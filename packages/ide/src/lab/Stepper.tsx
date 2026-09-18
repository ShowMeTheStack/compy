import { useEffect, useRef, useState } from 'react';

/**
 * Shared stepper controls: first / back / next / last, play with a speed
 * slider, and a position readout. The parent owns the position so panels
 * can sync (chart column, automaton state, tree).
 */
interface Props {
  pos: number;
  count: number;
  onChange: (pos: number) => void;
  label?: string;
  testId?: string;
}

export function Stepper({ pos, count, onChange, label, testId }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(3);
  const posRef = useRef(pos);
  posRef.current = pos;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      if (posRef.current >= count - 1) {
        setPlaying(false);
        return;
      }
      onChange(posRef.current + 1);
    }, 1200 / speed);
    return () => clearInterval(id);
  }, [playing, speed, count, onChange]);
  useEffect(() => {
    setPlaying(false);
  }, [count]);
  const disabled = count === 0;
  return (
    <div className="stepper-controls" data-testid={testId}>
      <button className="btn" disabled={disabled} onClick={() => onChange(0)} title="first">⏮</button>
      <button className="btn" disabled={disabled} onClick={() => onChange(Math.max(0, pos - 1))} title="back" data-testid={testId ? testId + '-back' : undefined}>←</button>
      <button className="btn" disabled={disabled} onClick={() => onChange(Math.min(count - 1, pos + 1))} title="next" data-testid={testId ? testId + '-next' : undefined}>→</button>
      <button className="btn" disabled={disabled} onClick={() => onChange(count - 1)} title="last">⏭</button>
      <button className={`btn ${playing ? 'stop' : ''}`} disabled={disabled} onClick={() => setPlaying((p) => !p)} title={playing ? 'pause' : 'play'}>
        {playing ? '⏸' : '▶'}
      </button>
      <input type="range" min={1} max={10} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="speed" className="speed" />
      <span className="step-count">
        {label ?? 'step'} {count ? pos + 1 : 0}/{count}
      </span>
    </div>
  );
}
