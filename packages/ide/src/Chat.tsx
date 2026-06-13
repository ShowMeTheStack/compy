import { useEffect, useRef, useState } from 'react';
import { ChatMessage, respond } from './assistant';
import { aiStatus, subscribeAi, getEngine, AiSnapshot } from './ai';
import { enableNeuralModel, releaseModel, neuralWasEnabled } from './neural';

interface ChatProps {
  onInsertCode: (code: string) => void;
}

function useAi(): AiSnapshot {
  const [snap, setSnap] = useState(aiStatus());
  useEffect(() => subscribeAi(() => setSnap(aiStatus())), []);
  return snap;
}

export function Chat({ onInsertCode }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const ai = useAi();
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Auto-load a previously enabled model from cache.
    if (neuralWasEnabled() && ai.state === 'absent') void enableNeuralModel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [messages, thinking]);

  const send = async () => {
    const q = input.trim();
    if (!q || thinking) return;
    const history = messages;
    const next = [...messages, { role: 'user' as const, text: q }];
    setMessages(next);
    setInput('');
    const engine = getEngine();
    if (engine && ai.ready) {
      setThinking(true);
      try {
        const reply = await engine.chat(q, history);
        setMessages((m) => [...m, { role: 'assistant', text: reply || respond(q, history) }]);
      } catch {
        setMessages((m) => [...m, { role: 'assistant', text: respond(q, history) }]);
      } finally {
        setThinking(false);
      }
    } else {
      setMessages((m) => [...m, { role: 'assistant', text: respond(q, history) }]);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const map: Record<string, Blob> = {};
    let folder = 'local-model';
    for (const f of Array.from(files)) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      const parts = rel.split('/');
      if (parts.length > 1) folder = parts[0]!;
      map[parts.slice(1).join('/') || f.name] = f;
    }
    await enableNeuralModel({ local: { name: folder, files: map } });
  };

  return (
    <div className="chat" data-testid="chat">
      <div className="chat-status">
        {ai.state === 'ready' ? (
          <>
            <span className="dot ready" /> {ai.label}
            <button className="link" onClick={() => void releaseModel()}>
              disable
            </button>
          </>
        ) : ai.state === 'loading' ? (
          <>
            <span className="dot loading" /> {ai.detail || 'loading…'}
            <div className="progress">
              <div className="bar" style={{ width: `${Math.round(ai.progress * 100)}%` }} />
            </div>
          </>
        ) : (
          <>
            <span className="dot" /> Offline assistant
            <button className="link" onClick={() => void enableNeuralModel()} data-testid="enable-ai">
              enable AI model
            </button>
            <button className="link" onClick={() => fileInput.current?.click()} title="Load a model from disk">
              upload model
            </button>
            <input
              ref={fileInput}
              type="file"
              // @ts-expect-error non-standard directory picker attributes
              webkitdirectory=""
              directory=""
              multiple
              style={{ display: 'none' }}
              onChange={onUpload}
            />
          </>
        )}
      </div>
      {ai.state === 'error' && <div className="chat-error">{ai.detail}</div>}

      <div className="chat-log" ref={scroller}>
        {messages.length === 0 && (
          <div className="chat-empty hint">
            Ask about C — pointers, malloc, a compiler error, or “write a program that…”. I answer
            offline; enable a model above for richer help + Tab completion.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            <Markdown text={m.text} onInsertCode={onInsertCode} />
          </div>
        ))}
        {thinking && <div className="msg assistant thinking">…</div>}
      </div>

      <div className="chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send();
          }}
          placeholder="Ask the C assistant…"
          data-testid="chat-input"
        />
        <button className="btn" onClick={() => void send()} data-testid="chat-send">
          Send
        </button>
      </div>
    </div>
  );
}

/** Minimal markdown: ```c code fences (with copy buttons) + **bold** / *italic*. */
function Markdown({ text, onInsertCode }: { text: string; onInsertCode: (c: string) => void }) {
  const parts = text.split(/```(?:c)?\n?([\s\S]*?)```/g);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <div className="code-block" key={i}>
            <pre>{part.replace(/\s+$/, '')}</pre>
            <div className="code-actions">
              <button className="link" onClick={() => navigator.clipboard?.writeText(part).catch(() => {})}>
                copy
              </button>
              <button className="link" onClick={() => onInsertCode(part.replace(/\s+$/, ''))}>
                copy to file
              </button>
            </div>
          </div>
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: inline(part) }} />
        ),
      )}
    </>
  );
}

function inline(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br/>');
}
