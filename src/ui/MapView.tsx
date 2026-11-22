import { useEffect, useState } from 'react';
import { ZONES } from '../content/office';
import type { Game } from '../game/game';
import { WALK_MS } from '../game/game';
import { formatIp } from '../sim/ip';
import type { Device, Link } from '../sim/types';
import { isHostKind } from '../sim/types';

interface Props {
  game: Game;
  tick: number;
  selected: string;
  onSelect: (id: string) => void;
  onConsole: (id: string) => void;
  onMonitor: (id: string) => void;
}

type Health = 'up' | 'down' | 'boot' | 'idle' | 'external';

function health(game: Game, d: Device): Health {
  if (!d.managed) return 'external';
  if (d.bootingUntil !== null) return 'boot';
  if (d.id.startsWith('ws')) return 'idle';
  return game.reachable(d) ? 'up' : 'down';
}

function linkClass(game: Game, link: Link): string {
  const net = game.net;
  const a = net.state(link.a.device, link.a.iface);
  const b = net.state(link.b.device, link.b.iface);
  const toWorkstation = link.a.device.startsWith('ws') || link.b.device.startsWith('ws');
  if (a.link === 'admin-down' || b.link === 'admin-down') return 'link admin';
  if (a.protocol === 'up' && b.protocol === 'up') {
    const trunk = [link.a, link.b].some((e) => {
      const d = net.device(e.device);
      const ifc = d.running.interfaces[e.iface];
      return ifc?.switchport && net.operationalMode(d, ifc) === 'trunk';
    });
    return trunk ? 'link up trunk' : 'link up';
  }
  return toWorkstation ? 'link quiet' : 'link down';
}

function Icon({ kind }: { kind: Device['kind'] | 'cloud' }) {
  switch (kind) {
    case 'router':
      return (
        <g className="glyph">
          <circle r="19" />
          <path d="M-9 -5 h18 m-5 -4 l5 4 l-5 4 M9 5 h-18 m5 -4 l-5 4 l5 4" />
        </g>
      );
    case 'switch':
    case 'l3switch':
      return (
        <g className="glyph">
          <rect x="-28" y="-14" width="56" height="28" rx="5" />
          <path d="M-16 -4 h26 m-5 -4 l5 4 l-5 4 M16 5 h-26 m5 -4 l-5 4 l5 4" />
          {kind === 'l3switch' && (
            <text className="glyph-tag" x="20" y="-17">
              L3
            </text>
          )}
        </g>
      );
    case 'server':
      return (
        <g className="glyph">
          <rect x="-13" y="-19" width="26" height="38" rx="3" />
          <path d="M-8 -10 h16 M-8 -3 h16 M-8 4 h16" />
          <circle cx="6" cy="12" r="1.8" className="glyph-led" />
        </g>
      );
    case 'printer':
      return (
        <g className="glyph">
          <rect x="-17" y="-7" width="34" height="16" rx="3" />
          <path d="M-10 -7 v-9 h20 v9 M-10 9 v7 h20 v-7" />
        </g>
      );
    case 'cloud':
      return (
        <g className="glyph">
          <path d="M-22 10 a10 10 0 0 1 2 -19 a13 13 0 0 1 24 -4 a10 10 0 0 1 18 9 a8 8 0 0 1 -2 14 z" />
        </g>
      );
    default:
      return (
        <g className="glyph">
          <rect x="-16" y="-13" width="32" height="21" rx="2.5" />
          <path d="M-6 13 h12 M0 8 v5" />
        </g>
      );
  }
}

