/**
 * MediClue scheduling engine (OS part)
 * ------------------------------------
 * Patients  = processes waiting for a CPU
 * Doctor    = the shared resource (one consultation at a time)
 * Policy    = priority scheduling with AGING
 *
 *   effective = clamp( base(urgency) + visitAdjustment + aging(waited) , ceiling(urgency) )
 *
 * - base      : urgency band set by authorised reception staff
 * - aging     : +AGING_PER_MINUTE for every minute waited (prevents starvation)
 * - ceiling   : aging can lift a patient but never above the band it must not overtake,
 *               so waiting time can never push a ROUTINE/NORMAL patient past an URGENT one,
 *               nor an URGENT one past a CRITICAL one (clinical safety rule).
 * - visit history:
 *       +BOOKED_BONUS        patient who pre-booked and checked in
 *       -FOLLOWUP_WALKIN_PEN walk-in who saw this doctor recently (follow-up bypassing booking)
 *
 * Because aging changes priority with time, the heap is rebuilt from a snapshot
 * whenever the queue is read or the next patient is called.
 */

const URGENCY = { ROUTINE: 1, NORMAL: 2, URGENT: 3, CRITICAL: 4 };

const CONFIG = {
  base: { 1: 10, 2: 30, 3: 60, 4: 100 },
  ceiling: { 1: 59, 2: 59, 3: 99, 4: 100 },
  agingPerMinute: 1,
  bookedBonus: 5,
  followUpWalkInPenalty: 5,
};

function computePriority(entry, cfg = CONFIG) {
  const urgency = Number(entry.urgency);
  const base = cfg.base[urgency];
  if (base === undefined) throw new Error(`Invalid urgency level: ${entry.urgency}`);

  const waited = Math.max(0, Number(entry.waitedMinutes) || 0);
  let adjustment = 0;
  if (entry.type === 'BOOKED') adjustment += cfg.bookedBonus;
  if (entry.type === 'WALK_IN' && entry.isFollowUpWalkIn) adjustment -= cfg.followUpWalkInPenalty;

  const aged = base + adjustment + waited * cfg.agingPerMinute;
  return Math.min(cfg.ceiling[urgency], aged);
}

/** Binary max-heap. Order: priority desc, longer wait first (FCFS tie-break), then id. */
class PriorityQueue {
  constructor() { this.heap = []; }
  get size() { return this.heap.length; }

  static higher(a, b) {
    if (a.priority !== b.priority) return a.priority > b.priority;
    if (a.waitedMinutes !== b.waitedMinutes) return a.waitedMinutes > b.waitedMinutes;
    return a.id < b.id;
  }

  push(item) {
    this.heap.push(item);
    let i = this.heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!PriorityQueue.higher(this.heap[i], this.heap[p])) break;
      [this.heap[i], this.heap[p]] = [this.heap[p], this.heap[i]];
      i = p;
    }
  }

  pop() {
    if (!this.heap.length) return null;
    const top = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let best = i;
        if (l < this.heap.length && PriorityQueue.higher(this.heap[l], this.heap[best])) best = l;
        if (r < this.heap.length && PriorityQueue.higher(this.heap[r], this.heap[best])) best = r;
        if (best === i) break;
        [this.heap[i], this.heap[best]] = [this.heap[best], this.heap[i]];
        i = best;
      }
    }
    return top;
  }
}

/**
 * Turn waiting entries into an ordered queue snapshot.
 * entry = { id, urgency, type, waitedMinutes, isFollowUpWalkIn, ...anything else }
 */
function buildQueue(entries, cfg = CONFIG) {
  const pq = new PriorityQueue();
  for (const e of entries) {
    pq.push({ ...e, waitedMinutes: Number(e.waitedMinutes) || 0, priority: computePriority(e, cfg) });
  }
  const ordered = [];
  let item;
  while ((item = pq.pop())) ordered.push({ ...item, position: ordered.length + 1 });
  return ordered;
}

module.exports = { URGENCY, CONFIG, computePriority, PriorityQueue, buildQueue };
