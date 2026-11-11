// Reads an online-order bill (a PDF invoice) into text, on this phone. Most store and delivery-app PDFs contain real text,
// which is read directly and exactly. If the PDF is only a picture, its pages are drawn and read like a photo instead.
// The PDF reader (pdf.js) is downloaded once from a public library host; the file itself is never uploaded anywhere.
import { scanBill } from './ocr.js';
const VERSION = '3.11.174';
const BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${VERSION}/build/`;
let loading = null;

function loadLibrary() {
  if (window.pdfjsLib) return Promise.resolve();
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = BASE + 'pdf.min.js'; s.onload = resolve;
    s.onerror = () => { loading = null; reject(new Error("The PDF reader couldn't be downloaded. It needs internet the first time. You can paste the bill text instead.")); };
    document.head.append(s);
  });
  return loading;
}

/** pdf.js text pieces ({str, transform:[.,.,.,.,x,y]}) -> text with one line per row, pieces left to right. */
export function itemsToText(items) {
  const rows = [];
  for (const it of items) {
    const s = (it.str || '').trim(); if (!s) continue;
    const x = it.transform[4], y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) < 3);
    if (!row) rows.push(row = { y, parts: [] });
    row.parts.push({ x, s });
  }
  return rows.sort((a, b) => b.y - a.y).map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s).join('  ')).join('\n');
}

/** -> the text of the PDF. `onStatus(text)` reports progress. */
export async function readPdf(file, onStatus = () => {}) {
  onStatus('Loading the PDF reader (first time needs internet)…');
  await loadLibrary();
  const lib = window.pdfjsLib;
  if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = BASE + 'pdf.worker.min.js';
  onStatus('Reading the PDF…');
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages = Math.min(pdf.numPages, 6);
  let text = '';
  for (let i = 1; i <= pages; i++) text += itemsToText((await (await pdf.getPage(i)).getTextContent()).items) + '\n';
  if (text.trim().length > 20) return text;
  // no text inside: it is a picture of a bill, so draw each page and read it like a photo
  let out = '';
  for (let i = 1; i <= Math.min(pages, 3); i++) {
    onStatus(`This PDF is a picture, reading page ${i}…`);
    const page = await pdf.getPage(i), vp = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas'); canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    out += (await scanBill(blob, onStatus)) + '\n';
  }
  return out;
}
