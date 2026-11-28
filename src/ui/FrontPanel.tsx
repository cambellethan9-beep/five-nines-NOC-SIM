import { useState } from 'react';
import type { Game } from '../game/game';
import { LATEST_PRINTER_FIRMWARE, portLed } from '../game/physical';
import { compareIfNames, shortIfName } from '../sim/ifnames';
import { formatIp } from '../sim/ip';

/** A switch or router's front panel: port LEDs, the labels above them, and moving patch cables. */
export function FrontPanel({ game, deviceId, onMessage }: { game: Game; deviceId: string; onMessage: (t: string) => void }) {
  const d = game.net.device(deviceId);
  const [sel, setSel] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [labelText, setLabelText] = useState('');
  const ports = Object.keys(d.hardware).sort(compareIfNames);
  const fast = ports.filter((p) => p.startsWith('Fast'));
  const gig = ports.filter((p) => !p.startsWith('Fast'));
  // Real switches put odd ports on the top row and even ports underneath.
  const rows = (list: string[]) => [list.filter((_, i) => i % 2 === 0), list.filter((_, i) => i % 2 === 1)];
  const hand = game.cableInHand;

  const port = (p: string) => {
    const led = portLed(game.net, d, p);
    const cabled = !!game.net.linkAt(d.id, p);
    const label = d.portLabels?.[p] ?? '';
    return (
      <div key={p} className={`fp-port ${sel === p ? 'sel' : ''}`}>
        {editing === p ? (
          <input
            className="fp-label-edit"
            value={labelText}
            autoFocus
            maxLength={24}
            onChange={(e) => setLabelText(e.target.value)}
            onBlur={() => {
              game.setPortLabel(d.id, p, labelText);
              setEditing(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditing(null);
            }}
            aria-label={`Label for ${p}`}
          />
        ) : (
          <button
            className="fp-label"
            title="Double-click to relabel"
            onDoubleClick={() => {
              setEditing(p);
              setLabelText(label);
            }}
            onClick={() => setSel(p)}
          >
            {label || ' '}
          </button>
        )}
        <button className={`fp-jack ${cabled ? 'cabled' : ''}`} onClick={() => setSel(p)} aria-label={`${p}${cabled ? ', cable connected' : ', empty'}, LED ${led}`}>
          <span className={`fp-led led-${led}`} />
          <span className="fp-num">{shortIfName(p).replace(/^(Fa|Gi)0\//, '')}</span>
        </button>
      </div>
    );
  };

  const selCabled = sel ? !!game.net.linkAt(d.id, sel) : false;
  const st = sel ? game.net.state(d.id, sel) : null;
  return (
    <div className="front-panel">
      <div className="fp-chassis" aria-label={`${d.running.hostname} front panel`}>
        <div className="fp-brand">
          NetSmart <strong>{d.model}</strong>
          <span className="muted"> · {d.running.hostname}</span>
        </div>
        <div className="fp-banks">
          {fast.length > 0 && (
            <div className="fp-bank">
              {rows(fast).map((r, i) => (
                <div key={i} className="fp-row">
                  {r.map(port)}
                </div>
              ))}
            </div>
          )}
          <div className="fp-bank uplinks">
            {rows(gig).map((r, i) => (
              <div key={i} className="fp-row">
                {r.map(port)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="fp-info">
        {hand && (
          <p className="fp-hand">
            You're holding the patch cable from {shortIfName(hand.fromPort)}
            {hand.fromDevice !== d.id && <> on {game.net.device(hand.fromDevice).running.hostname}</>}. Pick a free port to plug it in.
          </p>
        )}
        {sel && st ? (
          <>
            <p>
              <strong>{sel}</strong> · label "{d.portLabels?.[sel] ?? ''}" · LED {portLed(game.net, d, sel)} · {selCabled ? 'cable connected' : 'empty'}
              {st.err && <> · err-disabled ({st.err})</>}
            </p>
            <div className="row-form">
              {selCabled && (
                <button className="secondary small" onClick={() => onMessage(game.unplugPort(d.id, sel))} disabled={!!hand}>
                  Unplug cable
                </button>
              )}
              {selCabled && (
                <button className="secondary small" onClick={() => onMessage(game.replaceCableAt(d.id, sel))} disabled={!!hand}>
                  Replace cable
                </button>
              )}
              {!selCabled && hand && (
                <button className="primary small" onClick={() => onMessage(game.plugPort(d.id, sel))}>
                  Plug the cable in here
                </button>
              )}
              <button
                className="ghost small-ghost"
                onClick={() => {
                  setEditing(sel);
                  setLabelText(d.portLabels?.[sel] ?? '');
                }}
              >
                Relabel
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Click a port. Labels are the stickers above the ports: they only say what someone wrote, not what the config says.</p>
        )}
      </div>
    </div>
  );
}

/** A printer's own panel: link light and cable, network settings page, firmware. */
export function PrinterPanel({ game, deviceId, onMessage }: { game: Game; deviceId: string; onMessage: (t: string) => void }) {
  const d = game.net.device(deviceId);
  const nic = Object.keys(d.hardware)[0];
  const link = game.net.linkAt(d.id, nic);
  const up = game.net.isUp(d.id, nic);
  const booting = d.bootingUntil !== null;
  const ip = d.running.interfaces[nic]?.ip;
  return (
    <div className="printer-panel">
      <div className="pp-screen">
        <p className="pp-status">{booting ? 'Updating firmware... do not power off' : up ? 'Ready' : 'Network disconnected'}</p>
        <dl className="pp-config">
          <dt>Host name</dt>
          <dd>{d.running.hostname}</dd>
          <dt>IPv4</dt>
          <dd>{ip ? `${formatIp(ip.address)} /${ip.prefix}` : 'none'} (manual)</dd>
          <dt>Gateway</dt>
          <dd>{d.running.defaultGateway !== null ? formatIp(d.running.defaultGateway) : 'none'}</dd>
          <dt>MAC</dt>
          <dd>{d.hardware[nic].mac}</dd>
          <dt>Link</dt>
          <dd>{up ? `${game.net.negotiatedSpeed(d.id, nic)} Mb/s ${game.net.negotiatedDuplex(d.id, nic)} duplex` : 'down'}</dd>
          <dt>Firmware</dt>
          <dd>
            {d.firmware ?? 'unknown'}
            {d.firmware && d.firmware !== LATEST_PRINTER_FIRMWARE && <span className="warn-text"> (update {LATEST_PRINTER_FIRMWARE} available)</span>}
          </dd>
        </dl>
      </div>
      <div className="pp-back">
        <p>
          Network port at the back: link light <strong>{up ? 'on' : 'off'}</strong>.{' '}
          {!link ? 'No cable.' : link.cable === 'unplugged' ? 'The cable is hanging loose, not clicked in.' : link.cable === 'cut' ? 'The cable is plugged in but looks crushed.' : 'Cable seated.'}
        </p>
        <div className="row-form">
          <button className="secondary small" onClick={() => onMessage(game.reseatPrinterCable(d.id))}>
            Reseat network cable
          </button>
          <button className="secondary small" disabled={booting || d.firmware === LATEST_PRINTER_FIRMWARE} onClick={() => onMessage(game.updatePrinterFirmware(d.id))}>
            Install firmware {LATEST_PRINTER_FIRMWARE} from USB
          </button>
        </div>
      </div>
    </div>
  );
}
