// Fixture for hosted-lint.test.ts: each read below must be found.
type E = { HOSTED?: string };
export function propertyRead(env: E) {
  return env.HOSTED === "1";
}
export const elementRead = (env: E) => env["HOSTED"] === "1";
export const handlers = [(env: E) => env.HOSTED];
