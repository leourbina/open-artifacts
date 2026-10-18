import { describe, expect, it } from "vitest";

// F3 ships createHandlers at "@oa/shared/mocks", which FE2+ tests import.
// The "@oa/shared" alias must not rewrite that subpath to ".../index.ts/mocks".
describe("@oa/shared alias", () => {
  it("resolves the @oa/shared/mocks subpath to something other than index.ts/mocks", async () => {
    const spec = "@oa/shared/mocks";
    const err = await import(/* @vite-ignore */ spec).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err ?? "").not.toMatch(/index\.ts\/mocks/);
  });
});
