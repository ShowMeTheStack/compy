import { useState } from 'react';
import { Memory } from '@cide/runtime';
import { VarView } from '@cide/vm';
import { SegView, HeapView } from './session';

interface MemoryViewProps {
  segments: SegView[];
  locals: VarView[];
  globals: VarView[];
  heap: HeapView[];
  mem: Memory | null;
}

const SEG_COLOR: Record<string, string> = {
  null: '#555',
  text: '#4b6584',
  rodata: '#8854d0',
  data: '#3867d6',
  bss: '#2d98da',
  heap: '#20bf6b',
  stack: '#eb3b5a',
};

function hex(n: number): string {
  return '0x' + (n >>> 0).toString(16).padStart(6, '0');
}

function segmentOf(segments: SegView[], addr: number): SegView | undefined {
  return segments.find((s) => addr >= s.start && addr < s.end);
}

export function MemoryView({ segments, locals, globals, heap, mem }: MemoryViewProps) {
  const [inspectAddr, setInspectAddr] = useState<number | null>(null);

  return (
    <div className="memview">
      <section>
        <h3>Process memory layout</h3>
        <div className="seg-bars">
          {segments
            .filter((s) => s.name !== 'text')
            .map((s) => {
              const pct = s.size > 0 ? Math.min(100, (s.used / s.size) * 100) : 0;
              return (
                <div className="seg-row" key={s.name} title={`${s.name}: ${hex(s.start)}–${hex(s.end)} (${s.perm})`}>
                  <span className="seg-name" style={{ color: SEG_COLOR[s.name] }}>
                    {s.name}
                  </span>
                  <span className="seg-range">{hex(s.start)}</span>
                  <div className="seg-track">
                    <div
                      className="seg-fill"
                      style={{ width: `${Math.max(pct, s.used > 0 ? 2 : 0)}%`, background: SEG_COLOR[s.name] }}
                    />
                  </div>
                  <span className="seg-perm">{s.perm}</span>
                  <span className="seg-used">{s.used} B</span>
                </div>
              );
            })}
        </div>
        <p className="hint">
          stack grows down ↓, heap grows up ↑ — the two segments students always confuse are kept
          separate here.
        </p>
      </section>

      {locals.length > 0 && (
        <section>
          <h3>Locals (current frame)</h3>
          <VarTable vars={locals} segments={segments} onInspect={setInspectAddr} />
        </section>
      )}

      <section>
        <h3>Globals &amp; statics</h3>
        {globals.length === 0 ? <p className="hint">none</p> : <VarTable vars={globals} segments={segments} onInspect={setInspectAddr} />}
      </section>

      <section>
        <h3>Heap blocks</h3>
        {heap.length === 0 ? (
          <p className="hint">no allocations</p>
        ) : (
          <table className="mem-table">
            <thead>
              <tr>
                <th>address</th>
                <th>size</th>
                <th>state</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {heap.map((b) => (
                <tr key={b.addr} className={b.freed ? 'freed' : ''}>
                  <td className="mono">{hex(b.addr)}</td>
                  <td>{b.size} B</td>
                  <td>{b.freed ? 'freed' : 'live (leak if never freed)'}</td>
                  <td>
                    <button className="link" onClick={() => setInspectAddr(b.addr)}>
                      inspect
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {inspectAddr !== null && mem && (
        <ByteInspector mem={mem} addr={inspectAddr} segments={segments} onClose={() => setInspectAddr(null)} />
      )}
    </div>
  );
}

function VarTable({ vars, segments, onInspect }: { vars: VarView[]; segments: SegView[]; onInspect: (a: number) => void }) {
  return (
    <table className="mem-table">
      <thead>
        <tr>
          <th>name</th>
          <th>type</th>
          <th>address</th>
          <th>value</th>
        </tr>
      </thead>
      <tbody>
        {vars.map((v) => {
          const seg = segmentOf(segments, v.addr);
          return (
            <tr key={`${v.name}-${v.addr}`}>
              <td className="mono">{v.name}</td>
              <td className="type">{v.type}</td>
              <td className="mono">
                <button className="link" onClick={() => onInspect(v.addr)} style={{ color: SEG_COLOR[seg?.name ?? 'data'] }}>
                  {hex(v.addr)}
                </button>
              </td>
              <td className="mono value">{v.value}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ByteInspector({ mem, addr, segments, onClose }: { mem: Memory; addr: number; segments: SegView[]; onClose: () => void }) {
  const [, setTick] = useState(0);
  const start = addr - (addr % 16);
  const rows = 8;
  const seg = segmentOf(segments, addr);

  const readByte = (a: number): number => {
    try {
      return mem.inspect(a, 1).bytes[0] ?? 0;
    } catch {
      return 0;
    }
  };
  const poke = (a: number) => {
    const cur = readByte(a);
    const input = prompt(`Edit byte at ${hex(a)} (0–255):`, String(cur));
    if (input === null) return;
    const val = parseInt(input, input.trim().startsWith('0x') ? 16 : 10);
    if (!isNaN(val)) {
      mem.poke(a, val & 0xff);
      setTick((n) => n + 1);
    }
  };

  return (
    <section className="byte-inspector" data-testid="byte-inspector">
      <h3>
        Bytes at {hex(addr)} <span className="seg-tag" style={{ background: SEG_COLOR[seg?.name ?? 'data'] }}>{seg?.name ?? '?'}</span>
        <button className="link close" onClick={onClose}>
          close
        </button>
      </h3>
      <p className="hint">click any byte to edit it — you can change any memory in the machine.</p>
      <table className="hexdump">
        <tbody>
          {Array.from({ length: rows }, (_, r) => {
            const base = start + r * 16;
            return (
              <tr key={base}>
                <td className="mono addr">{hex(base)}</td>
                {Array.from({ length: 16 }, (_, c) => {
                  const a = base + c;
                  const b = readByte(a);
                  return (
                    <td key={a} className={`mono byte ${a === addr ? 'highlight' : ''}`} onClick={() => poke(a)} title={hex(a)}>
                      {b.toString(16).padStart(2, '0')}
                    </td>
                  );
                })}
                <td className="mono ascii">
                  {Array.from({ length: 16 }, (_, c) => {
                    const b = readByte(base + c);
                    return b >= 32 && b < 127 ? String.fromCharCode(b) : '.';
                  }).join('')}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
