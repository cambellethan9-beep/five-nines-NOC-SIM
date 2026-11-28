import { useState, type RefObject } from 'react';
import { textToBlocks } from '../content/doctext';
import type { Game, Note } from '../game/game';
import { commandsOf, dryRun, isCommandLine, parseTriggers, PLACEHOLDERS, toggleCommands, triggerMatches, COMMAND_MARK } from '../game/runbooks';
import { INTERN_FROM_RANK } from '../game/team';
import { RANKS } from '../game/scoring';
import type { Block } from '../content/docs';

/** Buttons above the note editor: mark the selected lines as commands, insert a placeholder. */
export function CommandToolbar({ area, body, setBody }: { area: RefObject<HTMLTextAreaElement>; body: string; setBody: (b: string) => void }) {
  const insert = (text: string) => {
    const ta = area.current;
    if (!ta) return;
    const at = ta.selectionStart;
    const next = body.slice(0, at) + text + body.slice(ta.selectionEnd);
    setBody(next);
    window.setTimeout(() => {
      ta.focus();
      ta.setSelectionRange(at + text.length, at + text.length);
    }, 0);
  };
  return (
    <div className="rb-toolbar">
      <button
        className="secondary small"
        title="Highlight one or more lines, then press this. Marked lines are what an employee types; press again to unmark."
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          const ta = area.current;
          if (!ta) return;
          setBody(toggleCommands(body, ta.selectionStart, ta.selectionEnd));
          window.setTimeout(() => ta.focus(), 0);
        }}
      >
        This is a command
      </button>
      <span className="rb-chips" aria-label="Placeholders">
        {PLACEHOLDERS.map((p) => (
          <button key={p.key} className="rb-chip" title={p.what} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(p.key)}>
            {p.key}
          </button>
        ))}
      </span>
    </div>
  );
}

/** A note with marked command lines: the commands stand out, the rest renders like any note. */
export function RunbookBody({ body, render }: { body: string; render: (b: Block, i: number) => JSX.Element }) {
  const chunks: { cmd: boolean; lines: string[] }[] = [];
  for (const line of body.split('\n')) {
    const cmd = isCommandLine(line);
    const last = chunks[chunks.length - 1];
    if (last && last.cmd === cmd) last.lines.push(cmd ? line.slice(COMMAND_MARK.length) : line);
    else chunks.push({ cmd, lines: [cmd ? line.slice(COMMAND_MARK.length) : line] });
  }
  return (
    <>
      {chunks.map((c, i) =>
        c.cmd ? (
          <pre key={i} className="doc-code rb-commands" aria-label="Commands an employee types">
            {c.lines.map((l) => `★ ${l}`).join('\n')}
          </pre>
        ) : (
          textToBlocks(c.lines.join('\n')).map((b, j) => render(b, i * 1000 + j))
        ),
      )}
    </>
  );
}

/** Under a note: use it as a runbook, its triggers, a trigger tester and a dry run. */
export function RunbookSettings({ game, note }: { game: Game; note: Note }) {
  const [triggers, setTriggers] = useState(note.runbook?.triggers ?? '');
  const [dryTicket, setDryTicket] = useState('');
  // Settings live in the game, so redraw right away when they change (not on the next tick).
  const [, redraw] = useState(0);
  const set = (settings: Parameters<Game['setRunbook']>[1]) => {
    game.setRunbook(note.id, settings);
    redraw((n) => n + 1);
  };
  const isRunbook = !!note.runbook;
  const parsed = parseTriggers(triggers);
  const commands = commandsOf(note.body);
  const recent = game.queue.tickets.slice(0, 40);
  const matches = parsed.ok ? recent.filter((t) => triggerMatches(triggers, t)) : [];
  const ticket = recent.find((t) => t.id === dryTicket) ?? recent[0];
  const internReady = game.queue.rankIndex >= INTERN_FROM_RANK;
  const save = (next: string) => set({ triggers: next, enabled: note.runbook?.enabled ?? true });

  return (
    <section className="rb-settings" aria-label="Runbook settings">
      <label className="check">
        <input type="checkbox" checked={isRunbook} onChange={(e) => set(e.target.checked ? { triggers, enabled: true } : null)} /> Use this note as a runbook
      </label>
      {isRunbook && (
        <>
          <p className="muted">
            {commands.length} command{commands.length === 1 ? '' : 's'} marked.{' '}
            {internReady ? 'Your intern picks up tickets whose text matches a trigger line.' : `Interns arrive at ${RANKS[INTERN_FROM_RANK].name}; get your runbooks ready now.`}
          </p>
          <label className="check">
            <input type="checkbox" checked={note.runbook!.enabled} onChange={(e) => set({ triggers, enabled: e.target.checked })} /> Enabled (employees may use it)
          </label>
          <label className="field">
            Triggers: one statement per line, phrases joined with OR / AND (uppercase). If any line matches the ticket's subject or description, the runbook runs.
            <textarea
              rows={4}
              className="mono"
              value={triggers}
              placeholder={"printer OR can't print\nno internet AND my desk"}
              onChange={(e) => {
                setTriggers(e.target.value);
                if (parseTriggers(e.target.value).ok) save(e.target.value);
              }}
              aria-label="Trigger statements"
            />
          </label>
          {!parsed.ok ? (
            <p className="bad-text">
              Line {parsed.line}: {parsed.error}
            </p>
          ) : (
            <div className="rb-test">
              <h4>Trigger test: recent tickets it would have picked up</h4>
              {matches.length ? (
                <ul>
                  {matches.map((t) => (
                    <li key={t.id}>
                      <span className="mono">{t.id}</span> {t.draft.subject}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">None of the last {recent.length} tickets match.</p>
              )}
            </div>
          )}
          {ticket && commands.length > 0 && (
            <div className="rb-test">
              <h4>
                Dry run for{' '}
                <select value={ticket.id} onChange={(e) => setDryTicket(e.target.value)} aria-label="Ticket for the dry run">
                  {recent.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.id}: {t.draft.subject}
                    </option>
                  ))}
                </select>
              </h4>
              <pre className="doc-code">{dryRun(game.net, note.body, ticket).join('\n')}</pre>
              <p className="muted">Nothing is typed here; this is what an employee would type for that ticket.</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
