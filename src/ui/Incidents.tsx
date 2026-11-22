import { useState } from 'react';
import type { Game } from '../game/game';
import { STATUS_TEXT, type DeclaredIncident, type IncidentStatus } from '../game/incidents';
import type { Priority } from '../game/scoring';

function clockAt(game: Game, t: number): string {
  return game.net.formatLogTime(t).slice(-12, -4);
}

export interface DeclareDraft {
  title?: string;
  source?: string;
}

export function DeclareDialog({ game, draft, onDone }: { game: Game; draft: DeclareDraft; onDone: (id: string | null) => void }) {
  const [title, setTitle] = useState(draft.title ?? '');
  const [severity, setSeverity] = useState<Priority>(2);
  const [first, setFirst] = useState('');
  const declare = () => {
    const inc = game.declareIncident(title, severity, draft.source);
    if (first.trim()) game.incidents.update(inc.id, game.net.time, first);
    onDone(inc.id);
  };
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="declare-title">
        <h2 id="declare-title">Declare an incident</h2>
        <p className="modal-sub">For something the NOC spotted itself. User tickets about it get linked here as they come in, and count as already acknowledged.</p>
        {draft.source && <p className="declare-source mono">{draft.source}</p>}
        <label className="field">
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. CR-ACC2 uplink flapping, 2nd floor degraded" autoFocus />
        </label>
        <label className="field">
          Severity
          <select value={severity} onChange={(e) => setSeverity(Number(e.target.value) as Priority)}>
            <option value={1}>P1 Critical: many users, business stopped</option>
            <option value={2}>P2 High: a floor or a key service</option>
            <option value={3}>P3 Medium: a few users, workaround exists</option>
            <option value={4}>P4 Low: no user impact yet</option>
          </select>
        </label>
        <label className="field">
          First update (optional)
          <textarea rows={3} value={first} onChange={(e) => setFirst(e.target.value)} placeholder="What you see so far" />
        </label>
        <div className="td-buttons">
          <button className="secondary" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button className="primary" onClick={declare} disabled={!title.trim()}>
            Declare
          </button>
        </div>
      </div>
    </div>
  );
}

