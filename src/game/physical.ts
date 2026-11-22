// The physical layer you can touch: switch front panels (port LEDs, the labels stuck above each port, moving patch
// cables), the printers' own front panels (cable, network settings, firmware) and the print drivers on PCs.

import type { Office } from '../content/office';
import { shortIfName } from '../sim/ifnames';
import type { Network } from '../sim/network';
import type { Device } from '../sim/types';
import { isHostKind, isSwitchKind } from '../sim/types';

export const LATEST_PRINTER_FIRMWARE = '4.2.0';
export const LATEST_PRINT_DRIVER = '7.1.3';

/** A patch cable you unplugged from a switch and haven't plugged in again. */
export interface CableInHand {
  /** The far end of the cable (what it really connects to; the player isn't told). */
  device: string;
  iface: string;
  /** Where it came from. */
  fromDevice: string;
  fromPort: string;
}

/** Writes the labels a tidy predecessor stuck above the switch ports. They are physical: config changes don't touch them. */
export function initLabels(net: Network, office: Office): void {
  for (const sw of net.devices.values()) {
    if (!isSwitchKind(sw.kind)) continue;
    const labels: Record<string, string> = {};
    for (const port of Object.keys(sw.hardware)) {
      const peer = net.peerOf(sw.id, port);
      const floor = sw.id === 'acc1' ? 1 : sw.id === 'acc2' ? 2 : null;
      const n = Number(port.split('/')[1]);
      if (peer) {
        const pd = net.device(peer.device);
        const person = office.people.find((p) => p.pcId === pd.id);
        if (person) labels[port] = `Desk ${person.desk}`;
        else if (pd.kind === 'printer') labels[port] = 'Copy room printer';
        else if (pd.kind === 'server') labels[port] = pd.running.hostname;
        else if (pd.id === 'noc') labels[port] = 'NOC desk';
        else if (pd.id === 'conf1') labels[port] = 'Conf room';
        else labels[port] = `To ${pd.running.hostname} ${shortIfName(peer.iface)}`;
      } else if (floor && port.startsWith('Fast') && n >= 11 && n <= 19) labels[port] = `Desk ${floor}-${String(n).padStart(2, '0')}`;
    }
    sw.portLabels = labels;
  }
  for (const d of net.devices.values()) {
    if (d.kind === 'printer') d.firmware = '3.8.1';
    if (d.kind === 'pc') d.printDriver = { version: LATEST_PRINT_DRIVER, ok: true };
  }
}

/** Front-panel LED for a port: off, green (up), blinking amber (blocking / err-disabled / suspended). */
export function portLed(net: Network, sw: Device, port: string): 'off' | 'green' | 'amber' {
  const st = net.state(sw.id, port);
  if (st.err || st.suspended) return 'amber';
  if (st.protocol !== 'up') return 'off';
  const ifc = sw.running.interfaces[port];
  if (ifc?.switchport) {
    for (const key of net.stp.blocked) if (key.startsWith(`${sw.id}|${port}|`)) return 'amber';
  }
  return 'green';
}

export function canTouchPorts(d: Device): boolean {
  return !isHostKind(d.kind) && d.managed;
}
