import { setSteadyInterval } from '../keepAwake'
// Copied from lego-mario (src/joycon1). Keep the copies in sync.
// Original (Switch 1) right Joy-Con NFC reader over WebHID.
//
// Unlike the Switch 2 Joy-Con, it uses classic Bluetooth, so it must be
// paired in the computer's Bluetooth settings first; Chrome then talks to it
// as a HID device. The NFC reader sits behind the Joy-Con's MCU (its NFC/IR
// chip), which has to be powered up and switched to NFC mode before it will
// poll for tags. Command bytes and report offsets follow
// https://github.com/aka256/joycon-webhid (src/event.ts, input_report.ts)
// and dekuNukem's Nintendo_Switch_Reverse_Engineering notes.
//
// Same surface as JoyCon2 where the station uses it: status, name,
// nfc.error, connect(), listen(), dispose(), rumble(), and 'status' / 'nfc'
// events (nfc detail = { uid }, uppercase hex like the API's band UIDs).

export const NINTENDO_VENDOR_ID = 0x057e
export const JOYCON_R_PRODUCT_ID = 0x2007

const NEUTRAL_RUMBLE = [0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40]

// Output report 0x01 subcommands
const SUB_SET_INPUT_MODE = 0x03
const SUB_SET_MCU_CONFIG = 0x21
const SUB_SET_MCU_STATE = 0x22
const SUB_SET_PLAYER_LIGHTS = 0x30
const INPUT_MODE_MCU = 0x31        // full input reports with MCU (NFC) data

// Output report 0x11 MCU commands
const MCU_CMD_STATUS = 0x01
const MCU_CMD_NFC = 0x02
const NFC_START_POLLING = [0x01, 0x00, 0x00, 0x08, 0x05, 0x00, 0xff, 0xff, 0x00, 0x01]
const NFC_STOP_POLLING = [0x02, 0x00, 0x00, 0x08, 0x00]

// Input report 0x31 layout (offsets into event.data, which excludes the ID)
const MCU_REPORT_ID = 48
const MCU_REPORT_STATE = 0x01
const MCU_REPORT_NFC = 0x2a
const MCU_STATE = 55               // in a state report: 1 standby, 4 NFC mode
const MCU_STATE_STANDBY = 1
const MCU_STATE_NFC = 4
const NFC_IC_STATE = 55            // in an NFC report
const NFC_TAG_PRESENT = 59         // 1 when a tag is in range
const NFC_UID_LENGTH = 63
const NFC_UID_START = 64
const NFC_IC_POLLING = 0x01
const NFC_IC_ERROR = 0x07
const NFC_IC_TAG_DETECTED = 0x09
const NFC_IC_RESET_REQUIRED = 0x0d
const VALID_UID_LENGTHS = new Set([4, 7, 10])

const STEP_MS = 100                // gap between set-up commands
const SETUP_TRIES = 30
const POLL_MS = 300                // how often "start polling" is re-sent
// A search times out with an error after ~65 s (seen on hardware: state 0x07,
// result 0x41), so restart it well before then.
const POLL_CYCLE_MS = 30000
const NFC_STUCK_MS = 4000          // not searching for this long: set up again
// No NFC report for this long: set the chip up again. Longer than the ~5 s it
// takes the Mac to report a dropped Bluetooth link, so a drop is handled as
// a disconnect (wait for the Joy-Con) rather than as a chip fault.
const NFC_SILENT_MS = 7000
const RETRY_MIN_MS = 2000          // failed set-up: retry after this, doubling
const RETRY_MAX_MS = 15000
const NFC_TAG_GONE_MS = 2500       // same band counts again after this long unseen

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const CRC8_TABLE = (() => {
  const table = []
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff
    table.push(c)
  }
  return table
})()

function crc8(bytes) {
  let v = 0
  for (const b of bytes) v = CRC8_TABLE[v ^ b]
  return v
}

// MCU sub-command plus arguments, padded to 36 bytes, then its CRC.
function mcuPayload(sub, args) {
  const body = [sub, ...args]
  while (body.length < 36) body.push(0)
  return [...body, crc8(body)]
}

export function webHidSupported() {
  return typeof navigator !== 'undefined' && Boolean(navigator.hid)
}

// Opens Chrome's HID chooser for a paired right Joy-Con. Must be called from
// a click. Resolves to the device, or null if the chooser was cancelled.
export async function requestJoyCon1Device() {
  const [device] = await navigator.hid.requestDevice({
    filters: [{ vendorId: NINTENDO_VENDOR_ID, productId: JOYCON_R_PRODUCT_ID }],
  })
  return device ?? null
}

