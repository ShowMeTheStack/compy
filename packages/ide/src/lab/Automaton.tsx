import { useMemo } from 'react';
import { GNode, GEdge, layoutGraph, LaidOut } from './graph';
import { DiagramFrame } from './DiagramFrame';

/**
 * Draws a graph laid out by `layoutGraph`: circle states (double for
 * accepting) or rectangular blocks with text lines, a start arrow,
 * orthogonal labelled edges, and highlighted active states/edges. Every
 * element carries data attributes so tests can verify nothing overlaps.
 */
interface Props {
  nodes: GNode[];
  edges: GEdge[];
  start: number;
  active?: Set<number>;
  trail?: Set<number>;
  activeEdge?: [number, number] | null;
  onStateClick?: (id: number) => void;
  onStateHover?: (id: number | null) => void;
  onLineHover?: (nodeId: number, line: number) => void;
  compact?: boolean;
  maxHeight?: number;
  testId?: string;
  title?: string;
}

export function Automaton({ nodes, edges, start, active, trail, activeEdge, onStateClick, onStateHover, onLineHover, compact, maxHeight, testId, title }: Props) {
  const laid = useMemo(() => layoutGraph(nodes, edges, start, { compact }), [nodes, edges, start, compact]);
  const svg = <GraphSvg laid={laid} start={start} active={active} trail={trail} activeEdge={activeEdge} onStateClick={onStateClick} onStateHover={onStateHover} onLineHover={onLineHover} testId={testId} />;
  return (
    <DiagramFrame title={title ?? `${nodes.length} states, ${edges.length} edges`} width={laid.width} height={laid.height} maxHeight={maxHeight} testId={testId ? testId + '-frame' : undefined}>
      {svg}
    </DiagramFrame>
  );
}

function GraphSvg({ laid, start, active, trail, activeEdge, onStateClick, onStateHover, onLineHover, testId }: { laid: LaidOut; start: number } & Omit<Props, 'nodes' | 'edges' | 'start' | 'compact' | 'maxHeight' | 'title'>) {
  const sn = laid.nodes.find((n) => n.id === start);
  return (
    <svg className="automaton" width={laid.width} height={laid.height} viewBox={`0 0 ${laid.width} ${laid.height}`} data-testid={testId} data-diagram="graph">
      <defs>
        <marker id="aut-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#9aa7b2" />
        </marker>
        <marker id="aut-arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#4ec9b0" />
        </marker>
        <marker id="aut-arrow-back" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#c9a24c" />
        </marker>
      </defs>
      {sn && <path d={`M ${sn.x - sn.hw - 30} ${sn.y} L ${sn.x - sn.hw - 2} ${sn.y}`} className="aut-edge start" markerEnd="url(#aut-arrow)" data-from="-1" data-to={sn.id} />}
      {laid.edges.map((e) => {
        const hot = activeEdge && activeEdge[0] === e.from && activeEdge[1] === e.to;
        return (
          <g key={e.id} className={`aut-edge-group ${hot ? 'hot' : ''} ${e.kind ?? ''}`}>
            <path d={e.path} className={`aut-edge ${e.back ? 'back' : ''} ${hot ? 'hot' : ''} ${e.kind ?? ''}`} markerEnd={hot ? 'url(#aut-arrow-hot)' : e.back ? 'url(#aut-arrow-back)' : 'url(#aut-arrow)'} data-from={e.from} data-to={e.to} data-edge={e.id} />
            {e.leader && <line x1={e.leader.x1} y1={e.leader.y1} x2={e.leader.x2} y2={e.leader.y2} className="aut-leader" />}
            {e.label && (
              <text x={e.lx + (e.self ? 0 : 3)} y={e.ly} className={`aut-label ${hot ? 'hot' : ''} ${e.kind ?? ''}`} textAnchor={e.self ? 'middle' : 'start'} data-edge={e.id}>
                {e.label}
              </text>
            )}
          </g>
        );
      })}
      {laid.nodes.map((n) => {
        const isActive = active?.has(n.id);
        const isTrail = !isActive && trail?.has(n.id);
        return (
          <g key={n.id} className={`aut-state ${isActive ? 'active' : ''} ${isTrail ? 'trail' : ''} ${n.accept ? 'accept' : ''} ${n.shape}`} transform={`translate(${n.x}, ${n.y})`} onClick={() => onStateClick?.(n.id)} onMouseEnter={() => onStateHover?.(n.id)} onMouseLeave={() => onStateHover?.(null)} data-node={n.id}>
            {n.shape === 'circle' ? (
              <>
                <circle r={n.r} className="aut-circle" />
                {n.accept && <circle r={n.r - 4} className="aut-circle inner" />}
                <text y={4} textAnchor="middle" className="aut-text">
                  {n.label}
                </text>
                {n.sub && (
                  <text y={n.r + 12} textAnchor="middle" className="aut-sub">
                    {n.sub.length > 22 ? n.sub.slice(0, 20) + '…' : n.sub}
                  </text>
                )}
              </>
            ) : (
              <>
                <rect x={-n.hw} y={-n.hh} width={n.hw * 2} height={n.hh * 2} rx={6} className="aut-rect" />
                <rect x={-n.hw} y={-n.hh} width={n.hw * 2} height={18} rx={6} className="aut-rect-title" />
                <text x={-n.hw + 8} y={-n.hh + 13} className="aut-block-title">
                  {n.label}
                </text>
                {(n.lines ?? []).map((l, k) => (
                  <text key={k} x={-n.hw + 8} y={-n.hh + 18 + 14 + k * 15} className={`aut-line ${k === (n.lines?.length ?? 0) - 1 ? 'term' : ''}`} onMouseEnter={() => onLineHover?.(n.id, k)}>
                    {l}
                  </text>
                ))}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
