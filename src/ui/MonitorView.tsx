import type { DeclareDraft } from './Incidents';
import type { Game, Sample } from '../game/game';
import { NOC_PC_IP, SNMP_COMMUNITY } from '../content/office';
import { compareIfNames, shortIfName } from '../sim/ifnames';
import { formatIp } from '../sim/ip';
import { deviceCpu, formatBps, interfaceRates } from '../sim/traffic';
import { isHostKind } from '../sim/types';

interface Props {
  game: Game;
  tick: number;
  selected: string;
  onSelect: (id: string) => void;
}

function Spark({ values, max, className }: { values: number[]; max: number; className: string }) {
  const w = 120;
  const h = 28;
  if (values.length < 2) return <svg className={`spark ${className}`} width={w} height={h} aria-hidden />;
  const top = Math.max(max, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - 2 - (v / top) * (h - 4)}`);
  return (
    <svg className={`spark ${className}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <path className="spark-area" d={`M0,${h} L${pts.join(' L')} L${w},${h} Z`} />
      <path className="spark-line" d={`M${pts.join(' L')}`} />
    </svg>
  );
}

function Chart({ samples }: { samples: Sample[] }) {
  const w = 1000;
  const h = 180;
  const pad = { l: 84, r: 12, t: 12, b: 24 };
  const max = Math.max(1, ...samples.map((s) => Math.max(s.inBps, s.outBps)));
  // Round the axis max up to a readable number.
  const mag = 10 ** Math.floor(Math.log10(max));
  const top = Math.ceil(max / mag) * mag;
  const x = (i: number) => pad.l + (i / Math.max(1, samples.length - 1)) * (w - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - v / top) * (h - pad.t - pad.b);
  const line = (key: 'inBps' | 'outBps') => samples.map((s, i) => `${i ? 'L' : 'M'}${x(i)},${y(s[key])}`).join(' ');
  const ticks = [0, top / 2, top];
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Total throughput over the last 10 minutes">
      {ticks.map((t) => (
        <g key={t}>
          <line className="grid" x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} />
          <text className="axis" x={pad.l - 8} y={y(t) + 4} textAnchor="end">
            {formatBps(t)}
          </text>
        </g>
      ))}
      <text className="axis" x={pad.l} y={h - 4}>
        10 min ago
      </text>
      <text className="axis" x={w - pad.r} y={h - 4} textAnchor="end">
        now
      </text>
      {samples.length > 1 && (
        <>
          <path className="series in" d={line('inBps')} />
          <path className="series out" d={line('outBps')} />
        </>
      )}
    </svg>
  );
}

