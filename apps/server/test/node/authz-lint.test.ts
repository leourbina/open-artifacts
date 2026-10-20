import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// P3 T5: access is decided in src/auth/ only. Outside it, no comparison on a
// `.role` or `.ownerId`, no TEAM_ROLES, and no requireAccess(..., "owner")
// except single transfer (managers must go through can(), and the exact-owner
// rule refuses them there).

const SRC = join(import.meta.dirname, "../../src");

/** Target-row rules, not caller checks: "the owner cannot be demoted/removed". */
const ALLOWED: readonly string[] = [
  'services/members.ts: row.role === "owner"',
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return e.name.endsWith(".ts") && !e.name.endsWith(".generated.ts")
      ? [p]
      : [];
  });
}

function findAdHocChecks(root: string): string[] {
  const out: string[] = [];
  for (const file of files(root)) {
    const rel = relative(root, file);
    if (rel.startsWith("auth/")) continue;
    const src = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const report = (n: ts.Node) => {
      const hit = `${rel}: ${n.getText(src)}`;
      if (!ALLOWED.includes(hit)) out.push(hit);
    };
    const prop = (n: ts.Node, name: string) =>
      ts.isPropertyAccessExpression(n) && n.name.text === name;
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        const cmp =
          k === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          k === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          k === ts.SyntaxKind.EqualsEqualsToken ||
          k === ts.SyntaxKind.ExclamationEqualsToken;
        if (
          cmp &&
          [n.left, n.right].some((s) => prop(s, "role") || prop(s, "ownerId"))
        )
          report(n);
      }
      if (ts.isIdentifier(n) && n.text === "TEAM_ROLES") report(n);
      if (
        ts.isCallExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === "requireAccess"
      ) {
        const min = n.arguments[3];
        if (min && ts.isStringLiteral(min) && min.text === "owner") report(n);
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return out;
}

describe("authz lint", () => {
  it("no ad-hoc role, ownerId or owner-level checks outside src/auth", () => {
    expect(findAdHocChecks(SRC)).toEqual([]);
  });
  it("the scan catches each pattern", () => {
    const dir = join(import.meta.dirname, "fixtures");
    const hits = findAdHocChecks(dir);
    for (const h of [
      'bad.ts: user.role === "admin"',
      "bad.ts: a.ownerId !== me",
      "bad.ts: TEAM_ROLES",
      'bad.ts: requireAccess(env, c, id, "owner")',
    ])
      expect(hits).toContain(h);
  });
});