// Right Joy-Cons this page was allowed to use before (WebHID remembers them
// without any Chrome flags). Only currently connected ones are returned.
export async function knownJoyCon1Devices() {
  if (!webHidSupported()) return []
  const devices = await navigator.hid.getDevices()
  return devices.filter(d => d.vendorId === NINTENDO_VENDOR_ID && d.productId === JOYCON_R_PRODUCT_ID)
}

// Reads the Joy-Con's Bluetooth address (subcommand 0x02, "device info"):
// the only way to tell two right Joy-Cons apart, since WebHID gives them the
// same name. Opens the device if needed. Resolves to "AA:BB:CC:DD:EE:FF".
export async function readJoyCon1Address(device, timeoutMs = 1500) {
  if (!device.opened) await device.open()
  for (let attempt = 0; attempt < 3; attempt++) {
    const address = await new Promise(resolve => {
      const done = value => {
        clearTimeout(timer)
        device.removeEventListener('inputreport', onReport)
        resolve(value)
      }
      const onReport = e => {
        // 0x21 = subcommand reply; byte 13 echoes the subcommand; the
        // address is bytes 18-23 (dekuNukem notes; aka256/joycon-webhid).
        if (e.reportId !== 0x21 || e.data.byteLength < 24 || e.data.getUint8(13) !== 0x02) return
        const bytes = []
        for (let i = 18; i < 24; i++) bytes.push(e.data.getUint8(i).toString(16).padStart(2, '0'))
        done(bytes.join(':').toUpperCase())
      }
      const timer = setTimeout(() => done(null), timeoutMs)
      device.addEventListener('inputreport', onReport)
      device.sendReport(0x01, Uint8Array.from([attempt & 0x0f, ...NEUTRAL_RUMBLE, 0x02])).catch(() => done(null))
    })
    if (address) return address
  }
  throw new Error("The Joy-Con didn't report its address")
}

// Player-light patterns: the low 4 bits are the 4 lights.
export const PLAYER_LIGHTS = [0x01, 0x03, 0x07, 0x0f]

// The page that owns the Joy-Cons watches navigator.hid 'connect' and
// 'disconnect' (it has to work out which Joy-Con came back), then calls
// reattach() / markDisconnected() on the right JoyCon1.
export class JoyCon1 extends EventTarget {
  constructor(device, { lights = PLAYER_LIGHTS[0], address = null } = {}) {
    super()
    this.device = device
    this.address = address
    this._lights = lights
    this.side = 'R'
    this.kind = 'switch1'
    this.status = 'idle'
    this.error = null
    this.nfc = { scanning: false, uid: null, readAt: 0, icState: null, error: null }
    this._packet = 0
    this._mcuState = null
    this._lastNfcReportAt = 0
    this._pollTimer = null
    this._disposed = false
    this._connecting = false
    this._retryTimer = null
    this._retryDelay = RETRY_MIN_MS
    this._onReport = this._onReport.bind(this)
  }

  get name() {
    return this.device.productName || 'Joy-Con (R)'
  }

  async connect() {
    if (this._connecting) return
    this._connecting = true
    this._disposed = false
    this._clearRetry()
    this._stopPolling()
    if (this.status !== 'waiting') this._setStatus('connecting')
    try {
      if (!this.device.opened) await this.device.open()
      this.device.removeEventListener('inputreport', this._onReport)
      this.device.addEventListener('inputreport', this._onReport)
      await this._setUpNfc()
      await this._subcommand(SUB_SET_PLAYER_LIGHTS, [this._lights])
      this._startPolling()
      this.error = null
      this.nfc.error = null
      this._retryDelay = RETRY_MIN_MS
      this._setStatus('connected')
    } catch (err) {
      this.error = err
      this.nfc.error = `${err.message}. Retrying…`
      this._debug(`set-up failed: ${err.message}`)
      this._setStatus('error')
      this._scheduleRetry()
      throw err
    } finally {
      this._connecting = false
    }
  }

