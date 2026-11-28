import { useState } from 'react';
import type { Game } from '../game/game';
import { CERTS, INTERN_BAR, INTERN_PROMOTION_REWARD, INTERN_STREAK, INTERN_TERM_SHIFTS, type Employee } from '../game/team';

function realTime(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function statusText(game: Game, e: Employee): string {
  const s = e.status;
  if (s.kind === 'working') return `Working ${s.ticketId} with "${s.runbookTitle}"`;
  if (s.kind === 'training') return `Training for ${s.cert}: ${realTime(s.remainingRealMs)} of real time left`;
  return game.notes.some((n) => n.runbook?.enabled) || e.ownRunbooks.length ? 'Idle: waiting for a ticket a runbook matches' : 'Idle: no runbooks to follow';
}

export function TeamView({ game, tick, onMessage }: { game: Game; tick: number; onMessage: (t: string) => void }) {
  void tick;
  const team = game.team;
  const blocked = team.internBlocked(game);
  const [sel, setSel] = useState<string | null>(null);
  const current = team.employees.find((e) => e.id === sel) ?? team.employees[0] ?? null;
  const shift = game.queue.shift;

  return (
    <div className="team-view">
      <header className="team-head">
        <h2>Your team</h2>
        {!team.intern() && (
          <button
            className="primary small"
            disabled={!!blocked}
            title={blocked ?? ''}
            onClick={() => {
              const e = team.takeIntern(game, game.net.rng);
              if (e) setSel(e.id);
            }}
          >
            Take on an intern
          </button>
        )}
        {blocked && !team.intern() && <span className="muted">{blocked}</span>}
      </header>

      {!team.employees.length ? (
        <p className="empty">
          No one yet. Interns follow your runbooks: write them in Docs (mark the lines to type with "This is a command", then turn on "Use this note as a runbook" and add triggers). Paid hires
          come with the budget.
        </p>
      ) : (
        <div className="team-body">
          <table className="roster">
            <thead>
              <tr>
                <th>Name</th>
                <th>Title</th>
                <th>Status</th>
                <th className="num">This shift</th>
                <th className="num">Lifetime</th>
                <th className="num">Resolved</th>
                <th className="num">Handed back</th>
                <th className="num">Morale</th>
              </tr>
            </thead>
            <tbody>
              {team.employees.map((e) => (
                <tr key={e.id} className={current?.id === e.id ? 'active' : ''} onClick={() => setSel(e.id)}>
                  <td>
                    <button className="link-btn">{e.name}</button>
                  </td>
                  <td>{e.title}</td>
                  <td>{statusText(game, e)}</td>
                  <td className="num">{team.shiftScore(e, shift)}</td>
                  <td className="num">{e.lifetimePoints}</td>
                  <td className="num">{e.resolved}</td>
                  <td className="num">{e.handedBack}</td>
                  <td className="num">{e.morale}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {current && <EmployeeCard key={current.id} game={game} e={current} onMessage={onMessage} />}
        </div>
      )}

      {team.state.history.length > 0 && (
        <section className="team-history">
          <h3>Recent</h3>
          <ul>
            {[...team.state.history]
              .reverse()
              .slice(0, 12)
              .map((h, i) => (
                <li key={i}>
                  <span className="mono muted">{game.net.formatLogTime(h.t).slice(-12, -4)}</span> {h.text}
                </li>
              ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function EmployeeCard({ game, e, onMessage }: { game: Game; e: Employee; onMessage: (t: string) => void }) {
  const team = game.team;
  const [cert, setCert] = useState('');
  const [confirmFire, setConfirmFire] = useState(false);
  const shift = game.queue.shift;
  const recent = Array.from({ length: 5 }, (_, i) => shift - 4 + i).filter((n) => n >= 1);
  const books = team.runbooksFor(e, game);
  const act = (r: string | null, ok: string) => onMessage(r ?? ok);

  return (
    <section className="employee-card">
      <h3>
        {e.name} <span className="muted">· {e.title}</span>
      </h3>
      <dl className="emp-stats">
        <dt>Typo rate</dt>
        <dd>{(e.typoRate * 100).toFixed(1)}% a command</dd>
        <dt>Speed</dt>
        <dd>about {Math.round(e.minutesPerCommand * 60)} s a command, plus 2 min reading</dd>
        <dt>Catches errors</dt>
        <dd>{e.noticesErrors ? 'Yes, retypes a rejected command' : "No, doesn't notice error messages"}</dd>
        <dt>Certificates</dt>
        <dd>{e.certs.length ? e.certs.join(', ') : 'None'}</dd>
        <dt>Last shifts</dt>
        <dd>{recent.map((n) => `#${n}: ${team.shiftScore(e, n)}`).join(' · ')}</dd>
      </dl>

      {e.role === 'intern' && (
        <p className="intern-progress">
          Promotion: {INTERN_BAR}+ points in {INTERN_STREAK} shifts in a row ({e.qualifying}/{INTERN_STREAK} so far) makes them Tier 1 NOC and pays you {INTERN_PROMOTION_REWARD}. Internship shift{' '}
          {shift - e.startShift + 1} of {INTERN_TERM_SHIFTS}.
        </p>
      )}

      <h4>Runbooks they follow</h4>
      {books.length ? (
        <ul className="emp-books">
          {e.ownRunbooks.map((r) => (
            <li key={r.id}>
              <details>
                <summary>
                  {r.title} <span className="muted">(their own; leaves with them)</span>
                </summary>
                <pre className="doc-code">{r.body}</pre>
              </details>
            </li>
          ))}
          {books
            .filter((r) => !e.ownRunbooks.includes(r))
            .map((r) => (
              <li key={r.id}>
                {r.title} <span className="muted">(yours{r.runbook?.enabled ? '' : ', disabled'})</span>
              </li>
            ))}
        </ul>
      ) : (
        <p className="muted">None. Turn a note into a runbook in Docs.</p>
      )}

      <h4>Training</h4>
      <div className="row-form">
        <select value={cert} onChange={(ev) => setCert(ev.target.value)} aria-label="Certificate to train for">
          <option value="">Choose a certificate...</option>
          {CERTS.map((c) => (
            <option key={c.id} value={c.id} disabled={e.certs.includes(c.id)}>
              {c.id} · {c.name} ({c.level}, {realTime(c.realMs)}){c.requires ? `, needs ${c.requires}` : ''}
            </option>
          ))}
        </select>
        <button className="secondary small" disabled={!cert} onClick={() => act(team.train(e.id, cert, game.net.time), `${e.name} started training for ${cert}.`)}>
          Start training
        </button>
      </div>
      {cert && <p className="muted">{CERTS.find((c) => c.id === cert)?.about} Training runs in real time while the game is open; no tickets until it's done.</p>}

      <h4>Manage</h4>
      <div className="row-form">
        {e.role === 'tech' && (
          <>
            <button className="secondary small" onClick={() => act(team.promote(e.id, game.net.time), `${e.name} promoted.`)}>
              Promote
            </button>
            <button className="secondary small" onClick={() => act(team.demote(e.id, game.net.time), `${e.name} demoted.`)}>
              Demote
            </button>
          </>
        )}
        <button className="secondary small" disabled title="Raises come with the budget">
          Give a raise
        </button>
        {confirmFire ? (
          <>
            <span className="bad-text">Let {e.name} go?</span>
            <button className="primary danger small" onClick={() => team.fire(e.id, game.net.time)}>
              Yes
            </button>
            <button className="secondary small" onClick={() => setConfirmFire(false)}>
              No
            </button>
          </>
        ) : (
          <button className="secondary small" onClick={() => setConfirmFire(true)}>
            {e.role === 'intern' ? 'End the internship' : 'Fire'}
          </button>
        )}
      </div>
    </section>
  );
}
