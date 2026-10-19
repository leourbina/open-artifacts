// Minimal invite/share email templates, kept in one module so they are easy to
// replace. Every interpolated value is untrusted: HTML-escaped in `html`, and
// stripped of control characters (CR/LF included) and length-capped in
// `subject` and `text`, so nothing can inject headers or markup.

export type EmailContent = { subject: string; text: string; html: string };

// C0/C1 controls (incl. CR/LF/TAB), line/paragraph separators, bidi controls,
// zero-width characters and BOM.
const UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]+/g;

/** One plain line: unsafe characters become a space, at most `max` code points. */
export function oneLine(s: string, max: number): string {
  const t = s.replace(UNSAFE, " ").replace(/ {2,}/g, " ").trim();
  const cps = Array.from(t);
  return cps.length <= max ? t : `${cps.slice(0, max - 1).join("")}…`;
}

const esc = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const SUBJECT_MAX = 150;
const NAME_MAX = 80;
const TITLE_MAX = 200;

function layout(lead: string, cta: string, url: string): string {
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#111">
<p>${lead}</p>
<p><a href="${esc(url)}" style="display:inline-block;padding:8px 16px;background:#111;color:#fff;text-decoration:none;border-radius:6px">${cta}</a></p>
<p style="color:#666;font-size:13px">Or open ${esc(url)}</p>
</body></html>`;
}

/** A member invite; `url` must be the instance's https app origin. */
export function inviteEmail(p: {
  inviter: string;
  instance: string;
  url: string;
}): EmailContent {
  const inviter = oneLine(p.inviter, NAME_MAX);
  const instance = oneLine(p.instance, NAME_MAX);
  return {
    subject: oneLine(`${inviter} invited you to ${instance}`, SUBJECT_MAX),
    text: `${inviter} invited you to join ${instance} on Open Artifacts.\n\nSign in: ${p.url}\n`,
    html: layout(
      `<strong>${esc(inviter)}</strong> invited you to join <strong>${esc(instance)}</strong> on Open Artifacts.`,
      "Sign in",
      p.url,
    ),
  };
}

/** An artifact shared with a non-member; `url` is its https viewer URL. */
export function shareEmail(p: {
  inviter: string;
  instance: string;
  title: string;
  url: string;
}): EmailContent {
  const inviter = oneLine(p.inviter, NAME_MAX);
  const instance = oneLine(p.instance, NAME_MAX);
  const title = oneLine(p.title, TITLE_MAX);
  return {
    subject: oneLine(`${inviter} shared "${title}" with you`, SUBJECT_MAX),
    text: `${inviter} shared "${title}" with you on ${instance}.\n\nOpen it: ${p.url}\n`,
    html: layout(
      `<strong>${esc(inviter)}</strong> shared <strong>${esc(title)}</strong> with you on ${esc(instance)}.`,
      "Open",
      p.url,
    ),
  };
}