  // A Joy-Con that has only just reconnected often fails its first set-up,
  // so keep retrying (with a growing gap) instead of waiting for a click.
  // Stops while the Joy-Con is disconnected; its return triggers connect().
  _scheduleRetry() {
    if (this._disposed || this._retryTimer || this.status === 'waiting') return
    const delay = this._retryDelay
    this._retryDelay = Math.min(RETRY_MAX_MS, this._retryDelay * 2)
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null
      if (this._disposed || this.status === 'connected' || this.status === 'waiting') return
      this.connect().catch(() => {})
    }, delay)
  }

  _clearRetry() {
    clearTimeout(this._retryTimer)
    this._retryTimer = null
  }

  // Waits for the Joy-Con to reconnect (Chrome fires 'connect' when it does).
  listen() {
    if (this.status === 'connected') return
    this._setStatus('waiting')
  }

  dispose() {
    this._disposed = true
    this._clearRetry()
    this._stopPolling()
    this.device.removeEventListener('inputreport', this._onReport)
    if (this.device.opened) {
      this._sendMcu(MCU_CMD_NFC, NFC_STOP_POLLING).catch(() => {})
      this.device.close().catch(() => {})
    }
    this._setStatus('disconnected')
  }

  // The Switch 1 rumble encoding isn't implemented; taps just don't buzz.
  rumble() {
    return Promise.resolve()
  }

  // ── Set-up ──

  // MCU on → standby → NFC mode, checking its state between steps.
  async _setUpNfc() {
    await this._subcommand(SUB_SET_INPUT_MODE, [INPUT_MODE_MCU])
    await sleep(STEP_MS)
    await this._subcommand(SUB_SET_MCU_STATE, [0x01])
    await sleep(STEP_MS)
    // Only MCU state reports may set this; resuming can re-initialise the
    // chip, so a remembered "NFC mode" can be stale.
    this._mcuState = null
    if (!(await this._waitForMcuState(s => s === MCU_STATE_STANDBY || s === MCU_STATE_NFC))) {
      throw new Error('The Joy-Con NFC chip did not start')
    }
    if (this._mcuState !== MCU_STATE_NFC) {
      for (let i = 0; i < 3 && this._mcuState !== MCU_STATE_NFC; i++) {
        await this._subcommandMcuConfig(0x00, [0x04])
        await sleep(STEP_MS)
        await this._waitForMcuState(s => s === MCU_STATE_NFC, 10)
      }
      if (this._mcuState !== MCU_STATE_NFC) throw new Error("The Joy-Con NFC chip didn't switch to NFC mode")
    }
    await this._sendMcu(MCU_CMD_NFC, NFC_STOP_POLLING)
    await sleep(STEP_MS)
  }

  async _waitForMcuState(test, tries = SETUP_TRIES) {
    for (let i = 0; i < tries; i++) {
      await this._send(0x11, [this._nextPacket(), ...NEUTRAL_RUMBLE, MCU_CMD_STATUS])
      await sleep(STEP_MS)
      if (this._mcuState !== null && test(this._mcuState)) return true
    }
    return false
  }

  _startPolling() {
    this._stopPolling()
    const now = performance.now()
    this.nfc.scanning = true
    this._lastNfcReportAt = now
    this._searchingAt = now
    this._cycleStart = now
    this._pollTimer = setSteadyInterval(() => this._pollTick(), POLL_MS)
  }

  _stopPolling() {
    this._pollTimer?.()
    this._pollTimer = null
    this.nfc.scanning = false
  }

  // Every POLL_MS: keep the search going, restart it before its timeout or
  // after an error, and fully set the chip up again if it stops responding.
  _pollTick() {
    if (!this.device.opened || this._recovering) return
    const now = performance.now()
    const ic = this.nfc.icState
    if (ic === NFC_IC_POLLING || ic === NFC_IC_TAG_DETECTED) {
      this._searchingAt = now
      this.nfc.error = null
    }

    if (now - this._lastNfcReportAt > NFC_SILENT_MS) return this._recover('NFC chip went quiet')
    if (ic === NFC_IC_RESET_REQUIRED) return this._recover('NFC chip asked for a reset')
    if (now - this._searchingAt > NFC_STUCK_MS) return this._recover('NFC chip stopped searching')

    // Stop now; the next tick sends "start polling" again.
    if (ic === NFC_IC_ERROR || now - this._cycleStart > POLL_CYCLE_MS) {
      this._cycleStart = now
      this._debug(ic === NFC_IC_ERROR ? 'search error, restarting the search' : 'restarting the search')
      this._sendMcu(MCU_CMD_NFC, NFC_STOP_POLLING).catch(err => { this.nfc.error = err.message })
      return
    }
    this._sendMcu(MCU_CMD_NFC, NFC_START_POLLING).catch(err => { this.nfc.error = err.message })
  }

  async _recover(reason) {
    if (this._recovering) return
    this._recovering = true
    this._debug(`recovering: ${reason}`)
    this._stopPolling()
    this.nfc.error = `${reason}, restarting it`
    this.nfc.icState = null
    try {
      await this._setUpNfc()
      this.nfc.error = null
      this._startPolling()
    } catch (err) {
      // Usually the Joy-Con dropped off Bluetooth; if so the disconnect
      // event switches to 'waiting' and its return reconnects. Otherwise
      // retry the whole set-up.
      this.nfc.error = `${err.message}. Retrying…`
      this._debug(`recovery failed: ${err.message}`)
      this._setStatus('error')
      this._scheduleRetry()
    } finally {
      this._recovering = false
    }
  }

  // ── Reports ──

  _onReport(event) {
    if (event.reportId !== 0x31) return
    const d = event.data
    if (d.byteLength <= NFC_UID_START) return
    const kind = d.getUint8(MCU_REPORT_ID)

    if (kind === MCU_REPORT_STATE) {
      const state = d.getUint8(MCU_STATE)
      if (state !== this._mcuState) this._debug(`MCU state ${state}`)
      this._mcuState = state
    } else if (kind === MCU_REPORT_NFC) {
      this._lastNfcReportAt = performance.now()
      const ic = d.getUint8(NFC_IC_STATE)
      if (ic !== this.nfc.icState) this._debug(`NFC chip state 0x${ic.toString(16)}, result 0x${d.getUint8(49).toString(16)}, tag ${d.getUint8(NFC_TAG_PRESENT)}`)
      this.nfc.icState = ic
      if (d.getUint8(NFC_TAG_PRESENT) !== 1) return
      const len = d.getUint8(NFC_UID_LENGTH)
      if (!VALID_UID_LENGTHS.has(len) || NFC_UID_START + len > d.byteLength) return
      const bytes = []
      for (let i = 0; i < len; i++) bytes.push(d.getUint8(NFC_UID_START + i))
      if (bytes.every(b => b === 0)) return
      const uid = bytes.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
      const now = Date.now()
      const isNewTap = uid !== this.nfc.uid || now - this.nfc.readAt > NFC_TAG_GONE_MS
      this.nfc.uid = uid
      this.nfc.readAt = now
      if (isNewTap) this.dispatchEvent(new CustomEvent('nfc', { detail: { uid } }))
    }
  }

  // This Joy-Con came back (Chrome gives it a new HIDDevice object).
  reattach(device) {
    if (this._disposed || this.status === 'connected' || this._connecting) return
    this._debug('Joy-Con reconnected to the computer')
    this.device = device
    this._retryDelay = RETRY_MIN_MS
    // Give the Joy-Con a moment to settle; set-up right away often fails.
    setTimeout(() => this.connect().catch(() => {}), 500)
  }

  markDisconnected() {
    if (this._disposed) return
    this._debug('Joy-Con disconnected from the computer')
    this._clearRetry()
    this._stopPolling()
    this._mcuState = null
    this.nfc.error = null
    this._setStatus('waiting')
  }

  // ── Sending ──

  _nextPacket() {
    this._packet = (this._packet + 1) & 0x0f
    return this._packet
  }

  _send(reportId, bytes) {
    if (!this.device.opened) return Promise.reject(new Error('Not connected'))
    return this.device.sendReport(reportId, Uint8Array.from(bytes))
  }

  _subcommand(sub, args = []) {
    return this._send(0x01, [this._nextPacket(), ...NEUTRAL_RUMBLE, sub, ...args])
  }

  // Subcommand 0x21 carries an MCU payload with its own CRC.
  _subcommandMcuConfig(mcuSub, args) {
    return this._send(0x01, [this._nextPacket(), ...NEUTRAL_RUMBLE, SUB_SET_MCU_CONFIG, 0x21, ...mcuPayload(mcuSub, args)])
  }

  _sendMcu(cmd, [sub, ...args]) {
    return this._send(0x11, [this._nextPacket(), ...NEUTRAL_RUMBLE, cmd, ...mcuPayload(sub, args)])
  }

  _debug(text) {
    this.dispatchEvent(new CustomEvent('debug', { detail: text }))
  }

  _setStatus(status) {
    this.status = status
    this.dispatchEvent(new CustomEvent('status', { detail: status }))
  }
}
