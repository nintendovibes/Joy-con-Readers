import { useSyncExternalStore } from 'react'
import { JoyCon2, requestJoyCon2Device } from './joycon2/JoyCon2'
import {
  JoyCon1, requestJoyCon1Device, knownJoyCon1Devices, webHidSupported,
  NINTENDO_VENDOR_ID, JOYCON_R_PRODUCT_ID,
} from './joycon1/JoyCon1'

// Games that poll a station, for the links on the start screen. A game only
// reacts to taps posted under its own station name.
export const KNOWN_STATIONS = [
  { station: 'dk-spin', name: 'DK Spin' },
  { station: 'thwomp', name: 'Thwomp Panel Panic' },
]

const MAX_LOG = 40
const SEND_RETRIES = 2
const SEND_RETRY_MS = 1000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const isRightJoyCon2 = name => /\(R\)/.test(name ?? '')

// The station comes from the address: ?station=dk-spin
export function stationFromUrl() {
  const s = new URLSearchParams(window.location.search).get('station')
  return s && /^[\w-]{1,40}$/.test(s) ? s : null
}

export function webBluetoothSupported() {
  return typeof navigator !== 'undefined' && Boolean(navigator.bluetooth)
}

// Chrome only remembers Bluetooth (Switch 2) Joy-Cons across reloads with
// its experimental Web Bluetooth features on. Switch 1 Joy-Cons (WebHID) are
// always remembered.
export function remembersJoyCon2() {
  return typeof navigator !== 'undefined' && typeof navigator.bluetooth?.getDevices === 'function'
}

// Owns one right Joy-Con (either kind) and posts every band tap to the API
// under `station`. Events: 'change'.
class Reader extends EventTarget {
  station = null
  joycon = null
  busy = false
  log = []
  version = 0
  _restored = false

  addLog(text, level = 'info') {
    const time = new Date().toLocaleTimeString()
    this.log = [{ time, text, level, key: `${Date.now()}-${Math.random()}` }, ...this.log].slice(0, MAX_LOG)
    shipLog({ station: this.station, level, text })
    this._changed()
  }

  start(station) {
    this.station = station
    this.restore()
  }

  connectJoyCon2() {
    return this._choose(async () => {
      const device = await requestJoyCon2Device('R')
      if (this.joycon?.device.id !== device.id) this._wire(new JoyCon2(device, 'R'))
      await this.joycon.connect(0)
    })
  }

  // Must be paired in the computer's Bluetooth settings first.
  connectJoyCon1() {
    return this._choose(async () => {
      const device = await requestJoyCon1Device()
      if (!device) {
        this.addLog('Chooser closed, nothing selected. Pair the Joy-Con in Bluetooth settings first if it was missing.')
        return
      }
      if (this.joycon?.device !== device) this._wire(new JoyCon1(device))
      await this.joycon.connect()
    })
  }

  // Reconnects a Joy-Con this page was allowed to use before. Permission is
  // per page address, so readers for different stations on one computer
  // each keep their own Joy-Con.
  async restore() {
    if (this._restored) return
    this._restored = true
    if (webHidSupported()) {
      navigator.hid.addEventListener('connect', e => {
        const d = e.device
        if (this.joycon || d.vendorId !== NINTENDO_VENDOR_ID || d.productId !== JOYCON_R_PRODUCT_ID) return
        this._wire(new JoyCon1(d)).connect().catch(() => {})
      })
      try {
        const [device] = await knownJoyCon1Devices()
        if (device && !this.joycon) {
          this.addLog(`${device.productName}: remembered, connecting`)
          this._wire(new JoyCon1(device)).connect().catch(() => {})
          return
        }
      } catch (err) {
        this.addLog(`Couldn't restore the Joy-Con: ${err.message}`, 'error')
      }
    }
    if (remembersJoyCon2() && !this.joycon) {
      try {
        const device = (await navigator.bluetooth.getDevices()).find(d => isRightJoyCon2(d.name))
        if (device) {
          this._wire(new JoyCon2(device, 'R')).listen()
          this.addLog(`${device.name}: remembered, hold its sync button to connect`)
        }
      } catch (err) {
        this.addLog(`Couldn't restore the Joy-Con: ${err.message}`, 'error')
      }
    }
  }

  remove() {
    if (!this.joycon) return
    const jc = this.joycon
    jc.dispose()
    jc.device.forget?.().catch(() => {})
    this.joycon = null
    this.addLog(`${jc.name}: removed`)
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

  _wire(jc) {
    this.joycon?.dispose()
    jc.addEventListener('status', e => {
      this.addLog(`${jc.name}: ${e.detail}`, e.detail === 'error' ? 'error' : 'info')
      if (e.detail === 'connected') jc.startNfcScan?.()
    })
    jc.addEventListener('nfc', e => this._send(e.detail.uid))
    jc.addEventListener('debug', e => shipLog({ station: this.station, level: 'debug', text: e.detail }))
    this.joycon = jc
    this._changed()
    return jc
  }

  async _send(uid) {
    const station = this.station
    for (let attempt = 0; attempt <= SEND_RETRIES; attempt++) {
      try {
        const res = await fetch('/api/nfc-local-scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, station }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        this.joycon?.rumble().catch(() => {})
        this.addLog(`Band ${uid} sent to ${station}${await playerLabel(uid)}`)
        return
      } catch (err) {
        if (attempt === SEND_RETRIES) {
          this.addLog(`Band ${uid} not sent: ${err.message}`, 'error')
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

// " (Mario)" for a registered band, " (unregistered band)" otherwise, or ""
// if the lookup fails. Only for the log.
async function playerLabel(uid) {
  try {
    const res = await fetch(`/api/band/${encodeURIComponent(uid)}`)
    if (!res.ok) return ''
    const data = await res.json()
    return data.registered ? ` (${data.username})` : ' (unregistered band)'
  } catch {
    return ''
  }
}

// Dev only: sends a log line to the PC running the dev server
// (logs/nintendo-vibes.jsonl). The deployed site has no such endpoint.
function shipLog(entry) {
  if (!import.meta.env.DEV) return
  fetch('/__debug-log?name=nintendo-vibes', {
    method: 'POST',
    body: JSON.stringify({ at: new Date().toISOString(), ...entry }),
    keepalive: true,
  }).catch(() => {})
}

export const reader = new Reader()

export function useReader() {
  useSyncExternalStore(
    cb => {
      reader.addEventListener('change', cb)
      return () => reader.removeEventListener('change', cb)
    },
    () => reader.version,
  )
  return reader
}
