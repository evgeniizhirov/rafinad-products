// Dependency graph helpers for `blocks` relations (edge from → to means "from blocks to").

export type Edge = [from: string, to: string];

function adjacency(edges: Edge[]): Map<string, string[]> {
  const adj = new Map<string, string[]>();
  for (const [f, t] of edges) {
    if (!adj.has(f)) adj.set(f, []);
    adj.get(f)!.push(t);
  }
  return adj;
}

/** Returns the path that would close a cycle if `from → to` were added, or null. */
export function cyclePathIfAdded(edges: Edge[], from: string, to: string): string[] | null {
  if (from === to) return [from, to];
  const adj = adjacency(edges);
  // search path to → … → from
  const prev = new Map<string, string>();
  const queue = [to];
  const seen = new Set([to]);
  while (queue.length) {
    const n = queue.shift()!;
    if (n === from) {
      const path = [from];
      let cur = from;
      while (cur !== to) {
        cur = prev.get(cur)!;
        path.unshift(cur);
      }
      return [from, ...path];
    }
    for (const m of adj.get(n) ?? []) {
      if (!seen.has(m)) {
        seen.add(m);
        prev.set(m, n);
        queue.push(m);
      }
    }
  }
  return null;
}

/** Finds any cycle in the graph (used to validate a whole import batch). */
export function findCycle(edges: Edge[]): string[] | null {
  const adj = adjacency(edges);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const nodes = [...new Set(edges.flat())].sort();
  const visit = (n: string): string[] | null => {
    state.set(n, 1);
    stack.push(n);
    for (const m of (adj.get(n) ?? []).slice().sort()) {
      const s = state.get(m);
      if (s === 1) return [...stack.slice(stack.indexOf(m)), m];
      if (!s) {
        const c = visit(m);
        if (c) return c;
      }
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of nodes) {
    if (!state.get(n)) {
      const c = visit(n);
      if (c) return c;
    }
  }
  return null;
}

/** Layered layout (longest path from roots) used by the dependency graph view. */
export function layers(nodes: string[], edges: Edge[]): Map<string, number> {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  for (const [, t] of edges) if (indeg.has(t)) indeg.set(t, indeg.get(t)! + 1);
  const adj = adjacency(edges.filter(([f, t]) => indeg.has(f) && indeg.has(t)));
  const layer = new Map<string, number>();
  const queue = nodes.filter((n) => indeg.get(n) === 0).sort();
  for (const n of queue) layer.set(n, 0);
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of adj.get(n) ?? []) {
      layer.set(m, Math.max(layer.get(m) ?? 0, (layer.get(n) ?? 0) + 1));
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  for (const n of nodes) if (!layer.has(n)) layer.set(n, 0); // cycles cannot exist, but stay safe
  return layer;
}
