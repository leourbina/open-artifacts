import { LIMITS, sendToShell } from "@oa/shared";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { onShellMessage, truncateUtf8, versionFromPath } from "./shell";

const TEXT_PAGES = 50;
const THUMB_WIDTH = 480;
const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

type PdfJs = typeof import("pdfjs-dist");

let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist").then((m) => {
    // Served from /_oa/; pdf.js wraps cross-origin (opaque-origin) workers in a blob itself.
    m.GlobalWorkerOptions.workerSrc = workerUrl;
    return m;
  });
  return pdfjsPromise;
}

/** Text of the first 50 pages, capped at LIMITS.extractedTextBytes UTF-8 bytes. */
export async function extractText(doc: PDFDocumentProxy): Promise<string> {
  const parts: string[] = [];
  let bytes = 0;
  const n = Math.min(doc.numPages, TEXT_PAGES);
  for (let i = 1; i <= n && bytes < LIMITS.extractedTextBytes; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let s = "";
    for (const item of content.items)
      if ("str" in item) s += item.str + (item.hasEOL ? "\n" : "");
    parts.push(s);
    bytes += s.length;
    page.cleanup();
  }
  return truncateUtf8(parts.join("\n\n"), LIMITS.extractedTextBytes);
}

function base64Bytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/** Page 1 as a webp data URL ≤ LIMITS.thumbnailBytes, shrinking quality then scale; null if impossible. */
export async function thumbnail(doc: PDFDocumentProxy): Promise<string | null> {
  const page = await doc.getPage(1);
  const base = page.getViewport({ scale: 1 });
  let scale = THUMB_WIDTH / base.width;
  for (let attempt = 0; attempt < 6; attempt++, scale *= 0.7) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    for (const q of [0.8, 0.6, 0.4]) {
      const url = canvas.toDataURL("image/webp", q);
      if (!url.startsWith("data:image/webp;base64,")) return null; // no webp encoder
      if (base64Bytes(url) <= LIMITS.thumbnailBytes) return url;
    }
  }
  return null;
}

interface PageSlot {
  num: number;
  el: HTMLDivElement;
  rendered: boolean;
  task: { cancel(): void } | null;
}

function setScale(el: HTMLElement, scale: number): void {
  el.style.setProperty("--scale-factor", String(scale));
  el.style.setProperty("--user-unit", "1");
  el.style.setProperty("--total-scale-factor", String(scale));
}

