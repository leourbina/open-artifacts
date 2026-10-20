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

  it("hosted keys nest under their roots", () => {
    expect(qk.spaces()).toEqual(["spaces", {}]);
    expect(qk.spaceMembers("SpEngNpQrSt2uVwX")).toEqual([
      "spaces",
      "SpEngNpQrSt2uVwX",
      "members",
    ]);
    expect(qk.spaceMappings("SpEngNpQrSt2uVwX")).toEqual([
      "spaces",
      "SpEngNpQrSt2uVwX",
      "mappings",
    ]);
    expect(qk.restrictedGroups).toEqual(["directory", "restricted"]);
    expect(qk.directoryGroups("sa")).toEqual(["directory", "groups", "sa"]);
    expect(qk.memberTransfer("Cr7tNpQrSt8uVwXy")).toEqual([
      "members",
      "Cr7tNpQrSt8uVwXy",
      "transfer",
    ]);
  });
});
