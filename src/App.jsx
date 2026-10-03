import { useEffect } from 'react'
import { readers, useReaders, webBluetoothSupported, webHidSupported, remembersJoyCon2 } from './stations'

// joy-con-readers.nintendovibes.com: one screen that turns right Joy-Cons
// into Power-Up Band readers, one per game. Open it in Chrome on a computer
// with Bluetooth (the Mac) and leave it open.

const STATUS_TEXT = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  connected: 'Reading bands',
  waiting: 'Waiting for the Joy-Con to reconnect',
  error: 'Problem with the Joy-Con, retrying',
  disconnected: 'Disconnected',
}

const SITE = 'http://joy-con-readers.nintendovibes.com'

function Lights({ index }) {
  return (
    <span className="lights" title={`Player light ${index + 1}`}>
      {[0, 1, 2, 3].map(i => <span key={i} className={i <= index ? 'on' : ''} />)}
    </span>
  )
}

function StationCard({ card, busy }) {
  const jc = card.joycon
  const status = jc?.status ?? 'idle'
  return (
    <section className={`panel card ${status}`}>
      <div className="card-head">
        <div>
          <div className="card-name">{card.name}</div>
          <div className="muted small">station: {card.station}</div>
        </div>
        <Lights index={card.index} />
      </div>

      <div className="device-head">
        <span className={`dot ${status}`} />
        <span>{jc ? STATUS_TEXT[status] ?? status : 'No Joy-Con yet'}</span>
      </div>
      {jc && (
        <div className="muted small">
          {jc.kind === 'switch1' ? `Switch 1 Joy-Con${jc.address ? ` · ${jc.address}` : ''}` : `Switch 2 Joy-Con · ${jc.name}`}
        </div>
      )}
      {jc?.nfc?.error && <div className="small-error">{jc.nfc.error}</div>}

      <div className="last-tap">
        {card.lastTap
          ? <>Last tap: <b>{card.lastTap.player ?? 'unregistered band'}</b> at {card.lastTap.at}</>
          : <span className="muted">No taps yet</span>}
      </div>

      <div className="row">
        {jc ? (
          <>
            <button className="btn small" disabled={busy || status === 'connected'} onClick={() => readers.reconnect(card)}>RECONNECT</button>
            <button className="btn small dark" onClick={() => readers.unassign(card)}>REMOVE</button>
          </>
        ) : (
          <>
            <button className="btn small" disabled={busy || !webHidSupported()} onClick={() => readers.connectSwitch1(card)}>
              SWITCH 1 JOY-CON
            </button>
            <button className="btn small" disabled={busy || !webBluetoothSupported()} onClick={() => readers.connectSwitch2(card)}>
              SWITCH 2 JOY-CON
            </button>
          </>
        )}
      </div>
    </section>
  )
}

function Unassigned({ items, cards }) {
  if (!items.length) return null
  return (
    <section className="panel">
      <div className="label">JOY-CONS WITHOUT A GAME</div>
      {items.map(item => (
        <div key={item.key} className="unassigned">
          <span>Switch 1 Joy-Con · {item.address}</span>
          <div className="row">
            {cards.map(card => (
              <button key={card.station} className="btn small" onClick={() => readers.assignUnassigned(item, card)}>
                USE FOR {card.name.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

export default function App() {
  const r = useReaders()
  const secure = window.isSecureContext

  useEffect(() => { readers.start() }, [])

  return (
    <main className="page">
      <h1 className="title">JOY-CON READERS</h1>

      {!secure && (
        <section className="panel warning">
          <div className="label">CHROME NEEDS ONE SETTING FIRST</div>
          <p className="muted">
            Chrome only allows Joy-Cons on pages it treats as secure. On this computer, open
            {' '}<code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, add <code>{SITE}</code>,
            set it to Enabled, and relaunch Chrome.
          </p>
        </section>
      )}

      <div className="cards">
        {r.cards.map(card => <StationCard key={card.station} card={card} busy={r.busy} />)}
      </div>

      <Unassigned items={r.unassigned} cards={r.cards} />

      <details className="panel">
        <summary>Setup</summary>
        <ol>
          <li>Keep the Switch and Switch 2 off or out of range, or they'll grab the Joy-Cons back.</li>
          <li><b>Switch 1 Joy-Con:</b> pair each right Joy-Con in this computer's Bluetooth settings first (hold the sync button until the lights run, then pick "Joy-Con (R)"). Then click Switch 1 Joy-Con on a game's card and pick it.</li>
          <li><b>Switch 2 Joy-Con:</b> don't pair it in Bluetooth settings. Hold the sync button on its rail until the lights sweep, then click Switch 2 Joy-Con on a game's card.</li>
          <li>Each Joy-Con shows its game's player lights: one light for the first game, two for the second. This page remembers which Joy-Con is which and reconnects them by itself.</li>
          <li>To move a Joy-Con to another game, click Remove on its card, then Use For on the other game.</li>
        </ol>
        {!remembersJoyCon2() && (
          <p className="muted small">
            Switch 2 Joy-Cons are forgotten on reload unless chrome://flags/#enable-experimental-web-platform-features is on.
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
    </main>
  )
}
