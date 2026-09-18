/**
 * A small layered graph layout for automata and goto graphs: BFS layers from
 * the start node become columns, nodes within a layer are spread vertically
 * and lightly ordered by their predecessors' positions (barycenter) to reduce
 * crossings. Edges get cubic paths; back edges bow outward; self-loops are
 * arcs above the node.
 */
export interface GNode {
  id: number;
  label: string;
  accept?: boolean;
  start?: boolean;
  /** Secondary text (e.g. the NFA subset of a DFA state, or a rule name). */
  sub?: string;
}
export interface GEdge {
  from: number;
  to: number;
  label: string;
}
export interface LaidOut {
  nodes: (GNode & { x: number; y: number; r: number })[];
  edges: (GEdge & { path: string; lx: number; ly: number; back: boolean; self: boolean })[];
  width: number;
  height: number;
}

export function layoutGraph(nodes: GNode[], edges: GEdge[], start: number, opts: { r?: number; dx?: number; dy?: number } = {}): LaidOut {
  const r = opts.r ?? 22;
  const dx = opts.dx ?? 150;
  const dy = opts.dy ?? 80;
  const layerOf = new Map<number, number>();
  const succ = new Map<number, number[]>();
  for (const n of nodes) succ.set(n.id, []);
  for (const e of edges) if (e.from !== e.to) succ.get(e.from)?.push(e.to);
  const queue = [start];
  layerOf.set(start, 0);
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of succ.get(n) ?? []) if (!layerOf.has(m)) {
      layerOf.set(m, layerOf.get(n)! + 1);
      queue.push(m);
    }
  }
  let maxLayer = 0;
  for (const n of nodes) {
    if (!layerOf.has(n.id)) layerOf.set(n.id, ++maxLayer); // unreachable: own column at the end
    maxLayer = Math.max(maxLayer, layerOf.get(n.id)!);
  }
  const layers: number[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodes) layers[layerOf.get(n.id)!]!.push(n.id);
  // Barycenter ordering, two sweeps.
  const pos = new Map<number, number>();
  layers.forEach((l) => l.forEach((id, k) => pos.set(id, k)));
  const pred = new Map<number, number[]>();
  for (const n of nodes) pred.set(n.id, []);
  for (const e of edges) if (e.from !== e.to) pred.get(e.to)?.push(e.from);
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let li = 1; li < layers.length; li++) {
      const l = layers[li]!;
      const bary = (id: number) => {
        const ps = (pred.get(id) ?? []).filter((p) => layerOf.get(p)! < li);
        return ps.length ? ps.reduce((a, p) => a + (pos.get(p) ?? 0), 0) / ps.length : pos.get(id) ?? 0;
      };
      l.sort((a, b) => bary(a) - bary(b));
      l.forEach((id, k) => pos.set(id, k));
    }
  }
  const tallest = Math.max(1, ...layers.map((l) => l.length));
  // Crowded layers get more vertical room so edge labels stay legible.
  const dyEff = tallest > 8 ? dy * 1.25 : dy;
  const height = tallest * dyEff + 40;
  const placed = new Map<number, { x: number; y: number }>();
  layers.forEach((l, li) => {
    const total = l.length;
    l.forEach((id, k) => {
      const x = 60 + li * dx;
      const y = height / 2 + (k - (total - 1) / 2) * dyEff;
      placed.set(id, { x, y });
    });
  });
  const outNodes = nodes.map((n) => ({ ...n, ...placed.get(n.id)!, r }));
  // Edges, grouping multiple labels between the same pair.
  const grouped = new Map<string, GEdge>();
  for (const e of edges) {
    const k = `${e.from}>${e.to}`;
    const g = grouped.get(k);
    if (g) g.label = g.label ? `${g.label}, ${e.label}` : e.label;
    else grouped.set(k, { ...e });
  }
  const outEdges: LaidOut['edges'] = [];
  const pairCount = new Map<string, number>();
  for (const e of grouped.values()) {
    const a = placed.get(e.from)!;
    const b = placed.get(e.to)!;
    if (e.from === e.to) {
      const path = `M ${a.x - r * 0.6} ${a.y - r * 0.8} C ${a.x - r * 1.6} ${a.y - r * 2.6}, ${a.x + r * 1.6} ${a.y - r * 2.6}, ${a.x + r * 0.6} ${a.y - r * 0.8}`;
      outEdges.push({ ...e, path, lx: a.x, ly: a.y - r * 2.4, back: false, self: true });
      continue;
    }
    const back = layerOf.get(e.to)! <= layerOf.get(e.from)!;
    const reverseKey = `${e.to}>${e.from}`;
    const bidir = grouped.has(reverseKey);
    const bend = (bidir ? 0.25 : 0) + (back ? 0.45 : 0);
    const ddx = b.x - a.x;
    const ddy = b.y - a.y;
    const len = Math.hypot(ddx, ddy) || 1;
    const ux = ddx / len;
    const uy = ddy / len;
    const sx = a.x + ux * r;
    const sy = a.y + uy * r;
    const tx = b.x - ux * (r + 6);
    const ty = b.y - uy * (r + 6);
    // Perpendicular bow.
    const px = -uy;
    const py = ux;
    const amount = bend * len * (back ? 1 : 1) + (pairCount.get(`${e.from}>${e.to}`) ?? 0) * 12;
    pairCount.set(`${e.from}>${e.to}`, (pairCount.get(`${e.from}>${e.to}`) ?? 0) + 1);
    const c1x = sx + ux * len * 0.33 + px * amount;
    const c1y = sy + uy * len * 0.33 + py * amount;
    const c2x = sx + ux * len * 0.66 + px * amount;
    const c2y = sy + uy * len * 0.66 + py * amount;
    const path = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${tx} ${ty}`;
    const lx = (sx + tx) / 2 + px * amount * 0.75;
    const ly = (sy + ty) / 2 + py * amount * 0.75 - 6;
    outEdges.push({ ...e, path, lx, ly, back, self: false });
  }
  return { nodes: outNodes, edges: outEdges, width: 60 + (maxLayer + 1) * dx + 40, height };
}
