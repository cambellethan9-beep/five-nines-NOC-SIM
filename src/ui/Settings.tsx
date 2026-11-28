import { useState } from 'react';
import { applyTheme, DEFAULT_THEME, fileToBackground, PRESETS, probeImage, saveTheme, type Background, type BackgroundArea, type Theme } from './theme';

export const HOTKEYS: { key: string; what: string }[] = [
  { key: '1-7', what: 'Tickets, Chat, Map, Monitor, Logs, Docs, Team' },
  { key: '8', what: 'Show or hide the console' },
  { key: '9', what: 'Jump into the console prompt' },
  { key: '/', what: 'Search tickets' },
  { key: 'P', what: 'Pause or resume (Alt+P while typing)' },
  { key: 'Esc', what: 'Leave a text box (so the number keys work again)' },
  { key: 'Alt + 1-9', what: 'Same as the number keys, even while typing' },
];

export function SettingsDialog({ theme, onChange, onClose, onDeleteDocs }: { theme: Theme; onChange: (t: Theme) => void; onClose: () => void; onDeleteDocs: () => void }) {
  const [t, setT] = useState(theme);
  // Deleting your documentation takes three deliberate steps.
  const [delStep, setDelStep] = useState(0);
  const [typed, setTyped] = useState('');
  const [bgNote, setBgNote] = useState<string | null>(null);
  const set = (next: Theme) => {
    setT(next);
    applyTheme(next);
    const saved = saveTheme(next);
    setBgNote(saved ? null : "Your browser's storage is full, so this won't be kept after you close the game. Try a smaller image or a web link.");
    onChange(next);
  };
  const setBg = (area: BackgroundArea, b: Background | null) => {
    const backgrounds = { ...t.backgrounds };
    if (b) backgrounds[area] = b;
    else delete backgrounds[area];
    set({ ...t, backgrounds });
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="settings-title">Settings</h2>
        <h3>Colors</h3>
        <p className="modal-sub">Purely cosmetic, saved in this browser only.</p>
        <div className="theme-presets">
          {PRESETS.map((p) => (
            <button key={p.name} className="theme-preset" onClick={() => set({ ...p.theme, backgrounds: t.backgrounds })} aria-label={p.name}>
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
          <button className="secondary small" onClick={() => set({ ...DEFAULT_THEME, backgrounds: t.backgrounds })}>
            Reset
          </button>
        </div>
        <h3>Backgrounds</h3>
        <p className="modal-sub">Your own images behind the console and the Map, each with its own picture and settings. Paste an image address from the web, or pick a file.</p>
        <BackgroundEditor area="console" label="Console" value={t.backgrounds?.console} onChange={(b) => setBg('console', b)} />
        <BackgroundEditor area="map" label="Map canvas" value={t.backgrounds?.map} onChange={(b) => setBg('map', b)} />
        {bgNote && <p className="warn-text">{bgNote}</p>}

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

function BackgroundEditor({ area, label, value, onChange }: { area: BackgroundArea; label: string; value: Background | undefined; onChange: (b: Background | null) => void }) {
  const [url, setUrl] = useState(value && !value.src.startsWith('data:') ? value.src : '');
  const [msg, setMsg] = useState<string | null>(null);
  const base: Background = value ?? { src: '', fit: 'cover', dim: area === 'console' ? 0.6 : 0.4, blur: 0 };
  const use = async (src: string) => {
    setMsg('Loading...');
    if (!(await probeImage(src))) {
      setMsg("Couldn't load that image. Some sites block their pictures from being shown elsewhere: try another image, or save it and pick the file.");
      return;
    }
    setMsg(null);
    onChange({ ...base, src });
  };
  return (
    <div className="bg-area">
      <h4>{label}</h4>
      <div className="row-form">
        {value && <span className="bg-preview" style={{ backgroundImage: `url("${value.src.replace(/"/g, '%22')}")` }} aria-hidden="true" />}
        <input type="url" value={url} placeholder="https://... image address" onChange={(e) => setUrl(e.target.value)} aria-label={`${label} image address`} />
        <button className="secondary small" disabled={!url.trim()} onClick={() => void use(url.trim())}>
          Use link
        </button>
        <label className="secondary small file-btn">
          Pick a file
          <input
            type="file"
            accept="image/*"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try {
                await use(await fileToBackground(f));
              } catch (err) {
                setMsg((err as Error).message);
              }
            }}
          />
        </label>
        {value && (
          <button className="ghost small-ghost" onClick={() => onChange(null)}>
            Remove
          </button>
        )}
      </div>
      {value && (
        <div className="row-form">
          <label>
            Fit{' '}
            <select value={value.fit} onChange={(e) => onChange({ ...value, fit: e.target.value as Background['fit'] })}>
              <option value="cover">Fill</option>
              <option value="contain">Fit whole image</option>
              <option value="tile">Tile</option>
            </select>
          </label>
          <label>
            Dim{' '}
            <input type="range" min={0} max={0.9} step={0.05} value={value.dim} onChange={(e) => onChange({ ...value, dim: Number(e.target.value) })} aria-label={`${label} dim`} />
          </label>
          <label>
            Blur{' '}
            <input type="range" min={0} max={12} step={1} value={value.blur} onChange={(e) => onChange({ ...value, blur: Number(e.target.value) })} aria-label={`${label} blur`} />
          </label>
        </div>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
