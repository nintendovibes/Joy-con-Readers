// Copied from Bowser Jr (src/joycon2). Keep the copies in sync.
import {
  NINTENDO_COMPANY_ID,
  SERVICE_UUID,
  INPUT_CHAR_UUID,
  COMMAND_CHAR_UUID,
  COMMAND_RESPONSE_CHAR_UUID,
  SIDES,
  CMD_ENABLE_STANDARD,
  CMD_ENABLE_EXTENDED,
  PLAYER_LIGHT_PATTERNS,
  playerLightsCommand,
  buildCommand,
  parseCommandResponse,
  CMD_VIBRATION,
  SUB_PLAY_SAMPLE,
  CMD_NFC,
  NFC_START_POLL,
  NFC_STOP_POLL,
  NFC_GET_STATUS,
  NFC_STATE_TIMED_OUT,
  parseNfcStatus,
  parseReport,
  REPORT_MIN_LENGTH,
} from './protocol.js'
import { setSteadyInterval } from '../keepAwake'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// The Joy-Con ignores commands sent back-to-back right after connecting.
const COMMAND_GAP_MS = 500
const HISTORY_LENGTH = 240
const MOUSE_WRAP = 65536
const RESPONSE_LOG_LENGTH = 30

// NFC scan loop. Each search times out after ~1.2 s and only restarts after
// a "stop", so the loop cycles stop → start → status checks, beginning a new
// cycle when the search times out or reads a tag.
const NFC_TICK_MS = 150
// Safety net: restart a cycle that never reported timing out.
const NFC_CYCLE_MAX_MS = 2000
// A band left on the stick keeps being re-read; it only counts as a new tap
// once it has gone unseen for this long.
const NFC_TAG_GONE_MS = 2500

// Staying connected. A harmless read-only command every KEEPALIVE_MS in case
// the Joy-Con drops hosts that go quiet. Any controller that isn't connected
// (dropped, asleep, or remembered from an earlier visit) is 'waiting': it
// keeps listening and connects as soon as the Joy-Con advertises — i.e. when
// someone holds its sync button. No clicks needed.
const KEEPALIVE_MS = 10000
const CMD_FEATURE_INFO = { command: 0x0c, sub: 0x01, data: [0x2f, 0x00, 0x00, 0x00] }
const LISTEN_RETRY_MIN_MS = 1000
const LISTEN_RETRY_MAX_MS = 5000

// Raw stick counts from center that count as "pushed all the way" for the
// direction test. The true range is unconfirmed — the Lab shows the max
// reached so it can be tuned.
export const STICK_TEST_THRESHOLD = 900

export function webBluetoothStatus() {
  if (typeof navigator !== 'undefined' && navigator.bluetooth) return { ok: true }
  return { ok: false, reason: window.isSecureContext ? 'browser' : 'insecure' }
}

// Opens Chrome's device chooser filtered to one side. Must be called from a
// click handler. Rejects with NotFoundError if the chooser is cancelled.
export function requestJoyCon2Device(side) {
  const pid = SIDES[side].productId
  return navigator.bluetooth.requestDevice({
    filters: [{
      manufacturerData: [{
        companyIdentifier: NINTENDO_COMPANY_ID,
        dataPrefix: new Uint8Array([0, 0, 0, 0, 0, pid & 0xff, pid >> 8]),
        mask: new Uint8Array([0, 0, 0, 0, 0, 0xff, 0xff]),
      }],
    }],
    optionalServices: [SERVICE_UUID],
  })
}

let nextId = 1

