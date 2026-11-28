import { useEffect, useRef, useState } from 'react';
import { ALL } from '../game/chat';
import { COWORKERS } from '../game/coworkers';
import type { Game } from '../game/game';

interface Props {
  game: Game;
  tick: number;
  active: string;
  onSelect: (id: string) => void;
}

export function ChatView({ game, tick, active, onSelect }: Props) {
  const chat = game.chat;
  const [draft, setDraft] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const conv = chat.conv(active);
  const count = conv.messages.length;

  // Viewing a conversation marks it read.
  useEffect(() => {
    chat.markRead(active);
  }, [chat, active, tick]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [active, count]);

  const lastAt = (id: string) => chat.state.convs[id]?.messages.at(-1)?.t ?? -1;
  const people = [...game.office.people].sort((a, b) => lastAt(b.pcId) - lastAt(a.pcId) || a.name.localeCompare(b.name));
  const nameOf = (from: string) => chat.nameOf(from);
  const teammate = active.startsWith('cw:') ? COWORKERS.find((c) => `cw:${c.id}` === active) : undefined;
  const employee = active.startsWith('emp:') ? game.team.find(active.slice(4)) : undefined;
  const person = active === ALL || employee ? null : chat.person(active);

  const send = () => {
    chat.send(active, draft);
    setDraft('');
  };

  return (
    <div className="chat-view">
      <nav className="chat-list" aria-label="Conversations">
        <button className={`chat-item ${active === ALL ? 'active' : ''}`} onClick={() => onSelect(ALL)}>
          <span className="ci-name"># everyone</span>
          <span className="ci-sub">All {game.office.people.length} staff in the building</span>
          {chat.unread(ALL) > 0 && active !== ALL && <span className="badge hot">{chat.unread(ALL)}</span>}
        </button>
        <h2 className="side-title">Your team</h2>
        {COWORKERS.map((c) => (
          <button key={c.id} className={`chat-item ${active === `cw:${c.id}` ? 'active' : ''}`} onClick={() => onSelect(`cw:${c.id}`)}>
            <span className="ci-name">{c.name}</span>
            <span className="ci-sub">{c.title}</span>
            {chat.unread(`cw:${c.id}`) > 0 && active !== `cw:${c.id}` && <span className="badge hot">{chat.unread(`cw:${c.id}`)}</span>}
          </button>
        ))}
        {game.team.employees.map((e) => (
          <button key={e.id} className={`chat-item ${active === `emp:${e.id}` ? 'active' : ''}`} onClick={() => onSelect(`emp:${e.id}`)}>
            <span className="ci-name">{e.name}</span>
            <span className="ci-sub">{e.title} · works for you</span>
            {chat.unread(`emp:${e.id}`) > 0 && active !== `emp:${e.id}` && <span className="badge hot">{chat.unread(`emp:${e.id}`)}</span>}
          </button>
        ))}
        <h2 className="side-title">Staff</h2>
        {people.map((p) => (
          <button key={p.pcId} className={`chat-item ${active === p.pcId ? 'active' : ''}`} onClick={() => onSelect(p.pcId)}>
            <span className="ci-name">{p.name}</span>
            <span className="ci-sub">
              {p.title} · desk {p.desk}
            </span>
            {chat.unread(p.pcId) > 0 && active !== p.pcId && <span className="badge hot">{chat.unread(p.pcId)}</span>}
          </button>
        ))}
      </nav>

      <section className="chat-main" aria-label="Messages">
        <p className="chat-disclaimer" role="note">
          Staff here can only handle simple conversation. Keep messages short and about one thing, like "Is the cable plugged into your
          computer?" or "Is it working now?" Their answers are based on what's really happening on their PC.
        </p>
        <header className="chat-head">
          <h2>{employee ? employee.name : teammate ? teammate.name : person ? person.name : '# everyone'}</h2>
          <p className="dp-model">
            {employee
              ? `${employee.title}. Short and literal: "take INC-1004", "use <runbook> on INC-1004", "drop it", "status", "skills", "train NSCA", "focus on printers", "only P1s", "anything", "only when I tell you".`
              : teammate
              ? `${teammate.title} · ${teammate.tenure}. ${teammate.blurb}`
              : person
              ? `${person.title} · desk ${person.desk} · ${game.net.device(person.pcId).running.hostname}`
              : 'Anything you post here goes to every person in the building. A status update calms people down for a while.'}
          </p>
        </header>
        <div className="chat-messages" ref={scroller}>
          {conv.messages.length === 0 && (
            <p className="empty">
              {teammate
                ? `No messages with ${teammate.name.split(' ')[0]} yet.`
                : person
                  ? `No messages with ${person.name.split(' ')[0]} yet.`
                  : 'Quiet for now. That will change the first time something breaks.'}
            </p>
          )}
          {conv.messages.map((m, i) => (
            <div key={i} className={`msg ${m.from === 'you' ? 'mine' : ''}`}>
              <span className="msg-meta">
                <strong>{nameOf(m.from)}</strong> <span className="mono">{game.net.formatLogTime(m.t).slice(-12, -7)}</span>
              </span>
              <p>{m.text}</p>
            </div>
          ))}
        </div>
        <form
          className="chat-compose"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            id="chat-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={
              employee
                ? `Message ${employee.name.split(' ')[0]}, e.g. "take INC-1004"`
                : teammate
                ? `Message ${teammate.name.split(' ')[0]}, e.g. "any idea on my ticket?"`
                : person
                  ? `Message ${person.name.split(' ')[0]}, e.g. "can you check the cable behind your PC?"`
                  : 'Post a status update to everyone'
            }
            autoComplete="off"
          />
          <button className="primary" type="submit" disabled={!draft.trim()}>
            Send
          </button>
        </form>
      </section>
    </div>
  );
}
