import { describe, expect, it } from 'vitest';
import { buildOffice } from '../src/content/office';
import { CliSession } from '../src/sim/cli/session';
import { run } from './helpers';

const lines = (s: string) => s.split('\n');

describe('output filters', () => {
  const { net } = buildOffice();

  it('include, exclude, begin and count on show commands, with abbreviations', () => {
    const inc = run(net, 'core1', ['en', 'show run | include ip address']);
    const body = lines(inc).slice(2);
    expect(body.length).toBeGreaterThan(3);
    expect(body.every((l) => l.includes('ip address'))).toBe(true);
    const ex = run(net, 'core1', ['en', 'sh ip int br | ex unassigned']);
    expect(lines(ex).slice(2).join('\n')).not.toContain('unassigned');
    expect(ex).toContain('Vlan10');
    const beg = run(net, 'core1', ['en', 'sh run | b interface Vlan10']);
    expect(lines(beg)[2]).toBe('interface Vlan10');
    expect(run(net, 'core1', ['en', 'sh run | c ^interface'])).toMatch(/Number of lines which match regexp = \d+/);
  });

  it('section prints whole blocks whose header or children match', () => {
    const out = run(net, 'core1', ['en', 'show running-config | section helper']);
    expect(out).toContain('interface Vlan10\n description STAFF gateway\n ip address 10.10.10.1 255.255.255.0\n ip helper-address 10.10.20.10');
    expect(out).not.toContain('interface Vlan20');
  });

  it('works from config mode with do, and over a regex', () => {
    const out = run(net, 'core1', ['en', 'conf t', 'do sh ip int br | i ^Vlan(10|20) ']);
    expect(out).toContain('Vlan10');
    expect(out).toContain('Vlan20');
    expect(out).not.toContain('Vlan30');
  });

  it('errors like IOS: non-show commands, unknown modifiers, missing pattern', () => {
    const s = new CliSession(net, 'core1');
    run(net, 'core1', ['en'], s);
    expect(run(net, 'core1', ['ping 10.10.10.1 | i !'], s)).toContain("% Invalid input detected at '^' marker.");
    const bad = run(net, 'core1', ['show run | grep ip'], s);
    expect(bad).toContain('^');
    expect(bad.split('\n')[1].indexOf('^')).toBe('CR-CORE1#show run | '.length);
    expect(run(net, 'core1', ['show run | include'], s)).toContain('% Incomplete command.');
  });

  it('a description with a pipe in it is still just a description', () => {
    const out = run(net, 'core1', ['en', 'conf t', 'int fa0/20', 'description spare | do not use', 'do sh run int fa0/20']);
    expect(out).toContain(' description spare | do not use');
  });

  it('? after the pipe lists the modifiers', () => {
    const s = new CliSession(net, 'core1');
    run(net, 'core1', ['en'], s);
    expect(s.help('show run | ').join('\n')).toContain('include   Include lines that match');
    expect(s.help('show run | s')).toEqual(['section']);
    expect(s.help('show run | include ')).toEqual(['  LINE  Regular Expression']);
  });
});
