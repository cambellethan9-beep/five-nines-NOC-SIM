// Cosmetic colors. Kept in this browser only (they're a personal preference, not part of a saved game).

export interface Theme {
  bg: string;
  panel: string;
  accent: string;
}

export const DEFAULT_THEME: Theme = { bg: '#0b0f14', panel: '#111821', accent: '#4cc2ff' };

export const PRESETS: { name: string; theme: Theme }[] = [
  { name: 'NOC night (default)', theme: DEFAULT_THEME },
  { name: 'Graphite', theme: { bg: '#121212', panel: '#1c1c1c', accent: '#f5a524' } },
  { name: 'Deep green', theme: { bg: '#07130d', panel: '#0e1f16', accent: '#3ddc84' } },
  { name: 'Purple haze', theme: { bg: '#100b18', panel: '#1a1326', accent: '#b48cff' } },
  { name: 'Ember', theme: { bg: '#160c0a', panel: '#241310', accent: '#ff7a45' } },
];

const KEY = 'noc-sim.theme';

export function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_THEME, ...(JSON.parse(raw) as Partial<Theme>) };
  } catch {
    // storage blocked: use the default
  }
  return DEFAULT_THEME;
}

export function saveTheme(t: Theme): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
  } catch {
    // not saved; it still applies for this visit
  }
}

/** Mixes a color toward white (amount > 0) or black (< 0), for derived panel and line shades. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)));
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
}

export function applyTheme(t: Theme): void {
  const s = document.documentElement.style;
  s.setProperty('--bg', t.bg);
  s.setProperty('--zone', shade(t.bg, 0.03));
  s.setProperty('--panel', t.panel);
  s.setProperty('--panel-2', shade(t.panel, 0.06));
  s.setProperty('--line', shade(t.panel, 0.12));
  s.setProperty('--line-2', shade(t.panel, 0.18));
  s.setProperty('--accent', t.accent);
}
