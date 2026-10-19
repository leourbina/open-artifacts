import { APP, expect, test } from "./fixtures";

for (const path of ["/favicon.ico", "/apple-touch-icon.png", "/favicon.svg"]) {
  test(`${path} is served as an image`, async ({ request }) => {
    const res = await request.get(`${APP}${path}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/^image\//);
  });
}

for (const path of ["/", "/sign-in"]) {
  test(`${path} HTML links the icons`, async ({ request }) => {
    const html = await (await request.get(`${APP}${path}`)).text();
    expect(html).toContain('rel="icon" href="/favicon.svg"');
    expect(html).toContain('rel="icon" href="/favicon.ico"');
    expect(html).toContain(
      'rel="apple-touch-icon" href="/apple-touch-icon.png"',
    );
  });
}
