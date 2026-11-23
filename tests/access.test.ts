import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { Game } from '../src/game/game';
import { canMakeChange, outsiderCanChange } from '../src/game/access';
import { planGenerated } from '../src/game/generator';
import { TEMPLATES } from '../src/game/templates';
import { Rng } from '../src/sim/rng';
import { HostShell } from '../src/sim/host';
import { run } from './helpers';

const GEAR = ['rtr1', 'core1', 'acc1', 'acc2'];

function lockDown(net: ReturnType<typeof buildOffice>['net']): void {
  for (const id of GEAR) run(net, id, ['en', 'conf t', 'username nocadmin privilege 15 secret N0c-Only!2026', 'no username backup', 'end']);
}

describe('outsiders and the shared admin password', () => {
  it('the contractor, the MSP and Tom get in with the leaked password until it is changed', () => {
    const { net } = buildOffice('acc');
    for (const id of GEAR) expect(outsiderCanChange(net, 'tbrennan', id)).toBe(true);
    lockDown(net);
    for (const id of GEAR) {
      expect(outsiderCanChange(net, 'tbrennan', id)).toBe(false);
      expect(outsiderCanChange(net, 'dlindqvist', id)).toBe(false);
      expect(canMakeChange(net, 'jreyes', id)).toBe(true); // NOC staff have their own access
    }
  });

  it('a vty access-class for the NOC keeps them out even with the password', () => {
    const { net } = buildOffice('acc2');
    run(net, 'core1', ['en', 'conf t', 'access-list 5 permit 10.10.99.50', 'line vty 0 15', 'access-class 5 in', 'end']);
    expect(outsiderCanChange(net, 'dlindqvist', 'core1')).toBe(false);
    expect(outsiderCanChange(net, 'dlindqvist', 'rtr1')).toBe(true);
  });

  it('the NOC PC still logs in with its key after the password change', () => {
    const o = buildOffice('acc3');
    lockDown(o.net);
    const pc = new HostShell(o.net, 'noc', o.hostOptions.noc);
    pc.input('ssh nocadmin@10.10.99.11');
    pc.input('yes');
    expect(pc.promptText()).toBe('CR-ACC1#');
  });

  it('once locked down, no generated change is blamed on an outsider and their hand-built tickets stop', () => {
    const office = buildOffice('acc4');
    lockDown(office.net);
    const ctx = { net: office.net, office, rng: new Rng('acc4'), busyPcs: new Set([office.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
    for (let i = 0; i < 60; i++) {
      const p = planGenerated(ctx, 'moderate', 2);
      if (p && Number(p.actor) > 0) throw new Error(`blamed actor ${p.actor}`); // index 0 is Jordan
    }
    for (const id of ['nat-acl-narrowed', 'stp-loop', 'acl-web-filter', 'ospf-passive-default', 'duplex-mismatch', 'option82-outage', 'dai-printers', 'guest-no-gateway']) {
      expect(TEMPLATES.find((t) => t.id === id)!.canStart(ctx)).toBe(false);
    }
  });
});

describe('escalations are checked', () => {
  it('a coworker who fixes their part while users are still down hands it back instead of claiming it', () => {
    const g = new Game('esc-check');
    g.introPending = false;
    const tut = g.queue.tickets[0];
    // A second, office-wide fault the tutorial ticket doesn't cover: the internet is down too.
    run(g.net, 'rtr1', ['en', 'conf t', 'no ip route 0.0.0.0 0.0.0.0 203.0.113.1', 'end']);
    g.queue.escalate(tut.id, 'gloria');
    g.tick(60 * 60_000);
    const t = g.queue.find(tut.id);
    expect(t.status).not.toBe('senior-resolved');
    expect(t.activity.some((a) => a.text.startsWith('Fixed and checked'))).toBe(false);
  });
});
