/*
 * CIDE model cache.
 *  - Downloaded models: onnxruntime fetches the 260-370 MB weights itself, and
 *    Cache.put() rejects redirected responses (weights 302-redirect to the HF
 *    LFS CDN). We cache on the FIRST download by teeing the stream: one copy
 *    feeds onnxruntime, a reconstructed non-redirected copy goes to the cache,
 *    and byte progress is posted to the page. Later loads: served from cache.
 *  - Disk-uploaded models: served from cache under a same-origin path.
 */
const CACHE = 'cide-ai-cache-v1';
const MODEL_HOST = /^https:\/\/(huggingface\.co|[^/]*\.hf\.co|cdn-lfs[^/]*\.huggingface\.co)\//;
const LOCAL_PREFIX = '/cide-local-model/';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function post(msg) {
  self.clients.matchAll().then((cs) => cs.forEach((c) => c.postMessage(msg)));
}

async function handle(req, localOnly) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req.url);
  if (hit) {
    post({ type: 'cide-model', phase: 'cached' });
    return hit; // served from cache — no network, no redownload
  }
  if (localOnly) return new Response('not found', { status: 404 });

  const res = await fetch(req.url, { redirect: 'follow' });
  if (res.status !== 200 || !res.body) return res;
  const total = Number(res.headers.get('content-length')) || 0;
  const isWeights = /\.onnx(\?|$)/.test(req.url);
  const headers = { 'Content-Type': res.headers.get('content-type') || 'application/octet-stream' };
  if (total) headers['Content-Length'] = String(total);

  const [toCache, toClient] = res.body.tee();
  cache.put(req.url, new Response(toCache, { status: 200, headers })).catch(() => {});

  let loaded = 0;
  let last = 0;
  const metered = toClient.pipeThrough(
    new TransformStream({
      transform(chunk, ctrl) {
        loaded += chunk.byteLength;
        const now = Date.now();
        if (isWeights && (now - last > 200 || loaded === total)) {
          last = now;
          post({ type: 'cide-model', phase: 'download', loaded, total });
        }
        ctrl.enqueue(chunk);
      },
    }),
  );
  return new Response(metered, { status: 200, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const isLocal = req.url.startsWith(self.location.origin + LOCAL_PREFIX);
  if (!MODEL_HOST.test(req.url) && !isLocal) return;
  event.respondWith(handle(req, isLocal));
});
