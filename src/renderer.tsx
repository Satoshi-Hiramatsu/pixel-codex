import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element was not found');

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// index.html の起動スプラッシュは、Reactが最初のフレームを描いた時点で外します。
requestAnimationFrame(() => {
  const splash = document.getElementById('boot-splash');
  if (!splash) return;
  splash.style.transition = 'opacity .25s ease-out';
  splash.style.opacity = '0';
  window.setTimeout(() => splash.remove(), 260);
});
