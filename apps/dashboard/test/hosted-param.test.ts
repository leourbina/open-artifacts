// `?hosted=` tokens for the mock-only hosted mode.
import { expect, it } from "vitest";
import { parseHostedParam } from "../src/hostedParam";

it("admin acts as an admin instead of the owner", () => {
  expect(parseHostedParam("1,admin")).toEqual({ actAs: "admin" });
});

it("absent means self-hosted", () => {
  expect(parseHostedParam(null)).toBeUndefined();
});
