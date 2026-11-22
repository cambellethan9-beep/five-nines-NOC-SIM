import type { Game } from '../game/game';
import { FEATS, POINT_TIERS, type Achievement } from '../game/achievements';

export function AchievementsDialog({ game, onClose }: { game: Game; onClose: () => void }) {
  const a = game.achievements;
  const total = POINT_TIERS.length + FEATS.length;
  const got = Object.keys(a.state.unlocked).length;
  const lifetime = game.queue.lifetimePoints;
  const next = POINT_TIERS.find((t) => !a.has(t.id));
  const row = (x: Achievement) => {
    const earned = a.has(x.id);
    const hidden = x.secret && !earned;
    return (
      <li key={x.id} className={`ach ${earned ? 'earned' : ''}`}>
        <span className="ach-mark" aria-hidden="true">
          {earned ? '★' : '☆'}
        </span>
        <span className="ach-text">
          <span className="ach-name">{hidden ? '???' : x.name}</span>
          <span className="ach-desc">{hidden ? 'A secret. Keep playing.' : x.description}</span>
        </span>
      </li>
    );
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal achievements" role="dialog" aria-modal="true" aria-labelledby="ach-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="ach-title">Achievements</h2>
        <p className="modal-sub">
          {got} of {total} earned · {lifetime.toLocaleString()} lifetime points
          {next && <> · next title at {next.points!.toLocaleString()}</>}
        </p>
        <h3>Career titles</h3>
        <ul className="ach-list">{POINT_TIERS.map(row)}</ul>
        <h3>Feats</h3>
        <ul className="ach-list">{FEATS.map(row)}</ul>
        <div className="td-buttons">
          <button className="primary" onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
