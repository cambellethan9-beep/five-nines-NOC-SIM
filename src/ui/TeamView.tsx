import { useState } from 'react';
import type { Game } from '../game/game';
import { CERT_TOPICS, CERTS, CONFIDENT, INTERN_BAR, INTERN_PROMOTION_REWARD, INTERN_STREAK, INTERN_TERM_SHIFTS, skillOf, type Employee, type Focus } from '../game/team';
import { playerSkills, RADAR_WINDOW, TOPICS, type TopicScore } from '../game/topics';

function realTime(ms: number): string {
  const m = Math.ceil(ms / 60_000);
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function statusText(_game: Game, e: Employee): string {
  const s = e.status;
  if (s.kind === 'working') return `Working ${s.ticketId} with "${s.runbookTitle}"`;
  if (s.kind === 'investigating') return `Working ${s.ticketId} on their own`;
  if (s.kind === 'training') return `Training for ${s.cert}: ${realTime(s.remainingRealMs)} of real time left`;
  return e.focus === 'told' ? 'Idle: waiting for you (or a runbook match)' : 'Idle: looking for a ticket they can handle';
}

export function TeamView({ game, tick, onMessage }: { game: Game; tick: number; onMessage: (t: string) => void }) {
  void tick;
  const team = game.team;
  const blocked = team.internBlocked(game);
  const [sel, setSel] = useState<string | null>(null);
  const current = team.employees.find((e) => e.id === sel) ?? team.employees[0] ?? null;
  const shift = game.queue.shift;

  const mine = playerSkills(game.queue.tickets, game.chat.state.hinted ?? []);
  return (
    <div className="team-view">
      <section className="my-skills" aria-label="Your skill radar">
        <div>
          <h2>Your skills</h2>
          <p className="muted">
            Per topic, how you handled your last {RADAR_WINDOW} tickets in it: fixed it yourself quickly scores high; late fixes, false resolves, Owen's hints and
            handing it up cost. Tickets your team or a delegate fixed don't count.
          </p>
        </div>
        <SkillRadar scores={mine} />
      </section>
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
          No one yet. Employees follow your runbooks when one matches (write them in Docs: mark the lines to type with "This is a command", then turn on "Use this note as a
          runbook" and add triggers), and otherwise work tickets on their own by skill. They read your docs, so keep them current. Paid hires come with the budget.
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
        <dt>Focus</dt>
        <dd>
          <select value={e.focus ?? 'anything'} onChange={(ev) => (e.focus = ev.target.value as Focus)} aria-label={`What ${e.name} picks up on their own`}>
            <option value="anything">Anything they're confident about</option>
            <option value="p1">Only P1s</option>
            <option value="told">Only what you hand them</option>
            {TOPICS.map((t) => (
              <option key={t.id} value={t.id}>
                Only {t.name.toLowerCase()}
              </option>
            ))}
          </select>
        </dd>
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

      <h4>Skills</h4>
      <p className="muted">
        They pick up tickets on their own when they're at least {Math.round(CONFIDENT * 100)}% sure they can fix them. Every ticket they work teaches them its topics: +2% for one
        topic, +3% each for two, +4% each for three or more. Message them in Chat to hand them work.
      </p>
      <table className="skill-bars">
        <tbody>
          {TOPICS.map((t) => {
            const v = skillOf(e, t.id);
            return (
              <tr key={t.id}>
                <th scope="row">{t.name}</th>
                <td>
                  <span className="bar" aria-hidden="true">
                    <span style={{ width: `${v}%` }} />
                  </span>
                </td>
                <td className="num">{v}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>

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
      {cert && <p className="muted">{CERTS.find((c) => c.id === cert)?.about} Raises {Object.entries(CERT_TOPICS[cert] ?? {}).map(([t, v]) => `${TOPICS.find((x) => x.id === t)!.short} +${v}`).join(', ')}. Training runs in real time while the game is open; no tickets until it's done.</p>}

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

/** Your skill per topic as a radar: one series, value labels on each spoke, hover for the ticket count. */
function SkillRadar({ scores }: { scores: TopicScore[] }) {
  const size = 300;
  const c = size / 2;
  const r = 100;
  const n = scores.length;
  const at = (i: number, v: number) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + Math.cos(a) * r * (v / 100), c + Math.sin(a) * r * (v / 100)] as const;
  };
  const pts = scores.map((s, i) => at(i, s.score ?? 0));
  const tried = scores.filter((s) => s.score !== null).length;
  return (
    <figure className="radar">
      <svg viewBox={`-70 -24 ${size + 140} ${size + 48}`} role="img" aria-label={`Skill radar: ${scores.map((s) => `${TOPICS.find((t) => t.id === s.topic)!.short} ${s.score ?? 'no tickets'}`).join(', ')}`}>
        {[25, 50, 75, 100].map((ring) => (
          <polygon key={ring} className="radar-ring" points={scores.map((_, i) => at(i, ring).join(',')).join(' ')} />
        ))}
        {scores.map((_, i) => {
          const [x, y] = at(i, 100);
          return <line key={i} className="radar-spoke" x1={c} y1={c} x2={x} y2={y} />;
        })}
        {/* Only topics you've had tickets in are drawn: an untried topic isn't a zero. */}
        {tried > 0 && <polygon className="radar-area" points={pts.filter((_, i) => scores[i].score !== null).map((p) => p.join(',')).join(' ')} />}
        {scores.map((s, i) => {
          const [x, y] = pts[i];
          const [lx, ly] = at(i, 128);
          const t = TOPICS.find((t) => t.id === s.topic)!;
          return (
            <g key={s.topic}>
              {s.score !== null && <circle className="radar-dot" cx={x} cy={y} r={4} />}
              <circle className="radar-hit" cx={x} cy={y} r={12}>
                <title>{`${t.name}: ${s.score === null ? 'no tickets yet' : `${s.score} from your last ${s.tickets} ticket${s.tickets === 1 ? '' : 's'}`}`}</title>
              </circle>
              <text className="radar-label" x={lx} y={ly} textAnchor={Math.abs(lx - c) < 8 ? 'middle' : lx > c ? 'start' : 'end'} dominantBaseline="middle">
                {t.short} <tspan className="radar-val">{s.score ?? '–'}</tspan>
              </text>
            </g>
          );
        })}
      </svg>
      {tried === 0 && <figcaption className="muted">Close a few tickets yourself to fill this in.</figcaption>}
    </figure>
  );
}
