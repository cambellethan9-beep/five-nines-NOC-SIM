import { useEffect, useRef, useState } from 'react';
import { COMPANY } from '../content/office';
import { Game, WALK_MS } from '../game/game';
import { ALL } from '../game/chat';
import { SLA } from '../game/scoring';
import { clearLibrary, clearSave, loadGame, newGameWithLibrary, saveGame, saveLibrary } from '../game/storage';
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
import { SettingsDialog } from './Settings';
import { AchievementsDialog } from './Achievements';
import { PlacementOffer, PlacementResults, PlacementView } from './Placement';
import { FrontPanel, PrinterPanel } from './FrontPanel';
import type { DeclareDraft } from './Incidents';
import { applyTheme, loadTheme } from './theme';

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
  const [game, setGame] = useState<Game>(() => loadGame() ?? newGameWithLibrary());
  const [gen, setGen] = useState(0);
  // Open the page with ?debug to poke at the game from the browser console.
  if (new URLSearchParams(window.location.search).has('debug')) (window as unknown as { game: Game }).game = game;
  return (
    <GameScreen
      key={gen}
      game={game}
      onNewGame={() => {
        // Keep the documentation from the game being thrown away, right up to this moment.
        saveLibrary(game);
        clearSave();
        const fresh = newGameWithLibrary();
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [achOpen, setAchOpen] = useState(false);
  const [panelMode, setPanelMode] = useState<'console' | 'panel'>('console');
  const [declareDraft, setDeclareDraft] = useState<DeclareDraft | null>(null);
  const declareFrom = (draft: DeclareDraft) => {
    setDeclareDraft(draft);
    setView('tickets');
  };
  const [theme, setTheme] = useState(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);

  // Keyboard shortcuts: number keys switch views (Alt+number works even while typing in the console).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const el = document.activeElement as HTMLElement | null;
      const typing = !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
      if (document.querySelector('.modal-backdrop')) return;
      if (e.key === 'Escape' && typing) {
        el!.blur();
        return;
      }
      if (typing && !e.altKey) return;
      if (!typing && e.altKey && !/^Digit[1-8]$/.test(e.code)) return;
      const digit = /^Digit([1-8])$/.exec(e.code)?.[1];
      if (digit) {
        e.preventDefault();
        const n = Number(digit);
        if (n <= VIEWS.length) {
          setNoteToOpen(null);
          setView(VIEWS[n - 1].id);
        } else if (n === 7) setDockOpen((o) => !o);
        else if (n === 8) {
          setDockOpen(true);
          window.setTimeout(() => {
            const input = [...document.querySelectorAll<HTMLInputElement>('.terminal-input, .desk-input')].find((i) => i.offsetParent !== null);
            input?.focus();
          }, 0);
        }
        return;
      }
      if (e.key === '/' && !typing) {
        e.preventDefault();
        setView('tickets');
        window.setTimeout(() => document.getElementById('ticket-search')?.focus(), 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  // Announce achievements as they're earned.
  useEffect(() => {
    const fresh = game.achievements.fresh.splice(0);
    if (fresh.length) say(`Achievement unlocked: ${fresh.map((a) => a.name).join(', ')}`);
  }, [tick, game]);

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
  const atPrinter = here.kind === 'printer';
  const atGear = here.kind === 'switch' || here.kind === 'l3switch' || here.kind === 'router';
  const showPanel = atGear && panelMode === 'panel';
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
            {game.inPlacement ? 'Placement shift' : `Shift ${shiftClock(game.shiftTime)}`}
          </span>
          <span className={`saved ${saveFailed ? 'bad-text' : ''}`} title="Progress is saved in this browser">
            {saveFailed ? "Can't save in this browser" : savedAgo === null ? 'Autosaves every 15s' : `Saved ${savedAgo}s ago`}
          </span>
          <button className="ghost small-ghost" onClick={() => setHelpOpen(true)}>
            Help
          </button>
          <button className="ghost small-ghost" onClick={() => setAchOpen(true)}>
            Achievements
          </button>
          <button className="ghost small-ghost" onClick={() => setSettingsOpen(true)}>
            Settings
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
            {VIEWS.map((v, i) => (
              <button key={v.id} className={`view-btn ${view === v.id ? 'on' : ''}`} onClick={() => {
                  setNoteToOpen(null);
                  setView(v.id);
                }} aria-current={view === v.id}>
                <span className="view-label">
                  <kbd className="view-key" aria-hidden="true">{i + 1}</kbd>
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
            {view === 'tickets' && game.inPlacement && <PlacementView game={game} onMessage={say} />}
            {view === 'tickets' && !game.inPlacement && <TicketsView game={game} tick={tick} selected={ticketSel} onSelect={setTicketSel} onMessage={say} declareDraft={declareDraft} onDeclare={setDeclareDraft} />}
            {view === 'map' && <MapView game={game} tick={tick} selected={selected} onSelect={setSelected} onConsole={walk} onMonitor={openMonitor} />}
            {view === 'monitor' && <MonitorView game={game} tick={tick} selected={monitorSel} onSelect={setMonitorSel} onDeclare={declareFrom} />}
            {view === 'logs' && <LogsView game={game} tick={tick} onDeclare={declareFrom} />}
            {view === 'chat' && <ChatView game={game} tick={tick} active={chatSel} onSelect={setChatSel} />}
            {view === 'docs' && <DocsView key={noteToOpen ?? 'docs'} game={game} tick={tick} openNote={noteToOpen ?? undefined} />}
          </div>

          <section className={`dock ${dockOpen ? 'open' : 'closed'} ${atDesk ? 'tall' : ''}`} aria-label="Console">
            <div className="dock-head">
              <button className="dock-toggle" onClick={() => setDockOpen((o) => !o)} aria-expanded={dockOpen}>
                {dockOpen ? '▾' : '▸'} {atDesk ? 'At the desk' : atPrinter ? 'At the printer' : 'Console'}
              </button>
              <span className="dock-where">
                {here.running.hostname} · {atHome ? 'your desk' : game.placeName(game.location)}
              </span>
              {atGear && (
                <span className="dock-modes" role="group" aria-label="What you're looking at">
                  <button className={panelMode === 'console' ? 'on' : ''} onClick={() => setPanelMode('console')}>
                    Console
                  </button>
                  <button className={panelMode === 'panel' ? 'on' : ''} onClick={() => setPanelMode('panel')}>
                    Front panel
                  </button>
                </span>
              )}
              {game.cableInHand && <span className="dock-hand">Holding a patch cable</span>}
              {!atHome && (
                <button className="secondary small" onClick={() => walk(game.office.home)}>
                  Walk back to your desk (+{WALK_MS / 1000}s)
                </button>
              )}
            </div>
            <div className="dock-body">
              {visited
                .filter((id) => !id.startsWith('ws') && game.net.device(id).kind !== 'printer')
                .map((id) => (
                  <Terminal key={id} net={game.net} deviceId={id} session={game.session(id)} tick={tick} visible={dockOpen && id === game.location && !showPanel} />
                ))}
              {showPanel && dockOpen && <FrontPanel key={game.location} game={game} deviceId={game.location} onMessage={say} />}
              {atPrinter && dockOpen && <PrinterPanel key={game.location} game={game} deviceId={game.location} onMessage={say} />}
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
            <p className="modal-sub">This throws away your current network, tickets, chat and rank. It can't be undone. Your notebook and your edits to the inherited docs come with you.</p>
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

      {!game.introPending && game.placementOffered && !game.placement && game.queue.shift === 1 && (
        <PlacementOffer
          onTake={() => {
            game.startPlacement();
            setView('tickets');
            setTick((n) => n + 1);
          }}
          onDecline={() => {
            game.declinePlacement();
            setTick((n) => n + 1);
          }}
        />
      )}
      {game.inPlacement && game.placement?.state.done && (
        <PlacementResults
          game={game}
          onStart={() => {
            game.finishPlacement();
            setTick((n) => n + 1);
          }}
        />
      )}
      {achOpen && <AchievementsDialog game={game} onClose={() => setAchOpen(false)} />}
      {settingsOpen && (
        <SettingsDialog
          theme={theme}
          onChange={setTheme}
          onClose={() => setSettingsOpen(false)}
          onDeleteDocs={() => {
            clearLibrary();
            game.notes = [];
            for (const d of game.docs) if (d.original) game.revertDoc(d.id);
            saveGame(game);
            say('Your notebook and doc edits were deleted.');
          }}
        />
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
  if (game.inPlacement) {
    return (
      <button className="shift-card" onClick={onOpen} aria-label="Placement shift">
        <span className="sc-row">
          <span className="sc-label">Placement shift</span>
          <span className="sc-value">{game.placement?.score ?? 0}</span>
        </span>
        <span className="sc-ok">The shift clock starts after the test</span>
      </button>
    );
  }
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
      {game.achievements.title() && <span className="sc-title">"{game.achievements.title()}"</span>}
      {game.queue.rank.promotion && (
        <span className="sc-promo">
          Promotion {game.queue.qualifyingShifts}/{game.queue.rank.promotion.shifts} shifts at {game.queue.rank.promotion.pointsPerShift}+
          {game.queue.streak > 0 && <> · streak {game.queue.streak}</>}
        </span>
      )}
    </button>
  );
}
