// Team load per planning period.

export interface PeriodIn {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
}

export interface TeamIn {
  id: string;
  name: string;
}

export interface PlacedFeature {
  id: string;
  periodId: string | null;
  /** teamId → hours; a missing team means "not estimated", never zero */
  estimates: Record<string, number>;
}

export interface TeamLoad {
  periodId: string;
  teamId: string;
  capacity: number;
  planned: number;
  free: number;
  utilization: number | null; // percent, null when capacity is 0 and nothing planned
  deficit: number;
}

export function capacityKey(periodId: string, teamId: string) {
  return `${periodId}|${teamId}`;
}

export function computeLoad(
  periods: PeriodIn[],
  teams: TeamIn[],
  capacities: Map<string, number>,
  features: PlacedFeature[],
): TeamLoad[] {
  const planned = new Map<string, number>();
  for (const f of features) {
    if (!f.periodId) continue;
    for (const [teamId, hours] of Object.entries(f.estimates)) {
      const k = capacityKey(f.periodId, teamId);
      planned.set(k, (planned.get(k) ?? 0) + hours);
    }
  }
  const out: TeamLoad[] = [];
  for (const p of periods) {
    for (const t of teams) {
      const k = capacityKey(p.id, t.id);
      const capacity = capacities.get(k) ?? 0;
      const used = round1(planned.get(k) ?? 0);
      out.push({
        periodId: p.id,
        teamId: t.id,
        capacity,
        planned: used,
        free: round1(capacity - used),
        utilization: capacity > 0 ? Math.round((used / capacity) * 100) : used > 0 ? null : 0,
        deficit: round1(Math.max(0, used - capacity)),
      });
    }
  }
  return out;
}

export const round1 = (n: number) => Math.round(n * 10) / 10;

/** Overload caused by adding `estimates` to period: list of {teamId, over} where planned+add > capacity. */
export function overloadIfAdded(
  periodId: string,
  estimates: Record<string, number>,
  capacities: Map<string, number>,
  currentPlanned: Map<string, number>,
): { teamId: string; capacity: number; plannedAfter: number; over: number }[] {
  const out = [];
  for (const [teamId, hours] of Object.entries(estimates)) {
    if (hours <= 0) continue;
    const k = capacityKey(periodId, teamId);
    const cap = capacities.get(k) ?? 0;
    const after = round1((currentPlanned.get(k) ?? 0) + hours);
    if (after > cap) out.push({ teamId, capacity: cap, plannedAfter: after, over: round1(after - cap) });
  }
  return out;
}
