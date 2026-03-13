import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Cross-origin isolation enables transformers.js's multithreaded + SIMD WASM
// backend and WebGPU, making the in-browser AI model initialize and run far
// faster. COEP `credentialless` gives isolation without forcing CORP on the
// CDN / HuggingFace responses, so the model still loads.
const coiHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
};

// base './' keeps asset URLs relative so the same build works on GitHub Pages
// project sites and any other static host.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
});
