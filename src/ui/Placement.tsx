import { useState } from 'react';
import type { Game } from '../game/game';
import { PLACEMENT_BANDS, PLACEMENT_IN_PLAY, PLACEMENT_STEPS, STEP_MS } from '../game/placement';
import { RANKS } from '../game/scoring';

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function PlacementOffer({ onTake, onDecline }: { onTake: () => void; onDecline: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="place-title">
        <h2 id="place-title">Take the placement shift?</h2>
        <p className="modal-sub">If you already know your way around a network, you can test out of the early ranks.</p>
        <ul className="place-rules">
          <li>Five tickets, from a desk fault to an office-wide outage.</li>
          <li>Run like a {RANKS[2].name} shift: up to {PLACEMENT_IN_PLAY} open at once, each with {STEP_MS / 60_000} game minutes from when it arrives. Faster fixes score more. No hints, no escalation.</li>
          <li>
            {PLACEMENT_BANDS.tier2}+ points starts you at {RANKS[1].name}; {PLACEMENT_BANDS.engineer}+ starts you at {RANKS[2].name}. The most you can score is about 1,100.
          </li>
          <li>One attempt per game. Owen handles Priya's ticket while you test.</li>
        </ul>
        <div className="td-buttons">
          <button className="secondary" onClick={onDecline}>
            Start at {RANKS[0].name}
          </button>
          <button className="primary" onClick={onTake} autoFocus>
            Take the test
          </button>
        </div>
      </div>
    </div>
  );
}

function ResultsTable({ game }: { game: Game }) {
  const p = game.placement!;
  return (
    <table className="placement-results">
      <tbody>
        {p.state.results.map((r) => (
          <tr key={r.index}>
            <td>{r.index + 1}</td>
            <td>{r.difficulty}</td>
            <td>{r.solved ? `fixed in ${mmss(r.ms)}` : 'not fixed'}</td>
            <td className="num">+{r.points}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function PlacementView({ game, onMessage }: { game: Game; onMessage: (t: string) => void }) {
  const [feedback, setFeedback] = useState<Record<number, string>>({});
  const p = game.placement!;
  const live = p.current;
  return (
    <div className="placement-view">
      <header className="placement-head">
        <h2>Placement shift</h2>
        <span className="muted">
          {p.state.results.length} of {PLACEMENT_STEPS.length} done · {live.length} open · score {p.score}
        </span>
      </header>
      <div className="placement-tickets">
        {live.map(({ index, draft: d, remainingMs }) => (
          <section key={index} className="ticket-detail placement-ticket">
            <p className="td-kicker">
              Ticket {index + 1} · {d.difficulty}
            </p>
            <h2>{d.subject}</h2>
            <p className="muted">
              From {d.reporter.name}, desk {d.reporter.desk} ({d.reporter.pcId.toUpperCase()})
            </p>
            <p className="placement-desc">{d.description}</p>
            <p className={`placement-timer ${remainingMs < 120_000 ? 'bad-text' : ''}`}>{mmss(remainingMs)} left</p>
            <div className="row-form">
              <button
                className="primary"
                onClick={() => {
                  if (p.check(index)) {
                    const r = p.state.results.find((x) => x.index === index)!;
                    onMessage(`Ticket ${index + 1} fixed in ${mmss(r.ms)}: +${r.points}`);
                  } else setFeedback({ ...feedback, [index]: 'Not fixed yet. The check is against the real network, not what you typed.' });
                }}
              >
                Check my fix
              </button>
              <button
                className="secondary"
                onClick={() => {
                  p.skip(index);
                  onMessage(`Gave up on ticket ${index + 1}. A senior fixed it.`);
                }}
              >
                Give up on this one
              </button>
            </div>
            {feedback[index] && <p className="warn-text">{feedback[index]}</p>}
          </section>
        ))}
      </div>
      {p.state.results.length > 0 && <ResultsTable game={game} />}
    </div>
  );
}

export function PlacementResults({ game, onStart }: { game: Game; onStart: () => void }) {
  const p = game.placement!;
  const rank = p.state.placedRank ?? 0;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="placed-title">
        <h2 id="placed-title">You start as {RANKS[rank].name}</h2>
        <p className="modal-sub">
          Placement score {p.score}. Bands: {PLACEMENT_BANDS.tier2} for {RANKS[1].name}, {PLACEMENT_BANDS.engineer} for {RANKS[2].name}.
        </p>
        <ResultsTable game={game} />
        <p className="muted">Placement points don't count toward your lifetime score. Your streak and promotion count start at 0.</p>
        <div className="td-buttons">
          <button className="primary" onClick={onStart} autoFocus>
            Start my first shift
          </button>
        </div>
      </div>
    </div>
  );
}
