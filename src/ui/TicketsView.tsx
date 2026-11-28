import { useEffect, useState } from 'react';
import type { Game } from '../game/game';
import type { Ticket } from '../game/queue';
import { SLA, total, type Priority, type ScoreLine } from '../game/scoring';
import { formatIp } from '../sim/ip';
import { coworker, creditFor, DELEGATE_FROM_RANK, isDelegation, wastesManagersTime } from '../game/coworkers';
import { BASE_POINTS } from '../game/scoring';
import { STATUS_TEXT } from '../game/incidents';
import { DeclareDialog, IncidentDetail, type DeclareDraft } from './Incidents';

interface Props {
  game: Game;
  tick: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onMessage: (text: string) => void;
  /** Open the "declare incident" form (from a log line or the Monitor, with a source). */
  declareDraft: DeclareDraft | null;
  onDeclare: (draft: DeclareDraft | null) => void;
}

type StatusFilter = 'open' | 'all' | 'closed';
type KindFilter = 'all' | 'incident' | 'request' | 'noc';

/** Does a ticket match the search text? Looks at the ID, subject, reporter, description, device and activity. */
function matches(game: Game, t: Ticket, q: string): boolean {
  if (!q) return true;
  const hay = [t.id, t.draft.subject, t.draft.reporter.name, t.draft.reporter.pcId, t.draft.description, game.incidents.parentOf(t.id)?.id ?? '', ...t.activity.map((a) => a.text)]
    .join('\n')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

const STATUS_LABEL: Record<Ticket['status'], string> = {
  new: 'New',
  'in-progress': 'In progress',
  resolved: 'Resolved',
  escalated: 'Escalated',
  reopened: 'Reopened',
  'senior-resolved': 'Resolved by a coworker',
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

export function TicketsView({ game, tick, selected, onSelect, onMessage, declareDraft, onDeclare }: Props) {
  void tick;
  const [query, setQuery] = useState('');
  const [statusF, setStatusF] = useState<StatusFilter>('all');
  const [prioF, setPrioF] = useState<0 | Priority>(0);
  const [kindF, setKindF] = useState<KindFilter>('all');
  const all = sortTickets(game, game.tickets());
  const filtering = query.trim() !== '' || statusF !== 'all' || prioF !== 0 || kindF !== 'all';
  const tickets = kindF === 'noc' ? [] : all.filter((t) => {
    const open = game.queue.isOpen(t);
    if (statusF === 'open' && !open) return false;
    if (statusF === 'closed' && open) return false;
    if (prioF && t.priority !== prioF) return false;
    if (kindF !== 'all' && t.draft.kind !== kindF) return false;
    return matches(game, t, query.trim());
  });
  const incidents = kindF === 'all' || kindF === 'noc' ? game.incidents.list.filter((i) => {
    if (statusF === 'open' && i.status === 'resolved') return false;
    if (statusF === 'closed' && i.status !== 'resolved') return false;
    if (prioF && i.severity !== prioF) return false;
    const q = query.trim().toLowerCase();
    return !q || q.split(/\s+/).every((w) => [i.id, i.title, i.source ?? '', ...i.timeline.map((e) => e.text), ...i.linked].join('\n').toLowerCase().includes(w));
  }) : [];
  const currentIncident = selected?.startsWith('MI-') ? game.incidents.find(selected) : undefined;
  const current = currentIncident ? null : (tickets.find((t) => t.id === selected) ?? all.find((t) => t.id === selected) ?? tickets[0] ?? null);
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
          <div className="queue-head">
            <h2 className="side-title">Queue · {game.queue.openTickets().length} open</h2>
            <button className="secondary small" onClick={() => onDeclare({})} title="Declare an incident the NOC spotted itself">
              Declare incident
            </button>
          </div>
          <div className="ticket-search">
            <input id="ticket-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search tickets (press /)" aria-label="Search tickets" />
            <div className="ticket-filters">
              <select value={statusF} onChange={(e) => setStatusF(e.target.value as StatusFilter)} aria-label="Status filter">
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
              <select value={prioF} onChange={(e) => setPrioF(Number(e.target.value) as 0 | Priority)} aria-label="Priority filter">
                <option value={0}>Any priority</option>
                {[1, 2, 3, 4].map((p) => (
                  <option key={p} value={p}>
                    P{p}
                  </option>
                ))}
              </select>
              <select value={kindF} onChange={(e) => setKindF(e.target.value as KindFilter)} aria-label="Type filter">
                <option value="all">Everything</option>
                <option value="incident">Incidents</option>
                <option value="request">Changes</option>
                <option value="noc">NOC incidents</option>
              </select>
            </div>
            {filtering && (
              <p className="search-count">
                {tickets.length + incidents.length} match{tickets.length + incidents.length === 1 ? '' : 'es'}{' '}
                <button
                  className="link-btn"
                  onClick={() => {
                    setQuery('');
                    setStatusF('all');
                    setPrioF(0);
                    setKindF('all');
                  }}
                >
                  clear
                </button>
              </p>
            )}
          </div>
          {incidents.length > 0 && (
            <ul className="noc-incidents" aria-label="NOC incidents">
              {incidents.map((i) => (
                <li key={i.id}>
                  <button className={`q-item noc ${currentIncident?.id === i.id ? 'active' : ''} ${i.status === 'resolved' ? 'closed' : ''}`} onClick={() => onSelect(i.id)}>
                    <span className={`prio prio-${i.severity}`}>P{i.severity}</span>
                    <span className="q-main">
                      <span className="q-subject">{i.title}</span>
                      <span className="q-meta">
                        {i.id} · NOC · {i.linked.length} linked
                      </span>
                    </span>
                    <span className="q-side">
                      <span className={`st st-${i.status === 'resolved' ? 'resolved' : 'in-progress'}`}>{STATUS_TEXT[i.status]}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
                      {t.status === 'resolved' && t.notifiedAt === null && <span className="st st-notify">tell user</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        {currentIncident ? (
          <IncidentDetail key={currentIncident.id} game={game} inc={currentIncident} onSelect={onSelect} onMessage={onMessage} />
        ) : current ? (
          <TicketDetail key={current.id} game={game} ticket={current} onMessage={onMessage} onSelect={onSelect} />
        ) : (
          <p className="empty">{filtering ? 'Nothing matches.' : 'No tickets yet.'}</p>
        )}
      </div>
      {declareDraft && (
        <DeclareDialog
          game={game}
          draft={declareDraft}
          onDone={(id) => {
            onDeclare(null);
            if (id) {
              onSelect(id);
              onMessage(`${id} declared. Reports about it will be linked as they come in.`);
            }
          }}
        />
      )}
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

function TicketDetail({ game, ticket: t, onMessage, onSelect }: { game: Game; ticket: Ticket; onMessage: (text: string) => void; onSelect: (id: string) => void }) {
  const parent = game.incidents.parentOf(t.id);
  const openIncidents = game.incidents.open();
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
        {parent ? (
          <p className="td-parent">
            Part of{' '}
            <button className="link-btn" onClick={() => onSelect(parent.id)}>
              {parent.id}
            </button>{' '}
            · {parent.title}
          </p>
        ) : (
          q.isOpen(t) &&
          openIncidents.length > 0 && (
            <p className="td-parent">
              <select
                value=""
                onChange={(e) => {
                  if (!e.target.value) return;
                  game.linkTicket(e.target.value, t.id);
                  onMessage(`${t.id} linked to ${e.target.value}.`);
                }}
                aria-label="Link to an incident"
              >
                <option value="">Link to a NOC incident...</option>
                {openIncidents.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.id}: {i.title}
                  </option>
                ))}
              </select>
            </p>
          )
        )}
      </header>

      {t.status === 'resolved' && t.notifiedAt === null && (
        <section className="notify-box" aria-label="Tell the user">
          <p>
            <strong>{t.draft.reporter.name} doesn't know it's fixed yet.</strong> Until someone tells them, they're still sitting there not working (it costs the same as
            being down).
          </p>
          <div className="row-form">
            <button
              className="primary"
              onClick={() => {
                const err = game.notifyUser(t.id, 'direct');
                onMessage(err ?? `Told ${t.draft.reporter.name} it's working again.`);
              }}
            >
              Notify user: working again
            </button>
            <button
              className="secondary"
              onClick={() => {
                const err = game.notifyUser(t.id, 'everyone');
                onMessage(err ?? 'Announced to everyone that it is working again.');
              }}
              title="For problems that hit more than one person"
            >
              Announce to everyone
            </button>
          </div>
        </section>
      )}

      <TeamPanel game={game} ticket={t} onMessage={onMessage} />

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
              <span className="act-who">{a.who === 'you' ? 'You' : a.who === 'user' ? t.draft.reporter.name.split(' ')[0] : a.who === 'senior' ? (a.name ?? 'Senior tech') : 'System'}</span>
              <span className="act-time mono">{clockAt(game, a.t)}</span>
              <p className="act-text">{a.text}</p>
            </li>
          ))}
        </ol>
      </section>

      {open && <EscalatePanel game={game} ticket={t} onMessage={onMessage} />}

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

function EscalatePanel({ game, ticket: t, onMessage }: { game: Game; ticket: Ticket; onMessage: (text: string) => void }) {
  const q = game.queue;
  const targets = q.escalationTargets();
  if (t.escalation) {
    const c = coworker(t.escalation.to);
    return (
      <section className="td-escalate" aria-label="Escalation">
        <h3>{t.escalation.delegated ? 'Assigned' : 'Escalated'}</h3>
        <p className="td-fine">
          {c.name} ({c.title}) is working on it. You can still fix it yourself first.
        </p>
      </section>
    );
  }
  if (t.seniorAt !== null) return null;
  return (
    <section className="td-escalate" aria-label="Escalate">
      <h3>{q.rankIndex >= DELEGATE_FROM_RANK ? 'Escalate or assign' : 'Escalate'}</h3>
      {targets.length === 0 ? (
        <p className="td-fine">Nobody above you to escalate to. This one's yours.</p>
      ) : (
        <div className="esc-list">
          {targets.map((c) => {
            const blocked = q.escalationBlocked(t, c.id);
            const share = creditFor(c, q.rankIndex);
            const down = isDelegation(c, q.rankIndex);
            const credit = Math.round(BASE_POINTS[t.difficulty] * share);
            const routine = wastesManagersTime(c, t.difficulty, t.truePriority);
            return (
              <div key={c.id} className="esc-row">
                <div className="esc-who">
                  <strong>{c.name}</strong>
                  <span className="td-fine">
                    {c.title} · {c.tenure}
                  </span>
                  <span className="td-fine">{c.blurb}</span>
                </div>
                <div className="esc-side">
                  <span className="td-fine">
                    ~{Math.round(c.minMs / 60000)}-{Math.round(c.maxMs / 60000)} min · you keep {Math.round(share * 100)}% (~{credit} pts)
                  </span>
                  <button
                    className="secondary small"
                    disabled={!!blocked}
                    title={blocked ?? (routine ? 'She will not love getting a routine ticket.' : '')}
                    onClick={() => onMessage(q.escalate(t.id, c.id))}
                  >
                    {blocked && blocked.includes('busy') ? 'Busy' : `${down ? 'Assign' : 'Escalate'} to ${c.name.split(' ')[0]}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <p className="td-fine">The SLA clock keeps running while they work. They might hand it back if it's beyond them.</p>
    </section>
  );
}

/** Who on your team is on this ticket, assigning it by hand, and the log of what they typed. */
function TeamPanel({ game, ticket: t, onMessage }: { game: Game; ticket: Ticket; onMessage: (text: string) => void }) {
  const [who, setWho] = useState('');
  const [book, setBook] = useState('');
  const team = game.team;
  const open = game.queue.isOpen(t);
  const idle = team.employees.filter((e) => e.status.kind === 'idle');
  const emp = team.employees.find((e) => e.id === who) ?? idle[0];
  const books = emp ? team.runbooksFor(emp, game).filter((r) => r.runbook?.enabled) : [];
  if (!t.assignedTo && !t.runLog && !(open && idle.length && !t.escalation)) return null;
  return (
    <section className="team-panel" aria-label="Your team on this ticket">
      {t.assignedTo && (
        <p>
          <strong>{t.assignedTo}</strong> is working this {t.runbook ? <>with the runbook "{t.runbook}"</> : 'on their own'}.
        </p>
      )}
      {!t.assignedTo && open && idle.length > 0 && !t.escalation && emp && (
        <div className="row-form">
          <span>Assign to</span>
          <select value={emp.id} onChange={(e) => setWho(e.target.value)} aria-label="Employee">
            {idle.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          <span>with</span>
          <select value={book} onChange={(e) => setBook(e.target.value)} aria-label="Runbook">
            <option value="">no runbook (on their own)</option>
            {books.map((r) => (
              <option key={r.id} value={r.id}>
                {r.title}
              </option>
            ))}
          </select>
          <button
            className="secondary small"
            onClick={() => {
              const rb = books.find((r) => r.id === book);
              const err = rb ? team.assign(game, emp, t.id, rb) : team.takeOwn(game, emp, t.id);
              onMessage(err ?? `${emp.name} is on ${t.id}${rb ? ` with "${rb.title}"` : ' on their own'}.`);
            }}
          >
            Assign
          </button>
        </div>
      )}
      {t.runLog && (
        <details className="run-log">
          <summary>
            What {t.employee ?? 'they'} typed ({t.runLog.length} lines{t.runLog.some((l) => l.meant !== undefined) ? ', with typos' : ''})
          </summary>
          <pre className="doc-code">
            {t.runLog
              .map((l) => `> ${l.typed}${l.meant !== undefined ? `      [meant: ${l.meant}]` : ''}${l.output.length ? '\n' + l.output.join('\n') : ''}`)
              .join('\n')}
          </pre>
        </details>
      )}
    </section>
  );
}
