import { useState } from 'react';
import { ADAPTER_NAME, applyIpSettings, currentIpSettings, deskStatus, lookBehind, reseatCable, replaceCable, setAdapterEnabled, updateDriver, USB_DRIVER, wake, type NetStatus } from '../game/desk';
import type { Game } from '../game/game';
import { formatIp, prefixToMask } from '../sim/ip';
import { Terminal } from './Terminal';

type Tab = 'status' | 'settings' | 'devices' | 'cmd';

const STATUS_TEXT: Record<NetStatus, { title: string; detail: string; tone: 'ok' | 'warn' | 'bad' }> = {
  connected: { title: 'Connected', detail: 'Internet access', tone: 'ok' },
  'no-internet': { title: 'No internet access', detail: 'Connected to a network, but nothing beyond it answers', tone: 'warn' },
  unidentified: { title: 'Unidentified network', detail: 'No internet access. Windows could not get an address from a DHCP server', tone: 'warn' },
  unplugged: { title: 'Network cable unplugged', detail: 'Ethernet: cable unplugged', tone: 'bad' },
  disconnected: { title: 'Not connected', detail: 'Ethernet: no link', tone: 'bad' },
  'no-adapter': { title: 'No network adapters', detail: 'Windows can\'t find a working network adapter', tone: 'bad' },
  asleep: { title: 'Asleep', detail: '', tone: 'warn' },
};

