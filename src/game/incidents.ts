// Incidents the NOC declares itself: spotted in Logs or Monitor before (or instead of) a user calling. Each has a
// status, a timeline of updates, user tickets linked to it as children, and a post-incident review at the end.

import type { Priority } from './scoring';

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

export interface IncidentEntry {
  t: number;
  who: 'you' | 'system';
  text: string;
}

export interface IncidentReview {
  cause: string;
  fix: string;
  prevention: string;
}

export interface DeclaredIncident {
  id: string;
  title: string;
  severity: Priority;
  status: IncidentStatus;
  declaredAt: number;
  resolvedAt: number | null;
  /** Where it was spotted ("Logs: CR-ACC1 %LINK-3-UPDOWN ..."), if declared from a view. */
  source?: string;
  timeline: IncidentEntry[];
  /** Ticket IDs linked as children. */
  linked: string[];
  review?: IncidentReview;
}

export interface IncidentState {
  list: DeclaredIncident[];
  seq: number;
}

export const STATUS_TEXT: Record<IncidentStatus, string> = {
  investigating: 'Investigating',
  identified: 'Cause identified',
  monitoring: 'Fix applied, monitoring',
  resolved: 'Resolved',
};

export class IncidentLog {
  list: DeclaredIncident[] = [];
  private seq = 101;

  open(): DeclaredIncident[] {
    return this.list.filter((i) => i.status !== 'resolved');
  }

  find(id: string): DeclaredIncident | undefined {
    return this.list.find((i) => i.id === id);
  }

  declare(title: string, severity: Priority, now: number, source?: string): DeclaredIncident {
    const inc: DeclaredIncident = {
      id: `MI-${this.seq++}`,
      title: title.trim() || 'Untitled incident',
      severity,
      status: 'investigating',
      declaredAt: now,
      resolvedAt: null,
      ...(source ? { source } : {}),
      timeline: [{ t: now, who: 'system', text: `Declared by the NOC as P${severity}.${source ? ` Spotted in ${source}` : ''}` }],
      linked: [],
    };
    this.list.unshift(inc);
    return inc;
  }

  update(id: string, now: number, text: string, status?: IncidentStatus): void {
    const inc = this.find(id);
    if (!inc || inc.status === 'resolved') return;
    if (status && status !== inc.status) {
      inc.status = status;
      inc.timeline.push({ t: now, who: 'system', text: `Status: ${STATUS_TEXT[status]}.` });
    }
    if (text.trim()) inc.timeline.push({ t: now, who: 'you', text: text.trim() });
  }

  link(id: string, ticketId: string, now: number, why: string): void {
    const inc = this.find(id);
    if (!inc || inc.linked.includes(ticketId)) return;
    for (const other of this.list) other.linked = other.linked.filter((x) => x !== ticketId);
    inc.linked.push(ticketId);
    inc.timeline.push({ t: now, who: 'system', text: `${ticketId} linked${why ? `: ${why}` : ''}.` });
  }

  unlink(id: string, ticketId: string, now: number): void {
    const inc = this.find(id);
    if (!inc || !inc.linked.includes(ticketId)) return;
    inc.linked = inc.linked.filter((x) => x !== ticketId);
    inc.timeline.push({ t: now, who: 'system', text: `${ticketId} unlinked.` });
  }

  /** The open incident a ticket belongs to, if any. */
  parentOf(ticketId: string): DeclaredIncident | undefined {
    return this.list.find((i) => i.linked.includes(ticketId));
  }

  /**
   * A user's report comes in while the NOC already has an incident open that was declared after the fault began:
   * the service desk attaches it to that incident (the newest one, if several).
   */
  autoParent(faultAt: number): DeclaredIncident | undefined {
    return this.open().find((i) => i.declaredAt >= faultAt);
  }

  resolve(id: string, now: number, review: IncidentReview): void {
    const inc = this.find(id);
    if (!inc || inc.status === 'resolved') return;
    inc.status = 'resolved';
    inc.resolvedAt = now;
    inc.review = review;
    inc.timeline.push({ t: now, who: 'system', text: 'Resolved. Post-incident review recorded.' });
  }

  exportState(): IncidentState {
    return { list: structuredClone(this.list), seq: this.seq };
  }

  importState(s: IncidentState | undefined): void {
    if (!s) return;
    this.list = s.list;
    this.seq = s.seq;
  }
}
