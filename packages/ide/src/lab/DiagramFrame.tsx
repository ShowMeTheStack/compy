import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Wraps any diagram: inline it gets a small toolbar with an "open" button;
 * opened, it fills the window as a central panel with zoom (buttons, wheel,
 * fit) and drag-to-pan, so big automata and trees can be explored.
 */
interface Props {
  title: string;
  /** Natural size of the drawing. */
  width: number;
  height: number;
  children: ReactNode;
  maxHeight?: number;
  testId?: string;
}

export function DiagramFrame({ title, width, height, children, maxHeight = 420, testId }: Props) {
  const [open, setOpen] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const [fitScale, setFitScale] = useState(1);
  useEffect(() => {
    // Measure the frame (whose width the panel sets), never the scrolling
    // viewport: an inner scrollbar would change the measurement and loop.
    const el = frameRef.current;
    if (!el) return;
    let last = -1;
    const update = () => {
      const avail = el.clientWidth - 26; // frame padding + a possible vertical scrollbar
      const next = Math.min(1, Math.max(0.3, avail / Math.max(1, width)));
      if (Math.abs(next - last) < 0.01) return;
      last = next;
      setFitScale(next);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="diagram-frame" data-testid={testId} ref={frameRef}>
      <div className="diagram-bar">
        <span className="diagram-title">{title}</span>
        <span className="dim">
          {Math.round(width)}×{Math.round(height)}
        </span>
        <span className="spacer" />
        <button className="btn" onClick={() => setOpen(true)} title="Open as a central panel with zoom and pan" data-testid="diagram-open">
          ⤢ open
        </button>
      </div>
      <div className="diagram-inline" style={{ maxHeight }}>
        <div className="diagram-fit" style={{ width: width * fitScale, height: height * fitScale }}>
          <div style={{ transform: `scale(${fitScale})`, transformOrigin: '0 0', width, height }}>{children}</div>
        </div>
        {fitScale < 1 && <div className="diagram-fit-note dim">shown at {Math.round(fitScale * 100)}% — open for full size</div>}
      </div>
      {open && createPortal(<Zoomer title={title} width={width} height={height} onClose={() => setOpen(false)}>{children}</Zoomer>, document.body)}
    </div>
  );
}

function Zoomer({ title, width, height, onClose, children }: { title: string; width: number; height: number; onClose: () => void; children: ReactNode }) {
  const host = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const drag = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const fit = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const s = Math.min((el.clientWidth - 40) / width, (el.clientHeight - 40) / height, 2.5);
    setScale(Math.max(0.1, s));
    setTx((el.clientWidth - width * Math.max(0.1, s)) / 2);
    setTy((el.clientHeight - height * Math.max(0.1, s)) / 2);
  }, [width, height]);
  useEffect(() => {
    fit();
  }, [fit]);
  const zoomBy = (factor: number, cx?: number, cy?: number) => {
    const el = host.current;
    const next = Math.min(6, Math.max(0.1, scale * factor));
    const px = cx ?? (el ? el.clientWidth / 2 : 0);
    const py = cy ?? (el ? el.clientHeight / 2 : 0);
    // Keep the point under the cursor fixed.
    setTx(px - ((px - tx) * next) / scale);
    setTy(py - ((py - ty) * next) / scale);
    setScale(next);
  };
  return (
    <div className="diagram-modal" data-testid="diagram-modal" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="diagram-window">
        <div className="diagram-bar">
          <span className="diagram-title">{title}</span>
          <span className="spacer" />
          <button className="btn" onClick={() => zoomBy(1 / 1.25)} title="zoom out">−</button>
          <span className="mono dim zoom-pct" data-testid="zoom-pct">{Math.round(scale * 100)}%</span>
          <button className="btn" onClick={() => zoomBy(1.25)} title="zoom in" data-testid="zoom-in">+</button>
          <button className="btn" onClick={fit} title="fit to window">fit</button>
          <button className="btn" onClick={() => { setScale(1); setTx(20); setTy(20); }} title="actual size">100%</button>
          <button className="btn stop" onClick={onClose} title="close (Esc)" data-testid="diagram-close">✕</button>
        </div>
        <div
          className="diagram-canvas"
          ref={host}
          onWheel={(e) => {
            e.preventDefault();
            const rect = host.current!.getBoundingClientRect();
            zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - rect.left, e.clientY - rect.top);
          }}
          onMouseDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY, tx, ty };
          }}
          onMouseMove={(e) => {
            if (!drag.current) return;
            setTx(drag.current.tx + (e.clientX - drag.current.x));
            setTy(drag.current.ty + (e.clientY - drag.current.y));
          }}
          onMouseUp={() => (drag.current = null)}
          onMouseLeave={() => (drag.current = null)}
        >
          <div className="diagram-stage" style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, width, height }}>
            {children}
          </div>
        </div>
        <div className="diagram-help dim">scroll to zoom · drag to pan · Esc to close</div>
      </div>
    </div>
  );
}
