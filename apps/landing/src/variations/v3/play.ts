// Variation 3: the terminal session plays once it scrolls into view, pauses
// offscreen, and the artifact it publishes (chart and poll) works for real.
// Reduced motion keeps the final frame: the inline guard never sets data-play.

const $ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) =>
  root.querySelector(sel) as T;
const $$ = <T extends Element = HTMLElement>(root: ParentNode, sel: string) =>
  [...root.querySelectorAll<T & Element>(sel)] as T[];

function chart(root: HTMLElement) {
  const box = $(root, "[data-chart]");
  const series: Record<string, number[]> = JSON.parse(
    box.dataset.series ?? "{}",
  );
  const slo = Number(box.dataset.slo);
  const bars = $$(box, "li");
  const line = $(box, "[data-slo-line]");
  const btns = $$(root, "[data-metric]");
  for (const b of btns)
    b.onclick = () => {
      const k = b.dataset.metric ?? "p95";
      const v = series[k];
      const top = Math.max(...v, slo) * 1.12;
      for (const x of btns) x.setAttribute("aria-pressed", String(x === b));
      bars.forEach((li, i) => {
        li.style.setProperty("--h", `${(v[i] / top) * 100}%`);
        li.classList.toggle("over", k === "p95" && v[i] > slo);
        (li.firstElementChild as HTMLElement).textContent = String(v[i]);
      });
      line.style.setProperty("--y", String(slo / top));
      line.hidden = k !== "p95";
    };
}

function poll(root: HTMLElement) {
  const btns = $$(root, "[data-vote]");
  const seed = btns.map((b) => Number(b.dataset.seed));
  const names = btns.map((b) => $(b, ".v3-opt").textContent ?? "");
  const total = $(root, "[data-total]");
  const hint = $(root, "[data-hint]");
  const follow = $(root, "[data-follow]");
  let mine = -1;
  const render = () => {
    const counts = seed.map((c, i) => c + (i === mine ? 1 : 0));
    const sum = counts.reduce((a, b) => a + b, 0);
    btns.forEach((b, i) => {
      b.setAttribute("aria-pressed", String(i === mine));
      b.style.setProperty("--w", `${(counts[i] / sum) * 100}%`);
      $(b, ".v3-count").textContent = String(counts[i]);
    });
    total.textContent = `${sum} votes`;
    hint.textContent =
      mine < 0
        ? "tap one to vote"
        : "saved · your agent reads it with artifact_data_list";
    const lead = counts.indexOf(Math.max(...counts));
    follow.hidden = false;
    $(follow, "[data-docs]").textContent = String(sum);
    $(follow, "[data-summary]").textContent =
      `${names[lead]} leads with ${counts[lead]} of ${sum} votes.` +
      (mine < 0 ? "" : ` You voted for ${names[mine]}.`);
  };
  btns.forEach((b, i) => {
    b.onclick = () => {
      mine = mine === i ? -1 : i;
      render();
    };
  });
}

function copy(root: HTMLElement) {
  const status = $(root, "[data-copied]");
  if (!navigator.clipboard) return;
  for (const b of $$(root, "[data-copy]")) {
    b.hidden = false;
    b.onclick = async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy ?? "");
        b.textContent = "Copied";
        status.textContent = "Copied to the clipboard";
        setTimeout(() => {
          b.textContent = "Copy";
        }, 1600);
      } catch {
        status.textContent = "Couldn't copy. Select the text instead.";
      }
    };
  }
}

function play(stage: HTMLElement) {
  if (!stage.hasAttribute("data-play")) return;
  const term = $$(stage, ".v3-screen > [data-s]");
  const art = $(stage, "[data-unfold]");
  const spin = term.findIndex((s) => s.hasAttribute("data-spin"));
  const steps = [...term.slice(0, spin + 1), art, ...term.slice(spin + 1)];
  const typed = $(stage, "[data-type]");
  const [done, rest] = $$(typed, "span");
  const text = (done.textContent ?? "") + (rest.textContent ?? "");
  const replay = $(stage, "[data-replay]");
  let gen = 0;
  let visible = false;
  let wake: (() => void) | null = null;
  // Resolve after ms, but only while the stage is on screen.
  const wait = (ms: number) =>
    new Promise((r) => setTimeout(r, ms)).then(() =>
      visible ? undefined : new Promise<void>((r) => (wake = r)),
    );
  const run = async () => {
    const g = ++gen;
    replay.hidden = true;
    for (const s of steps) s.classList.remove("in", "busy");
    done.textContent = "";
    rest.textContent = text;
    for (const s of steps) {
      await wait(Number(s.dataset.s));
      if (g !== gen) return;
      s.classList.add("in");
      if (s.contains(typed)) {
        typed.classList.add("typing");
        for (let i = 0; i <= text.length; i += 2) {
          done.textContent = text.slice(0, i);
          rest.textContent = text.slice(i);
          await wait(16);
          if (g !== gen) return;
        }
        done.textContent = text;
        rest.textContent = "";
        typed.classList.remove("typing");
      } else if (s.hasAttribute("data-spin")) {
        s.classList.add("busy");
        await wait(1200);
        if (g !== gen) return;
        s.classList.remove("busy");
      }
    }
    replay.hidden = false;
  };
  replay.onclick = run;
  let started = false;
  new IntersectionObserver(
    ([e]) => {
      visible = e.isIntersecting;
      stage.classList.toggle("run", visible);
      if (visible && !started) {
        started = true;
        run();
      } else if (visible && wake) {
        const w = wake;
        wake = null;
        w();
      }
    },
    { threshold: 0.15 },
  ).observe(stage);
}

export function run() {
  const root = document.querySelector<HTMLElement>(".v3");
  if (!root) return;
  chart(root);
  poll(root);
  copy(root);
  play($(root, "[data-stage]"));
}
