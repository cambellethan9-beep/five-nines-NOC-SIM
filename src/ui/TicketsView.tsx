import { useEffect, useState } from 'react';
import type { Game } from '../game/game';
import type { Ticket } from '../game/queue';
import { SLA, total, type Priority, type ScoreLine } from '../game/scoring';
import { formatIp } from '../sim/ip';

interface Props {
  game: Game;
  tick: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onMessage: (text: string) => void;
}

const STATUS_LABEL: Record<Ticket['status'], string> = {
  new: 'New',
  'in-progress': 'In progress',
  resolved: 'Resolved',
  escalated: 'Escalated',
  reopened: 'Reopened',
  'senior-resolved': 'Resolved by senior',
};

/** "12:04" for durations, "-3:10" when overdue. */
function countdown(ms: number): string {
  const neg = ms < 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const m = Math.floor(s / 60);
  const text = m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : `${m}:${String(s % 60).padStart(2, '0')}`;
  return neg ? `−${text}` : text;
}

function clockAt(game: Game, t: number): string {
  return game.net.formatLogTime(t).slice(-12, -4);
}

function sortTickets(game: Game, list: Ticket[]): Ticket[] {
  const open = list.filter((t) => game.queue.isOpen(t)).sort((a, b) => a.priority - b.priority || game.queue.dueIn(a) - game.queue.dueIn(b));
  const closed = list.filter((t) => !game.queue.isOpen(t)).sort((a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0));
  return [...open, ...closed];
}

