import * as pdfjsLib from './lib/pdf.min.mjs';

const BG = { r: 42, g: 37, b: 34 };
const FG = { r: 234, g: 223, b: 200 };
const MAX_SCALE = 3;
const PAGES = document.getElementById('pages');
const STATUS = document.getElementById('status');
const source = decodeURIComponent(location.hash.slice(1));

pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(
  chrome.runtime.getURL('lib/pdf.worker.min.mjs'),
  { type: 'module' }
);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'dpdf-get-source') {
    sendResponse({ url: source });
  }
});

function setStatus(text) {
  if (!text) {
    STATUS.classList.add('hidden');
    return;
  }
  STATUS.classList.remove('hidden');
  STATUS.textContent = text;
}

const RAMP_R = new Uint8ClampedArray(256);
const RAMP_G = new Uint8ClampedArray(256);
const RAMP_B = new Uint8ClampedArray(256);
for (let v = 0; v < 256; v++) {
  const t = v / 255;
  RAMP_R[v] = BG.r + t * (FG.r - BG.r);
  RAMP_G[v] = BG.g + t * (FG.g - BG.g);
  RAMP_B[v] = BG.b + t * (FG.b - BG.b);
}

function applyDark(imageData, keepMask) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    if (keepMask && keepMask[i >> 2]) continue;
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const k = 255 - 2 * (0.299 * r + 0.587 * g + 0.114 * b);
    let a = r + k, bb = g + k, c = b + k;
    a = a < 0 ? 0 : a > 255 ? 255 : a | 0;
    bb = bb < 0 ? 0 : bb > 255 ? 255 : bb | 0;
    c = c < 0 ? 0 : c > 255 ? 255 : c | 0;
    d[i] = RAMP_R[a];
    d[i + 1] = RAMP_G[bb];
    d[i + 2] = RAMP_B[c];
  }
}

async function imageRects(page, viewport) {
  const OPS = pdfjsLib.OPS, U = pdfjsLib.Util;
  let ops;
  try { ops = await page.getOperatorList(); } catch (e) { return []; }
  const rects = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const add = (m) => {
    const full = U.transform(viewport.transform, m);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(p => U.applyTransform(p, full));
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
  };
  const IMG = new Set(
    [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject].filter(v => v !== undefined)
  );
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], a = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm.slice());
    else if (fn === OPS.restore) { if (stack.length) ctm = stack.pop(); }
    else if (fn === OPS.transform) ctm = U.transform(ctm, a);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm.slice());
      if (a && Array.isArray(a[0]) && a[0].length === 6) ctm = U.transform(ctm, a[0]);
    } else if (fn === OPS.paintFormXObjectEnd) { if (stack.length) ctm = stack.pop(); }
    else if (IMG.has(fn)) add(ctm);
    else if (fn === OPS.paintImageXObjectRepeat && a) {
      const sx = a[1], sy = a[2], pos = a[3] || [];
      for (let j = 0; j + 1 < pos.length; j += 2) add(U.transform(ctm, [sx, 0, 0, sy, pos[j], pos[j + 1]]));
    } else if (fn === OPS.paintInlineImageXObjectGroup && a && Array.isArray(a[1])) {
      a[1].forEach(e => { if (e && e.transform) add(U.transform(ctm, e.transform)); });
    }
  }
  return rects;
}

function isPhoto(d, w, h, r) {
  const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1]));
  const x1 = Math.min(w, Math.ceil(r[2])), y1 = Math.min(h, Math.ceil(r[3]));
  if (x1 - x0 < 24 || y1 - y0 < 24) return false;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 20000)));
  let n = 0, paper = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * w + x) * 4, R = d[i], G = d[i + 1], B = d[i + 2];
      const Y = 0.299 * R + 0.587 * G + 0.114 * B;
      const chroma = Math.max(R, G, B) - Math.min(R, G, B);
      n++;
      if (Y > 195 && chroma < 30) paper++;
    }
  }
  return n > 0 && paper / n < 0.55;
}

async function main() {
  if (!source) {
    setStatus('No PDF specified.');
    return;
  }
  let doc;
  try {
    const task = pdfjsLib.getDocument({
      url: source,
      withCredentials: true,
      isEvalSupported: false,
      standardFontDataUrl: chrome.runtime.getURL('lib/standard_fonts/'),
      cMapUrl: chrome.runtime.getURL('lib/cmaps/'),
      cMapPacked: true
    });
    task.onProgress = ({ loaded, total }) => {
      if (total > 0) setStatus('Loading ' + Math.round((loaded / total) * 100) + '%…');
    };
    doc = await task.promise;
  } catch (e) {
    setStatus('Failed to load PDF.');
    return;
  }

  const page1 = await doc.getPage(1);
  const vp1 = page1.getViewport({ scale: 1 });
  const fit = Math.max(0.1, (window.innerWidth - 24) / vp1.width);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.min(fit * dpr, MAX_SCALE);
  const cssW = Math.round(vp1.width * fit);

  const state = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const holder = document.createElement('div');
    holder.className = 'page';
    holder.style.width = cssW + 'px';
    holder.style.height = Math.round(vp1.height * fit) + 'px';
    holder.dataset.index = i;
    const canvas = document.createElement('canvas');
    holder.appendChild(canvas);
    PAGES.appendChild(holder);
    state.push({ holder, canvas, status: 'idle', gen: 0, task: null });
  }

  setStatus('');

  async function renderPage(n) {
    const s = state[n - 1];
    if (s.status === 'ready' || s.status === 'rendering') return;
    const gen = ++s.gen;
    s.status = 'rendering';
    try {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale });
      const canvas = s.canvas;
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const cssH = Math.round(viewport.height / (scale / fit));
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const task = page.render({ canvasContext: ctx, viewport });
      s.task = task;
      await task.promise;
      if (gen !== s.gen) return;
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let keep = null;
      const rects = s.rects || (s.rects = await imageRects(page, viewport));
      for (const r of rects) {
        if (!isPhoto(imageData.data, canvas.width, canvas.height, r)) continue;
        if (!keep) keep = new Uint8Array(canvas.width * canvas.height);
        const x0 = Math.max(0, Math.floor(r[0])), y0 = Math.max(0, Math.floor(r[1]));
        const x1 = Math.min(canvas.width, Math.ceil(r[2])), y1 = Math.min(canvas.height, Math.ceil(r[3]));
        for (let y = y0; y < y1; y++) keep.fill(1, y * canvas.width + x0, y * canvas.width + x1);
      }
      if (gen !== s.gen) return;
      applyDark(imageData, keep);
      ctx.putImageData(imageData, 0, 0);
      if (gen !== s.gen) return;
      s.holder.style.height = cssH + 'px';
      s.holder.classList.add('ready');
      s.status = 'ready';
      page.cleanup();
    } catch (e) {
      if (gen === s.gen) s.status = 'idle';
    }
  }

  function unloadPage(n) {
    const s = state[n - 1];
    s.gen++;
    if (s.task) {
      try { s.task.cancel(); } catch (e) {}
      s.task = null;
    }
    if (s.status !== 'idle') {
      s.status = 'idle';
      s.holder.classList.remove('ready');
      s.canvas.width = 0;
      s.canvas.height = 0;
    }
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const n = Number(e.target.dataset.index);
        if (e.isIntersecting) renderPage(n);
        else unloadPage(n);
      }
    },
    { rootMargin: '150% 0px' }
  );
  for (const s of state) io.observe(s.holder);
}

main();