export function DeskView({ game, pcId, tick, visible }: { game: Game; pcId: string; tick: number; visible: boolean }) {
  void tick;
  const [tab, setTab] = useState<Tab>('status');
  const [driverDialog, setDriverDialog] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const net = game.net;
  const pc = net.device(pcId);
  const person = game.office.people.find((p) => p.pcId === pcId);
  const status = deskStatus(net, pc);
  const back = lookBehind(net, pc);
  const nic = pc.nic!;
  const ifc = pc.running.interfaces['FastEthernet0'];
  const s = STATUS_TEXT[status];

  const act = (text: string) => setResult(text);

  if (!visible) return null;

  return (
    <div className="desk">
      <section className="desk-screen" aria-label={`${pc.running.hostname} screen`}>
        <div className="win-bar">
          <span className="win-title">
            {pc.running.hostname}
            {person ? ` · ${person.name}'s desk ${person.desk}` : ''}
          </span>
          <span className={`win-net tone-${s.tone}`} title={s.title}>
            {status === 'connected' ? '▮▮▮ Connected' : status === 'no-internet' || status === 'unidentified' ? '⚠ No internet' : status === 'asleep' ? 'Asleep' : '✕ ' + s.title}
          </span>
        </div>

        {status === 'asleep' ? (
          <div className="win-body asleep-screen">
            <p>The screen is dark. The PC is asleep.</p>
            <button className="primary" onClick={() => wake(net, pc)}>
              Move the mouse to wake it
            </button>
          </div>
        ) : (
          <>
            <div className="win-tabs" role="tablist">
              {(
                [
                  ['status', 'Network status'],
                  ['settings', 'Network settings'],
                  ['devices', 'Device Manager'],
                  ['cmd', 'Command Prompt'],
                ] as [Tab, string][]
              ).map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
                  {label}
                </button>
              ))}
            </div>

            <div className="win-body">
              {tab === 'status' && (
                <div className="net-status">
                  <p className={`ns-big tone-${s.tone}`}>{s.title}</p>
                  <p className="ns-detail">{s.detail}</p>
                  {status !== 'no-adapter' && (
                    <dl className="ns-facts">
                      <dt>Adapter</dt>
                      <dd>{ADAPTER_NAME}</dd>
                      <dt>IPv4 address</dt>
                      <dd className="mono">{ifc.ip ? formatIp(ifc.ip.address) : '-'}</dd>
                      <dt>Subnet mask</dt>
                      <dd className="mono">{ifc.ip ? formatIp(prefixToMask(ifc.ip.prefix)) : '-'}</dd>
                      <dt>Default gateway</dt>
                      <dd className="mono">{pc.running.defaultGateway !== null ? formatIp(pc.running.defaultGateway) : '-'}</dd>
                      <dt>Link speed</dt>
                      <dd>{net.isUp(pc.id, 'FastEthernet0') ? '100 Mbps' : '-'}</dd>
                    </dl>
                  )}
                  {status === 'no-adapter' && <p className="ns-hint">Device Manager will show what's going on with the adapter.</p>}
                </div>
              )}

              {tab === 'settings' && <IpSettingsForm key={pcId + String(pc.hostNet?.dhcp)} game={game} pcId={pcId} onResult={act} />}

              {tab === 'devices' && (
                <div className="devmgr">
                  <ul className="dm-tree">
                    {nic.driver === 'missing' ? (
                      <li>
                        <span className="dm-group">▾ Other devices</span>
                        <ul>
                          <li className="dm-dev warn">⚠ Ethernet Controller</li>
                        </ul>
                      </li>
                    ) : (
                      <li>
                        <span className="dm-group">▾ Network adapters</span>
                        <ul>
                          <li className={`dm-dev ${nic.driver === 'outdated' ? 'warn' : nic.disabled ? 'off' : ''}`}>
                            {nic.driver === 'outdated' ? '⚠ ' : nic.disabled ? '⬇ ' : ''}
                            {ADAPTER_NAME}
                          </li>
                        </ul>
                      </li>
                    )}
                    <li>
                      <span className="dm-group">▾ Print queues</span>
                      <ul>
                        {['CR-PRN1 (1st floor copy room)', 'CR-PRN2 (2nd floor copy room)'].map((q) => (
                          <li key={q} className={`dm-dev ${pc.printDriver && !pc.printDriver.ok ? 'warn' : ''}`}>
                            {pc.printDriver && !pc.printDriver.ok ? '⚠ ' : ''}
                            {q} · NetSmart Universal PCL6 driver {pc.printDriver?.version ?? 'not installed'}
                          </li>
                        ))}
                      </ul>
                      {pc.printDriver && !pc.printDriver.ok && (
                        <button className="secondary small" onClick={() => setResult(game.updatePrintDriver(pcId))}>
                          Reinstall the printer driver
                        </button>
                      )}
                    </li>
                    <li>
                      <span className="dm-group">▸ Display adapters</span>
                    </li>
                    <li>
                      <span className="dm-group">▸ Keyboards</span>
                    </li>
                  </ul>
                  <div className="dm-props">
                    <h4>{nic.driver === 'missing' ? 'Ethernet Controller' : ADAPTER_NAME}</h4>
                    <p className="dm-state">
                      {nic.driver === 'missing'
                        ? 'The drivers for this device are not installed. (Code 28)'
                        : nic.driver === 'outdated'
                          ? 'This device cannot start. (Code 10)'
                          : nic.disabled
                            ? 'This device is disabled. (Code 22)'
                            : 'This device is working properly.'}
                    </p>
                    <p className="dm-ver">Driver version: {nic.version || 'none'}</p>
                    <div className="dm-buttons">
                      <button className="secondary small" onClick={() => setDriverDialog(true)}>
                        Update driver
                      </button>
                      {nic.driver !== 'missing' &&
                        (nic.disabled ? (
                          <button className="secondary small" onClick={() => act(setAdapterEnabled(net, pc, true))}>
                            Enable device
                          </button>
                        ) : (
                          <button className="secondary small" onClick={() => act(setAdapterEnabled(net, pc, false))}>
                            Disable device
                          </button>
                        ))}
                    </div>
                    {driverDialog && (
                      <div className="dm-dialog" role="group" aria-label="Update driver">
                        <p>How do you want to search for drivers?</p>
                        <button
                          className="secondary small"
                          onClick={() => {
                            act(updateDriver(net, pc, 'auto'));
                            setDriverDialog(false);
                          }}
                        >
                          Search automatically for drivers
                        </button>
                        <button
                          className="secondary small"
                          onClick={() => {
                            act(updateDriver(net, pc, 'usb'));
                            setDriverDialog(false);
                          }}
                        >
                          Browse my computer: {USB_DRIVER}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {tab === 'cmd' && (
                <div className="desk-cmd">
                  <Terminal net={net} deviceId={pcId} session={game.session(pcId)} tick={tick} visible />
                </div>
              )}
              {result && tab !== 'cmd' && <p className="desk-result">{result}</p>}
            </div>
          </>
        )}
      </section>

      <aside className="behind" aria-label="Behind the desk">
        <h3>Behind the desk</h3>
        <div className="nic-art" aria-hidden>
          <div className="nic-port">
            <span className={`led led-link ${back.linkLight ? 'on' : ''}`} />
            <span className={`led led-act ${back.linkLight ? 'blink' : ''}`} />
            <span className={`plug ${back.cableInNic ? 'in' : 'out'}`} />
          </div>
          <span className="nic-label">NIC</span>
        </div>
        <ul className="behind-facts">
          <li>Cable in the PC: {back.cableInNic ? 'yes' : 'no'}</li>
          <li>Link light: {back.linkLight ? 'green' : 'off'}</li>
          <li>{back.cableNote}</li>
          <li>
            Wall jack label: <span className="mono">{back.jackLabel}</span>
          </li>
        </ul>
        <div className="behind-actions">
          <button className="secondary small" onClick={() => act(reseatCable(net, pc))}>
            Reseat cable
          </button>
          <button className="secondary small" onClick={() => act(replaceCable(net, pc))}>
            Replace patch cable
          </button>
        </div>
      </aside>
    </div>
  );
}

function IpSettingsForm({ game, pcId, onResult }: { game: Game; pcId: string; onResult: (text: string) => void }) {
  const pc = game.net.device(pcId);
  const [s, setS] = useState(() => currentIpSettings(pc));
  const field = (key: 'ip' | 'mask' | 'gateway' | 'dns', label: string) => (
    <label className="ip-field">
      <span>{label}</span>
      <input
        id={`ip-${key}`}
        className="mono"
        value={s[key]}
        disabled={s.dhcp && key !== 'dns'}
        onChange={(e) => setS({ ...s, [key]: e.target.value })}
        placeholder={s.dhcp && key !== 'dns' ? 'from DHCP' : ''}
        spellCheck={false}
        autoComplete="off"
      />
    </label>
  );
  if (!pc.hostNet) return <p className="ns-hint">This machine's network settings are managed by the server team.</p>;
  return (
    <form
      className="ip-form"
      onSubmit={(e) => {
        e.preventDefault();
        onResult(applyIpSettings(game.net, pc, s));
      }}
    >
      <p className="ns-hint">Internet Protocol Version 4 (TCP/IPv4) Properties</p>
      <label className="ip-radio">
        <input type="radio" name="ipmode" checked={s.dhcp} onChange={() => setS({ ...s, dhcp: true })} /> Obtain an IP address automatically
      </label>
      <label className="ip-radio">
        <input type="radio" name="ipmode" checked={!s.dhcp} onChange={() => setS({ ...s, dhcp: false })} /> Use the following IP address:
      </label>
      <div className="ip-grid">
        {field('ip', 'IP address')}
        {field('mask', 'Subnet mask')}
        {field('gateway', 'Default gateway')}
      </div>
      <div className="ip-grid">{field('dns', s.dhcp ? 'Preferred DNS server (blank = from DHCP)' : 'Preferred DNS server')}</div>
      <div className="dm-buttons">
        <button className="primary small" type="submit">
          OK
        </button>
      </div>
    </form>
  );
}
