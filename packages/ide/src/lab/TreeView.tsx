import { useMemo } from 'react';
import { TreeNode } from '@compy/lab';

/**
 * Parse tree as an SVG, laid out with leaves evenly spaced left to right
 * and parents centred over their children. Nodes animate in as the stepper
 * advances; the node most recently created is highlighted.
 */
interface Props {
  nodes: Map<number, TreeNode>;
  roots: number[];
  highlightLatest?: boolean;
  onHover?: (node: TreeNode | null) => void;
  compact?: boolean;
}

interface Placed {
  node: TreeNode;
  x: number;
  y: number;
}

export function ParseTree({ nodes, roots, highlightLatest = true, onHover, compact }: Props) {
  const dx = compact ? 34 : 46;
  const dy = compact ? 46 : 60;
  const laid = useMemo(() => {
    const placed: Placed[] = [];
    let nextLeaf = 0;
    let maxDepth = 0;
    const place = (id: number, depth: number): number => {
      const n = nodes.get(id);
      if (!n) return 0;
      maxDepth = Math.max(maxDepth, depth);
      let x: number;
      if (n.children.length === 0) x = nextLeaf++ * dx;
      else {
        const xs = n.children.map((c) => place(c, depth + 1));
        x = (xs[0]! + xs[xs.length - 1]!) / 2;
      }
      placed.push({ node: n, x, y: depth * dy });
      return x;
    };
    let offset = 0;
    for (const r of roots) {
      nextLeaf = Math.max(nextLeaf, offset);
      place(r, 0);
      offset = nextLeaf + 1;
    }
    const width = Math.max(1, nextLeaf) * dx + 60;
    const height = (maxDepth + 1) * dy + 40;
    return { placed, width, height };
  }, [nodes, roots, dx, dy]);
  const latest = useMemo(() => {
    let max = -1;
    for (const id of nodes.keys()) max = Math.max(max, id);
    return max;
  }, [nodes]);
  if (laid.placed.length === 0) return <p className="hint">The tree appears as the parser builds it.</p>;
  const byId = new Map(laid.placed.map((p) => [p.node.id, p] as const));
  return (
    <div className="tree-wrap">
      <svg className="parse-tree" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`}>
        {laid.placed.map((p) =>
          p.node.children.map((c) => {
            const q = byId.get(c);
            if (!q) return null;
            return <line key={`${p.node.id}-${c}`} x1={p.x + 30} y1={p.y + 20} x2={q.x + 30} y2={q.y + 20} className="tree-edge" />;
          }),
        )}
        {laid.placed.map((p) => (
          <g key={p.node.id} className={`tree-node ${p.node.terminal ? 'terminal' : 'nonterminal'} ${highlightLatest && p.node.id === latest ? 'latest' : ''} ${p.node.children.length === 0 && !p.node.terminal ? 'epsilon' : ''}`} transform={`translate(${p.x + 30}, ${p.y + 20})`} onMouseEnter={() => onHover?.(p.node)} onMouseLeave={() => onHover?.(null)}>
            {p.node.terminal ? <rect x={-20} y={-12} width={40} height={24} rx={5} className="tree-box" /> : <ellipse rx={22} ry={13} className="tree-ellipse" />}
            <text y={4} textAnchor="middle" className="tree-text">
              {p.node.terminal ? truncate(p.node.token?.text ?? p.node.label) : p.node.children.length === 0 ? `${p.node.label}` : truncate(p.node.label)}
            </text>
            {!p.node.terminal && p.node.children.length === 0 && (
              <text y={26} textAnchor="middle" className="tree-eps">
                ε
              </text>
            )}
          </g>
        ))}
      </svg>
    </div>
  );
}

function truncate(s: string): string {
  return s.length > 7 ? s.slice(0, 6) + '…' : s;
}
