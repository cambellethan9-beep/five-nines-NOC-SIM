// Cosmetic colors. Kept in this browser only (they're a personal preference, not part of a saved game).

/** An image behind one area: a web address or an uploaded file (a data URL), and how it's shown. */
export interface Background {
  src: string;
  fit: 'cover' | 'contain' | 'tile';
  /** 0 = the image at full strength, 0.9 = almost hidden behind the area's own color. */
  dim: number;
  /** Blur in pixels. */
  blur: number;
}

export type BackgroundArea = 'console' | 'map';

export interface Theme {
  bg: string;
  panel: string;
  accent: string;
  backgrounds?: Partial<Record<BackgroundArea, Background>>;
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

/** Saves the theme. Returns false when the browser refuses (usually: uploaded images too big for its storage). */
export function saveTheme(t: Theme): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(t));
    return true;
  } catch {
    return false; // not saved; it still applies for this visit
  }
}

/** Checks that an image loads (some sites block their images from being shown elsewhere). */
export function probeImage(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

/** Shrinks an uploaded image to at most 1920 px wide and JPEG, so it fits in browser storage. */
export function fileToBackground(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("That file isn't an image the browser can show."));
      img.onload = () => {
        const scale = Math.min(1, 1920 / img.width);
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Mixes a color toward white (amount > 0) or black (< 0), for derived panel and line shades. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => Math.round(amount > 0 ? c + (255 - c) * amount : c * (1 + amount)));
  return '#' + ch.map((c) => c.toString(16).padStart(2, '0')).join('');
}

export function applyTheme(t: Theme): void {
  const s = document.documentElement.style;
  for (const area of ['console', 'map'] as BackgroundArea[]) {
    const b = t.backgrounds?.[area];
    s.setProperty(`--${area}-img`, b ? `url("${b.src.replace(/"/g, '%22')}")` : 'none');
    s.setProperty(`--${area}-size`, b?.fit === 'contain' ? 'contain' : b?.fit === 'tile' ? 'auto' : 'cover');
    s.setProperty(`--${area}-repeat`, b?.fit === 'tile' ? 'repeat' : 'no-repeat');
    s.setProperty(`--${area}-dim`, String(b ? b.dim : 0));
    s.setProperty(`--${area}-blur`, `${b ? b.blur : 0}px`);
  }
  // The map's floor zones are solid by default; let a background image show through them.
  s.setProperty('--map-zone-opacity', t.backgrounds?.map ? '0.35' : '1');
  s.setProperty('--bg', t.bg);
  s.setProperty('--zone', shade(t.bg, 0.03));
  s.setProperty('--panel', t.panel);
  s.setProperty('--panel-2', shade(t.panel, 0.06));
  s.setProperty('--line', shade(t.panel, 0.12));
  s.setProperty('--line-2', shade(t.panel, 0.18));
  s.setProperty('--accent', t.accent);
}