export function IncidentDetail({ game, inc, onSelect, onMessage }: { game: Game; inc: DeclaredIncident; onSelect: (id: string) => void; onMessage: (t: string) => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<IncidentStatus>(inc.status === 'resolved' ? 'monitoring' : inc.status);
  const [linkPick, setLinkPick] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState({ cause: '', fix: '', prevention: '' });
  const [closeLinked, setCloseLinked] = useState(true);
  const [toNotebook, setToNotebook] = useState(true);
  const [results, setResults] = useState<{ ticket: string; ok: boolean; message: string }[] | null>(null);
  const open = inc.status !== 'resolved';
  const linkable = game.queue.openTickets().filter((t) => !inc.linked.includes(t.id));

  return (
    <section className="ticket-detail incident-detail" aria-label={`Incident ${inc.id}`}>
      <header className="td-head">
        <div className="td-ids">
          <span className={`prio prio-${inc.severity}`}>P{inc.severity}</span>
          <span className="mono">{inc.id}</span>
          <span className="muted">· NOC incident</span>
          <span className={`st st-${open ? 'in-progress' : 'resolved'}`}>{STATUS_TEXT[inc.status]}</span>
        </div>
        <h2>{inc.title}</h2>
        <p className="muted">
          Declared {clockAt(game, inc.declaredAt)}
          {inc.resolvedAt !== null && <> · resolved {clockAt(game, inc.resolvedAt)}</>}
        </p>
      </header>

      <h3 className="td-sub">Linked tickets</h3>
      {inc.linked.length ? (
        <ul className="linked-list">
          {inc.linked.map((id) => {
            const t = game.queue.tickets.find((x) => x.id === id);
            return (
              <li key={id}>
                <button className="link-btn" onClick={() => onSelect(id)}>
                  {id}
                </button>{' '}
                {t?.draft.subject} <span className="muted">({t && game.queue.isOpen(t) ? 'open' : 'closed'})</span>
                {open && (
                  <button className="ghost small-ghost" onClick={() => game.incidents.unlink(inc.id, id, game.net.time)}>
                    Unlink
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">None yet. Reports that come in after you declared are linked automatically.</p>
      )}
      {open && linkable.length > 0 && (
        <div className="row-form">
          <select value={linkPick} onChange={(e) => setLinkPick(e.target.value)} aria-label="Ticket to link">
            <option value="">Link an open ticket...</option>
            {linkable.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id}: {t.draft.subject}
              </option>
            ))}
          </select>
          <button
            className="secondary small"
            disabled={!linkPick}
            onClick={() => {
              game.linkTicket(inc.id, linkPick);
              setLinkPick('');
            }}
          >
            Link
          </button>
        </div>
      )}

      <h3 className="td-sub">Timeline</h3>
      <ol className="activity">
        {inc.timeline.map((e, i) => (
          <li key={i} className={`act act-${e.who === 'you' ? 'you' : 'system'}`}>
            <span className="act-who">{e.who === 'you' ? 'You' : 'System'}</span>
            <span className="act-time">{clockAt(game, e.t)}</span>
            <p>{e.text}</p>
          </li>
        ))}
      </ol>

      {open && !reviewing && (
        <div className="td-actions">
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="Post an update" aria-label="Incident update" />
          <div className="row-form">
            <select value={status} onChange={(e) => setStatus(e.target.value as IncidentStatus)} aria-label="Status">
              {(['investigating', 'identified', 'monitoring'] as IncidentStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_TEXT[s]}
                </option>
              ))}
            </select>
            <button
              className="secondary"
              onClick={() => {
                game.incidents.update(inc.id, game.net.time, text, status);
                setText('');
              }}
            >
              Post update
            </button>
            <button className="primary" onClick={() => setReviewing(true)}>
              Resolve...
            </button>
          </div>
        </div>
      )}

      {open && reviewing && (
        <div className="td-actions review-form">
          <h3 className="td-sub">Post-incident review</h3>
          <label className="field">
            Root cause
            <textarea rows={2} value={review.cause} onChange={(e) => setReview({ ...review, cause: e.target.value })} />
          </label>
          <label className="field">
            Fix
            <textarea rows={2} value={review.fix} onChange={(e) => setReview({ ...review, fix: e.target.value })} />
          </label>
          <label className="field">
            How to stop it happening again
            <textarea rows={2} value={review.prevention} onChange={(e) => setReview({ ...review, prevention: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={closeLinked} onChange={(e) => setCloseLinked(e.target.checked)} /> Resolve the open linked tickets too
          </label>
          <label className="check">
            <input type="checkbox" checked={toNotebook} onChange={(e) => setToNotebook(e.target.checked)} /> Save the review to my notebook
          </label>
          <div className="row-form">
            <button className="secondary" onClick={() => setReviewing(false)}>
              Back
            </button>
            <button
              className="primary"
              disabled={!review.cause.trim() || !review.fix.trim()}
              onClick={() => {
                const r = game.resolveIncident(inc.id, review, { closeLinked, toNotebook });
                setResults(r);
                const bad = r.filter((x) => !x.ok).length;
                onMessage(`${inc.id} resolved${r.length ? `: ${r.length - bad}/${r.length} linked tickets closed` : ''}.`);
              }}
            >
              Resolve incident
            </button>
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <ul className="linked-list">
          {results.map((r) => (
            <li key={r.ticket} className={r.ok ? 'good-text' : 'bad-text'}>
              {r.ticket}: {r.message}
            </li>
          ))}
        </ul>
      )}

      {inc.review && (
        <>
          <h3 className="td-sub">Review</h3>
          <dl className="review">
            <dt>Root cause</dt>
            <dd>{inc.review.cause}</dd>
            <dt>Fix</dt>
            <dd>{inc.review.fix}</dd>
            <dt>Prevention</dt>
            <dd>{inc.review.prevention || '-'}</dd>
          </dl>
        </>
      )}
    </section>
  );
}
