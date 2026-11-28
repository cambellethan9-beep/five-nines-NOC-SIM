import { describe, expect, it } from 'vitest';
import { adviceFor, docFacts, factTrue } from '../src/game/docfacts';
import { FAULTS } from '../src/game/faults';
import { Game } from '../src/game/game';
import { chanceToFix, learnPerTopic, skillOf } from '../src/game/team';
import { TEMPLATES } from '../src/game/templates';
import { FAULT_TOPICS, growthBonus, playerSkills, TEMPLATE_TOPICS, ticketTopics, TOPICS, type TopicScore } from '../src/game/topics';

const MIN = 60_000;

function game(seed: string) {
  const g = new Game(seed);
  g.introPending = false;
  g.declinePlacement();
  return g;
}

function withIntern(seed: string) {
  const g = game(seed);
  g.queue.rankIndex = 1;
  const e = g.team.takeIntern(g, g.net.rng)!;
  return { g, e };
}

describe('topics', () => {
  it('every fault building block and ticket template is tagged', () => {
    for (const f of FAULTS) expect(FAULT_TOPICS[f.id]?.length, f.id).toBeGreaterThan(0);
    for (const t of TEMPLATES) if (t.id !== 'generated') expect(TEMPLATE_TOPICS[t.id]?.length, t.id).toBeGreaterThan(0);
    const ids = new Set(TOPICS.map((t) => t.id));
    for (const list of [...Object.values(FAULT_TOPICS), ...Object.values(TEMPLATE_TOPICS)]) for (const t of list) expect(ids.has(t)).toBe(true);
  });

  it('your radar scores a quick fix high, and a hint or false resolve lower', () => {
    const g = game('radar');
    const tut = g.queue.tickets[0];
    tut.draft.fix();
    g.queue.resolve(tut.id, 'fixed');
    // The tutorial doesn't count.
    expect(playerSkills(g.queue.tickets, []).every((s) => s.score === null)).toBe(true);
    expect(g.queue.startTemplate('wrong-vlan', 0)).toBe(true);
    g.tick(5000);
    const t = g.queue.openTickets()[0];
    expect(ticketTopics(t.draft)).toEqual(['switching']);
    t.draft.fix();
    g.queue.resolve(t.id, 'fixed');
    const quick = playerSkills(g.queue.tickets, []).find((s) => s.topic === 'switching')!;
    expect(quick.score).toBeGreaterThan(85);
    const hinted = playerSkills(g.queue.tickets, [t.id]).find((s) => s.topic === 'switching')!;
    expect(hinted.score).toBe(quick.score! - 15);
  });
});

describe('employee skills', () => {
  it('learning by doing: more per topic when a ticket spans topics', () => {
    expect([1, 2, 3, 4].map(learnPerTopic)).toEqual([2, 3, 4, 4]);
  });

  it('certificates raise topic skills', () => {
    const { g, e } = withIntern('cert');
    const before = skillOf(e, 'security');
    e.status = { kind: 'training', cert: 'NSCS', remainingRealMs: 1 };
    g.realTick(10);
    expect(skillOf(e, 'security')).toBe(before + 35);
  });

  it('works a ticket without a runbook when confident, fixes it, and learns from it', () => {
    const { g, e } = withIntern('own');
    e.skills = { ...e.skills!, switching: 80 };
    const tut = g.queue.tickets[0];
    expect(chanceToFix(e, tut, g)).toBeGreaterThan(0.7);
    g.tick(5000);
    expect(e.status.kind).toBe('investigating');
    expect(tut.assignedTo).toBe(e.name);
    g.tick(20 * MIN);
    // Either fixed or handed back, they learned VLANs either way.
    expect(skillOf(e, 'switching')).toBe(82);
    expect(g.chat.conv(`emp:${e.id}`).messages.length).toBeGreaterThan(0);
    expect(g.team.state.history.some((h) => /learned from INC-1001: VLANs \+2%/.test(h.text))).toBe(true);
  });

  it("doesn't touch tickets it's not confident about, and you can hand them one in chat", () => {
    const { g, e } = withIntern('chat');
    e.skills = { ...e.skills!, switching: 0 };
    g.tick(30_000);
    expect(e.status.kind).toBe('idle');
    g.chat.send(`emp:${e.id}`, 'status');
    g.chat.send(`emp:${e.id}`, 'take INC-1001');
    expect(e.status.kind).toBe('investigating');
    g.tick(20_000);
    const msgs = g.chat.conv(`emp:${e.id}`).messages.filter((m) => m.from !== 'you').map((m) => m.text);
    expect(msgs.some((m) => /Free/.test(m))).toBe(true);
    expect(msgs.some((m) => /not sure I can fix/.test(m))).toBe(true);
    g.chat.send(`emp:${e.id}`, 'drop it');
    expect(e.status.kind).toBe('idle');
    g.chat.send(`emp:${e.id}`, 'focus on printers');
    expect(e.focus).toBe('endpoints');
    g.chat.send(`emp:${e.id}`, 'only when I tell you');
    expect(e.focus).toBe('told');
  });
});