export function TicketsView({ game, tick, selected, onSelect, onMessage }: Props) {
  void tick;
  const tickets = sortTickets(game, game.tickets());
  const current = tickets.find((t) => t.id === selected) ?? tickets[0] ?? null;
  const stats = game.shiftStats();

  return (
    <div className="tickets-view">
      <div className="shift-strip" aria-label="Shift status">
        <Metric label="Shift score" value={`${stats.points >= 0 ? '' : '−'}${Math.abs(stats.points)}`} tone={stats.points < 0 ? 'bad' : undefined} />
        <Metric label="Time left" value={countdown(game.shiftRemaining)} />
        <Metric
          label={`Tickets in SLA (target ${Math.round(stats.slaTarget * 100)}%)`}
          value={stats.ticketsDue ? `${stats.ticketsInSla}/${stats.ticketsDue}` : '-'}
          tone={stats.ticketsDue && stats.slaCompliance < stats.slaTarget ? 'bad' : undefined}
        />
        <Metric
          label={`Availability (target ${Math.round(stats.uptimeTarget * 100)}%)`}
          value={`${(stats.availability * 100).toFixed(1)}%`}
          tone={stats.availability < stats.uptimeTarget ? 'bad' : undefined}
        />
        <Metric
          label="Points per minute"
          value={game.pointsPerMinute > 0 ? `+${game.pointsPerMinute}` : game.pointsPerMinute < 0 ? `−${-game.pointsPerMinute}` : '0'}
          note={
            game.drainPerMinute
              ? `${game.health.affectedUsers} ${game.health.affectedUsers === 1 ? 'user' : 'users'} affected`
              : game.healthy
                ? 'network healthy'
                : 'paused while an incident is open'
          }
          tone={game.pointsPerMinute < 0 ? 'bad' : game.pointsPerMinute > 0 ? 'good' : undefined}
        />
      </div>

      <div className="tickets-body">
        <nav className="queue" aria-label="Ticket queue">
          <h2 className="side-title">Queue · {game.queue.openTickets().length} open</h2>
          <ul>
            {tickets.map((t) => {
              const open = game.queue.isOpen(t);
              const due = game.queue.dueIn(t);
              return (
                <li key={t.id}>
                  <button className={`q-item ${current?.id === t.id ? 'active' : ''} ${open ? '' : 'closed'}`} onClick={() => onSelect(t.id)}>
                    <span className={`prio prio-${t.priority}`}>P{t.priority}</span>
                    <span className="q-main">
                      <span className="q-subject">{t.draft.subject}</span>
                      <span className="q-meta">
                        {t.id} · {t.draft.reporter.name}
                      </span>
                    </span>
                    <span className="q-side">
                      {open ? (
                        <span className={`q-due ${t.breached || due < 0 ? 'late' : due < 5 * 60_000 ? 'soon' : ''}`}>{t.breached ? 'breached' : countdown(due)}</span>
                      ) : (
                        <span className="q-done">{t.status === 'resolved' ? `+${Math.max(0, total(t.score))}` : '0'}</span>
                      )}
                      <span className={`st st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {current ? <TicketDetail key={current.id} game={game} ticket={current} onMessage={onMessage} /> : <p className="empty">No tickets yet.</p>}
      </div>
    </div>
  );
}

function Metric({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`metric ${tone ?? ''}`}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
      {note && <span className="metric-note">{note}</span>}
    </div>
  );
}

function TicketDetail({ game, ticket: t, onMessage }: { game: Game; ticket: Ticket; onMessage: (text: string) => void }) {
  const [note, setNote] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string; lines: ScoreLine[] } | null>(null);
  const q = game.queue;
  const open = q.isOpen(t);
  const pc = game.ticketDevice(t);
  const pcIp = Object.values(pc.running.interfaces)[0]?.ip?.address;
  const shownSla = SLA[t.priority];
  const respondDue = t.openedAt + shownSla.respondMs - game.net.time;

  useEffect(() => setResult(null), [t.id]);

  const resolve = () => {
    const r = q.resolve(t.id, note);
    setResult(r);
    setNote('');
    onMessage(r.message);
  };

  return (
    <article className="ticket-detail" aria-label={`${t.id} details`}>
      <header className="td-head">
        <p className="td-kicker">
          {t.id} · {t.draft.kind === 'request' ? 'Change request' : 'Incident'} · <span className={`st st-${t.status}`}>{STATUS_LABEL[t.status]}</span>
          {t.breached && <span className="st st-breached">SLA breached</span>}
          {t.proactive && <span className="st st-resolved">Caught early</span>}
        </p>
        <h2>{t.draft.subject}</h2>
      </header>

      <div className="td-grid">
        <section className="td-card">
          <h3>Reported by</h3>
          <p className="td-person">{t.draft.reporter.name}</p>
          <p className="td-sub">
            {t.draft.reporter.title} · desk {t.draft.reporter.desk}
          </p>
          <p className="td-sub mono">
            {pc.running.hostname}
            {pcIp !== undefined ? ` · ${formatIp(pcIp)}` : ''}
          </p>
        </section>
        <section className="td-card">
          <h3>Priority and SLA</h3>
          <label className="td-prio">
            <span>Priority</span>
            <select
              id={`prio-${t.id}`}
              value={t.priority}
              disabled={!open}
              onChange={(e) => {
                q.setPriority(t.id, Number(e.target.value) as Priority);
                setResult(null);
              }}
            >
              {([1, 2, 3, 4] as Priority[]).map((p) => (
                <option key={p} value={p}>
                  P{p} {SLA[p].name}
                </option>
              ))}
            </select>
          </label>
          <dl className="td-sla">
            <dt>Opened</dt>
            <dd className="mono">{clockAt(game, t.openedAt)}</dd>
            <dt>Response</dt>
            <dd className="mono">{t.respondedAt !== null ? `done ${clockAt(game, t.respondedAt)}` : !open ? '-' : respondDue < 0 ? 'missed' : `due in ${countdown(respondDue)}`}</dd>
            <dt>Resolve</dt>
            <dd className="mono">{t.resolvedAt !== null ? `done ${clockAt(game, t.resolvedAt)}` : q.dueIn(t) < 0 ? `overdue by ${countdown(-q.dueIn(t))}` : `due in ${countdown(q.dueIn(t))}`}</dd>
          </dl>
          <p className="td-fine">Deadlines follow the priority on the ticket, but the SLA is judged on the issue's real business impact.</p>
        </section>
      </div>

      <section className="td-activity" aria-label="Activity">
        <h3>Activity</h3>
        <ol>
          {t.activity.map((a, i) => (
            <li key={i} className={`act act-${a.who}`}>
              <span className="act-who">{a.who === 'you' ? 'You' : a.who === 'user' ? t.draft.reporter.name.split(' ')[0] : a.who === 'senior' ? 'Senior tech' : 'System'}</span>
              <span className="act-time mono">{clockAt(game, a.t)}</span>
              <p className="act-text">{a.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {open && (
        <section className="td-actions">
          <label htmlFor={`note-${t.id}`} className="td-label">
            Work note or resolution
          </label>
          <textarea id={`note-${t.id}`} value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What did you find? What did you change?" />
          <div className="td-buttons">
            {t.respondedAt === null && (
              <button className="secondary" onClick={() => q.acknowledge(t.id)}>
                Acknowledge
              </button>
            )}
            <button
              className="secondary"
              disabled={!note.trim()}
              onClick={() => {
                q.addNote(t.id, note);
                setNote('');
              }}
            >
              Add note
            </button>
            <button className="primary" onClick={resolve}>
              Resolve
            </button>
          </div>
          <p className="td-fine">Resolve checks that the problem is really gone. Closing a ticket that isn't fixed counts against you.</p>
        </section>
      )}

      {(result || t.score.length > 0) && (
        <section className="td-score" aria-label="Points">
          <h3>Points</h3>
          {result && <p className={result.ok ? 'ok-text' : 'bad-text'}>{result.message}</p>}
          {t.score.length > 0 && (
            <table className="score-table">
              <tbody>
                {t.score.map((l, i) => (
                  <tr key={i}>
                    <td>{l.label}</td>
                    <td className={`num ${l.points < 0 ? 'bad-text' : ''}`}>{l.points > 0 ? `+${l.points}` : l.points}</td>
                  </tr>
                ))}
                <tr className="score-total">
                  <td>Total</td>
                  <td className="num">{total(t.score)}</td>
                </tr>
              </tbody>
            </table>
          )}
        </section>
      )}
    </article>
  );
}
