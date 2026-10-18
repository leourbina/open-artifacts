// The slice of node:sqlite (Node ≥ 22.5) the bench uses; @types/node 20 lacks it.
declare module "node:sqlite" {
  type Value = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    all(...params: Value[]): unknown[];
    get(...params: Value[]): unknown;
    run(...params: Value[]): {
      changes: number | bigint;
      lastInsertRowid: number | bigint;
    };
    columns(): { name: string }[];
    setReturnArrays(enabled: boolean): void;
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
}
