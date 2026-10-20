import { frameLoad } from "../src/viewer/frame";

/** An artifact iframe stand-in: `src`, `load` events and a contentWindow. */
export class FakeFrame extends EventTarget {
  src = "";
  constructor(public contentWindow: unknown) {
    super();
  }
  /** The frame's current load finished. */
  loaded() {
    this.dispatchEvent(new Event("load"));
  }
}

export const asFrame = (f: FakeFrame) => f as unknown as HTMLIFrameElement;

/** `data` stamped with the frame's current nonce, as its runtime would send it. */
export const stamped = (f: FakeFrame, data: unknown): unknown =>
  data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, nonce: frameLoad(asFrame(f))?.nonce }
    : data;
