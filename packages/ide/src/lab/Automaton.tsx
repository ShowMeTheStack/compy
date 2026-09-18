import { useMemo } from 'react';
import { GNode, GEdge, layoutGraph } from './graph';

/**
 * Draws an automaton (NFA, DFA, LR goto graph, PDA): circles for states
 * (double for accepting), a start arrow, labelled curved edges, and sets of
 * highlighted states/edges that animate as a stepper advances.
 */
interface Props {
  nodes: GNode[];
  edges: GEdge[];
  start: number;
  /** Currently active states (e.g. NFA set, DFA state, LR state). */
  active?: Set<number>;
  /** Previously active states (faded trail). */
  trail?: Set<number>;
  /** Edge to pulse (from, to). */
  activeEdge?: [number, number] | null;
  onStateClick?: (id: number) => void;
  onStateHover?: (id: number | null) => void;
  compact?: boolean;
  maxHeight?: number;
  testId?: string;
}

export function Automaton({ nodes, edges, start, active, trail, activeEdge, onStateClick, onStateHover, compact, maxHeight, testId }: Props) {
  const laid = useMemo(() => layoutGraph(nodes, edges, start, compact ? { r: 16, dx: 110, dy: 58 } : {}), [nodes, edges, start, compact]);
  const sn = laid.nodes.find((n) => n.id === start);
  return (
    <div className="automaton-wrap" style={{ maxHeight }} data-testid={testId}>
      <svg className="automaton" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`}>
        <defs>
          <marker id="aut-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa7b2" />
          </marker>
          <marker id="aut-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4ec9b0" />
          </marker>
        </defs>
        {sn && <path d={`M ${sn.x - sn.r - 34} ${sn.y} L ${sn.x - sn.r - 6} ${sn.y}`} className="aut-edge start" markerEnd="url(#aut-arrow)" />}
        {laid.edges.map((e, k) => {
          const hot = activeEdge && activeEdge[0] === e.from && activeEdge[1] === e.to;
          return (
            <g key={k} className={`aut-edge-group ${hot ? 'hot' : ''}`}>
              <path d={e.path} className={`aut-edge ${e.back ? 'back' : ''} ${hot ? 'hot' : ''}`} markerEnd={hot ? 'url(#aut-arrow-hot)' : 'url(#aut-arrow)'} />
              <text x={e.lx} y={e.ly} className={`aut-label ${hot ? 'hot' : ''}`} textAnchor="middle">
                {e.label.length > 28 ? e.label.slice(0, 26) + '…' : e.label}
              </text>
            </g>
          );
        })}
        {laid.nodes.map((n) => {
          const isActive = active?.has(n.id);
          const isTrail = !isActive && trail?.has(n.id);
          return (
            <g key={n.id} className={`aut-state ${isActive ? 'active' : ''} ${isTrail ? 'trail' : ''} ${n.accept ? 'accept' : ''}`} transform={`translate(${n.x}, ${n.y})`} onClick={() => onStateClick?.(n.id)} onMouseEnter={() => onStateHover?.(n.id)} onMouseLeave={() => onStateHover?.(null)}>
              <circle r={n.r} className="aut-circle" />
              {n.accept && <circle r={n.r - 4} className="aut-circle inner" />}
              <text y={4} textAnchor="middle" className="aut-text">
                {n.label}
              </text>
              {n.sub && (
                <text y={n.r + 14} textAnchor="middle" className="aut-sub">
                  {n.sub.length > 22 ? n.sub.slice(0, 20) + '…' : n.sub}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
