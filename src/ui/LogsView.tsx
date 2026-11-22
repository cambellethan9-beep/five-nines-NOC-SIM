import { useMemo, useState } from 'react';
import type { Game } from '../game/game';

const SEVERITIES = ['emergencies', 'alerts', 'critical', 'errors', 'warnings', 'notifications', 'informational', 'debugging'];

/** Pulls the severity digit out of "%LINK-3-UPDOWN: ...". */
function severityOf(message: string): number {
  const m = /^%[A-Z0-9_]+-(\d)-/.exec(message);
  return m ? Number(m[1]) : 6;
}

export function LogsView({ game, tick }: { game: Game; tick: number }) {
  const [maxSev, setMaxSev] = useState(7);
  const [device, setDevice] = useState('all');
  const [query, setQuery] = useState('');
  const net = game.net;

  const rows = useMemo(() => {
    void tick;
    const q = query.trim().toLowerCase();
    return net.logs
      .filter((l) => {
        if (device !== 'all' && l.device !== device) return false;
        if (severityOf(l.message) > maxSev) return false;
        if (q && !l.message.toLowerCase().includes(q) && !net.device(l.device).running.hostname.toLowerCase().includes(q)) return false;
        return true;
      })
      .slice(-500)
      .reverse();
  }, [net, tick, maxSev, device, query]);

  const sources = game.monitored().filter((d) => !['pc', 'server', 'printer'].includes(d.kind));

  return (
    <div className="logs-view">
      <div className="logs-toolbar">
        <label>
          Severity
          <select id="log-severity" value={maxSev} onChange={(e) => setMaxSev(Number(e.target.value))}>
            {SEVERITIES.map((s, i) => (
              <option key={s} value={i}>
                {i} {s} {i < 7 ? 'and worse' : '(all)'}
              </option>
            ))}
          </select>
        </label>
        <label>
          Device
          <select id="log-device" value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="all">All devices</option>
            {sources.map((d) => (
              <option key={d.id} value={d.id}>
                {d.running.hostname}
              </option>
            ))}
          </select>
        </label>
        <label className="grow">
          Search
          <input id="log-search" type="search" placeholder="e.g. UPDOWN, Fa0/7, LOGIN" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <span className="logs-count">{rows.length} messages</span>
      </div>
      <div className="logs-table-wrap">
        <table className="logs-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Device</th>
              <th>Severity</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const sev = severityOf(l.message);
              return (
                <tr key={l.seq} className={sev <= 3 ? 'log-row hot' : 'log-row'}>
                  <td className="mono nowrap">{net.formatLogTime(l.time)}</td>
                  <td className="mono nowrap">{net.device(l.device).running.hostname}</td>
                  <td>
                    <span className={`sev sev-${sev}`}>
                      {sev} {SEVERITIES[sev]}
                    </span>
                  </td>
                  <td className="mono msg">{l.message}</td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={4} className="empty">
                  No messages match. Network devices log here when interfaces change state, someone logs in, or a config changes.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
