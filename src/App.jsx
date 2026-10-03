import { useEffect } from 'react'
import { reader, useReader, stationFromUrl, KNOWN_STATIONS, webBluetoothSupported, remembersJoyCon2 } from './reader'
import { webHidSupported } from './joycon1/JoyCon1'

const STATUS_TEXT = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Connected, reading bands',
  waiting: 'Waiting for the Joy-Con to reconnect',
  error: 'Problem with the Joy-Con, retrying',
  disconnected: 'Disconnected',
}

// nintendo-vibes.nintendovibes.com: shared pages for the Nintendo NFC games.
//   /                         home: links to each game's Joy-Con reader
//   /joycon?station=dk-spin   Joy-Con reader for one game's station

function PickStation() {
  return (
    <section className="panel">
      <div className="label">WHICH GAME IS THIS JOY-CON FOR?</div>
      <p className="muted">Each game only reacts to taps sent to its own station.</p>
      <div className="row">
        {KNOWN_STATIONS.map(s => (
          <a key={s.station} className="btn" href={`/joycon?station=${s.station}`}>{s.name.toUpperCase()}</a>
        ))}
      </div>
      <p className="muted">Bookmark the page that opens, so this computer always reads for that game.</p>
    </section>
  )
}

function Home() {
  return (
    <main className="page">
      <h1 className="title">NINTENDO VIBES</h1>
      <PickStation />
      <section className="panel">
        <div className="label">FIRST TIME ON THIS COMPUTER?</div>
        <p className="muted">
          Chrome only allows Bluetooth on pages it treats as secure. In Chrome on this computer, open
          {' '}<code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add
          {' '}<code>http://nintendo-vibes.nintendovibes.com</code>, set it to Enabled, and relaunch Chrome.
        </p>
      </section>
    </main>
  )
}

export default function App() {
  return window.location.pathname.startsWith('/joycon') ? <ReaderPage /> : <Home />
}

function ReaderPage() {
  const station = stationFromUrl()
  const r = useReader()
  const jc = r.joycon
  const status = jc?.status ?? 'idle'
  const game = KNOWN_STATIONS.find(s => s.station === station)?.name

  useEffect(() => {
    if (station) reader.start(station)
  }, [station])

  return (
    <main className="page">
      <h1 className="title">JOY-CON READER</h1>

      {!station ? <PickStation /> : (
        <>
          <section className="panel station">
            <div className="label">STATION</div>
            <div className="station-name">{station}</div>
            <p className="muted">
              Taps on this Joy-Con only start {game ?? `the game using the "${station}" station`}. Keep this tab open.
            </p>
          </section>

          <section className="panel">
            <div className="device-head">
              <span className={`dot ${status}`} />
              <strong>{jc ? jc.name : 'Joy-Con (R)'}</strong>
              {jc && <span className="muted">{jc.kind === 'switch1' ? 'Switch 1' : 'Switch 2'}</span>}
            </div>
            <div className="muted">{STATUS_TEXT[status] ?? status}</div>
            {jc?.nfc?.error && <div className="small-error">{jc.nfc.error}</div>}
            <div className="row">
              {jc ? (
                <>
                  <button
                    className="btn small"
                    disabled={r.busy || status === 'connected'}
                    onClick={() => (jc.kind === 'switch1' ? reader.connectJoyCon1() : reader.connectJoyCon2())}
                  >
                    RECONNECT
                  </button>
                  <button className="btn small dark" onClick={() => reader.remove()}>REMOVE</button>
                </>
              ) : (
                <>
                  <button className="btn small" disabled={r.busy || !webHidSupported()} onClick={() => reader.connectJoyCon1()}>
                    SWITCH 1 JOY-CON
                  </button>
                  <button className="btn small" disabled={r.busy || !webBluetoothSupported()} onClick={() => reader.connectJoyCon2()}>
                    SWITCH 2 JOY-CON
                  </button>
                </>
              )}
            </div>
          </section>

          <details className="panel">
            <summary>Setup</summary>
            <ol>
              <li>Keep the Switch and Switch 2 off or out of range, or they'll grab the Joy-Con back.</li>
              <li><b>Switch 1 Joy-Con:</b> pair the right Joy-Con in this computer's Bluetooth settings first (hold the sync button until the lights run, then pick "Joy-Con (R)"). Then click Switch 1 Joy-Con. After that it reconnects by itself.</li>
              <li><b>Switch 2 Joy-Con:</b> don't pair it in Bluetooth settings. Hold the sync button on its rail until the lights sweep, then click Switch 2 Joy-Con.</li>
              <li>Tap a band on the Joy-Con's stick. The log shows who it was sent for.</li>
              <li>To read for another game on this same computer, open this page with that game's station in another tab and give it a different Joy-Con.</li>
            </ol>
            {!remembersJoyCon2() && (
              <p className="muted">
                A Switch 2 Joy-Con is forgotten when this page reloads unless
                chrome://flags/#enable-experimental-web-platform-features is on.
              </p>
            )}
          </details>

          <section className="panel">
            <div className="label">LOG</div>
            {r.log.length === 0 && <div className="muted">Nothing yet.</div>}
            {r.log.map(e => (
              <div key={e.key} className={`log-line ${e.level}`}>{e.time} {e.text}</div>
            ))}
          </section>
        </>
      )}
    </main>
  )
}
