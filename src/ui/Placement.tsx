import type { Game } from '../game/game';
import { PLACEMENT_BANDS, PLACEMENT_RANK } from '../game/placement';
import { RANKS } from '../game/scoring';

export function PlacementOffer({ onTake, onDecline }: { onTake: () => void; onDecline: () => void }) {
  const r = RANKS[PLACEMENT_RANK];
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="place-title">
        <h2 id="place-title">Take the placement shift?</h2>
        <p className="modal-sub">If you already know your way around a network, you can test out of the early ranks.</p>
        <ul className="place-rules">
          <li>It's a normal shift: whatever the day brings, scored like any other shift, with a {r.name}'s workload (up to {r.maxOpenTickets} tickets in play).</li>
          <li>
            Score {PLACEMENT_BANDS.tier2}+ to start at {RANKS[1].name}, {PLACEMENT_BANDS.engineer}+ to start at {RANKS[2].name}. Below that you start at {RANKS[0].name}.
          </li>
          <li>The points don't count toward your career. One attempt per game. Owen handles Priya's ticket so you start clean.</li>
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

/** Shown in the Tickets view while the placement shift runs. */
export function PlacementBanner({ game }: { game: Game }) {
  const points = game.shiftStats().points;
  const next = points >= PLACEMENT_BANDS.engineer ? null : points >= PLACEMENT_BANDS.tier2 ? PLACEMENT_BANDS.engineer : PLACEMENT_BANDS.tier2;
  return (
    <p className="placement-banner">
      <strong>Placement shift.</strong> {points} points so far
      {next !== null ? <> · {next - points} more for {next === PLACEMENT_BANDS.tier2 ? RANKS[1].name : RANKS[2].name}</> : <> · {RANKS[2].name} pace</>}
    </p>
  );
}

export function PlacementResults({ game, onStart }: { game: Game; onStart: () => void }) {
  const p = game.placement!;
  const rank = p.placedRank ?? 0;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="placed-title">
        <h2 id="placed-title">You start as {RANKS[rank].name}</h2>
        <p className="modal-sub">
          Placement shift score: <strong>{p.score}</strong> ({p.resolved ?? 0} of {p.opened ?? 0} tickets resolved yourself). Bands: {PLACEMENT_BANDS.tier2} for {RANKS[1].name},{' '}
          {PLACEMENT_BANDS.engineer} for {RANKS[2].name}.
        </p>
        <p className="muted">Owen wrapped up anything still open. The placement points don't count toward your lifetime score; your streak and promotion count start at 0.</p>
        <div className="td-buttons">
          <button className="primary" onClick={onStart} autoFocus>
            Start my first shift
          </button>
        </div>
      </div>
    </div>
  );
}
