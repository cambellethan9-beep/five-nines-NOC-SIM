import { useState } from 'react';
import { COMPANY } from '../content/office';
import { PREDECESSOR } from '../content/docs';

const PAGES = [
  {
    kicker: 'Day one',
    title: `Welcome to ${COMPANY}`,
    body: (
      <>
        <p>
          You're the new Tier 1 NOC technician for a 20-person accounting firm: two floors, one server room, four VLANs and a lot of people who
          need the internet to work right now.
        </p>
        <p>
          Your predecessor, {PREDECESSOR}, left last week. He left documentation behind. How current it is, you'll find out.
        </p>
      </>
    ),
  },
  {
    kicker: 'Before you touch anything',
    title: 'NetSmart gear speaks Cisco',
    body: (
      <>
        <p>
          Every router and switch here is NetSmart, "the only networking vendor ever!" Their command line uses <strong>Cisco IOS syntax</strong>, so
          any Cisco guide, CCNA book or forum post applies as-is.
        </p>
        <p>
          <strong>Google is your friend.</strong> Looking up a command or an error message isn't cheating. It's how the job works, and real NOC
          engineers do it all day. What matters is applying it correctly.
        </p>
      </>
    ),
  },
  {
    kicker: 'How the job works',
    title: 'The short version',
    body: (
      <ul className="intro-list">
        <li>
          <strong>Tickets</strong> arrive as people hit problems. The SLA clock runs on the problem's real impact, not the priority printed on the
          ticket.
        </li>
        <li>
          <strong>Points</strong> come from real, fast fixes. Closing a ticket that isn't fixed costs you. A healthy network earns points;
          downtime drains them.
        </li>
        <li>
          <strong>Your desk is the NOC PC.</strong> SSH from there is instant: <code>ssh nocadmin@10.10.99.11</code>. Walking to a closet or
          someone's desk costs 30 seconds each way.
        </li>
        <li>
          <strong>Map, Monitor and Logs</strong> show what the network is doing. <strong>Chat</strong> is where the office tells you how they feel
          about it.
        </li>
        <li>
          <strong>Docs</strong> has Mike's notes and playbooks, plus your own notebook.
        </li>
      </ul>
    ),
  },
  {
    kicker: 'That\'s all the help you get',
    title: 'Your first ticket is waiting',
    body: (
      <>
        <p>There's no step-by-step from here. Priya Natarajan on the 1st floor can't get online. Figure out why, fix it, then resolve the ticket.</p>
        <p>When you work something out, write it down in your notebook. Future you will thank you.</p>
      </>
    ),
  },
];

export function IntroDialog({ onDone }: { onDone: () => void }) {
  const [page, setPage] = useState(0);
  const p = PAGES[page];
  const last = page === PAGES.length - 1;
  return (
    <div className="modal-backdrop">
      <div className="modal intro" role="dialog" aria-modal="true" aria-labelledby="intro-title">
        <p className="doc-kind">{p.kicker}</p>
        <h2 id="intro-title">{p.title}</h2>
        <div className="intro-body">{p.body}</div>
        <div className="intro-foot">
          <span className="intro-dots" aria-label={`Page ${page + 1} of ${PAGES.length}`}>
            {PAGES.map((_, i) => (
              <span key={i} className={i === page ? 'on' : ''} />
            ))}
          </span>
          <div className="td-buttons">
            {page > 0 && (
              <button className="secondary" onClick={() => setPage(page - 1)}>
                Back
              </button>
            )}
            <button className="primary" onClick={() => (last ? onDone() : setPage(page + 1))} autoFocus>
              {last ? 'Start my shift' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DebriefDialog({ onWrite, onLater }: { onWrite: () => void; onLater: () => void }) {
  return (
    <div className="modal-backdrop">
      <div className="modal intro" role="dialog" aria-modal="true" aria-labelledby="debrief-title">
        <p className="doc-kind">INC-1001 closed</p>
        <h2 id="debrief-title">That was the training wheels</h2>
        <div className="intro-body">
          <p>From here, tickets arrive on their own. While you're Tier 1 you'll get one at a time, but nobody is going to tell you where to look.</p>
          <p>Before you forget: what was wrong, how did you find it, and what fixed it? Writing it down now is how you get faster next time.</p>
        </div>
        <div className="td-buttons">
          <button className="secondary" onClick={onLater}>
            Later
          </button>
          <button className="primary" onClick={onWrite} autoFocus>
            Write it in my notebook
          </button>
        </div>
      </div>
    </div>
  );
}
