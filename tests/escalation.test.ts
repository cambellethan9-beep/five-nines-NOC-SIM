import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { total } from '../src/game/scoring';

const MIN = 60_000;

describe('escalation', () => {
  it('Owen really fixes an escalated ticket, explains it, and you get partial credit', () => {
    const game = new Game('esc');
    const t = game.queue.tickets[0];
    expect(game.queue.escalate(t.id, 'owen')).toMatch(/escalated to Owen Price/);
    expect(t.status).toBe('escalated');
    game.tick(13 * MIN);
    expect(t.status).toBe('senior-resolved');
    expect(t.resolvedBy).toBe('owen');
    expect(game.tutorialSolved()).toBe(true); // the network really changed
    expect(total(t.score)).toBe(Math.round(40 * 0.35));
    const dm = game.chat.conv('cw:owen').messages.map((m) => m.text).join(' ');
    expect(dm).toMatch(/administratively shut down/);
  });

  it('you can only escalate upward; Jordan counts while you are both Tier 1', () => {
    const game = new Game('esc');
    expect(game.queue.escalationTargets().map((c) => c.id)).toEqual(['jordan', 'owen', 'gloria']);
    game.queue.rankIndex = 1; // Tier 2: only Gloria is above you
    expect(game.queue.escalationTargets().map((c) => c.id)).toEqual(['gloria']);
    game.queue.rankIndex = 4; // NOC Manager: nobody above, but Jordan and Owen work for you
    expect(game.queue.escalationTargets().map((c) => c.id)).toEqual(['jordan', 'owen']);
    expect(game.queue.escalate(game.queue.tickets[0].id, 'gloria')).toMatch(/doesn't outrank you/);
  });

  it("a coworker who's busy can't take another ticket", () => {
    const game = new Game('esc');
    game.queue.escalate(game.queue.tickets[0].id, 'owen');
    game.queue.startTemplate('wrong-vlan', 0);
    game.tick(5_000);
    const second = game.queue.tickets.find((x) => x.draft.templateId === 'wrong-vlan')!;
    expect(game.queue.escalate(second.id, 'owen')).toMatch(/busy/);
  });

  it('Jordan sometimes hands a hard one back, and you can escalate again', () => {
    let handedBack = false;
    for (let seed = 0; seed < 30 && !handedBack; seed++) {
      const game = new Game(`esc-${seed}`);
      game.queue.startTemplate('trunk-pruned', 0);
      game.tick(5_000);
      const t = game.queue.tickets.find((x) => x.draft.templateId === 'trunk-pruned')!;
      game.queue.escalate(t.id, 'jordan');
      game.tick(16 * MIN);
      if (t.status === 'in-progress') {
        handedBack = true;
        expect(t.escalation).toBeNull();
        expect(game.chat.conv('cw:jordan').messages.at(-1)!.text).toMatch(/Couldn't figure this one out/);
        expect(game.queue.escalate(t.id, 'owen')).toMatch(/escalated/);
      }
    }
    expect(handedBack).toBe(true);
  });

  it('sending the manager a routine ticket costs you', () => {
    const game = new Game('esc');
    const t = game.queue.tickets[0];
    game.queue.escalate(t.id, 'gloria');
    game.tick(9 * MIN);
    expect(t.score.some((l) => l.label === 'Sent the manager a routine ticket')).toBe(true);
    expect(game.chat.conv('cw:gloria').messages.at(-1)!.text).toMatch(/try Owen first/);
  });

  it('fixing it yourself before they get to it cancels the escalation and pays normally', () => {
    const game = new Game('esc');
    const t = game.queue.tickets[0];
    game.queue.escalate(t.id, 'jordan');
    t.draft.fix();
    const r = game.queue.resolve(t.id, 'did it myself');
    expect(r.ok).toBe(true);
    expect(t.escalation).toBeNull();
    expect(total(r.lines)).toBeGreaterThan(40 * 0.5);
  });

  it('asking Owen for help nudges you once per ticket', () => {
    const game = new Game('esc');
    game.chat.send('cw:owen', 'any idea on this one?');
    game.tick(70_000);
    const first = game.chat.conv('cw:owen').messages.at(-1)!.text;
    expect(first).toMatch(/^For INC-1001: Start at their switch port/);
    game.chat.send('cw:owen', 'still stuck');
    game.tick(70_000);
    expect(game.chat.conv('cw:owen').messages.at(-1)!.text).toMatch(/escalate it to me/);
  });

  it('escalations survive a save and finish after loading', () => {
    const game = new Game('esc');
    game.queue.escalate(game.queue.tickets[0].id, 'owen');
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    restored.tick(13 * MIN);
    expect(restored.queue.tickets[0].status).toBe('senior-resolved');
    expect(restored.chat.conv('cw:owen').messages.length).toBeGreaterThan(0);
  });
});