export function MonitorView({ game, tick, selected, onSelect, onDeclare }: Props & { onDeclare: (d: DeclareDraft) => void }) {
  void tick;
  const net = game.net;
  const devices = game.monitored();
  const current = devices.find((d) => d.id === selected) ?? devices.find((d) => d.id === 'core1')!;
  const samples = game.history.get(current.id) ?? [];
  const cpu = deviceCpu(net, current);
  const up = game.reachable(current);
  const snmp = isHostKind(current.kind) || game.snmpOk(current);
  const booting = current.bootingUntil !== null;
  const uptimeMin = Math.floor((net.time - current.bootedAt) / 60000);
  const ifaces = Object.values(current.running.interfaces)
    .filter((i) => current.hardware[i.name] || i.name.startsWith('Vlan'))
    .sort((a, b) => compareIfNames(a.name, b.name));
  const ip = game.mgmtIp(current);

  return (
    <div className="monitor-view">
      <nav className="mon-list" aria-label="Monitored devices">
        <h2 className="side-title">Monitored devices</h2>
        <ul>
          {devices.map((d) => {
            const ok = game.reachable(d);
            return (
              <li key={d.id}>
                <button className={`mon-item ${d.id === current.id ? 'active' : ''}`} onClick={() => onSelect(d.id)}>
                  <span className={`dot ${d.bootingUntil !== null ? 'boot' : ok ? 'up' : 'down'}`} aria-hidden />
                  <span className="mon-name">{d.running.hostname}</span>
                  <span className="mon-cpu">{net.isOnline(d) && (isHostKind(d.kind) || game.snmpOk(d)) ? `${deviceCpu(net, d)}%` : '-'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <section className="mon-detail" aria-label={`${current.running.hostname} details`}>
        <header className="mon-head">
          <div>
            <h2>{current.running.hostname}</h2>
            <p className="dp-model">
              NetSmart {current.model} · {ip !== null ? formatIp(ip) : 'no IP'} · {game.placeName(current.id)}
            </p>
          </div>
          <span className="mon-head-right">
            <button className="ghost small-ghost" onClick={() => onDeclare({ source: `Monitor: ${current.running.hostname} ${booting ? 'booting' : up ? 'up' : 'down'}`, title: `${current.running.hostname} ${up ? 'degraded' : 'down'}` })}>
              Declare incident
            </button>
            <span className={`pill pill-${booting ? 'boot' : up ? 'up' : 'down'}`}>{booting ? 'Booting' : up ? 'Up' : 'Down'}</span>
          </span>
        </header>

        {!snmp && !booting && (
          <p className="doc-note">
            No SNMP response from {current.running.hostname}. The poller on NOC-PC ({NOC_PC_IP}) asks with SNMP v2c, community <code>{SNMP_COMMUNITY}</code>, read-only.
            Up/down above is from ping; CPU, uptime, traffic and interface data need SNMP.
          </p>
        )}
        {snmp && (<>
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Uptime</span>
            <span className="stat-value">{booting ? '-' : uptimeMin < 60 ? `${uptimeMin} min` : `${Math.floor(uptimeMin / 60)} h ${uptimeMin % 60} min`}</span>
          </div>
          <div className="stat">
            <span className="stat-label">CPU</span>
            <span className="stat-value">{booting ? '-' : `${cpu}%`}</span>
            <Spark values={samples.map((s) => s.cpu)} max={100} className="cpu" />
          </div>
          <div className="stat">
            <span className="stat-label">Throughput in / out</span>
            <span className="stat-value small">
              {formatBps(samples.at(-1)?.inBps ?? 0)} / {formatBps(samples.at(-1)?.outBps ?? 0)}
            </span>
          </div>
          {!isHostKind(current.kind) && (
            <div className="stat">
              <span className="stat-label">Config</span>
              <span className={`stat-value small ${game.configUnsaved(current) ? 'warn-text' : ''}`}>{game.configUnsaved(current) ? 'Unsaved changes' : 'Saved'}</span>
            </div>
          )}
        </div>

        <div className="chart-card">
          <div className="chart-head">
            <h3>Total throughput</h3>
            <span className="legend">
              <i className="lg-in" /> in <i className="lg-out" /> out
            </span>
          </div>
          <Chart samples={samples} />
        </div>

        <div className="table-wrap">
          <table className="if-table">
            <thead>
              <tr>
                <th>Port</th>
                <th>Description</th>
                <th>Status</th>
                <th>VLAN / IP</th>
                <th className="num">In</th>
                <th className="num">Out</th>
                <th>Last 10 min</th>
              </tr>
            </thead>
            <tbody>
              {ifaces.map((ifc) => {
                const s = net.state(current.id, ifc.name);
                const status = s.link === 'admin-down' ? 'admin down' : s.protocol === 'up' ? 'up' : 'down';
                const r = current.hardware[ifc.name] ? interfaceRates(net, current.id, ifc.name) : null;
                let where = '';
                if (ifc.switchport) where = net.operationalMode(current, ifc) === 'trunk' && s.protocol === 'up' ? 'trunk' : `VLAN ${ifc.switchport.accessVlan}`;
                else if (ifc.ip) where = `${formatIp(ifc.ip.address)}/${ifc.ip.prefix}`;
                const hist = samples.map((x) => (x.ifaces[ifc.name]?.inBps ?? 0) + (x.ifaces[ifc.name]?.outBps ?? 0));
                return (
                  <tr key={ifc.name}>
                    <td className="mono">{shortIfName(ifc.name)}</td>
                    <td className="desc">{ifc.description ?? ''}</td>
                    <td>
                      <span className={`chip chip-${status.replace(' ', '-')}`}>{status}</span>
                    </td>
                    <td className="mono">{where}</td>
                    <td className="num mono">{r ? formatBps(r.inBps) : ''}</td>
                    <td className="num mono">{r ? formatBps(r.outBps) : ''}</td>
                    <td>{r && <Spark values={hist} max={Math.max(...hist, 1)} className="tp" />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
              </>)}
      </section>
    </div>
  );
}
