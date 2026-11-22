import { describe, expect, it } from 'vitest';
import { ALL } from '../src/game/chat';
import { Game } from '../src/game/game';
import { HostShell } from '../src/sim/host';
import { run } from './helpers';

const MIN = 60_000;

function playABit(): Game {
  const game = new Game('save');
  // Fix the tutorial over SSH (adds a known host), start a couple of tickets, chat, take notes.
  const pc = new HostShell(game.net, 'noc', game.office.hostOptions.noc);
  pc.input('ssh nocadmin@10.10.99.11');
  pc.input('yes');
  pc.input('conf t');
  pc.input('int fa0/7');
  pc.input('no shut');
  pc.input('end');
  game.queue.resolve('INC-1001', 'no shut Fa0/7');
  game.queue.startTemplate('moved-desk', 30_000);
  game.queue.startTemplate('driver-outdated', 30_000);
  game.chat.send(ALL, 'Heads up: working on a couple of desk issues.');
  const note = game.addNote();
  game.updateNote(note.id, 'ACC1 quirks', 'Fa0/7 was shut at handover.');
  game.walkTo('acc1');
  game.tick(4 * MIN);
  return game;
}

function snapshot(game: Game) {
  return {
    time: game.net.time,
    logs: game.net.logs.length,
    tickets: game.queue.tickets.map((t) => [t.id, t.status, t.priority, t.draft.templateId]),
    lifetime: game.queue.lifetimePoints,
    chat: Object.fromEntries(Object.entries(game.chat.state.convs).map(([k, c]) => [k, c.messages.length])),
    asleep: [...game.net.devices.values()].filter((d) => !d.powered).map((d) => d.id),
  };
}

describe('saving and loading', () => {
  it('restores everything: network, tickets, chat, notes, location, known hosts', () => {
    const game = playABit();
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(snapshot(restored)).toEqual(snapshot(game));
    expect(restored.location).toBe('acc1');
    expect(restored.notes[0].title).toBe('ACC1 quirks');
    expect(restored.knownHosts.has('10.10.99.11')).toBe(true);
    expect(restored.net.device('acc1').running.interfaces['FastEthernet0/7'].shutdown).toBe(false);
    // The moved-desk ticket really moved the cable, and the person's desk.
    const moved = restored.queue.tickets.find((t) => t.draft.templateId === 'moved-desk')!;
    expect(restored.net.peerOf(moved.draft.reporter.pcId, 'FastEthernet0')?.iface).toBe(String(moved.draft.params.port));
    expect(moved.draft.reporter.desk).toBe(String(moved.draft.params.desk));
  });

  it('a restored game plays out exactly like the original', () => {
    const game = playABit();
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    game.tick(15 * MIN);
    restored.tick(15 * MIN);
    expect(snapshot(restored)).toEqual(snapshot(game));
  });

  it('restored tickets still verify and fix the real network', () => {
    const game = playABit();
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    const t = restored.queue.tickets.find((x) => x.draft.templateId === 'driver-outdated')!;
    expect(t.draft.check()).toBe(false);
    t.draft.fix();
    expect(restored.queue.resolve(t.id, 'updated driver').ok).toBe(true);
  });

  it('unsaved device config is kept separately from startup config', () => {
    const game = new Game('save2');
    run(game.net, 'acc2', ['en', 'conf t', 'hostname FLOOR2', 'end']);
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(restored.net.device('acc2').running.hostname).toBe('FLOOR2');
    expect(restored.net.device('acc2').startup!.hostname).toBe('CR-ACC2');
    expect(restored.configUnsaved(restored.net.device('acc2'))).toBe(true);
  });

  it('a save is a reasonable size', () => {
    const game = playABit();
    game.tick(30 * MIN);
    expect(JSON.stringify(game.toSave()).length).toBeLessThan(1_500_000);
  });
});

describe('first day', () => {
  it('a new game starts with the intro pending; the flags survive a save', () => {
    const game = new Game('intro');
    expect(game.introPending).toBe(true);
    expect(game.debriefDue).toBe(false);
    game.introPending = false;
    game.queue.tickets[0].draft.fix();
    game.queue.resolve('INC-1001', '');
    expect(game.debriefDue).toBe(true);
    game.debriefShown = true;
    const restored = new Game(game.seed, JSON.parse(JSON.stringify(game.toSave())));
    expect(restored.introPending).toBe(false);
    expect(restored.debriefDue).toBe(false);
  });
});
