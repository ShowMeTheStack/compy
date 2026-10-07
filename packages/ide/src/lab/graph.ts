/**
 * Layered graph drawing with guarantees the eye can rely on:
 *  - nodes sit in columns (layers); an edge that spans several columns gets
 *    a reserved slot in every intermediate column, so it never passes
 *    through a node;
 *  - edges are routed orthogonally: horizontal runs only at a node's or a
 *    reserved slot's own row, vertical runs only in the gutters between
 *    columns, each edge in its own lane; back edges use the same slots in
 *    the opposite direction, self-loops are small arcs above the node;
 *  - every label is placed by searching positions along its own edge for one
 *    that overlaps no node, no other label and no other edge.
 * Edge/edge crossings can still occur (most graphs are not planar); nothing
 * else overlaps.
 */
export interface GNode {
  id: number;
  label: string;
  accept?: boolean;
  start?: boolean;
  /** Secondary text under the node. */
  sub?: string;
  /** Rectangular nodes (basic blocks) with text lines instead of a circle. */
  lines?: string[];
  title?: string;
}
export interface GEdge {
  from: number;
  to: number;
  label: string;
  kind?: string;
}
export interface Pt {
  x: number;
  y: number;
}
export interface LaidNode extends GNode {
  x: number;
  y: number;
  /** Half-extents of the node's visual box (circle: r; rect: w/2, h/2). */
  hw: number;
  hh: number;
  r: number;
  shape: 'circle' | 'rect';
}
export interface LaidEdge extends GEdge {
  id: number;
  points: Pt[];
  path: string;
  lx: number;
  ly: number;
  lw: number;
  lh: number;
  back: boolean;
  self: boolean;
  /** When no spot on the edge itself was free, the label sits nearby with a leader line to the edge. */
  leader?: { x1: number; y1: number; x2: number; y2: number };
}
export interface LaidOut {
  nodes: LaidNode[];
  edges: LaidEdge[];
  width: number;
  height: number;
}

interface Opts {
  r?: number;
  compact?: boolean;
  /** Font metrics for label/box sizing. */
  charW?: number;
  lineH?: number;
}

const CHAR_W = 7.2;
const LINE_H = 15;

export function labelSize(text: string, charW = CHAR_W): { w: number; h: number } {
  return { w: Math.max(8, text.length * charW + 6), h: 14 };
}