// Events: 'status' (status changed), 'input' (detail = parsed report, fired
// for every packet — use this for anything that must not miss samples),
// 'response' (detail = parsed command reply), 'nfc' (detail = { uid }, fired
// when a new tag is read) and 'connection' (detail = diagnostics about a
// drop or reconnect, for logging).
//
// Statuses: idle → connecting → connected; 'waiting' while listening for the
// Joy-Con to come back; 'disconnected' only after disconnect()/dispose().
export class JoyCon2 extends EventTarget {
  constructor(device, side) {
    super()
    this.id = nextId++
    this.device = device
    this.side = side
    this.status = 'idle'
    this.error = null
    this.state = null
    this.raw = null
    this.rawChangedAt = null
    this.packetCount = 0
    this.packetsPerSecond = 0
    this.history = []
    this._rateCount = 0
    this._rateStart = performance.now()
    this._input = null
    this._command = null
    this._response = null
    this.responses = []
    this.responseError = null
    this.nfc = { scanning: false, uid: null, state: null, lastStatus: null, readAt: 0, error: null }
    this._nfcTimer = null
    this._nfcPhase = 'stop'
    this._nfcCycleStart = 0
    this._playerIndex = 0
    this._keepaliveTimer = null
    this._manualDisconnect = false
    this._connectedAt = 0
    this._lastPacketAt = 0
    this._lastButtonsAt = 0
    this._listening = false
    this._stopWatching = null
    this._onPacket = this._onPacket.bind(this)
    this._onResponse = this._onResponse.bind(this)
    this._onDisconnected = this._onDisconnected.bind(this)
    device.addEventListener('gattserverdisconnected', this._onDisconnected)
    this.resetTracking()
  }

  get name() {
    return this.device.name || SIDES[this.side].label
  }

  resetTracking() {
    this.seenButtons = 0
    this.stickCenter = null
    this.stickDelta = { x: 0, y: 0 }
    this.stickMax = { up: 0, down: 0, left: 0, right: 0 }
    this.mouseTotal = { x: 0, y: 0 }
  }

  recenterStick() {
    this.stickCenter = null
    this.stickMax = { up: 0, down: 0, left: 0, right: 0 }
  }

  async connect(playerIndex = this._playerIndex) {
    this._playerIndex = playerIndex
    this._manualDisconnect = false
    if (!this._listening) this._setStatus('connecting')
    try {
      const server = await this.device.gatt.connect()
      const service = await server.getPrimaryService(SERVICE_UUID)
      this._command = await service.getCharacteristic(COMMAND_CHAR_UUID)
      await this._subscribeResponses(service)
      await this.setPlayerLights(PLAYER_LIGHT_PATTERNS[playerIndex % PLAYER_LIGHT_PATTERNS.length])
      await sleep(COMMAND_GAP_MS)
      await this._send(CMD_ENABLE_STANDARD)
      await sleep(COMMAND_GAP_MS)
      await this._send(CMD_ENABLE_EXTENDED)

      this._input?.removeEventListener('characteristicvaluechanged', this._onPacket)
      this._input = await service.getCharacteristic(INPUT_CHAR_UUID)
      this._input.addEventListener('characteristicvaluechanged', this._onPacket)
      await this._input.startNotifications()
      this._connectedAt = performance.now()
      this._lastButtonsAt = this._connectedAt
      this._startKeepalive()
      this._setStatus('connected')
    } catch (err) {
      this.error = err
      if (!this._listening) this._setStatus('error')
      throw err
    }
  }

  disconnect() {
    this._manualDisconnect = true
    this.device.gatt?.disconnect()
  }

  // Tears down listeners; call when the controller is removed from the app.
  dispose() {
    this._manualDisconnect = true
    this._stopWatching?.()
    this._clearNfcTimer()
    this._stopKeepalive()
    this._input?.removeEventListener('characteristicvaluechanged', this._onPacket)
    this._response?.removeEventListener('characteristicvaluechanged', this._onResponse)
    this.device.removeEventListener('gattserverdisconnected', this._onDisconnected)
    this.disconnect()
  }

  setPlayerLights(pattern) {
    return this._send(playerLightsCommand(pattern))
  }

  sendCommand(command, subcommand, data = []) {
    return this._send(buildCommand(command, subcommand, data))
  }

  rumble(sample = 3) {
    return this.sendCommand(CMD_VIBRATION, SUB_PLAY_SAMPLE, [sample, 0, 0, 0])
  }

  startNfcScan() {
    if (this._nfcTimer) return
    this.nfc = { ...this.nfc, scanning: true, error: null }
    this._nfcPhase = 'stop'
    this._nfcTick()
    this._nfcTimer = setSteadyInterval(() => this._nfcTick(), NFC_TICK_MS)
  }

