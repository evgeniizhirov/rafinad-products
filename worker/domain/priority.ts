// Department voting → aggregated priority.
// priority_score = SUM(score * weight) / SUM(weight) over active departments that voted.
// No vote ≠ score 1: departments without a vote are simply not part of the formula.

export interface DeptWeight {
  id: string;
  weight: number;
  isActive: boolean;
  isProduct: boolean;
}

export interface Vote {
  departmentId: string;
  score: number;
  votedAt?: string | null;
}

export interface PriorityResult {
  score: number | null;
  voters: number;
  productScore: number | null;
  lastVotedAt: string | null;
}

export function computePriority(votes: Vote[], departments: Map<string, DeptWeight>): PriorityResult {
  let num = 0;
  let den = 0;
  let voters = 0;
  let productScore: number | null = null;
  let lastVotedAt: string | null = null;
  for (const v of votes) {
    const d = departments.get(v.departmentId);
    if (!d || !d.isActive) continue;
    if (!Number.isInteger(v.score) || v.score < 1 || v.score > 5) continue;
    num += v.score * d.weight;
    den += d.weight;
    voters++;
    if (d.isProduct) productScore = v.score;
    if (v.votedAt && (!lastVotedAt || v.votedAt > lastVotedAt)) lastVotedAt = v.votedAt;
  }
  return {
    score: den > 0 ? Math.round((num / den) * 100) / 100 : null,
    voters,
    productScore,
    lastVotedAt,
  };
}

export interface Rankable {
  score: number | null;
  productScore: number | null;
  createdAt: string;
  number: number;
}

/**
 * Stable ranking: higher score first; features without votes go last;
 * ties → Product department score, then older first (created_at), then lower number.
 */
export function compareByPriority(a: Rankable, b: Rankable): number {
  const sa = a.score ?? -1;
  const sb = b.score ?? -1;
  if (sa !== sb) return sb - sa;
  const pa = a.productScore ?? -1;
  const pb = b.productScore ?? -1;
  if (pa !== pb) return pb - pa;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.number - b.number;
}
