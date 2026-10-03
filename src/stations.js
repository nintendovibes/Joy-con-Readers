import { useSyncExternalStore } from 'react'
import { JoyCon2, requestJoyCon2Device } from './joycon2/JoyCon2'
import {
  JoyCon1, requestJoyCon1Device, knownJoyCon1Devices, readJoyCon1Address, webHidSupported,
  NINTENDO_VENDOR_ID, JOYCON_R_PRODUCT_ID, PLAYER_LIGHTS,
} from './joycon1/JoyCon1'
import { keepScreenAwake } from './keepAwake'

// One card per game. A game only reacts to taps posted under its own station
// (it polls /last-nfc?station=<station>). The card's position sets the
// Joy-Con's player lights (1 light, 2 lights, …) so you can tell them apart.
// To add a game: add it here and have the game poll its station.
export const STATIONS = [
  { station: 'thwomp', name: 'Thwomp Panel Panic' },
  { station: 'dk-spin', name: 'DK Spin' },
]

const MAP_KEY = 'joy-con-readers:stations' // { "hid:AA:BB:…" | "ble:<id>": station }
const MAX_LOG = 60
const SEND_RETRIES = 2
const SEND_RETRY_MS = 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isRightJoyCon2 = name => /\(R\)/.test(name ?? '')
const isRightJoyCon1 = d => d.vendorId === NINTENDO_VENDOR_ID && d.productId === JOYCON_R_PRODUCT_ID

export function webBluetoothSupported() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth)
}
export { webHidSupported }

// Switch 2 Joy-Cons are only remembered across reloads with Chrome's
// experimental Web Bluetooth features on; Switch 1 Joy-Cons always are.
export function remembersJoyCon2() {
  return typeof navigator !== 'undefined' && typeof navigator.bluetooth?.getDevices === 'function'
}

function loadMap() {
  try { return JSON.parse(localStorage.getItem(MAP_KEY) || '{}') } catch { return {} }
}
function saveMap(map) {
  try { localStorage.setItem(MAP_KEY, JSON.stringify(map)) } catch { /* not remembered */ }
}

// Owns every Joy-Con on this page and which game each one reads for.
// Events: 'change'.
class Readers extends EventTarget {
  cards = STATIONS.map((s, index) => ({ ...s, index, joycon: null, key: null, lastTap: null }))
  unassigned = []   // connected Switch 1 Joy-Cons with no game yet: [{ key, address, device }]
  busy = false
  log = []
  version = 0
  _map = loadMap()
  _identifying = new Set()
  _started = false

  addLog(text, level = 'info') {
    const time = new Date().toLocaleTimeString()
    this.log = [{ time, text, level, key: `${Date.now()}-${Math.random()}` }, ...this.log].slice(0, MAX_LOG)
    this._changed()
  }

  start() {
    if (this._started) return
    this._started = true
    keepScreenAwake(() => this._changed())
    if (webHidSupported()) {
      navigator.hid.addEventListener('connect', e => { if (isRightJoyCon1(e.device)) this._foundJoyCon1(e.device) })
      navigator.hid.addEventListener('disconnect', e => this._lostJoyCon1(e.device))
    }
    this._restore()
  }

  // ── Connecting from a card ──

  // Switch 1: must be paired in the computer's Bluetooth settings first.
  connectSwitch1(card) {
    return this._choose(async () => {
      const device = await requestJoyCon1Device()
      if (!device) {
        this.addLog('Chooser closed, nothing selected. Pair the Joy-Con in Bluetooth settings first if it was missing.')
        return
      }
      const address = await readJoyCon1Address(device)
      this._assign(card, { kind: 'switch1', device, address, key: `hid:${address}` })
    })
  }

  // Switch 2: don't pair it in Bluetooth settings; hold its sync button.
  connectSwitch2(card) {
    return this._choose(async () => {
      const device = await requestJoyCon2Device('R')
      this._assign(card, { kind: 'switch2', device, key: `ble:${device.id}` })
    })
  }

  // A connected Joy-Con from the "not assigned" list.
  assignUnassigned(item, card) {
    this._assign(card, { kind: 'switch1', device: item.device, address: item.address, key: item.key })
  }

  reconnect(card) {
    const jc = card.joycon
    if (!jc) return
    if (jc.kind === 'switch1') jc.connect().catch(() => {})
    else jc.connect(card.index).catch(() => {})
  }

  // Stops this card reading. A Switch 1 Joy-Con stays listed as unassigned
  // so it can be given to another game.
  unassign(card) {
    const jc = card.joycon
    if (!jc) return
    const { key } = card
    delete this._map[key]
    saveMap(this._map)
    jc.dispose()
    if (jc.kind === 'switch2') jc.device.forget?.().catch(() => {})
    card.joycon = null
    card.key = null
    this.addLog(`${card.name}: Joy-Con removed`)
    if (jc.kind === 'switch1') this._foundJoyCon1(jc.device)
  }

