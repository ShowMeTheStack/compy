import { Memory } from '@cide/runtime';

/**
 * Placeholder shell. The real IDE (editor, memory visualizer, debugger,
 * console, AI assistant) arrives in M8–M10. For now this proves the workspace
 * builds end to end and the runtime is importable from the app.
 */
export function App() {
  const m = new Memory();
  const segs = Object.values(m.segments);
  return (
    <main className="shell">
      <h1>CIDE — a C89 teaching IDE</h1>
      <p>Runtime online. Process memory layout:</p>
      <table>
        <thead>
          <tr>
            <th>segment</th>
            <th>start</th>
            <th>end</th>
            <th>perm</th>
          </tr>
        </thead>
        <tbody>
          {segs.map((s) => (
            <tr key={s.name}>
              <td>{s.name}</td>
              <td>0x{s.start.toString(16)}</td>
              <td>0x{s.end.toString(16)}</td>
              <td>{s.perm}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
