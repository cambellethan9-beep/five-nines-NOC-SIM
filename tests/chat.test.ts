import { describe, expect, it } from 'vitest';
import { ALL, personaOf } from '../src/game/chat';
import { Game } from '../src/game/game';

const SEC = 1000;
const MIN = 60 * SEC;

function fixTutorial(game: Game): void {
  game.queue.tickets[0].draft.fix();
}

describe('office chat', () => {
  it('people complain on their own during an outage, mostly in the all-staff channel', () => {
    const game = new Game('chat');
    fixTutorial(game);
    game.queue.startTemplate('default-route', 10 * MIN);
    game.tick(6 * MIN);
    const all = game.chat.conv(ALL).messages.filter((m) => m.from !== 'you');
    expect(all.length).toBeGreaterThanOrEqual(5);
    expect(game.chat.totalUnread()).toBeGreaterThan(0);
  });

  it('an announcement to everyone pushes complaints back', () => {
    const game = new Game('chat2');
    fixTutorial(game);
    game.queue.startTemplate('default-route', 10 * MIN);
    game.tick(2 * MIN);
    game.chat.send(ALL, "We know the internet is down, working on it now. ETA 10 minutes.");
    const now = game.net.time;
    expect(game.chat.state.calmUntil).toBeGreaterThan(now);
    for (const t of Object.values(game.chat.state.nextComplaint)) expect(t).toBeGreaterThanOrEqual(now + 4 * MIN);
  });

  it('a helpful user plugs their own cable back in when asked', () => {
    const game = new Game('chat3');
    const helpful = game.office.people.find((p) => personaOf(p) === 'helpful' && p.pcId !== game.office.tutorial.pcId)!;
    game.net.linkAt(helpful.pcId, 'FastEthernet0')!.cable = 'unplugged';
    game.net.commit();
    game.chat.send(helpful.pcId, 'Can you check the network cable behind your computer?');
    game.tick(30 * SEC);
    const reply = game.chat.conv(helpful.pcId).messages.at(-1)!;
    expect(reply.from).toBe(helpful.pcId);
    expect(reply.text).toMatch(/Plugged it back in/);
    expect(game.net.linkAt(helpful.pcId, 'FastEthernet0')!.cable).toBe('ok');
  });

  it('answers come from the real state of the machine', () => {
    const game = new Game('chat4');
    const p = game.office.people.find((x) => personaOf(x) === 'helpful' && x.pcId !== game.office.tutorial.pcId)!;
    game.net.device(p.pcId).nic!.driver = 'outdated';
    game.net.commit();
    game.chat.send(p.pcId, 'what does device manager say about your network adapter?');
    game.tick(30 * SEC);
    expect(game.chat.conv(p.pcId).messages.slice(-3).map((m) => m.text).join(' | ')).toContain('Code 10');
    game.chat.send(p.pcId, 'what does ipconfig show?');
    game.tick(30 * SEC);
    expect(game.chat.conv(p.pcId).messages.slice(-3).map((m) => m.text).join(' | ')).toContain('Media disconnected');
  });

  it('a user with nothing wrong says so', () => {
    const game = new Game('chat5');
    const p = game.office.people.find((x) => personaOf(x) === 'helpful' && x.pcId !== game.office.tutorial.pcId)!;
    game.net.device(p.pcId).powered = true;
    game.net.commit();
    game.tick(5 * SEC);
    game.chat.send(p.pcId, 'Can you help me with something?');
    game.tick(30 * SEC);
    expect(game.chat.conv(p.pcId).messages.at(-1)!.text).toMatch(/fine on my end/);
  });

  it('every persona appears among the staff', () => {
    const game = new Game('chat6');
    const personas = new Set(game.office.people.map(personaOf));
    expect([...personas].sort()).toEqual(['clueless', 'ghost', 'helpful', 'impatient']);
  });
});

describe('conversation flow', () => {
  function setup() {
    const game = new Game('talk');
    const p = game.office.people.find((x) => personaOf(x) === 'helpful' && x.pcId !== game.office.tutorial.pcId)!;
    game.net.device(p.pcId).powered = true;
    game.net.commit();
    game.tick(5 * SEC);
    const say = (text: string) => {
      const before = game.chat.conv(p.pcId).messages.length;
      game.chat.send(p.pcId, text);
      game.tick(30 * SEC);
      const msgs = game.chat.conv(p.pcId).messages;
      // Returns their reply, or null if they didn't answer.
      return msgs.length > before + 1 ? msgs.at(-1)!.text : null;
    };
    return { game, p, say };
  }

  it('"Nope, that\'s all" ends the conversation instead of asking again', () => {
    const { say } = setup();
    expect(say('hey')).toMatch(/about my computer/);
    expect(say('no')).toMatch(/What's up then/);
    expect(say("Nope, that's all")).toMatch(/have a good one|Sounds good/);
  });

  it('plain acknowledgments get no reply', () => {
    const { say } = setup();
    expect(say('ok')).toBeNull();
    expect(say('cool')).toBeNull();
  });

  it('thanks and "hold on" get sensible answers', () => {
    const { say } = setup();
    expect(say('thanks!')).toBe('No problem!');
    expect(say('give me a sec')).toBe('No rush!');
  });

  it('confusion is said once, then they stop replying instead of looping', () => {
    const { say } = setup();
    expect(say('purple monkey dishwasher')).toMatch(/Did you need something/);
    expect(say('banana')).toMatch(/not sure what you mean/);
    expect(say('asdf')).toBeNull();
    // Understanding something resets it.
    expect(say('what desk are you at?')).toMatch(/desk/);
  });

  it('answering yes to "did you need something" moves the conversation on', () => {
    const { say } = setup();
    say('purple monkey dishwasher');
    expect(say('yes')).toMatch(/what's up/i);
  });
});
