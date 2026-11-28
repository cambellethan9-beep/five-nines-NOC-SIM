import { formatDuration } from './MonitorView';
import type { ShiftReport } from '../game/game';

function pct(n: number, digits = 1): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function ShiftReportDialog({ report, onNext }: { report: ShiftReport; onNext: () => void }) {
  const slaOk = report.slaCompliance >= report.slaTarget;
  const upOk = report.availability >= report.uptimeTarget;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="report-title">
        <p className="doc-kind">End of shift {report.shift}</p>
        <h2 id="report-title">{report.bonus > 0 ? 'Targets met' : 'Targets missed'}</h2>
        <p className="modal-sub">{report.rankName}</p>
        <table className="report-table">
          <tbody>
            <tr>
              <td>Tickets resolved within SLA</td>
              <td className="num">
                {report.ticketsDue ? `${report.ticketsInSla} of ${report.ticketsDue} (${pct(report.slaCompliance, 0)})` : 'none due'}
              </td>
              <td className="num muted">target {pct(report.slaTarget, 0)}</td>
              <td>
                <span className={`chip ${slaOk ? 'chip-up' : 'chip-down'}`}>{slaOk ? 'met' : 'missed'}</span>
              </td>
            </tr>
            <tr>
              <td>Service availability</td>
              <td className="num">{pct(report.availability, 2)}</td>
              <td className="num muted">target {pct(report.uptimeTarget, report.uptimeTarget > 0.99 ? 2 : 0)}</td>
              <td>
                <span className={`chip ${upOk ? 'chip-up' : 'chip-admin-down'}`}>{upOk ? 'met' : 'missed'}</span>
              </td>
            </tr>
            <tr>
              <td>Tickets opened this shift</td>
              <td className="num">{report.ticketsOpened}</td>
              <td />
              <td />
            </tr>
            <tr>
              <td>Points for a healthy network</td>
              <td className="num ok-text">+{report.healthy}</td>
              <td />
              <td />
            </tr>
            <tr>
              <td>Points lost to downtime</td>
              <td className="num bad-text">−{report.drain}</td>
              <td />
              <td />
            </tr>
            <tr>
              <td>{report.bonus > 0 ? 'Shift bonus' : 'Shift penalty'}</td>
              <td className={`num ${report.bonus < 0 ? 'bad-text' : ''}`}>{report.bonus > 0 ? `+${report.bonus}` : report.bonus}</td>
              <td />
              <td />
            </tr>
            <tr>
              <td>Reliability streak</td>
              <td className={`num ${report.streakBonus ? 'ok-text' : ''}`}>{report.streakBonus ? `+${report.streakBonus}` : '0'}</td>
              <td className="num muted">{report.streak ?? 0} in a row</td>
              <td />
            </tr>
            {report.hardware && (
              <tr>
                <td>Hardware failures</td>
                <td className="num">{report.hardware.failures}</td>
                <td className="num muted">
                  MTBF {formatDuration(report.hardware.mtbf)} · MTTR {formatDuration(report.hardware.mttr)}
                </td>
                <td />
              </tr>
            )}
            <tr className="score-total">
              <td>Shift score</td>
              <td className="num">{report.points}</td>
              <td className="num muted">lifetime {report.lifetimePoints}</td>
              <td />
            </tr>
          </tbody>
        </table>
        {report.promotion &&
          (report.promotion.promotedTo ? (
            <p className="promo promo-up">
              Promoted to <strong>{report.promotion.promotedTo}</strong>. {report.promotion.shifts} shifts in a row at {report.promotion.pointsPerShift}+ points.
            </p>
          ) : report.promotion.qualified ? (
            <p className="promo">
              Promotion: {report.promotion.done} of {report.promotion.shifts} shifts in a row at {report.promotion.pointsPerShift}+ points.
            </p>
          ) : (
            <p className="promo promo-reset">
              Under {report.promotion.pointsPerShift} points this shift. Promotion count is back to 0 of {report.promotion.shifts}.
            </p>
          ))}
        <p className="modal-note">The network carries over to the next shift as you left it, open tickets included. Anything unsaved is still unsaved.</p>
        <button className="primary" onClick={onNext} autoFocus>
          Start next shift
        </button>
      </div>
    </div>
  );
}