export function layoutGraph(nodes: GNode[], edges: GEdge[], start: number, opts: Opts = {}): LaidOut {
  const r = opts.r ?? (opts.compact ? 17 : 22);
  const charW = opts.charW ?? CHAR_W;
  const lineH = opts.lineH ?? LINE_H;
  if (nodes.length === 0) return { nodes: [], edges: [], width: 10, height: 10 };
  const ids = nodes.map((n) => n.id);
  const index = new Map(ids.map((id, k) => [id, k] as const));
  const N = nodes.length;

  // -- node boxes ------------------------------------------------------------
  const LOOP_H = 22; // height of a self-loop arc above its node
  const hasLoop = new Set(edges.filter((e) => e.from === e.to).map((e) => e.from));
  const boxes = nodes.map((n) => {
    if (n.lines && n.lines.length) {
      const w = Math.max(90, ...n.lines.map((l) => l.length * charW + 20), n.label.length * charW + 20);
      const h = (n.lines.length + 1) * lineH + 14;
      return { hw: w / 2, hh: h / 2, shape: 'rect' as const };
    }
    const subH = n.sub ? 14 : 0;
    const loopH = hasLoop.has(n.id) ? LOOP_H + 16 : 0; // arc plus its label
    // The slot box is symmetric around the circle centre and must contain the
    // sub-label below and the loop (with its label) above.
    const half = Math.max(r + subH, r + loopH);
    return { hw: r, hh: half, shape: 'circle' as const };
  });

  // -- DFS: classify back edges, then longest-path layering on the DAG ------
  const out: number[][] = Array.from({ length: N }, () => []);
  const plain = edges.filter((e) => e.from !== e.to && index.has(e.from) && index.has(e.to));
  plain.forEach((e, k) => out[index.get(e.from)!]!.push(k));
  const state = new Array<number>(N).fill(0); // 0 new, 1 on stack, 2 done
  const isBack = new Array<boolean>(plain.length).fill(false);
  const dfs = (u: number) => {
    state[u] = 1;
    for (const k of out[u]!) {
      const v = index.get(plain[k]!.to)!;
      if (state[v] === 1) isBack[k] = true;
      else if (state[v] === 0) dfs(v);
    }
    state[u] = 2;
  };
  const startIdx = index.get(start) ?? 0;
  dfs(startIdx);
  for (let u = 0; u < N; u++) if (state[u] === 0) dfs(u);
  const layer = new Array<number>(N).fill(0);
  // Longest path from any source along DAG edges (topological order via repeated relaxation).
  for (let iter = 0; iter < N + 1; iter++) {
    let changed = false;
    plain.forEach((e, k) => {
      if (isBack[k]) return;
      const u = index.get(e.from)!;
      const v = index.get(e.to)!;
      if (layer[v]! < layer[u]! + 1) {
        layer[v] = layer[u]! + 1;
        changed = true;
      }
    });
    if (!changed) break;
  }
  // Keep the start node in the first column: shift nothing (sources already at 0).

  // -- slots: real nodes and dummies per column ------------------------------
  interface Slot {
    key: string;
    node?: number; // index into nodes
    edge?: number; // index into plain (dummy)
    col: number;
    pos: number;
    y: number;
    hh: number;
  }
  const maxLayer = Math.max(...layer);
  const columns: Slot[][] = Array.from({ length: maxLayer + 1 }, () => []);
  const nodeSlot = new Map<number, Slot>();
  nodes.forEach((_, i) => {
    const s: Slot = { key: `n${i}`, node: i, col: layer[i]!, pos: 0, y: 0, hh: boxes[i]!.hh };
    columns[s.col]!.push(s);
    nodeSlot.set(i, s);
  });
  // Dummy chain per edge spanning more than one column.
  const chain: Slot[][] = plain.map(() => []);
  plain.forEach((e, k) => {
    const u = index.get(e.from)!;
    const v = index.get(e.to)!;
    const a = Math.min(layer[u]!, layer[v]!);
    const b = Math.max(layer[u]!, layer[v]!);
    for (let c = a + 1; c < b; c++) {
      const s: Slot = { key: `d${k}.${c}`, edge: k, col: c, pos: 0, y: 0, hh: 6 };
      columns[c]!.push(s);
      chain[k]!.push(s);
    }
    if (layer[u]! > layer[v]!) chain[k]!.reverse(); // back edge: walk from source leftwards
  });
  columns.forEach((col) => col.forEach((s, k) => (s.pos = k)));

  // -- crossing minimisation (barycenter sweeps over the slot graph) --------
  // Neighbours of a slot in the previous / next column.
  const slotEdges: [Slot, Slot][] = [];
  plain.forEach((e, k) => {
    const u = nodeSlot.get(index.get(e.from)!)!;
    const v = nodeSlot.get(index.get(e.to)!)!;
    const seq = [u, ...(layer[index.get(e.from)!]! < layer[index.get(e.to)!]! ? chain[k]! : chain[k]!.slice()), v];
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i]!;
      const b = seq[i + 1]!;
      slotEdges.push(a.col < b.col ? [a, b] : [b, a]);
    }
  });
  const prevOf = new Map<Slot, Slot[]>();
  const nextOf = new Map<Slot, Slot[]>();
  for (const [a, b] of slotEdges) {
    nextOf.set(a, [...(nextOf.get(a) ?? []), b]);
    prevOf.set(b, [...(prevOf.get(b) ?? []), a]);
  }
  const sweep = (dir: 1 | -1) => {
    const order = dir === 1 ? columns.slice(1) : columns.slice(0, -1).reverse();
    for (const col of order) {
      const bary = (s: Slot) => {
        const ns = (dir === 1 ? prevOf.get(s) : nextOf.get(s)) ?? [];
        return ns.length ? ns.reduce((acc, t) => acc + t.pos, 0) / ns.length : s.pos;
      };
      col.sort((a, b) => bary(a) - bary(b) || a.pos - b.pos);
      col.forEach((s, k) => (s.pos = k));
    }
  };
  for (let i = 0; i < 12; i++) sweep(i % 2 === 0 ? 1 : -1);

  // -- y coordinates: stack slots in each column with gaps ---------------------
  const gap = opts.compact ? 26 : 34;
  const colHeights = columns.map((col) => col.reduce((acc, s) => acc + 2 * s.hh, 0) + Math.max(0, col.length - 1) * gap);
  const height = Math.max(...colHeights) + 60;
  for (const col of columns) {
    let y = (height - colHeights[columns.indexOf(col)]!) / 2;
    for (const s of col) {
      s.y = y + s.hh;
      y += 2 * s.hh + gap;
    }
  }
  // Straighten dummy chains a little toward their neighbours (keeps order, stays inside the column band).
  for (let pass = 0; pass < 4; pass++) {
    for (const col of columns) {
      for (let k = 0; k < col.length; k++) {
        const s = col[k]!;
        if (s.node !== undefined) continue;
        const ns = [...(prevOf.get(s) ?? []), ...(nextOf.get(s) ?? [])];
        if (!ns.length) continue;
        const want = ns.reduce((a, t) => a + t.y, 0) / ns.length;
        const lo = k > 0 ? col[k - 1]!.y + col[k - 1]!.hh + gap / 2 + s.hh : s.hh + 10;
        const hi = k + 1 < col.length ? col[k + 1]!.y - col[k + 1]!.hh - gap / 2 - s.hh : height - s.hh - 10;
        s.y = Math.min(hi, Math.max(lo, want));
      }
    }
  }

  // -- x coordinates: column widths and gutters sized for lanes and labels ----
  const colW = columns.map((col) => Math.max(...col.map((s) => (s.node !== undefined ? boxes[s.node]!.hw * 2 : 12))));
  // Lanes: every edge segment between column c and c+1 occupies one lane in gutter c.
  const laneCount = new Array<number>(Math.max(1, maxLayer)).fill(0);
  const laneOf = new Map<string, number>();
  for (const [a, b] of slotEdges) {
    const g = a.col;
    laneOf.set(`${a.key}>${b.key}`, laneCount[g]!++);
  }
  const maxLabel = Math.max(0, ...plain.map((e) => labelSize(e.label, charW).w));
  const laneGap = 9;
  const gutterW = laneCount.map((n) => Math.max(opts.compact ? 70 : 90, n * laneGap + 24 + Math.min(maxLabel, 120)));
  const colX: number[] = [];
  let x = 40;
  for (let c = 0; c <= maxLayer; c++) {
    x += colW[c]! / 2;
    colX.push(x);
    x += colW[c]! / 2 + (gutterW[c] ?? 60);
  }
  const width = x + 30;

  const laid: LaidNode[] = nodes.map((n, i) => {
    const s = nodeSlot.get(i)!;
    return { ...n, x: colX[s.col]!, y: s.y, hw: boxes[i]!.hw, hh: boxes[i]!.hh, r, shape: boxes[i]!.shape };
  });

  // -- edge routing ------------------------------------------------------------
  const slotX = (s: Slot) => colX[s.col]!;
  const laidEdges: LaidEdge[] = [];
  const occupiedBoxes: { x1: number; y1: number; x2: number; y2: number }[] = laid.map((n) => (n.shape === 'rect' ? { x1: n.x - n.hw, y1: n.y - n.hh, x2: n.x + n.hw, y2: n.y + n.hh } : { x1: n.x - n.hw - (n.sub ? 14 : 0), y1: n.y - n.r, x2: n.x + n.hw + (n.sub ? 14 : 0), y2: n.y + n.r + (n.sub ? 16 : 0) }));
  const segments: { a: Pt; b: Pt; edge: number }[] = [];

  plain.forEach((e, k) => {
    const uI = index.get(e.from)!;
    const vI = index.get(e.to)!;
    const forward = layer[uI]! < layer[vI]!;
    const u = nodeSlot.get(uI)!;
    const v = nodeSlot.get(vI)!;
    const seq = [u, ...chain[k]!, v]; // in travel order (source → target)
    const points: Pt[] = [];
    for (let i = 0; i + 1 < seq.length; i++) {
      const a = seq[i]!;
      const b = seq[i + 1]!;
      const left = forward ? a : b;
      const right = forward ? b : a;
      const g = left.col;
      const lane = laneOf.get(`${left.key}>${right.key}`) ?? 0;
      const gx = colX[g]! + colW[g]! / 2 + 14 + lane * laneGap;
      const ax = a.node !== undefined ? slotX(a) + (forward ? boxes[a.node]!.hw : -boxes[a.node]!.hw) : slotX(a);
      const bx = b.node !== undefined ? slotX(b) + (forward ? -boxes[b.node]!.hw : boxes[b.node]!.hw) : slotX(b);
      if (i === 0) points.push({ x: ax, y: a.y });
      points.push({ x: gx, y: a.y }, { x: gx, y: b.y }, { x: bx, y: b.y });
    }
    laidEdges.push({ ...e, id: k, points, path: roundedPath(points), lx: 0, ly: 0, lw: 0, lh: 0, back: !forward, self: false });
    for (let i = 0; i + 1 < points.length; i++) segments.push({ a: points[i]!, b: points[i + 1]!, edge: k });
  });
  // Self loops: an arc above the circle, inside the node's reserved slot; label above the arc.
  const loopBoxes: { x1: number; y1: number; x2: number; y2: number }[] = [];
  edges.filter((e) => e.from === e.to).forEach((e, j) => {
    const n = laid[index.get(e.from)!]!;
    const top = n.y - n.r;
    const points: Pt[] = [{ x: n.x - 10, y: top }, { x: n.x - 10, y: top - LOOP_H }, { x: n.x + 10, y: top - LOOP_H }, { x: n.x + 10, y: top }];
    const path = `M ${n.x - 10} ${top} C ${n.x - 24} ${top - LOOP_H - 6}, ${n.x + 24} ${top - LOOP_H - 6}, ${n.x + 10} ${top}`;
    laidEdges.push({ ...e, id: plain.length + j, points, path, lx: n.x, ly: top - LOOP_H - 6, lw: 0, lh: 0, back: false, self: true });
    loopBoxes.push({ x1: n.x - 20, y1: top - LOOP_H - 8, x2: n.x + 20, y2: top });
  });
  occupiedBoxes.push(...loopBoxes);

  // -- label placement --------------------------------------------------------
  // Obstacles live in a uniform grid so each candidate only checks nearby items.
  type Box = { x1: number; y1: number; x2: number; y2: number };
  const CELL = 64;
  const grid = new Map<string, { box: Box; kind: 'node' | 'label' | 'seg'; edge?: number }[]>();
  const cellsOf = (b: Box) => {
    const out: string[] = [];
    for (let cx = Math.floor(b.x1 / CELL); cx <= Math.floor(b.x2 / CELL); cx++) for (let cy = Math.floor(b.y1 / CELL); cy <= Math.floor(b.y2 / CELL); cy++) out.push(`${cx},${cy}`);
    return out;
  };
  const addObstacle = (box: Box, kind: 'node' | 'label' | 'seg', edge?: number) => {
    const item = { box, kind, edge };
    for (const c of cellsOf(box)) {
      const list = grid.get(c);
      if (list) list.push(item);
      else grid.set(c, [item]);
    }
  };
  const hit = (b: Box, o: Box) => Math.min(b.x2, o.x2) - Math.max(b.x1, o.x1) > 0 && Math.min(b.y2, o.y2) - Math.max(b.y1, o.y1) > 0;
  for (const b of occupiedBoxes) addObstacle(b, 'node');
  // Runs are zero-width or zero-height: pad them so the strict overlap test can see them.
  for (const sg of segments) addObstacle({ x1: Math.min(sg.a.x, sg.b.x) - 1.5, y1: Math.min(sg.a.y, sg.b.y) - 1.5, x2: Math.max(sg.a.x, sg.b.x) + 1.5, y2: Math.max(sg.a.y, sg.b.y) + 1.5 }, 'seg', sg.edge);
  const scoreBox = (box: Box, ownEdge: number): number => {
    let score = 0;
    const seen = new Set<object>();
    for (const c of cellsOf(box)) {
      for (const it of grid.get(c) ?? []) {
        if (seen.has(it)) continue;
        seen.add(it);
        if (!hit(box, it.box)) continue;
        if (it.kind === 'node') score += 100;
        else if (it.kind === 'label') score += 50;
        else if (it.edge !== ownEdge) score += 10;
      }
    }
    if (box.x1 < 2 || box.x2 > width - 2 || box.y1 < 2 || box.y2 > height - 2) score += 30;
    return score;
  };
  for (const le of laidEdges) {
    if (!le.label) continue;
    const { w, h } = labelSize(le.label, charW);
    le.lw = w;
    le.lh = h;
    if (le.self) {
      const box: Box = { x1: le.lx - w / 2, y1: le.ly - h, x2: le.lx + w / 2, y2: le.ly };
      // The slot reserved room above the arc; nudge up a little if something still touches.
      for (let tries = 0; tries < 6 && scoreBox(box, le.id) >= 10; tries++) {
        box.y1 -= 4;
        box.y2 -= 4;
      }
      le.lx = (box.x1 + box.x2) / 2;
      le.ly = box.y2;
      addObstacle(box, 'label', le.id);
      continue;
    }
    // Candidate anchors along the polyline (bounded per run), both sides of each run.
    type Cand = { x: number; y: number; score: number };
    let best = null as Cand | null;
    const runs = le.points.length - 1;
    for (let i = 0; i < runs; i++) {
      const a = le.points[i]!;
      const b = le.points[i + 1]!;
      const vertical = a.x === b.x;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.min(10, Math.max(1, Math.floor(len / 12)));
      for (let t = 0; t <= steps; t++) {
        const f = t / steps;
        const px = a.x + (b.x - a.x) * f;
        const py = a.y + (b.y - a.y) * f;
        // Both sides of the run, at two distances, so a crowded run still has a free spot nearby.
        const options: Box[] = vertical
          ? [4, -4 - w, 4 + h + 6, -4 - w - h - 6].map((dx) => ({ x1: px + dx, y1: py - h / 2, x2: px + dx + w, y2: py + h / 2 }))
          : [-h - 3, 3, -2 * h - 9, h + 9].map((dy) => ({ x1: px - w / 2, y1: py + dy, x2: px + w / 2, y2: py + dy + h }));
        for (let side = 0; side < options.length; side++) {
          const box = options[side]!;
          const score = scoreBox(box, le.id) + side * 0.7 + Math.abs(f - 0.5) * 2 + (vertical ? 0 : 1) + i * 0.1;
          if (best === null || score < best.score) best = { x: box.x1, y: box.y2, score };
        }
      }
      if (best !== null && best.score < 1 && i >= 1) break; // a clean spot early on is good enough
    }
    let chosen: Cand = best ?? { x: le.points[0]!.x, y: le.points[0]!.y, score: 0 };
    if (chosen.score >= 10) {
      // Every spot on the edge collides with something: search outward from the
      // edge's middle for free space and connect the label with a leader line.
      const mid = le.points[Math.floor((le.points.length - 1) / 2)]!;
      const mid2 = le.points[Math.floor((le.points.length - 1) / 2) + 1] ?? mid;
      const anchor = { x: (mid.x + mid2.x) / 2, y: (mid.y + mid2.y) / 2 };
      let found: (Cand & { ax: number; ay: number }) | null = null;
      for (let radius = 14; radius <= 160 && !found; radius += 10) {
        for (let k = 0; k < 12; k++) {
          const ang = (k / 12) * Math.PI * 2;
          const cx = anchor.x + Math.cos(ang) * radius;
          const cy = anchor.y + Math.sin(ang) * radius;
          const box: Box = { x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2 };
          const sc = scoreBox(box, le.id);
          if (sc < 10 && (!found || sc < found.score)) found = { x: box.x1, y: box.y2, score: sc, ax: anchor.x, ay: anchor.y };
        }
      }
      if (found) {
        chosen = found;
        le.leader = { x1: found.x + w / 2, y1: found.y - h / 2, x2: found.ax, y2: found.ay };
      }
    }
    le.lx = chosen.x;
    le.ly = chosen.y - 3;
    addObstacle({ x1: chosen.x, y1: chosen.y - h, x2: chosen.x + w, y2: chosen.y }, 'label', le.id);
  }
  return { nodes: laid, edges: laidEdges, width, height };
}

/** Orthogonal polyline with small rounded corners. */
function roundedPath(points: Pt[], radius = 7): string {
  if (points.length < 2) return '';
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i + 1 < points.length; i++) {
    const p = points[i - 1]!;
    const c = points[i]!;
    const n = points[i + 1]!;
    const d1 = Math.hypot(c.x - p.x, c.y - p.y);
    const d2 = Math.hypot(n.x - c.x, n.y - c.y);
    const rr = Math.min(radius, d1 / 2, d2 / 2);
    if (rr < 1) {
      d += ` L ${c.x} ${c.y}`;
      continue;
    }
    const ax = c.x - ((c.x - p.x) / d1) * rr;
    const ay = c.y - ((c.y - p.y) / d1) * rr;
    const bx = c.x + ((n.x - c.x) / d2) * rr;
    const by = c.y + ((n.y - c.y) / d2) * rr;
    d += ` L ${ax} ${ay} Q ${c.x} ${c.y} ${bx} ${by}`;
  }
  const last = points[points.length - 1]!;
  d += ` L ${last.x} ${last.y}`;
  return d;
}