describe('employees learn from your docs', () => {
  it('the inherited docs start out true, and a moved desk makes the port map stale', () => {
    const g = game('docs');
    const facts = docFacts(g);
    expect(facts.length).toBeGreaterThan(20);
    for (const f of facts) expect(factTrue(g.net, f), `${f.where}: ${f.says}`).toBe(true);
    g.queue.tickets[0].draft.fix();
    g.queue.resolve('INC-1001', 'x');
    g.notifyUser('INC-1001', 'direct');
    expect(g.queue.startTemplate('moved-desk', 0)).toBe(true);
    g.tick(5000);
    const t = g.queue.openTickets()[0];
    const advice = adviceFor(g, t);
    expect(advice.stale).not.toBeNull();
    expect(advice.stale!.where).toBe('the "Desk and port map" doc');
    expect(advice.stale!.says).toContain(t.draft.reporter.name);
  });

  it('stale docs mislead them; a newer note with the right port fixes that', () => {
    const { g, e } = withIntern('stale');
    e.focus = 'told';
    g.queue.tickets[0].draft.fix();
    g.queue.resolve('INC-1001', 'x');
    g.notifyUser('INC-1001', 'direct');
    expect(g.queue.startTemplate('moved-desk', 0)).toBe(true);
    g.tick(5000);
    const t = g.queue.openTickets()[0];
    e.skills = { ...e.skills!, switching: 45 };
    const misled = chanceToFix(e, t, g);
    const peer = g.net.peerOf(t.draft.reporter.pcId, 'FastEthernet0')!;
    const sw = g.net.device(peer.device).running.hostname;
    const n = g.addNote();
    g.updateNote(n.id, 'Desk moves', `${t.draft.reporter.name} moved: now on ${sw} ${peer.iface.replace('FastEthernet', 'Fa')}`);
    const advice = adviceFor(g, t);
    expect(advice.stale).toBeNull();
    expect(advice.bonus).toBeGreaterThan(0);
    expect(chanceToFix(e, t, g)).toBeGreaterThan(misled + 0.3);
  });
});

describe('growth bonus', () => {
  const radar = (score: number | null): TopicScore[] => TOPICS.map((t) => ({ topic: t.id, score: t.id === 'nat' ? score : 90, tickets: score === null ? 0 : 5 }));

  it('pays up to half the base points in a weak topic, nothing at 70+', () => {
    expect(growthBonus(['nat'], radar(0), 140)!.points).toBe(70);
    expect(growthBonus(['nat'], radar(35), 140)!.points).toBe(35);
    expect(growthBonus(['nat'], radar(null), 140)!.points).toBe(35); // untried counts as 35
    expect(growthBonus(['nat'], radar(70), 140)).toBeNull();
    expect(growthBonus(['nat'], radar(95), 140)).toBeNull();
    // The weakest topic on the ticket decides.
    expect(growthBonus(['acl', 'nat'], radar(0), 220)!.topic).toBe('nat');
  });

  it('shows up on a real resolve, but not after Owen\'s hint', () => {
    const g = game('growth');
    g.queue.tickets[0].draft.fix();
    const tut = g.queue.resolve('INC-1001', 'x');
    expect(tut.lines.some((l) => l.label.startsWith('Growth'))).toBe(false); // not on the tutorial
    g.notifyUser('INC-1001', 'direct');
    expect(g.queue.startTemplate('nat-no-overload', 0)).toBe(true);
    g.tick(5000);
    const t = g.queue.openTickets()[0];
    t.draft.fix();
    const r = g.queue.resolve(t.id, 'fixed');
    expect(r.lines.find((l) => l.label.startsWith('Growth: NAT'))?.points).toBeGreaterThan(0);
    expect(g.queue.startTemplate('nat-inside-missing', 0)).toBe(true);
    g.tick(5000);
    const t2 = g.queue.openTickets()[0];
    (g.chat.state.hinted ??= []).push(t2.id);
    t2.draft.fix();
    expect(g.queue.resolve(t2.id, 'fixed').lines.some((l) => l.label.startsWith('Growth'))).toBe(false);
  });
});
