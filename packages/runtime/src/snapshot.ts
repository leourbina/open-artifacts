import { LIMITS } from "@oa/shared";
import { toCanvas } from "html-to-image";

export const WIDTH = 1200;
export const HEIGHT = 750;
const PREFIX = "data:image/webp;base64,";
const QUALITIES = [0.8, 0.6, 0.45, 0.3, 0.15];

/** Decoded size of a base64 data URL's payload. */
export function base64Bytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

/**
 * The page (document.documentElement) at 1200×750 as a webp data URL no larger
 * than LIMITS.thumbnailBytes, lowering quality until it fits; null otherwise.
 */
export async function snapshot(): Promise<string | null> {
  const bg = getComputedStyle(
    document.body ?? document.documentElement,
  ).backgroundColor;
  const canvas = await toCanvas(document.documentElement, {
    width: WIDTH,
    height: HEIGHT,
    canvasWidth: WIDTH,
    canvasHeight: HEIGHT,
    pixelRatio: 1,
    backgroundColor:
      bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" ? bg : "#ffffff",
  });
  for (const q of QUALITIES) {
    const url = canvas.toDataURL("image/webp", q);
    if (!url.startsWith(PREFIX)) return null; // no webp encoder
    if (base64Bytes(url) <= LIMITS.thumbnailBytes) return url;
  }
  return null;
}
