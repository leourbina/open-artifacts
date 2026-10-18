import { describe, expect, it } from "vitest";
import { sandbox, script } from "./stubs.ts";

const gh = '[[ "$*" == "pr list"* ]] && echo "$OPEN_PRS"; true';
const dispatch = (open: number) => {
  const sb = sandbox({ gh });
  const r = sb.run(["bash", script("release-pr-dispatch.sh")], {
    env: {
      GITHUB_REPOSITORY: "o/r",
      BRANCH: "release-please--x",
      OPEN_PRS: String(open),
    },
  });
  return { code: r.code, calls: sb.log() };
};

describe("release-pr-dispatch.sh", () => {
  it("dispatches ci.yml on the release branch when a PR is open", () => {
    const r = dispatch(1);
    expect(r.code).toBe(0);
    expect(r.calls).toContain(
      "gh workflow run ci.yml --repo o/r --ref release-please--x",
    );
  });
  it("does not dispatch when no PR is open", () => {
    const r = dispatch(0);
    expect(r.code).toBe(0);
    expect(r.calls.some((c) => c.startsWith("gh workflow run"))).toBe(false);
  });
});
