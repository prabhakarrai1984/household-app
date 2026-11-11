// Reads a photo of a bill into text, on this phone. The reader (Tesseract.js) is downloaded once from a public
// library host the first time you scan; your photo is never uploaded anywhere. If it can't load, type or paste the bill.
const VERSION = '5.1.1';
const SRC = `https://cdn.jsdelivr.net/npm/tesseract.js@${VERSION}/dist/tesseract.min.js`;
let loading = null;

function loadLibrary() {
  if (window.Tesseract) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC; s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error("The text reader couldn't be downloaded. It needs internet the first time. You can type or paste the bill instead.")); };
    document.head.append(s);
  });
  return loading;
}

/** Shrinks big photos and boosts contrast (grey, stretched), which makes receipts much easier to read. */
export async function prepareImage(file, maxSide = 2000) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
  let lo = 255, hi = 0;
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0; d[i] = g; if (g < lo) lo = g; if (g > hi) hi = g; }
  const span = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) { const v = Math.max(0, Math.min(255, ((d[i] - lo) * 255) / span)); d[i] = d[i + 1] = d[i + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** -> the text found in the photo. `onStatus(text)` reports progress. */
export async function scanBill(file, onStatus = () => {}) {
  onStatus('Preparing the photo…');
  const image = await prepareImage(file);
  onStatus('Loading the text reader (first time needs internet)…');
  await loadLibrary();
  const worker = await window.Tesseract.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') onStatus(`Reading the bill… ${Math.round(m.progress * 100)}%`); },
  });
  try { return (await worker.recognize(image)).data.text || ''; } finally { await worker.terminate(); }
}
