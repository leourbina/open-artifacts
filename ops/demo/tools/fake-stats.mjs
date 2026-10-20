#!/usr/bin/env node
// Fake feed for the dashboard demo: writes stats/today and stats/hourly-YYYYMMDD
// through the REST data API every few seconds, with numbers that grow like a busy demo.
//
//   node ops/demo/tools/fake-stats.mjs --origin http://localhost:8787 --artifact <id> --token <PAT>
//
// Options: --every <seconds> (default 3), --truncate <metric,...> (lower bounds: votes, pixels,
// pins, countries, moves.chess, ...), --missing <source,...> (not deployed: poll, canvas, map,
// tictactoe, chess), --failed <source,...> (this tick failed for that source; its metrics are
// written as 0 so the page has to keep its last value), --chaos (random truncated, missing and
// failed each tick), --age <seconds> (backdates updatedAt, to see the stale state), --once.
// The token is any PAT that can write the artifact (its owner's). OA_TOKEN works too.
import { parseArgs } from "node:util";

const { values: o } = parseArgs({
  options: {
    origin: { type: "string", default: "http://localhost:8787" },
    artifact: { type: "string" },
    token: { type: "string", default: process.env.OA_TOKEN },
    every: { type: "string", default: "3" },
    truncate: { type: "string", default: "" },
    missing: { type: "string", default: "" },
    failed: { type: "string", default: "" },
    chaos: { type: "boolean", default: false },
    age: { type: "string", default: "0" },
    once: { type: "boolean", default: false },
  },
});
if (!o.artifact || !o.token) {
  console.error("usage: fake-stats.mjs --origin <url> --artifact <id> --token <PAT> [--every 3] [--truncate pixels] [--age 0] [--once]");
  process.exit(2);
}

const base = `${o.origin.replace(/\/$/, "")}/api/v1/artifacts/${o.artifact}/data/stats`;
const rnd = (n) => Math.floor(Math.random() * (n + 1));
const day = () => new Date().toISOString().slice(0, 10).replace(/-/g, "");

/* Today so far: a believable morning, then it grows each tick. */
const hourNow = new Date().getUTCHours();
const h = Array.from({ length: 24 }, (_, i) => (i < hourNow ? 20 + rnd(60) + Math.round(40 * Math.sin((i / 24) * Math.PI)) : 0));
const s = {
  votes: 120 + rnd(80), ttt: 1 + rnd(3), chess: rnd(2),
  mttt: 300 + rnd(100), mchess: 150 + rnd(80),
  pixels: 600 + rnd(300), countries: 12 + rnd(10), pins: 40 + rnd(20),
};

const SOURCES = ["poll", "canvas", "map", "tictactoe", "chess"];
const BY_SOURCE = {
  poll: ["votes"], canvas: ["pixels"], map: ["countries", "pins"],
  tictactoe: ["gamesInProgress.tictactoe", "moves.tictactoe"], chess: ["gamesInProgress.chess", "moves.chess"],
};
const zero = (doc, path) => { const [a, b] = path.split("."); if (b) doc[a][b] = 0; else doc[a] = 0; };

async function put(id, data) {
  const r = await fetch(`${base}/${id}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`PUT ${id}: ${r.status} ${await r.text()}`);
}

async function tick() {
  const votes = rnd(6), mt = rnd(9), mc = rnd(5), px = rnd(14);
  s.votes += votes; s.mttt += mt; s.mchess += mc; s.pixels += px;
  s.ttt = Math.max(0, s.ttt + rnd(2) - 1); s.chess = Math.max(0, s.chess + rnd(2) - 1);
  if (Math.random() < 0.25) { s.pins += 1; if (Math.random() < 0.4) s.countries += 1; }
  const hr = new Date().getUTCHours();
  h[hr] += votes + mt + mc + px;
  const today = {
    day: day(), updatedAt: Date.now() - Number(o.age) * 1000,
    votes: s.votes, gamesInProgress: { tictactoe: s.ttt, chess: s.chess },
    moves: { tictactoe: s.mttt, chess: s.mchess }, pixels: s.pixels,
    countries: s.countries, pins: s.pins,
  };
  const list = (v) => v.split(",").filter(Boolean);
  const pick = (xs, p) => xs.filter(() => Math.random() < p);
  const truncated = o.chaos ? pick(["votes", "pixels", "pins", "countries", "moves.chess"], 0.2) : list(o.truncate);
  const missing = o.chaos ? pick(SOURCES, 0.15) : list(o.missing);
  const failed = o.chaos ? pick(SOURCES.filter((x) => !missing.includes(x)), 0.2) : list(o.failed);
  for (const src of [...missing, ...failed]) for (const k of BY_SOURCE[src] || []) zero(today, k);
  if (truncated.length) today.truncated = truncated;
  if (missing.length) today.missing = missing;
  if (failed.length) today.failed = failed;
  await put(`hourly-${day()}`, { h, lastTotal: h.reduce((a, b) => a + b, 0), lastDay: day() });
  await put("today", today);
  console.log(new Date().toISOString(), JSON.stringify(today));
}

await tick();
if (!o.once) setInterval(() => tick().catch((e) => console.error(e.message)), Number(o.every) * 1000);
