import { setAiProgress, setAiStatus, setEngine, type AiEngine } from './ai';
import type { ChatMessage } from './assistant';

/**
 * The in-browser neural engine. transformers.js is loaded from a CDN on demand
 * (never in the app bundle) and runs on WebGPU when a GPU adapter exists (any
 * vendor, desktop or mobile), else the WASM/CPU backend that runs everywhere.
 * Weights are cached by a service worker after the first download, so enabling
 * it again is instant. If anything fails, the app stays on the offline
 * assistant.
 */

// esm.sh resolves the whole dependency graph (onnxruntime-web/-common, etc.) to
// full URLs, so it loads in a browser with no bundler and no import map. The
// jsdelivr dist builds leave bare imports unresolved.
const TRANSFORMERS_CDN = 'https://esm.sh/@huggingface/transformers@3.5.1';
export const MODEL_ID = 'HuggingFaceTB/SmolLM2-360M-Instruct';
const ENABLED_KEY = 'compy-ai-enabled';

const SYSTEM =
  'You are a concise, friendly assistant for beginning C programmers using an ' +
  'in-browser C89 IDE with a memory visualizer. Prefer short, correct answers. ' +
  'When you give code, wrap it in a ```c fenced block that compiles as C89 and ' +
  'runs in this IDE (include the headers and a main).';

export type GenerateFn = (input: unknown, opts?: Record<string, unknown>) => Promise<unknown>;

function extractGenerated(out: unknown): string {
  const first = Array.isArray(out) ? (out[0] as Record<string, unknown>) : {};
  const gen = first?.generated_text;
  if (typeof gen === 'string') return gen;
  if (Array.isArray(gen)) {
    const last = gen[gen.length - 1] as { content?: string } | undefined;
    return last?.content ?? '';
  }
  return '';
}

/**
 * Builds an AiEngine over a transformers.js text-generation function. All
 * generation is serialized through one lock (onnxruntime can't run two
 * inferences at once, and it keeps the UI responsive). Ghost completion bails
 * immediately when the engine is busy; chat waits its turn.
 */
export function buildEngine(generate: GenerateFn): AiEngine {
  let busy = false;
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    while (busy) await new Promise((r) => setTimeout(r, 40));
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };

  const doChat = async (query: string, history: ChatMessage[]): Promise<string> => {
    const messages = [
      { role: 'system', content: SYSTEM },
      ...history.slice(-6).map((m) => ({ role: m.role, content: m.text })),
      { role: 'user', content: query },
    ];
    try {
      const out = await generate(messages, { max_new_tokens: 320, temperature: 0.3, do_sample: true, return_full_text: false });
      return extractGenerated(out).trim();
    } catch {
      const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:';
      const out = await generate(prompt, { max_new_tokens: 160, temperature: 0.4, do_sample: true, return_full_text: false });
      return extractGenerated(out).trim();
    }
  };

  const doComplete = async (before: string): Promise<string> => {
    const out = await generate(before, { max_new_tokens: 40, do_sample: false, return_full_text: false });
    let text = extractGenerated(out);
    if (text.startsWith(before)) text = text.slice(before.length);
    return (text.split('\n')[0] ?? '').replace(/\s+$/, '');
  };

  return {
    chat: (query, history) => run(() => doChat(query, history)),
    complete: (before) => (busy ? Promise.resolve('') : run(() => doComplete(before))),
  };
}

let currentPipeline: (GenerateFn & { dispose?: () => Promise<void> }) | null = null;
let loading = false;

const mb = (n: number) => (n / 1_048_576).toFixed(1);

function makeProgressTracker() {
  const files = new Map<string, { loaded: number; total: number }>();
  let lastBytes = 0;
  let lastTime = Date.now();
  let speed = 0;
  return (p: { status?: string; file?: string; name?: string; loaded?: number; total?: number }) => {
    if (p?.status !== 'progress') return;
    const key = p.file ?? p.name ?? '?';
    files.set(key, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    const now = Date.now();
    const dt = (now - lastTime) / 1000;
    if (dt >= 0.4) {
      const inst = (loaded - lastBytes) / dt;
      speed = speed ? speed * 0.6 + inst * 0.4 : inst;
      lastBytes = loaded;
      lastTime = now;
    }
    const frac = total ? loaded / total : 0;
    const pct = Math.round(frac * 100);
    if (pct >= 100) {
      setAiProgress(1, 'Downloaded ✓ — initializing model in your browser…');
    } else {
      setAiProgress(frac, total ? `Downloading model… ${pct}% · ${mb(loaded)}/${mb(total)} MB · ${mb(speed)} MB/s` : 'Preparing model…');
    }
  };
}

interface Backend {
  device: 'webgpu' | 'wasm';
  dtype: string;
}

export const LOCAL_MODEL_PREFIX = '/compy-local-model/';

async function pickBackend(): Promise<Backend> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (gpu && (await gpu.requestAdapter())) return { device: 'webgpu', dtype: 'q4f16' };
  } catch {
    // WebGPU present but no usable adapter → fall back.
  }
  return { device: 'wasm', dtype: 'q4' };
}

