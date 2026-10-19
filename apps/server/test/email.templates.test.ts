import { describe, expect, it } from "vitest";
import inviteHtml from "../../../design/emails/invite.html?raw";
import inviteTxt from "../../../design/emails/invite.txt?raw";
import shareHtml from "../../../design/emails/share.html?raw";
import shareTxt from "../../../design/emails/share.txt?raw";
import {
  INVITE_HTML,
  INVITE_TXT,
  SHARE_HTML,
  SHARE_TXT,
} from "../src/email/email-templates.js";
import { fill, inviteEmail, shareEmail } from "../src/email/templates.js";

const EVIL = '"><script>alert(1)</script>\r\nBcc: evil@x.com {{logoUrl}} &amp;';
const common = {
  inviter: `Mal${EVIL}`,
  instance: `Acme${EVIL}`,
  recipient: "new@x.com",
  appHost: "app.example.com",
};

/** Asserts a rendered email is clean, whatever the input. */
function clean(m: { subject: string; text: string; html: string }) {
  expect(m.subject).not.toMatch(/[\r\n]/);
  expect(m.subject.length).toBeLessThanOrEqual(150);
  for (const part of [m.subject, m.text, m.html]) {
    expect(part).not.toContain("\r");
    expect(part).not.toMatch(/\nBcc/);
  }
  expect(m.html).not.toContain("<script>");
  expect(m.html).toContain("&lt;script&gt;");
  // A placeholder inside a value is data, not a second substitution.
  expect(m.html).toContain("{{logoUrl}}");
  expect(m.html).toContain("&amp;amp;");
  expect(m.html).toContain('src="https://app.example.com/email/logo@2x.png"');
  for (const href of m.html.matchAll(/href="([^"]*)"/g))
    expect(href[1]).toMatch(/^https:\/\/app\.example\.com\//);
}

describe("email templates", () => {
  it("the bundled templates match design/emails (run the build)", () => {
    expect(INVITE_HTML).toBe(inviteHtml);
    expect(INVITE_TXT).toBe(inviteTxt);
    expect(SHARE_HTML).toBe(shareHtml);
    expect(SHARE_TXT).toBe(shareTxt);
  });

  it("renders the invite with hostile values", () => {
    const m = inviteEmail(common);
    clean(m);
    expect(m.text).toContain("https://app.example.com/sign-in");
    expect(m.html).toContain('href="https://app.example.com/sign-in"');
    expect(m.text).toContain("new@x.com");
  });

  it("renders the share with hostile values", () => {
    const m = shareEmail({
      ...common,
      title: `Plan${EVIL}<img src=x onerror=1>`,
      path: "/a/abc",
      format: "markdown",
      role: "editor",
    });
    clean(m);
    expect(m.html).not.toContain("<img src=x");
    expect(m.html).toContain('href="https://app.example.com/a/abc"');
    expect(m.text).toContain("Format: Markdown doc");
    expect(m.text).toContain("Your role: Editor");
    expect(m.subject).toMatch(/^Mal.* shared “Plan/);
  });

  it("refuses links off the app host", () => {
    for (const appHost of ["x.com/@evil", "evil.com:80@x", "a b"])
      expect(() => inviteEmail({ ...common, appHost })).toThrow();
    for (const path of ["@evil.com/x", ".evil.com/x", "x"])
      expect(() =>
        shareEmail({
          ...common,
          title: "t",
          path,
          format: "pdf",
          role: "viewer",
        }),
      ).toThrow();
  });

  it("fill throws on an unknown, unfilled or malformed placeholder", () => {
    expect(() => fill("Hi {{who}}", {})).toThrow(/who/);
    expect(() => fill("Hi {{ who }}", { who: "x" })).toThrow(/malformed/);
    expect(() => fill("Hi {{who-1}}", { who: "x" })).toThrow(/malformed/);
    expect(fill("Hi {{who}}", { who: "<b>" }, (s) => `[${s}]`)).toBe(
      "Hi [<b>]",
    );
  });
});
