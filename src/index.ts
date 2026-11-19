import {BananaStudioViewer} from './banana/BananaStudioViewer';

document.addEventListener('DOMContentLoaded', () => {
  const mountEl = document.getElementById('canvas-root');
  if (!mountEl) return;
  const fallbackEl = document.getElementById('webgl-fallback');
  const viewer = new BananaStudioViewer(mountEl, fallbackEl);

  window.addEventListener('pagehide', () => viewer.dispose(), {once: true});
});
