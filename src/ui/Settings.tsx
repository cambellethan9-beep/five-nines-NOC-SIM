import { useState } from 'react';
import { applyTheme, DEFAULT_THEME, PRESETS, saveTheme, type Theme } from './theme';

export const HOTKEYS: { key: string; what: string }[] = [
  { key: '1-6', what: 'Tickets, Chat, Map, Monitor, Logs, Docs' },
  { key: '7', what: 'Show or hide the console' },
  { key: '8', what: 'Jump into the console prompt' },
  { key: '/', what: 'Search tickets' },
  { key: 'Esc', what: 'Leave a text box (so the number keys work again)' },
  { key: 'Alt + 1-8', what: 'Same as the number keys, even while typing' },
];

export function SettingsDialog({ theme, onChange, onClose, onDeleteDocs }: { theme: Theme; onChange: (t: Theme) => void; onClose: () => void; onDeleteDocs: () => void }) {
  const [t, setT] = useState(theme);
  // Deleting your documentation takes three deliberate steps.
  const [delStep, setDelStep] = useState(0);
  const [typed, setTyped] = useState('');
  const set = (next: Theme) => {
    setT(next);
    applyTheme(next);
    saveTheme(next);
    onChange(next);
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Settings</h2>
        <h3>Colors</h3>
        <p className="modal-sub">Purely cosmetic, saved in this browser only.</p>
        <div className="theme-presets">
          {PRESETS.map((p) => (
            <button key={p.name} className="theme-preset" onClick={() => set(p.theme)} aria-label={p.name}>
              <span className="swatch" style={{ background: p.theme.bg, borderColor: p.theme.accent }}>
                <span style={{ background: p.theme.panel }} />
              </span>
              {p.name}
            </button>
          ))}
        </div>
        <div className="theme-pickers">
          <label>
            Backdrop <input type="color" value={t.bg} onChange={(e) => set({ ...t, bg: e.target.value })} />
          </label>
          <label>
            Panels <input type="color" value={t.panel} onChange={(e) => set({ ...t, panel: e.target.value })} />
          </label>
          <label>
            Accent <input type="color" value={t.accent} onChange={(e) => set({ ...t, accent: e.target.value })} />
          </label>
          <button className="secondary small" onClick={() => set(DEFAULT_THEME)}>
            Reset
          </button>
        </div>
        <h3>Keyboard shortcuts</h3>
        <table className="hotkeys">
          <tbody>
            {HOTKEYS.map((h) => (
              <tr key={h.key}>
                <td>
                  <kbd>{h.key}</kbd>
                </td>
                <td>{h.what}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h3>Your documentation</h3>
        <p className="modal-sub">Your notebook and your edits to the inherited docs carry over to every new game. They stay until you delete them here.</p>
        {delStep === 0 && (
          <button className="secondary small" onClick={() => setDelStep(1)}>
            Delete my documentation...
          </button>
        )}
        {delStep === 1 && (
          <div className="danger-box">
            <p>This deletes every note in your notebook and every edit you made to the inherited docs, in this game and all future ones.</p>
            <div className="row-form">
              <button className="secondary small" onClick={() => setDelStep(0)}>
                Keep it
              </button>
              <button className="primary danger small" onClick={() => setDelStep(2)}>
                I understand, continue
              </button>
            </div>
          </div>
        )}
        {delStep === 2 && (
          <div className="danger-box">
            <p>
              Are you sure? There is no backup and no undo. Type <kbd>DELETE</kbd> to confirm.
            </p>
            <div className="row-form">
              <input value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type DELETE to confirm" className="mono" />
              <button className="secondary small" onClick={() => { setDelStep(0); setTyped(''); }}>
                Cancel
              </button>
              <button
                className="primary danger small"
                disabled={typed !== 'DELETE'}
                onClick={() => {
                  onDeleteDocs();
                  setDelStep(0);
                  setTyped('');
                }}
              >
                Delete forever
              </button>
            </div>
          </div>
        )}
        <div className="td-buttons">
          <button className="primary" onClick={onClose} autoFocus>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