async function drawPage(
  pdfjs: PdfJs,
  page: PDFPageProxy,
  slot: PageSlot,
  scale: number,
): Promise<void> {
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const wrap = document.createElement("div");
  wrap.className = "canvasWrapper";
  wrap.appendChild(canvas);
  const text = document.createElement("div");
  text.className = "textLayer";
  slot.el.replaceChildren(wrap, text);
  slot.el.style.width = `${Math.floor(viewport.width)}px`;
  slot.el.style.height = `${Math.floor(viewport.height)}px`;
  setScale(slot.el, scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const task = page.render({
    canvas,
    canvasContext: ctx,
    viewport,
    transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
  });
  slot.task = task;
  await task.promise;
  slot.task = null;
  await new pdfjs.TextLayer({
    textContentSource: page.streamTextContent(),
    container: text,
    viewport,
  }).render();
}

/**
 * Render a PDF into el as .oa-pdf (D5 contract): pages draw lazily as they near
 * the viewport. Posts pdf.text to the shell and answers thumb.request.
 */
export async function renderPdf(
  url: string,
  el: HTMLElement,
): Promise<{ text: string }> {
  el.innerHTML = `<div class="oa-pdf">
<div class="oa-pdf-toolbar">
<div class="oa-pdf-group"><span class="oa-pdf-page">1</span> / <span class="oa-pdf-count">…</span></div>
<span class="oa-pdf-sep"></span>
<div class="oa-pdf-zoom">
<button type="button" class="oa-pdf-out" aria-label="Zoom out">−</button>
<span class="oa-pdf-level">100%</span>
<button type="button" class="oa-pdf-in" aria-label="Zoom in">+</button>
</div>
</div>
<div class="oa-pdf-pages"></div>
</div>`;
  const q = <T extends Element>(s: string) => el.querySelector(s) as T;
  const pagesEl = q<HTMLDivElement>(".oa-pdf-pages");

  const docPromise = (async () => {
    const pdfjs = await loadPdfJs();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const data = new Uint8Array(await res.arrayBuffer());
    // pdf.js 5 no longer evals and dropped this flag; kept so a downgrade stays safe.
    const params = { data, isEvalSupported: false } as Parameters<
      PdfJs["getDocument"]
    >[0];
    const doc = await pdfjs.getDocument(params).promise;
    return { pdfjs, doc };
  })();
  docPromise.catch(() => undefined);

  // Registered before loading: the shell asks for a thumbnail right after hello.
  onShellMessage((msg) => {
    if (msg.type !== "thumb.request") return;
    void docPromise
      .then(({ doc }) => thumbnail(doc))
      .then((dataUrl) => {
        if (dataUrl) sendToShell({ oa: 1, type: "thumb.ready", dataUrl });
      })
      .catch(() => undefined);
  });

  const { pdfjs, doc } = await docPromise;

  q<HTMLElement>(".oa-pdf-count").textContent = String(doc.numPages);
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  const fit = Math.min(
    1.5,
    Math.max(0.5, ((pagesEl.clientWidth || 900) - 32) / first.width),
  );
  let zoom = 1;
  const scale = () => fit * zoom;

  const slots: PageSlot[] = [];
  const sizeSlot = (s: PageSlot) => {
    s.el.style.width = `${Math.floor(first.width * scale())}px`;
    s.el.style.height = `${Math.floor(first.height * scale())}px`;
    setScale(s.el, scale());
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const slot =
          slots[Number((e.target as HTMLElement).dataset.pageNumber) - 1];
        if (!slot) continue;
        if (e.isIntersecting && e.intersectionRatio >= 0)
          q<HTMLElement>(".oa-pdf-page").textContent = String(slot.num);
        if (e.isIntersecting && !slot.rendered) {
          slot.rendered = true;
          void doc
            .getPage(slot.num)
            .then((p) => drawPage(pdfjs, p, slot, scale()))
            .catch(() => {
              slot.rendered = false;
            });
        }
      }
    },
    { root: null, rootMargin: "100% 0px" },
  );
  for (let i = 1; i <= doc.numPages; i++) {
    const div = document.createElement("div");
    div.className = "page";
    div.dataset.pageNumber = String(i);
    const slot: PageSlot = { num: i, el: div, rendered: false, task: null };
    sizeSlot(slot);
    slots.push(slot);
    pagesEl.appendChild(div);
    observer.observe(div);
  }

  const setZoom = (z: number) => {
    zoom = z;
    q<HTMLElement>(".oa-pdf-level").textContent = `${Math.round(z * 100)}%`;
    for (const s of slots) {
      s.task?.cancel();
      s.rendered = false;
      s.el.replaceChildren();
      sizeSlot(s);
      observer.unobserve(s.el);
      observer.observe(s.el);
    }
  };
  q<HTMLButtonElement>(".oa-pdf-in").addEventListener("click", () => {
    const next = ZOOMS.find((z) => z > zoom);
    if (next) setZoom(next);
  });
  q<HTMLButtonElement>(".oa-pdf-out").addEventListener("click", () => {
    const prev = [...ZOOMS].reverse().find((z) => z < zoom);
    if (prev) setZoom(prev);
  });

  const text = await extractText(doc);
  const version = versionFromPath(location.pathname);
  if (version !== null) sendToShell({ oa: 1, type: "pdf.text", version, text });
  return { text };
}
