import { hashKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { qk } from "../src/api/queries";

describe("query keys", () => {
  it("an explicit default ListQuery shares the cache entry with the empty one", () => {
    // Both send GET /api/v1/artifacts with identical server semantics.
    expect(
      hashKey(qk.artifacts({ scope: "all", limit: 25, includeDeleted: false })),
    ).toBe(hashKey(qk.artifacts({})));
  });
});
