import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './app.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<StrictMode><App /></StrictMode>);

// Register the service worker (model cache + cross-origin isolation headers on
// static hosts). Best-effort: the app works without it. When the worker takes
// control for the first time the page is not yet isolated, so reload once.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => {
        if (!navigator.serviceWorker.controller && !crossOriginIsolated && reg.active && !sessionStorage.getItem('compy-coi-reloaded')) {
          sessionStorage.setItem('compy-coi-reloaded', '1');
          location.reload();
        }
      })
      .catch(() => {});
  });
}