  _nfcTick() {
    const now = performance.now()
    if (this._nfcPhase === 'polling' && now - this._nfcCycleStart > NFC_CYCLE_MAX_MS) this._nfcPhase = 'stop'

    let step
    if (this._nfcPhase === 'stop') {
      step = NFC_STOP_POLL
      this._nfcPhase = 'start'
    } else if (this._nfcPhase === 'start') {
      step = NFC_START_POLL
      this._nfcPhase = 'polling'
      this._nfcCycleStart = now
    } else {
      step = NFC_GET_STATUS
    }
    this.sendCommand(CMD_NFC, step.sub, step.data).catch(err => { this.nfc.error = err.message })
  }

  stopNfcScan() {
    this._clearNfcTimer()
    if (this.status === 'connected') {
      this.sendCommand(CMD_NFC, NFC_STOP_POLL.sub, NFC_STOP_POLL.data).catch(() => {})
    }
  }

  _clearNfcTimer() {
    this._nfcTimer?.()
    this._nfcTimer = null
    this.nfc.scanning = false
  }

  // Command replies are only needed for NFC and diagnostics, so a failure
  // here is recorded rather than failing the whole connection.
  async _subscribeResponses(service) {
    try {
      this._response?.removeEventListener('characteristicvaluechanged', this._onResponse)
      this._response = await service.getCharacteristic(COMMAND_RESPONSE_CHAR_UUID)
      this._response.addEventListener('characteristicvaluechanged', this._onResponse)
      await this._response.startNotifications()
      this.responseError = null
    } catch (err) {
      this.responseError = err.message
    }
  }

