import { describe, expect, it, vi } from "vitest";
import {
  DATA_LIMIT_CEILINGS,
  DATA_LIMIT_DEFAULTS,
  dailyWritesMessage,
  dataDocTooLargeMessage,
  dataLimits,
  LIMITS,
  mcpBodyLimit,
  mcpTooLargeMessage,
} from "../src/limits.js";

const KB = 1024;
let n = 0;
/** A distinct number per call: warnings dedupe per isolate. */
const uniq = () => ++n;

describe("dataLimits (DATA_DOC_BYTES, DATA_DAILY_WRITES)", () => {
  it("defaults are unchanged: 256 KB / 1 MB docs, 10,000 writes a day", () => {
    const log = vi.fn();
    for (const e of [{}, { DATA_DOC_BYTES: "", DATA_DAILY_WRITES: "  " }])
      expect(dataLimits(e, log)).toEqual({
        plan: "free",
        docBytes: 256 * KB,
        dailyWrites: 10_000,
      });
    expect(dataLimits({ PLAN: "paid" }, log)).toEqual({
      plan: "paid",
      docBytes: 1024 * KB,
      dailyWrites: 10_000,
    });
    expect(DATA_LIMIT_DEFAULTS.free.docBytes).toBe(LIMITS.dataDocBytesFree);
    expect(DATA_LIMIT_DEFAULTS.paid.docBytes).toBe(LIMITS.dataDocBytesPaid);
    expect(log).not.toHaveBeenCalled();
  });

  it("Paid: overrides apply up to 1920 KB and 1,000,000 writes", () => {
    const log = vi.fn();
    expect(
      dataLimits(
        {
          PLAN: "paid",
          DATA_DOC_BYTES: String(1536 * KB),
          DATA_DAILY_WRITES: "250000",
        },
        log,
      ),
    ).toEqual({ plan: "paid", docBytes: 1536 * KB, dailyWrites: 250_000 });
    expect(
      dataLimits(
        {
          PLAN: "paid",
          DATA_DOC_BYTES: String(1920 * KB),
          DATA_DAILY_WRITES: "1000000",
        },
        log,
      ),
    ).toEqual({ plan: "paid", docBytes: 1920 * KB, dailyWrites: 1_000_000 });
    expect(log).not.toHaveBeenCalled();
  });

  it("Paid: over the ceiling clamps (logged)", () => {
    const log = vi.fn();
    const l = dataLimits(
      {
        PLAN: "paid",
        DATA_DOC_BYTES: String(2048 * KB + uniq()),
        DATA_DAILY_WRITES: String(2_000_000 + uniq()),
      },
      log,
    );
    expect(l.docBytes).toBe(DATA_LIMIT_CEILINGS.paid.docBytes);
    expect(l.docBytes).toBe(1920 * KB);
    expect(l.dailyWrites).toBe(1_000_000);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("Free: may go down; above 256 KB / 10,000 clamps and logs once per isolate", () => {
    const log = vi.fn();
    expect(
      dataLimits({ DATA_DOC_BYTES: "65536", DATA_DAILY_WRITES: "500" }, log),
    ).toEqual({ plan: "free", docBytes: 64 * KB, dailyWrites: 500 });
    expect(log).not.toHaveBeenCalled();
    const e = {
      DATA_DOC_BYTES: String(1024 * KB + uniq()),
      DATA_DAILY_WRITES: String(50_000 + uniq()),
    };
    for (let i = 0; i < 3; i++)
      expect(dataLimits(e, log)).toEqual({
        plan: "free",
        docBytes: 256 * KB,
        dailyWrites: 10_000,
      });
    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[0]?.[0]).toMatch(
      /^DATA_DOC_BYTES=\d+ exceeds the free-plan ceiling; using 262144$/,
    );
    expect(log.mock.calls[1]?.[0]).toMatch(
      /^DATA_DAILY_WRITES=\d+ exceeds the free-plan ceiling; using 10000$/,
    );
  });

  it("0 clamps to 1 (logged)", () => {
    const log = vi.fn();
    expect(
      dataLimits(
        { PLAN: "paid", DATA_DOC_BYTES: "0", DATA_DAILY_WRITES: "00" },
        log,
      ),
    ).toMatchObject({ docBytes: 1, dailyWrites: 1 });
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("invalid values fall back to the default (logged once)", () => {
    for (const bad of ["abc", "-5", "1.5", "1e6", "0x10", "12 KB", "NaN"]) {
      const log = vi.fn();
      const e = {
        PLAN: "paid",
        DATA_DOC_BYTES: `${bad}#${uniq()}`,
        DATA_DAILY_WRITES: `${bad}#${uniq()}`,
      };
      expect(dataLimits(e, log)).toEqual({
        plan: "paid",
        docBytes: 1024 * KB,
        dailyWrites: 10_000,
      });
      dataLimits(e, log);
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls[0]?.[0]).toContain("is not a whole number");
    }
  });
});

describe("messages carry the effective numbers", () => {
  it("data doc 413", () => {
    expect(dataDocTooLargeMessage("free", 64 * KB)).toBe(
      "Data docs are limited to 64 KB on this instance; Workers Paid allows 1 MB.",
    );
    expect(dataDocTooLargeMessage("paid", 1536 * KB)).toBe(
      "Data docs are limited to 1536 KB on this instance.",
    );
    expect(dataDocTooLargeMessage("paid", 1000)).toBe(
      "Data docs are limited to 1000 bytes on this instance.",
    );
  });
  it("/mcp body cap follows the Paid doc limit, never below Free's", () => {
    expect(mcpBodyLimit("paid", 1536 * KB)).toBe(1600 * KB);
    expect(mcpBodyLimit("paid", 64 * KB)).toBe(LIMITS.mcpBodyBytesFree);
    expect(mcpBodyLimit("free", 64 * KB)).toBe(LIMITS.mcpBodyBytesFree);
    const m = mcpTooLargeMessage("paid", 1536 * KB);
    expect(m).toContain("Request body exceeds 1600 KB on this instance.");
    expect(m).toContain("Data docs on this instance are limited to 1536 KB;");
    expect(m).not.toContain("Workers Paid allows");
  });
  it("daily writes", () => {
    expect(dailyWritesMessage(250_000)).toBe(
      "daily write limit reached (250000 writes per artifact per UTC day on this instance)",
    );
  });
});
