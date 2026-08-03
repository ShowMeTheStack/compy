/**
 * The compiler pipeline as a clickable strip. Each phase shows a tiny
 * status (token count, node count, errors…) so students see the program
 * flowing through the stages even before they open a panel.
 */
export type PhaseId = 'source' | 'tokens' | 'preprocess' | 'ast' | 'types' | 'ir' | 'optimize' | 'asm' | 'run';

export interface PhaseStatus {
  id: PhaseId;
  label: string;
  detail: string;
  error?: boolean;
}

export function PhaseBar({ phases, active, onSelect }: { phases: PhaseStatus[]; active: PhaseId | null; onSelect: (p: PhaseId) => void }) {
  return (
    <div className="phasebar" data-testid="phasebar">
      {phases.map((p, k) => (
        <div key={p.id} className="phase-wrap">
          <button className={`phase ${active === p.id ? 'active' : ''} ${p.error ? 'error' : ''}`} onClick={() => onSelect(p.id)} data-testid={`phase-${p.id}`}>
            <span className="phase-label">{p.label}</span>
            <span className="phase-detail">{p.detail}</span>
          </button>
          {k < phases.length - 1 && <span className="phase-arrow">→</span>}
        </div>
      ))}
    </div>
  );
}