  _onResponse(event) {
    const dv = event.target.value
    const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength))
    const res = parseCommandResponse(bytes)
    this.responses.unshift({ at: Date.now(), ...res })
    if (this.responses.length > RESPONSE_LOG_LENGTH) this.responses.pop()
    this.dispatchEvent(new CustomEvent('response', { detail: res }))

    if (res.command === CMD_NFC && res.subcommand === NFC_GET_STATUS.sub) {
      this.nfc.lastStatus = res.data
      this.nfc.state = res.data[0]
      const uid = parseNfcStatus(res.data)
      if (uid) {
        const now = Date.now()
        const isNewTap = uid !== this.nfc.uid || now - this.nfc.readAt > NFC_TAG_GONE_MS
        this.nfc.uid = uid
        this.nfc.readAt = now
        if (isNewTap) this.dispatchEvent(new CustomEvent('nfc', { detail: { uid } }))
      }
      // Start a fresh search after a read (so a new band can be seen) or
      // after the search timed out (a new "start" is ignored until "stop").
      if (this._nfcTimer && (uid || this.nfc.state === NFC_STATE_TIMED_OUT)) this._nfcPhase = 'stop'
    }
  }

  async _send(bytes) {
    if (!this._command) throw new Error('Not connected')
    return this._command.writeValueWithoutResponse(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
  }

  _setStatus(status) {
    this.status = status
    this.dispatchEvent(new CustomEvent('status', { detail: status }))
  }

  _startKeepalive() {
    this._stopKeepalive()
    this._keepaliveTimer = setSteadyInterval(() => {
      const { command, sub, data } = CMD_FEATURE_INFO
      this.sendCommand(command, sub, data).catch(() => {})
    }, KEEPALIVE_MS)
  }

  _stopKeepalive() {
    this._keepaliveTimer?.()
    this._keepaliveTimer = null
  }

  _onDisconnected() {
    const now = performance.now()
    const wasScanning = this.nfc.scanning
    this._stopKeepalive()
    this._clearNfcTimer()
    if (this._manualDisconnect) {
      this._setStatus('disconnected')
      return
    }
    this._emitConnection({
      event: 'dropped',
      connectedForS: Math.round((now - this._connectedAt) / 1000),
      sinceButtonS: Math.round((now - this._lastButtonsAt) / 1000),
      sincePacketMs: Math.round(now - this._lastPacketAt),
      batteryVolts: this.state?.batteryVolts,
      nfcScanning: wasScanning,
      hidden: document.hidden,
    })
    this.listen()
  }

  // Keep trying to connect until connected or disposed. Used after a drop
  // and for Joy-Cons remembered from an earlier visit (see hub.restore()).
  listen() {
    if (this._listening || this.device.gatt?.connected) return
    this._listening = true
    this._manualDisconnect = false
    this._setStatus('waiting')
    this._listenLoop()
  }

  async _listenLoop() {
    const started = performance.now()
    let delay = LISTEN_RETRY_MIN_MS
    try {
      for (let attempt = 1; !this._manualDisconnect; attempt++) {
        if (this.device.gatt?.connected) return
        await this._waitForAdvertisement()
        // Stop if removed, or if it was connected another way meanwhile.
        if (this._manualDisconnect || this.device.gatt?.connected) return
        try {
          await this.connect()
          this._emitConnection({ event: 'reconnected', attempt, afterS: Math.round((performance.now() - started) / 1000) })
          return
        } catch {
          await sleep(delay)
          delay = Math.min(LISTEN_RETRY_MAX_MS, delay * 1.5)
        }
      }
    } finally {
      this._listening = false
    }
  }

  // With Chrome's experimental Web Bluetooth features, wait until the
  // Joy-Con is actually advertising (sync button held) before connecting.
  // Without them this returns immediately and connect() is simply retried.
  async _waitForAdvertisement() {
    if (typeof this.device.watchAdvertisements !== 'function') return
    const abort = new AbortController()
    await new Promise(resolve => {
      const done = () => {
        this.device.removeEventListener('advertisementreceived', done)
        this._stopWatching = null
        resolve()
      }
      this.device.addEventListener('advertisementreceived', done)
      this._stopWatching = done
      this.device.watchAdvertisements({ signal: abort.signal }).catch(done)
    })
    abort.abort()
  }

  _emitConnection(detail) {
    this.dispatchEvent(new CustomEvent('connection', { detail: { name: this.name, side: this.side, ...detail } }))
  }

  _onPacket(event) {
    const dv = event.target.value
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength)
    const now = performance.now()

    if (!this.raw || this.raw.length !== bytes.length) {
      this.raw = new Uint8Array(bytes.length)
      this.rawChangedAt = new Float64Array(bytes.length)
    }
    for (let i = 0; i < bytes.length; i++) {
      if (this.raw[i] !== bytes[i]) {
        this.raw[i] = bytes[i]
        this.rawChangedAt[i] = now
      }
    }

    this.packetCount++
    this._rateCount++
    if (now - this._rateStart >= 1000) {
      this.packetsPerSecond = Math.round((this._rateCount * 1000) / (now - this._rateStart))
      this._rateCount = 0
      this._rateStart = now
    }

    if (bytes.length < REPORT_MIN_LENGTH) return

    this._lastPacketAt = now
    const prev = this.state
    const s = parseReport(dv)
    this.state = s
    if (prev && s.buttons !== prev.buttons) this._lastButtonsAt = now
    this.seenButtons = (this.seenButtons | s.buttons) >>> 0
    this._trackStick(s)
    if (prev) this._trackMouse(s, prev)

    this.history.push({ t: now, accel: s.accel, gyro: s.gyro })
    if (this.history.length > HISTORY_LENGTH) this.history.shift()

    this.dispatchEvent(new CustomEvent('input', { detail: s }))
  }

  _trackStick(s) {
    const stick = this.side === 'L' ? s.stickL : s.stickR
    if (!this.stickCenter) this.stickCenter = { ...stick }
    const dx = stick.x - this.stickCenter.x
    const dy = stick.y - this.stickCenter.y
    this.stickDelta = { x: dx, y: dy }
    const m = this.stickMax
    if (dy > m.up) m.up = dy
    if (-dy > m.down) m.down = -dy
    if (dx > m.right) m.right = dx
    if (-dx > m.left) m.left = -dx
  }

  _trackMouse(s, prev) {
    this.mouseTotal.x += wrapDelta(s.mouse.x - prev.mouse.x)
    this.mouseTotal.y += wrapDelta(s.mouse.y - prev.mouse.y)
  }
}

function wrapDelta(d) {
  if (d > MOUSE_WRAP / 2) return d - MOUSE_WRAP
  if (d < -MOUSE_WRAP / 2) return d + MOUSE_WRAP
  return d
}
