/**
 * Shared UTF-8 codecs, one per isolate (the hot paths built one per call).
 * decode() is only ever called without `stream`, so it keeps no state.
 */
export const utf8Encoder = new TextEncoder();
export const utf8Decoder = new TextDecoder();
