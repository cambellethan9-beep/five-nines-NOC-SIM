import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { Game } from '../src/game/game';
import { FAULTS } from '../src/game/faults';
import { generatedTemplate, planGenerated } from '../src/game/generator';
import { rebuildDraft } from '../src/game/templates';
import { Rng } from '../src/sim/rng';
import type { Difficulty } from '../src/game/scoring';

const ctxFor = (seed: string) => {
  const office = buildOffice(seed);
  return { net: office.net, office, rng: new Rng(seed), busyPcs: new Set([office.tutorial.pcId]), activeTemplates: new Set<string>(), usedTemplates: new Set<string>() };
};

describe('fault building blocks', () => {
  for (const f of FAULTS) {
    it(`${f.id}: breaks real services, the ticket check fails until fix()`, () => {
      const ctx = ctxFor(`f-${f.id}`);
      const people = ctx.office.people.map((p) => p.pcId).filter((pc) => pc !== ctx.office.tutorial.pcId);
      const sites = f.sites(ctx.net, ctx.office, people);
      expect(sites.length).toBeGreaterThan(0);
      const site = sites[0];
      const victims = f.victims(ctx.net, ctx.office, site).filter((pc) => people.includes(pc));
      expect(victims.length).toBeGreaterThan(0);
      const params: Record<string, string | number | boolean> = { atoms: JSON.stringify([{ id: f.id, site }]), pcId: victims[0], diff: f.difficulty, herring: -1, actor: -1, variant: 0 };
      const draft = generatedTemplate.build(ctx, params);
      draft.inject();
      const lost = JSON.parse(String(params.lost));
      expect(Object.keys(lost).length).toBeGreaterThan(0);
      expect(draft.check()).toBe(false);
      expect(draft.subject.length).toBeGreaterThan(3);
      expect(draft.description.length).toBeGreaterThan(10);
      draft.fix();
      expect(draft.check()).toBe(true);
    });
  }
});

describe('generated incidents', () => {
  for (const rank of [0, 1, 2, 3, 4]) {
    it(`rank ${rank}: twenty generated tickets each break something, fail, then pass after fix`, () => {
      const order: Difficulty[] = ['trivial', 'easy', 'moderate', 'hard', 'expert'];
      for (let i = 0; i < 20; i++) {
        const ctx = ctxFor(`g-${rank}-${i}`);
        const params = planGenerated(ctx, order[i % 5], rank);
        expect(params).not.toBeNull();
        const draft = generatedTemplate.build(ctx, JSON.parse(JSON.stringify(params)));
        draft.inject();
        expect(draft.check()).toBe(false);
        // A save in the middle: the rebuilt ticket knows the same faults and impact.
        const again = rebuildDraft(ctx, 'generated', JSON.parse(JSON.stringify(draft.params)));
        expect(again.description).toBe(draft.description);
        expect(again.check()).toBe(false);
        again.fix();
        expect(draft.check()).toBe(true);
      }
    });
  }

  it('compound problems and red herrings show up at senior ranks', () => {
    let multi = 0;
    let herrings = 0;
    for (let i = 0; i < 40; i++) {
      const ctx = ctxFor(`m-${i}`);
      const p = planGenerated(ctx, 'hard', 3)!;
      if (JSON.parse(String(p.atoms)).length > 1) multi++;
      if (Number(p.herring) >= 0) herrings++;
    }
    expect(multi).toBeGreaterThan(5);
    expect(herrings).toBeGreaterThan(5);
  });

  it('the queue mixes generated and hand-built tickets', () => {
    const game = new Game('mix');
    game.introPending = false;
    game.queue.tickets[0].draft.fix();
    game.queue.resolve('INC-1001', 'fixed');
    game.notifyUser('INC-1001', 'direct');
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      game.tick(10 * 60_000);
      for (const t of game.queue.openTickets()) {
        seen.add(t.draft.templateId === 'generated' ? 'generated' : 'hand');
        t.draft.fix();
        game.queue.resolve(t.id, 'fixed');
        game.notifyUser(t.id, 'direct');
      }
      if (game.report) game.startNextShift();
    }
    expect(seen.has('generated')).toBe(true);
  });
});
