import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import { commandsOf, dryRun, matchRunbook, parseTriggers, runRunbook, toggleCommands, triggerMatches } from '../src/game/runbooks';
import { Rng } from '../src/sim/rng';

const PORT_RUNBOOK = [
  'Port down at a desk: bring the port back.',
  '» ssh {switch}',
  '» show interfaces status | include {port}',
  '» conf t',
  '» interface {port}',
  '» no shutdown',
  '» end',
  'If it is err-disabled, escalate instead.',
].join('\n');

const t = (subject: string, description: string) => ({ draft: { subject, description, reporter: { pcId: 'ws07' } } }) as never;

describe('runbook triggers (one statement per line, OR / AND)', () => {
  it('any true line runs it; AND needs every phrase; phrases can have spaces; operators are uppercase', () => {
    const trig = "printer OR can't print\nno internet AND my desk\noffline AND black and white";
    expect(parseTriggers(trig).ok).toBe(true);
    expect(triggerMatches(trig, t('Printer offline', ''))).toBe(true);
    expect(triggerMatches(trig, t('Help', "I can't print anything"))).toBe(true);
    expect(triggerMatches(trig, t('No internet', 'at my desk since 9'))).toBe(true);
    expect(triggerMatches(trig, t('No internet', 'for everyone'))).toBe(false);
    expect(triggerMatches(trig, t('Offline', 'the black and white one'))).toBe(true);
    expect(parseTriggers('AND printer').ok).toBe(false);
    expect(parseTriggers('printer OR').ok).toBe(false);
    expect(parseTriggers('printer OR AND x').ok).toBe(false);
  });

  it('matchRunbook picks the first enabled runbook that matches and has commands', () => {
    const books = [
      { id: 'a', title: 'off', body: '» ping {ip}', runbook: { triggers: 'printer', enabled: false } },
      { id: 'b', title: 'no cmds', body: 'just text', runbook: { triggers: 'printer', enabled: true } },
      { id: 'c', title: 'yes', body: '» ping {ip}', runbook: { triggers: 'printer', enabled: true } },
    ];
    expect(matchRunbook(books, t('Printer down', ''))!.id).toBe('c');
  });
});

describe('marking commands and running them', () => {
  it('"This is a command" toggles the marker on the selected lines', () => {
    const body = 'Bring the port up\nssh {switch}\nconf t';
    const marked = toggleCommands(body, body.indexOf('ssh'), body.length);
    expect(commandsOf(marked)).toEqual(['ssh {switch}', 'conf t']);
    expect(toggleCommands(marked, marked.indexOf('ssh'), marked.length)).toBe(body);
  });

  it('a runbook typed with no typos fixes the tutorial port; the log shows what happened', () => {
    const g = new Game('rb');
    const ticket = g.queue.tickets[0];
    expect(ticket.draft.check()).toBe(false);
    expect(dryRun(g.net, PORT_RUNBOOK, ticket)).toContain('interface Fa0/7');
    const log = runRunbook(g.net, g.office, PORT_RUNBOOK, ticket, { typoRate: 0, noticesErrors: true, rng: new Rng('x') });
    expect(log[0].typed).toBe('ssh 10.10.99.11');
    expect(log.some((e) => e.output.some((l) => /administratively down|disabled/.test(l)))).toBe(true);
    expect(ticket.draft.check()).toBe(true);
  });

  it('typos happen at the given rate; careless typists leave them, careful ones retype', () => {
    const g = new Game('rb2');
    const ticket = g.queue.tickets[0];
    const sloppy = runRunbook(g.net, g.office, PORT_RUNBOOK, ticket, { typoRate: 1, noticesErrors: false, rng: new Rng('y') });
    expect(sloppy.every((e) => e.meant === undefined || e.typed !== e.meant)).toBe(true);
    expect(sloppy.filter((e) => e.meant !== undefined).length).toBeGreaterThan(3);
    const careful = runRunbook(g.net, g.office, PORT_RUNBOOK, ticket, { typoRate: 0.5, noticesErrors: true, rng: new Rng('z') });
    expect(careful.length).toBeGreaterThan(6);
  });
});
