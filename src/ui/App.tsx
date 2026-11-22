import { useEffect, useRef, useState } from 'react';
import { COMPANY } from '../content/office';
import { Game, WALK_MS } from '../game/game';
import { ALL } from '../game/chat';
import { SLA } from '../game/scoring';
import { clearSave, loadGame, saveGame } from '../game/storage';
import { ChatView } from './ChatView';
import { DeskView } from './DeskView';
import { DocsView } from './DocsView';
import { DebriefDialog, IntroDialog } from './Intro';
import { LogsView } from './LogsView';
import { MapView } from './MapView';
import { MonitorView } from './MonitorView';
import { ShiftReportDialog } from './ShiftReport';
import { Terminal } from './Terminal';
import { TicketsView } from './TicketsView';

const TICK_MS = 250;

type View = 'tickets' | 'chat' | 'map' | 'monitor' | 'logs' | 'docs';

const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'tickets', label: 'Tickets', hint: 'Your queue and SLAs' },
  { id: 'chat', label: 'Chat', hint: 'Everyone in the building' },
  { id: 'map', label: 'Map', hint: 'Topology and devices' },
  { id: 'monitor', label: 'Monitor', hint: 'Health and traffic' },
  { id: 'logs', label: 'Logs', hint: 'Syslog from every device' },
  { id: 'docs', label: 'Docs', hint: 'Notebook and inherited docs' },
];

function shiftClock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const AUTOSAVE_MS = 15_000;

/** Owns the game object: loads the saved game on start and swaps in a fresh one for "New game". */
export function App() {
  const [game, setGame] = useState<Game>(() => loadGame() ?? new Game());
  const [gen, setGen] = useState(0);
  // Open the page with ?debug to poke at the game from the browser console.
  if (new URLSearchParams(window.location.search).has('debug')) (window as unknown as { game: Game }).game = game;
  return (
    <GameScreen
      key={gen}
      game={game}
      onNewGame={() => {
        clearSave();
        const fresh = new Game();
        saveGame(fresh);
        setGame(fresh);
        setGen((g) => g + 1);
      }}
    />
  );
}