  _assign(card, { kind, device, address = null, key }) {
    // Take it off any other card it was reading for.
    for (const other of this.cards) {
      if (other !== card && other.key === key && other.joycon) {
        other.joycon.dispose()
        other.joycon = null
        other.key = null
        this.addLog(`${other.name}: its Joy-Con now reads for ${card.name}`)
      }
    }
    card.joycon?.dispose()
    this.unassigned = this.unassigned.filter(u => u.key !== key)
    this._map[key] = card.station
    saveMap(this._map)

    const jc = kind === 'switch1'
      ? new JoyCon1(device, { lights: PLAYER_LIGHTS[card.index % PLAYER_LIGHTS.length], address })
      : new JoyCon2(device, 'R')
    jc.addEventListener('status', e => {
      this.addLog(`${card.name}: Joy-Con ${e.detail}`, e.detail === 'error' ? 'error' : 'info')
      if (e.detail === 'connected') jc.startNfcScan?.()
    })
    jc.addEventListener('nfc', e => this._send(card, e.detail.uid))
    card.joycon = jc
    card.key = key
    this._changed()

    if (kind === 'switch1') jc.connect().catch(() => {})
    else jc.connect(card.index).catch(() => jc.listen())
    return jc
  }

  async _choose(fn) {
    this.busy = true
    this._changed()
    try {
      await fn()
    } catch (err) {
      // NotFoundError also means "no Bluetooth adapter"; only a cancelled
      // chooser is harmless.
      if (err.name === 'NotFoundError' && /cancel/i.test(err.message)) this.addLog('Chooser closed, nothing selected')
      else this.addLog(`Connect failed: ${err.message}`, 'error')
    } finally {
      this.busy = false
      this._changed()
    }
  }

  // ── Finding Joy-Cons again (reload, reconnect) ──

  async _restore() {
    if (webHidSupported()) {
      try {
        for (const device of await knownJoyCon1Devices()) this._foundJoyCon1(device)
      } catch (err) {
        this.addLog(`Couldn't look for Joy-Cons: ${err.message}`, 'error')
      }
    }
    if (remembersJoyCon2()) {
      try {
        for (const device of await navigator.bluetooth.getDevices()) {
          if (!isRightJoyCon2(device.name)) continue
          const card = this.cards.find(c => c.station === this._map[`ble:${device.id}`])
          if (card && !card.joycon) {
            this._assign(card, { kind: 'switch2', device, key: `ble:${device.id}` })
            this.addLog(`${card.name}: remembered Switch 2 Joy-Con, hold its sync button to connect`)
          }
        }
      } catch (err) {
        this.addLog(`Couldn't look for Switch 2 Joy-Cons: ${err.message}`, 'error')
      }
    }
  }

  // A Switch 1 Joy-Con is connected to the computer: work out which one it
  // is, then give it back to its game, or list it as unassigned.
  async _foundJoyCon1(device) {
    if (this._identifying.has(device)) return
    if (this.cards.some(c => c.joycon?.device === device && c.joycon.status === 'connected')) return
    this._identifying.add(device)
    try {
      await sleep(300) // a Joy-Con that has only just connected needs a moment
      const address = await readJoyCon1Address(device)
      const key = `hid:${address}`
      const card = this.cards.find(c => c.key === key) ?? this.cards.find(c => c.station === this._map[key])
      if (card?.joycon && card.key === key) {
        card.joycon.reattach(device)
      } else if (card && !card.joycon) {
        this._assign(card, { kind: 'switch1', device, address, key })
        this.addLog(`${card.name}: Joy-Con ${address} is back`)
      } else if (!this.unassigned.some(u => u.key === key)) {
        this.unassigned = [...this.unassigned, { key, address, device }]
        this._changed()
      }
    } catch (err) {
      this.addLog(`A Switch 1 Joy-Con connected but couldn't be identified: ${err.message}`, 'error')
    } finally {
      this._identifying.delete(device)
    }
  }

  _lostJoyCon1(device) {
    for (const card of this.cards) {
      if (card.joycon?.kind === 'switch1' && card.joycon.device === device) card.joycon.markDisconnected()
    }
    const before = this.unassigned.length
    this.unassigned = this.unassigned.filter(u => u.device !== device)
    if (this.unassigned.length !== before) this._changed()
  }

  // ── Taps ──

  async _send(card, uid) {
    const { station, name } = card
    for (let attempt = 0; attempt <= SEND_RETRIES; attempt++) {
      try {
        const res = await fetch('/api/nfc-local-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, station }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        card.joycon?.rumble().catch(() => {})
        const player = await playerName(uid)
        card.lastTap = { uid, player, at: new Date().toLocaleTimeString() }
        this.addLog(`${name}: band ${uid} (${player ?? 'unregistered band'})`)
        return
      } catch (err) {
        if (attempt === SEND_RETRIES) {
          this.addLog(`${name}: band ${uid} not sent: ${err.message}`, 'error')
          return
        }
        await sleep(SEND_RETRY_MS)
      }
    }
  }

  _changed() {
    this.version++
    this.dispatchEvent(new Event('change'))
  }
}

// The player's name for a band, or null if it isn't registered (or the
// lookup fails).
async function playerName(uid) {
  try {
    const res = await fetch(`/api/band/${encodeURIComponent(uid)}`)
    if (!res.ok) return null
    const data = await res.json()
    return data.registered ? data.username : null
  } catch {
    return null
  }
}

export const readers = new Readers()

export function useReaders() {
  useSyncExternalStore(
    cb => {
      readers.addEventListener('change', cb)
      return () => readers.removeEventListener('change', cb)
    },
    () => readers.version,
  )
  return readers
}