type TransformersMod = {
  pipeline: (task: string, model: string, opts: Record<string, unknown>) => Promise<GenerateFn>;
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    useBrowserCache: boolean;
    localModelPath: string;
    backends?: { onnx?: { wasm?: { proxy?: boolean; numThreads?: number } } };
  };
};

async function loadTransformers(): Promise<TransformersMod> {
  return (await import(/* @vite-ignore */ TRANSFORMERS_CDN)) as TransformersMod;
}

export interface LocalModel {
  name: string;
  files: Record<string, Blob>;
}

function detectLocalDtype(files: Record<string, Blob>): string {
  const has = (n: string) => Object.keys(files).some((k) => k.replace(/\\/g, '/').endsWith(n));
  if (has('onnx/model_q4f16.onnx')) return 'q4f16';
  if (has('onnx/model_q4.onnx')) return 'q4';
  if (has('onnx/model_int8.onnx') || has('onnx/model_quantized.onnx')) return 'int8';
  if (has('onnx/model_fp16.onnx')) return 'fp16';
  return 'fp32';
}

async function stageLocalModel(model: LocalModel): Promise<string> {
  const cache = await caches.open('compy-ai-cache-v1');
  const id = model.name.replace(/[^A-Za-z0-9._-]/g, '_') || 'local-model';
  for (const [rel, blob] of Object.entries(model.files)) {
    const path = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    const url = `${location.origin}${LOCAL_MODEL_PREFIX}${id}/${path}`;
    await cache.put(url, new Response(blob, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }));
  }
  return id;
}

export interface EnableOptions {
  local?: LocalModel;
}

/**
 * Loads the model and registers the engine. By default it downloads the built-in
 * SmolLM2-360M (cached by the service worker so it downloads exactly once); with
 * `opts.local` it loads a model the user uploaded from disk. WebGPU is used when
 * available, else WASM/CPU everywhere.
 */
export async function enableNeuralModel(opts: EnableOptions = {}): Promise<void> {
  if (loading || currentPipeline) return;
  loading = true;
  setAiStatus('loading', 'Loading AI runtime…', 'AI model');
  try {
    const backend = await pickBackend();
    const mod = await loadTransformers();

    let modelId = MODEL_ID;
    let dtype = backend.dtype;
    let source: 'local' | 'download' = 'download';

    if (opts.local) {
      source = 'local';
      setAiProgress(0.05, `Staging “${opts.local.name}” from disk…`);
      modelId = await stageLocalModel(opts.local);
      dtype = detectLocalDtype(opts.local.files);
      mod.env.allowLocalModels = true;
      mod.env.allowRemoteModels = false;
      mod.env.useBrowserCache = false;
      mod.env.localModelPath = `${location.origin}${LOCAL_MODEL_PREFIX}`;
    } else {
      mod.env.allowLocalModels = false;
      mod.env.useBrowserCache = true;
    }

    setAiProgress(source === 'local' ? 0.1 : 0.02, backend.device === 'webgpu' ? 'Initializing on the GPU…' : 'Initializing model…');
    const generate = await mod.pipeline('text-generation', modelId, {
      device: backend.device,
      dtype,
      progress_callback: makeProgressTracker(),
    });

    currentPipeline = generate as GenerateFn & { dispose?: () => Promise<void> };
    const base = source === 'local' ? modelId : (MODEL_ID.split('/').pop() ?? 'AI model');
    setEngine(buildEngine(generate), `${base} · ${backend.device === 'webgpu' ? 'GPU' : 'CPU'}`);
    try {
      if (source === 'download') localStorage.setItem(ENABLED_KEY, '1');
    } catch {
      // storage may be unavailable
    }
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    setAiStatus('error', `Could not load the AI model: ${why.slice(0, 160)}`);
  } finally {
    loading = false;
  }
}

export async function releaseModel(): Promise<void> {
  const pipe = currentPipeline;
  currentPipeline = null;
  setAiStatus('absent', '');
  try {
    localStorage.removeItem(ENABLED_KEY);
  } catch {
    // ignore
  }
  try {
    await pipe?.dispose?.();
  } catch {
    // best-effort free
  }
}

export function neuralWasEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) === '1';
  } catch {
    return false;
  }
}
