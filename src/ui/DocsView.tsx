import { Fragment, useState, type ReactNode } from 'react';
import type { Block, Doc } from '../content/docs';
import { blocksToText, textToBlocks } from '../content/doctext';
import type { Game } from '../game/game';

/** Renders `code` and **bold** inside a line of text. */
function inline(text: string): ReactNode {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

function BlockView({ block }: { block: Block }) {
  if ('h' in block) return <h3>{block.h}</h3>;
  if ('p' in block) return <p>{inline(block.p)}</p>;
  if ('code' in block) return <pre className="doc-code">{block.code}</pre>;
  if ('note' in block) return <p className="doc-note">{inline(block.note)}</p>;
  if ('ul' in block)
    return (
      <ul>
        {block.ul.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>
    );
  if ('ol' in block)
    return (
      <ol>
        {block.ol.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ol>
    );
  return (
    <div className="table-wrap">
      <table className="doc-table">
        <thead>
          <tr>
            {block.table.head.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const FORMAT_HINT = '# Heading\n- bullet points\n1. numbered steps\n> callout\n| table | columns |\nPlain paragraphs, `inline code`, **bold**\n```\ncode blocks\n```';

export function DocsView({ game, tick, openNote }: { game: Game; tick: number; openNote?: string }) {
  void tick;
  const docs = game.docs;
  const startNote = openNote ? game.notes.find((n) => n.id === openNote) : undefined;
  const [active, setActive] = useState(startNote?.id ?? docs[0].id);
  const [editing, setEditing] = useState(!!startNote);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const note = game.notes.find((n) => n.id === active) ?? null;
  const doc = note ? null : (docs.find((d) => d.id === active) ?? docs[0]);
  const [title, setTitle] = useState(startNote?.title ?? '');
  const [body, setBody] = useState(startNote?.body ?? '');

  const open = (id: string) => {
    setActive(id);
    setEditing(false);
    setConfirmDelete(false);
  };

  const startEdit = () => {
    if (!note) return;
    setTitle(note.title);
    setBody(note.body);
    setEditing(true);
  };

  const newNote = () => {
    const n = game.addNote();
    setActive(n.id);
    setTitle(n.title);
    setBody('');
    setEditing(true);
    setConfirmDelete(false);
  };

  const groups: { label: string; kind: Doc['kind'] }[] = [
    { label: 'Reference', kind: 'reference' },
    { label: 'Playbooks', kind: 'playbook' },
  ];
  return (
    <div className="docs-view">
      <nav className="docs-list" aria-label="Documents">
        <div>
          <div className="nb-head">
            <h2 className="side-title">Your notebook</h2>
            <button className="link-btn" onClick={newNote}>
              + New note
            </button>
          </div>
          <ul>
            {game.notes.map((n) => (
              <li key={n.id}>
                <button className={`doc-item ${n.id === active ? 'active' : ''}`} onClick={() => open(n.id)}>
                  {n.title}
                </button>
              </li>
            ))}
            {!game.notes.length && <li className="docs-foot">Nothing yet. Notes you write here are saved with your game.</li>}
          </ul>
        </div>
        {groups.map((g) => (
          <div key={g.kind}>
            <h2 className="side-title">{g.label}</h2>
            <ul>
              {docs
                .filter((d) => d.kind === g.kind)
                .map((d) => (
                  <li key={d.id}>
                    <button className={`doc-item ${d.id === active ? 'active' : ''}`} onClick={() => open(d.id)}>
                      {d.title}
                    </button>
                  </li>
                ))}
            </ul>
          </div>
        ))}
        <p className="docs-foot">Reference and playbooks were inherited from the previous network admin. Nobody has updated them since. You can: open one and press Edit to fix what's gone stale.</p>
      </nav>

      {note ? (
        <article className="doc">
          <header>
            <p className="doc-kind">Your note</p>
            {editing ? (
              <input id="note-title" className="note-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Note title" />
            ) : (
              <h2>{note.title}</h2>
            )}
            <p className="doc-meta">You · last edited {game.net.formatLogTime(note.updated).slice(-12, -7)}</p>
          </header>
          {editing ? (
            <div className="note-editor">
              <textarea
                id="note-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={16}
                placeholder={FORMAT_HINT}
                aria-label="Note text"
              />
              <div className="td-buttons">
                <button
                  className="primary"
                  onClick={() => {
                    game.updateNote(note.id, title, body);
                    setEditing(false);
                  }}
                >
                  Save note
                </button>
                <button className="secondary" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              {note.body.trim() ? textToBlocks(note.body).map((b, i) => <BlockView key={i} block={b} />) : <p className="docs-foot">This note is empty.</p>}
              <div className="td-buttons note-actions">
                <button className="secondary" onClick={startEdit}>
                  Edit
                </button>
                {confirmDelete ? (
                  <>
                    <span className="bad-text">Delete this note for good?</span>
                    <button
                      className="secondary"
                      onClick={() => {
                        game.deleteNote(note.id);
                        open(docs[0].id);
                      }}
                    >
                      Yes, delete
                    </button>
                    <button className="secondary" onClick={() => setConfirmDelete(false)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="secondary" onClick={() => setConfirmDelete(true)}>
                    Delete
                  </button>
                )}
              </div>
            </>
          )}
        </article>
      ) : (
        doc && (
          <article className="doc">
            <header>
              <p className="doc-kind">{doc.kind === 'playbook' ? 'Playbook' : 'Reference'}</p>
              <h2>{doc.title}</h2>
              <p className="doc-meta">
                {doc.author} · last edited {doc.updated}
                {doc.editedAt !== undefined && <> · updated by you {game.net.formatLogTime(doc.editedAt).slice(-12, -7)}</>}
              </p>
            </header>
            {editing ? (
              <div className="note-editor">
                <textarea id="doc-body" value={body} onChange={(e) => setBody(e.target.value)} rows={24} placeholder={FORMAT_HINT} aria-label="Document text" />
                <p className="docs-foot">Tables are rows of cells between | bars. Add, remove or change rows and keep the bars lined up however you like.</p>
                <div className="td-buttons">
                  <button
                    className="primary"
                    onClick={() => {
                      game.updateDoc(doc.id, body);
                      setEditing(false);
                    }}
                  >
                    Save changes
                  </button>
                  <button className="secondary" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <>
                {doc.blocks.map((b, i) => (
                  <BlockView key={i} block={b} />
                ))}
                <div className="td-buttons note-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setBody(blocksToText(doc.blocks));
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  {doc.original &&
                    (confirmDelete ? (
                      <>
                        <span className="bad-text">Throw away your changes and go back to {doc.author}'s version?</span>
                        <button
                          className="secondary"
                          onClick={() => {
                            game.revertDoc(doc.id);
                            setConfirmDelete(false);
                          }}
                        >
                          Yes, revert
                        </button>
                        <button className="secondary" onClick={() => setConfirmDelete(false)}>
                          Keep mine
                        </button>
                      </>
                    ) : (
                      <button className="secondary" onClick={() => setConfirmDelete(true)}>
                        Revert to original
                      </button>
                    ))}
                </div>
              </>
            )}
          </article>
        )
      )}
    </div>
  );
}
