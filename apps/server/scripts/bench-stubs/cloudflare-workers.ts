// Node stand-in for `cloudflare:workers`, used only by the CPU bench (vitest.bench.config.ts).
export class DurableObject<E = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: E,
  ) {}
}
export class RpcTarget {}
export class WorkerEntrypoint<E = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: E,
  ) {}
}
export class WorkflowEntrypoint<E = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: E,
  ) {}
}
export const env = {};
export const exports = {};