export function MapView({ game, tick, selected, onSelect, onConsole, onMonitor }: Props) {
  const net = game.net;
  const layout = game.office.layout;
  // Only gear that's documented on the map: an unknown device someone plugged in doesn't draw itself.
  const devices = [...net.devices.values()].filter((d) => layout[d.id]);
  void tick;

  return (
    <div className="map-view">
      <div className="map-canvas">
        <svg viewBox="50 0 1100 700" role="img" aria-label={`${game.office.people.length}-person office network map`}>
          {ZONES.map((z) => (
            <g key={z.id} className={`zone zone-${z.id}`}>
              <rect x={z.x} y={z.y} width={z.w} height={z.h} rx="14" />
              <text x={z.x + 14} y={z.y + 22}>
                {z.label}
              </text>
            </g>
          ))}
          {net.links.map((l) => {
            const a = layout[l.a.device];
            const b = layout[l.b.device];
            if (!a || !b) return null;
            return <line key={l.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={linkClass(game, l)} />;
          })}
          {devices.map((d) => {
            const p = layout[d.id];
            const h = health(game, d);
            const ip = game.mgmtIp(d);
            const asleep = d.id.startsWith('ws') && !d.powered;
            return (
              <g
                key={d.id}
                className={`node node-${h} ${selected === d.id ? 'selected' : ''} ${asleep ? 'asleep' : ''} ${game.location === d.id ? 'here' : ''}`}
                transform={`translate(${p.x} ${p.y})`}
                onClick={() => onSelect(d.id)}
                onDoubleClick={() => onConsole(d.id)}
                role="button"
                tabIndex={0}
                aria-label={`${d.running.hostname}, ${h}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') onSelect(d.id);
                }}
              >
                <circle className="halo" r="34" />
                <Icon kind={d.id === 'internet' ? 'cloud' : d.kind} />
                {h !== 'idle' && h !== 'external' && <circle className="status-dot" cx="24" cy="-20" r="5" />}
                {game.location === d.id && (
                  <text className="here-tag" y="-30">
                    YOU
                  </text>
                )}
                <text className="node-label" y="38">
                  {d.running.hostname}
                </text>
                {ip !== null && !d.id.startsWith('ws') && (
                  <text className="node-ip" y="52">
                    {formatIp(ip)}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        <div className="map-legend" aria-hidden>
          <span>
            <i className="lg up" /> link up
          </span>
          <span>
            <i className="lg trunk" /> trunk
          </span>
          <span>
            <i className="lg down" /> link down
          </span>
          <span>
            <i className="lg admin" /> admin down
          </span>
          <span>Double-click a device to walk to its console</span>
        </div>
      </div>
      <DevicePanel game={game} id={selected} onConsole={onConsole} onMonitor={onMonitor} />
    </div>
  );
}

function DevicePanel({ game, id, onConsole, onMonitor }: { game: Game; id: string; onConsole: (id: string) => void; onMonitor: (id: string) => void }) {
  const d = game.net.device(id);
  const [name, setName] = useState(d.running.hostname);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setName(d.running.hostname);
    setError(null);
    setEditing(false);
  }, [id, d.running.hostname]);

  const person = game.office.people.find((p) => p.pc === d.running.hostname || p.pc === `CR-${d.id.toUpperCase()}`);
  const h = health(game, d);
  const statusText = !d.managed
    ? 'Not managed by you'
    : d.bootingUntil !== null
      ? 'Booting'
      : d.id.startsWith('ws')
        ? d.powered
          ? 'Not monitored'
          : 'Asleep'
        : h === 'up'
          ? 'Reachable from NOC'
          : 'Not reachable from NOC';
  const ips = Object.values(d.running.interfaces).filter((i) => i.ip && !i.switchport);
  const here = game.location === id;
  const monitored = d.managed && !d.id.startsWith('ws');

  const save = () => {
    const err = game.rename(id, name.trim());
    setError(err);
    if (!err) setEditing(false);
  };

  return (
    <aside className="device-panel" aria-label="Selected device">
      <div className="dp-head">
        <span className={`pill pill-${h}`}>{statusText}</span>
        {editing ? (
          <form
            className="rename"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <input id="rename-input" value={name} onChange={(e) => setName(e.target.value)} aria-label="New hostname" autoFocus />
            <button type="submit">Save</button>
            <button type="button" className="ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <div className="dp-title">
            <h2>{d.running.hostname}</h2>
            {d.managed && (
              <button className="link-btn" onClick={() => setEditing(true)}>
                Rename
              </button>
            )}
          </div>
        )}
        {error && <p className="dp-error">{error}</p>}
        <p className="dp-model">
          NetSmart {d.model} · {game.placeName(id)}
        </p>
      </div>

      <dl className="dp-facts">
        {person && (
          <>
            <dt>User</dt>
            <dd>
              {person.name}, {person.title}
              <br />
              Desk {person.desk}
            </dd>
          </>
        )}
        {ips.map((i) => (
          <div key={i.name} className="dp-row">
            <dt>{isHostKind(d.kind) ? 'IP address' : i.name.replace('GigabitEthernet', 'Gi').replace('FastEthernet', 'Fa')}</dt>
            <dd>
              {formatIp(i.ip!.address)}/{i.ip!.prefix}
            </dd>
          </div>
        ))}
        {!isHostKind(d.kind) && d.managed && (
          <div className="dp-row">
            <dt>Config</dt>
            <dd>{game.configUnsaved(d) ? <span className="warn-text">Unsaved changes</span> : 'Saved'}</dd>
          </div>
        )}
      </dl>

      <div className="dp-actions">
        {d.managed ? (
          <button className="primary" disabled={here} onClick={() => onConsole(id)}>
            {here ? "You're at this console" : `Walk to console (+${WALK_MS / 1000}s)`}
          </button>
        ) : (
          <p className="dp-note">This belongs to Brightline Fiber. Call them if it misbehaves.</p>
        )}
        {monitored && (
          <button className="secondary" onClick={() => onMonitor(id)}>
            Open in Monitor
          </button>
        )}
      </div>
      {!isHostKind(d.kind) && d.managed && (
        <p className="dp-hint">
          Faster: from the NOC PC, <code>ssh nocadmin@{game.mgmtIp(d) !== null ? formatIp(game.mgmtIp(d)!) : '…'}</code>
        </p>
      )}
    </aside>
  );
}
