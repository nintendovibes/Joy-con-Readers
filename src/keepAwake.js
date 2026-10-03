// Keeps the reader working when nobody is touching the Mac.
//
// 1. Steady timers. Chrome slows a background tab's timers down (to once a
//    minute after five minutes hidden), which starves the Joy-Con's NFC loop.
//    Timers inside a Web Worker aren't slowed like that, so the Joy-Con
//    drivers tick from one here instead of setInterval.
// 2. Screen wake lock. Asks the Mac not to dim, lock or sleep while this page
//    is open, so it always looks like someone is using it.

let worker = null
const callbacks = new Map()
let nextId = 1

function getWorker() {
  if (worker !== null) return worker
  try {
    const src = `
      const timers = {};
      onmessage = e => {
        const { cmd, id, ms } = e.data;
        if (cmd === 'start') timers[id] = setInterval(() => postMessage(id), ms);
        else { clearInterval(timers[id]); delete timers[id]; }
      };`
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    worker.onmessage = e => callbacks.get(e.data)?.()
  } catch {
    worker = false // no Worker (e.g. tests): fall back to setInterval
  }
  return worker
}

// Like setInterval, but not slowed down in a background tab. Returns a
// function that stops it.
export function setSteadyInterval(fn, ms) {
  const w = getWorker()
  if (!w) {
    const handle = setInterval(fn, ms)
    return () => clearInterval(handle)
  }
  const id = nextId++
  callbacks.set(id, fn)
  w.postMessage({ cmd: 'start', id, ms })
  return () => {
    callbacks.delete(id)
    w.postMessage({ cmd: 'stop', id })
  }
}

// Screen wake lock, re-taken whenever the page becomes visible again (the
// browser drops it when the tab is hidden or the Mac is locked manually).
export const wake = { supported: typeof navigator !== 'undefined' && 'wakeLock' in navigator, active: false, error: null }
let sentinel = null
let started = false

export function keepScreenAwake(onChange = () => {}) {
  if (!wake.supported || started) return
  started = true
  const take = async () => {
    if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return
    try {
      sentinel = await navigator.wakeLock.request('screen')
      wake.active = true
      wake.error = null
      sentinel.addEventListener('release', () => { wake.active = false; onChange() })
    } catch (err) {
      wake.active = false
      wake.error = err.message
    }
    onChange()
  }
  document.addEventListener('visibilitychange', take)
  take()
  // Belt and braces: re-check every minute in case it was dropped quietly.
  setSteadyInterval(take, 60000)
}
