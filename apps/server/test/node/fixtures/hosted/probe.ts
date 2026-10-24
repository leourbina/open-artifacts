// Fixture for hosted-lint.test.ts: each read below must be found.
type E = { HOSTED?: string };
export function propertyRead(env: E) {
  return env.HOSTED === "1";
}
export const elementRead = (env: E) => env["HOSTED"] === "1";
export const handlers = [(env: E) => env.HOSTED];
export function destructuredLocal(env: E) {
  const { HOSTED: h } = env;
  return h === "1";
}
export const destructuredParam = ({ HOSTED }: E) => HOSTED === "1";
const KEY = "HOSTED";
export function variableKey(env: E) {
  return env[KEY as keyof E] === "1";
}
