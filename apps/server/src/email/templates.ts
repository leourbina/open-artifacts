// Invite/share emails rendered from Design's templates (design/emails/, bundled
// by scripts/emit-email-templates.ts). Every value is untrusted: stripped of
// control characters (CR/LF included) and length-capped everywhere, then
// HTML-escaped for the .html part, so nothing can inject headers or markup.
import type { Format, ShareRole } from "@oa/shared";
import { escapeHtml } from "../mcp/template.js";
import { effectiveName } from "../services/users.js";
import {
  INVITE_HTML,
  INVITE_TXT,
  SHARE_HTML,
  SHARE_TXT,
} from "./email-templates.js";

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

/**
 * Who sent the invite/share: the member's effective name (see effectiveName),
 * never the bare email local part; else the full email address.
 */
export function senderName(m: { name: string | null; email: string }): string {
  return effectiveName({
    displayName: null,
    name: m.name ?? "",
    email: m.email,
  });
}

const SUBJECT_MAX = 150;
const NAME_MAX = 80;
const TITLE_MAX = 200;
const URL_MAX = 2000;
const PLACEHOLDER = /\{\{([A-Za-z]+)\}\}/g;

/**
 * Fills every `{{name}}` with `encode(value)`. Throws on a placeholder without
 * a value or any malformed `{{`, so a template change can't ship unfilled.
 */
export function fill(
  template: string,
  values: Record<string, string>,
  encode: (s: string) => string = (s) => s,
): string {
  const all = template.split("{{").length - 1;
  if ((template.match(PLACEHOLDER) ?? []).length !== all)
    throw new Error("malformed template placeholder");
  return template.replace(PLACEHOLDER, (_, k: string) => {
    const v = values[k];
    if (v === undefined)
      throw new Error(`template placeholder {{${k}}} has no value`);
    return encode(v);
  });
}

/** An absolute https URL on `origin` only. */
const linkOn = (origin: string, path: string): string => {
  const url = new URL(origin + path);
  if (
    !path.startsWith("/") ||
    url.origin !== origin ||
    url.href.length > URL_MAX
  )
    throw new Error("email links must be https on the app host");
  return url.href;
};

const FORMAT_LABEL: Record<Format, string> = {
  html: "HTML page",
  markdown: "Markdown doc",
  code: "Code",
  pdf: "PDF",
};
const ROLE_LABEL: Record<ShareRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
};

type Common = {
  inviter: string;
  instance: string;
  /** The validated recipient address. */
  recipient: string;
  /** The app host (no scheme); links and the logo point only here. */
  appHost: string;
};

function common(p: Common) {
  const url = new URL(`https://${p.appHost}/`);
  if (url.host !== p.appHost.toLowerCase()) throw new Error("invalid app host");
  const origin = url.origin;
  return {
    origin,
    values: {
      inviterName: oneLine(p.inviter, NAME_MAX),
      instanceName: oneLine(p.instance, NAME_MAX),
      recipientEmail: oneLine(p.recipient, 320),
      appHost: url.host,
      logoUrl: linkOn(origin, "/email/logo@2x.png"),
    },
  };
}

function render(
  html: string,
  txt: string,
  subject: string,
  values: Record<string, string>,
): EmailContent {
  return {
    subject: oneLine(fill(subject, values), SUBJECT_MAX),
    text: fill(txt, values),
    html: fill(html, values, escapeHtml),
  };
}

/** A member invite, linking to the instance's sign-in page. */
export function inviteEmail(p: Common): EmailContent {
  const { origin, values } = common(p);
  return render(
    INVITE_HTML,
    INVITE_TXT,
    "{{inviterName}} added you to {{instanceName}}",
    { ...values, signInUrl: linkOn(origin, "/sign-in") },
  );
}

/** An artifact shared with a non-member, linking to its viewer URL. */
export function shareEmail(
  p: Common & {
    title: string;
    /** Viewer path on the app host, e.g. `/a/<id>`. */
    path: string;
    format: Format;
    role: ShareRole;
  },
): EmailContent {
  const { origin, values } = common(p);
  return render(
    SHARE_HTML,
    SHARE_TXT,
    "{{inviterName}} shared “{{artifactTitle}}” with you",
    {
      ...values,
      artifactTitle: oneLine(p.title, TITLE_MAX),
      artifactUrl: linkOn(origin, p.path),
      artifactFormat: FORMAT_LABEL[p.format],
      role: ROLE_LABEL[p.role],
    },
  );
}