function GameScreen({ game, onNewGame }: { game: Game; onNewGame: () => void }) {
  const [tick, setTick] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [view, setView] = useState<View>('tickets');
  const [ticketSel, setTicketSel] = useState<string | null>(null);
  const knownTickets = useRef(new Set(game.queue.tickets.map((x) => x.id)));
  const [selected, setSelected] = useState('acc1');
  const [monitorSel, setMonitorSel] = useState('core1');
  const [visited, setVisited] = useState<string[]>([game.location]);
  const [toast, setToast] = useState<string | null>(null);
  const [dockOpen, setDockOpen] = useState(true);
  const [seenLogs, setSeenLogs] = useState(() => game.net.logs.length);
  const [chatSel, setChatSel] = useState(ALL);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirmNew, setConfirmNew] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const helpOpenRef = useRef(false);
  helpOpenRef.current = helpOpen;
  const [noteToOpen, setNoteToOpen] = useState<string | null>(null);
  const toastTimer = useRef<number>();

  // Autosave, plus a save whenever the tab is hidden or closed.
  useEffect(() => {
    const doSave = () => {
      const ok = saveGame(game);
      setSaveFailed(!ok);
      if (ok) setSavedAt(Date.now());
    };
    const id = setInterval(doSave, AUTOSAVE_MS);
    const onHide = () => {
      if (document.visibilityState === 'hidden') doSave();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', doSave);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', doSave);
    };
  }, [game]);

  useEffect(() => {
    const id = setInterval(() => {
      // Time stands still while the first-day intro or the help tour is open.
      if (!game.introPending && !helpOpenRef.current) game.tick(TICK_MS * speed);
      setTick((t) => t + 1);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [game, speed]);

  useEffect(() => {
    if (view === 'logs') setSeenLogs(game.net.logs.length);
  }, [view, tick, game]);

  // Announce new tickets as they arrive.
  useEffect(() => {
    for (const ticket of game.queue.tickets) {
      if (knownTickets.current.has(ticket.id)) continue;
      knownTickets.current.add(ticket.id);
      if (!ticket.proactive) say(`New ticket ${ticket.id} (P${ticket.priority} ${SLA[ticket.priority].name}): ${ticket.draft.subject}`);
    }
  }, [tick, game]);

  const say = (text: string) => {
    setToast(text);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  };

  const walk = (id: string) => {
    const device = game.net.device(id);
    if (!device.managed) return;
    if (game.walkTo(id)) {
      setVisited((v) => (v.includes(id) ? v : [...v, id]));
      say(`You walked to ${game.placeName(id)} (${device.running.hostname}). +${WALK_MS / 1000}s`);
      setTick((t) => t + 1);
    }
    setDockOpen(true);
  };

  const openMonitor = (id: string) => {
    setMonitorSel(id);
    setView('monitor');
  };

  const here = game.net.device(game.location);
  const atHome = game.location === game.office.home;
  const newLogs = Math.max(0, game.net.logs.length - seenLogs);
  const unacked = game.queue.openTickets().filter((x) => x.respondedAt === null).length;
  const unreadChat = game.chat.totalUnread() - (view === 'chat' ? game.chat.unread(chatSel) : 0);
  const atDesk = game.location.startsWith('ws');
  const savedAgo = savedAt === null ? null : Math.floor((Date.now() - savedAt) / 1000);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">99.999</span>
          <span className="brand-name">Five Nines</span>
          <span className="brand-sub">{COMPANY}</span>
        </div>
        <div className="topbar-right">
          <span className="where" title="Where you are standing">
            At <strong>{atHome ? 'your desk' : game.placeName(game.location)}</strong>
          </span>
          <span className="clock" title="Time on shift">
            Shift {shiftClock(game.shiftTime)}
          </span>
          <span className={`saved ${saveFailed ? 'bad-text' : ''}`} title="Progress is saved in this browser">
            {saveFailed ? "Can't save in this browser" : savedAgo === null ? 'Autosaves every 15s' : `Saved ${savedAgo}s ago`}
          </span>
          <button className="ghost small-ghost" onClick={() => setHelpOpen(true)}>
            Help
          </button>
          <button className="ghost small-ghost" onClick={() => setConfirmNew(true)}>
            New game
          </button>
          <div className="speed" role="group" aria-label="Simulation speed">
            {[1, 10].map((s) => (
              <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <nav className="views" aria-label="Views">
            {VIEWS.map((v) => (
              <button key={v.id} className={`view-btn ${view === v.id ? 'on' : ''}`} onClick={() => {
                  setNoteToOpen(null);
                  setView(v.id);
                }} aria-current={view === v.id}>
                <span className="view-label">
                  {v.label}
                  {v.id === 'logs' && newLogs > 0 && view !== 'logs' && <span className="badge">{newLogs > 99 ? '99+' : newLogs}</span>}
                  {v.id === 'tickets' && unacked > 0 && <span className="badge hot">{unacked} new</span>}
                  {v.id === 'chat' && unreadChat > 0 && <span className="badge hot">{unreadChat > 99 ? '99+' : unreadChat}</span>}
                </span>
                <span className="view-hint">{v.hint}</span>
              </button>
            ))}
          </nav>

          <ShiftCard game={game} onOpen={() => setView('tickets')} />
        </aside>

        <main className="main">
          <div className="view-area">
            {view === 'tickets' && <TicketsView game={game} tick={tick} selected={ticketSel} onSelect={setTicketSel} onMessage={say} />}
            {view === 'map' && <MapView game={game} tick={tick} selected={selected} onSelect={setSelected} onConsole={walk} onMonitor={openMonitor} />}
            {view === 'monitor' && <MonitorView game={game} tick={tick} selected={monitorSel} onSelect={setMonitorSel} />}
            {view === 'logs' && <LogsView game={game} tick={tick} />}
            {view === 'chat' && <ChatView game={game} tick={tick} active={chatSel} onSelect={setChatSel} />}
            {view === 'docs' && <DocsView key={noteToOpen ?? 'docs'} game={game} tick={tick} openNote={noteToOpen ?? undefined} />}
          </div>

          <section className={`dock ${dockOpen ? 'open' : 'closed'} ${atDesk ? 'tall' : ''}`} aria-label="Console">
            <div className="dock-head">
              <button className="dock-toggle" onClick={() => setDockOpen((o) => !o)} aria-expanded={dockOpen}>
                {dockOpen ? '▾' : '▸'} {atDesk ? 'At the desk' : 'Console'}
              </button>
              <span className="dock-where">
                {here.running.hostname} · {atHome ? 'your desk' : game.placeName(game.location)}
              </span>
              {!atHome && (
                <button className="secondary small" onClick={() => walk(game.office.home)}>
                  Walk back to your desk (+{WALK_MS / 1000}s)
                </button>
              )}
            </div>
            <div className="dock-body">
              {visited
                .filter((id) => !id.startsWith('ws'))
                .map((id) => (
                  <Terminal key={id} net={game.net} deviceId={id} session={game.session(id)} tick={tick} visible={dockOpen && id === game.location} />
                ))}
              {atDesk && dockOpen && <DeskView key={game.location} game={game} pcId={game.location} tick={tick} visible />}
            </div>
          </section>
        </main>
      </div>

      {game.report && (
        <ShiftReportDialog
          report={game.report}
          onNext={() => {
            game.startNextShift();
            setTick((n) => n + 1);
          }}
        />
      )}

      {(game.introPending || helpOpen) && (
        <IntroDialog
          onDone={() => {
            game.introPending = false;
            setHelpOpen(false);
            setView('tickets');
            setTick((n) => n + 1);
          }}
        />
      )}

      {!game.introPending && game.debriefDue && (
        <DebriefDialog
          onLater={() => {
            game.debriefShown = true;
            setTick((n) => n + 1);
          }}
          onWrite={() => {
            game.debriefShown = true;
            const note = game.addNote();
            game.updateNote(note.id, 'INC-1001: Priya has no network', '# What was wrong\n- \n\n# How I found it\n- \n\n# The fix\n- \n');
            setNoteToOpen(note.id);
            setView('docs');
          }}
        />
      )}

      {confirmNew && (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="newgame-title">
            <h2 id="newgame-title">Start a new game?</h2>
            <p className="modal-sub">This throws away your current network, tickets, chat and notebook. It can't be undone.</p>
            <div className="td-buttons">
              <button className="secondary" onClick={() => setConfirmNew(false)} autoFocus>
                Keep playing
              </button>
              <button className="primary danger" onClick={onNewGame}>
                Start over
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

function ShiftCard({ game, onOpen }: { game: Game; onOpen: () => void }) {
  const stats = game.shiftStats();
  const open = game.queue.openTickets();
  const top = open.reduce((best, x) => Math.min(best, x.priority), 5);
  const m = Math.floor(game.shiftRemaining / 60000);
  return (
    <button className="shift-card" onClick={onOpen} aria-label="Shift summary, open tickets">
      <span className="sc-row">
        <span className="sc-label">Shift {stats.shift} score</span>
        <span className={`sc-value ${stats.points < 0 ? 'bad-text' : ''}`}>{stats.points}</span>
      </span>
      <span className="sc-row">
        <span className="sc-label">Open tickets</span>
        <span className="sc-value">
          {open.length}
          {top < 5 && <span className={`prio prio-${top}`}>P{top}</span>}
        </span>
      </span>
      <span className="sc-row">
        <span className="sc-label">Time left</span>
        <span className="sc-value">{m} min</span>
      </span>
      {game.drainPerMinute > 0 ? (
        <span className="sc-drain">
          Losing {game.drainPerMinute} pts/min · {game.health.affectedUsers} {game.health.affectedUsers === 1 ? 'user' : 'users'} affected
        </span>
      ) : game.healthy ? (
        <span className="sc-ok">All clear · earning +{game.pointsPerMinute} pts/min</span>
      ) : (
        <span className="sc-ok">All services up · open ticket</span>
      )}
      <span className="sc-rank">{stats.rankName}</span>
      {game.queue.rank.promotion && (
        <span className="sc-promo">
          Promotion {game.queue.qualifyingShifts}/{game.queue.rank.promotion.shifts} shifts at {game.queue.rank.promotion.pointsPerShift}+
          {game.queue.streak > 0 && <> · streak {game.queue.streak}</>}
        </span>
      )}
    </button>
  );
}
