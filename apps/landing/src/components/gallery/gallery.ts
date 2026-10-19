// The gallery: the artifacts' own behavior and the viewer dialog. The viewer
// borrows a tile's artifact and version list while it is open and hands them
// back on close, so their state carries over. Adapted from variation 4.
const root = document.querySelector<HTMLElement>("[data-gallery]");
if (root) {
  const $ = <T extends Element = HTMLElement>(
    s: string,
    r: ParentNode = root,
  ) => r.querySelector<T>(s) as T;
  const $$ = <T extends Element = HTMLElement>(
    s: string,
    r: ParentNode = root,
  ) => [...r.querySelectorAll<T>(s)];
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
  const pct = (a: number, b: number) => `${(a / b) * 100}%`;

  // Copy buttons (code, viewer link).
  if (navigator.clipboard) for (const b of $$("[data-copy]")) b.hidden = false;
  root.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-copy]");
    if (!b) return;
    const label = b.textContent;
    navigator.clipboard.writeText(b.dataset.copy ?? "").then(
      () => {
        b.textContent = "Copied";
        setTimeout(() => {
          b.textContent = label;
        }, 1500);
      },
      () => {},
    );
  });

  // Mortgage calculator.
  const mort = $<HTMLFormElement>("[data-mort]");
  const val = (n: string) =>
    +(mort.elements.namedItem(n) as HTMLInputElement).value;
  const out = (k: string, v: string) => {
    $(`[data-o="${k}"]`, mort).textContent = v;
  };
  mort.addEventListener("submit", (e) => e.preventDefault());
  mort.addEventListener("input", () => {
    const loan = val("price") * (1 - val("down") / 100);
    const r = val("rate") / 1200;
    const n = val("term") * 12;
    const pay = r ? (loan * r) / (1 - (1 + r) ** -n) : loan / n;
    const int = pay * n - loan;
    out("pay", usd(pay));
    out("loan", usd(loan));
    out("int", usd(int));
    out("price", usd(val("price")));
    out("down", `${val("down")}%`);
    $('[data-o="split"]', mort).style.setProperty("--p", pct(loan, loan + int));
  });

  // Retro poll: your vote, plus teammates voting while it is on screen.
  const poll = $("[data-poll]");
  const opts = $$("button[data-n]", poll);
  let mine: HTMLElement | undefined;
  let seen = false;
  const add = (o: HTMLElement, d: number) => {
    o.dataset.n = String(+(o.dataset.n ?? 0) + d);
  };
  const draw = () => {
    const tot = opts.reduce((s, o) => s + +(o.dataset.n ?? 0), 0);
    for (const o of opts) {
      $(".poll-n", o).textContent = o.dataset.n ?? "";
      o.style.setProperty("--p", pct(+(o.dataset.n ?? 0), tot));
    }
    $("[data-total]", poll).textContent = `${tot} votes`;
    return tot;
  };
  poll.addEventListener("click", (e) => {
    const o = (e.target as Element).closest<HTMLElement>("button[data-n]");
    if (!o) return;
    if (mine) {
      add(mine, -1);
      mine.setAttribute("aria-pressed", "false");
    }
    mine = mine === o ? undefined : o;
    if (mine) {
      add(mine, 1);
      mine.setAttribute("aria-pressed", "true");
    }
    draw();
  });
  new IntersectionObserver(([en]) => {
    seen = en.isIntersecting;
  }).observe(poll);
  setInterval(() => {
    if (!seen || reduce.matches || document.hidden || draw() > 60) return;
    const o = opts[(Math.random() * opts.length) | 0];
    add(o, 1);
    o.classList.remove("bump");
    void o.offsetWidth;
    o.classList.add("bump");
    draw();
  }, 2600);

  // Launch checklist.
  const check = $("[data-check]");
  const boxes = $$<HTMLInputElement>("input", check);
  check.addEventListener("change", () => {
    const d = boxes.filter((b) => b.checked).length;
    $("[data-done]", check).textContent = `${d} of ${boxes.length} done`;
    check.style.setProperty("--p", pct(d, boxes.length));
    $("[data-saved]", check).textContent = "Saved for the team · just now";
  });

  // Carousel: one row, prev/next, a count, arrow keys on the track.
  const wall = $("[data-wall]");
  const tiles = $$("[data-tile]", wall);
  const count = $("[data-g-count]");
  const steps = $$<HTMLButtonElement>("[data-g-step]");
  const first = () => {
    const x = wall.getBoundingClientRect().left;
    const i = tiles.findIndex((t) => t.getBoundingClientRect().left >= x - 8);
    return i < 0 ? tiles.length - 1 : i;
  };
  const sync = () => {
    const end = wall.scrollLeft + wall.clientWidth >= wall.scrollWidth - 2;
    steps[0].disabled = wall.scrollLeft <= 2;
    steps[1].disabled = end;
    count.textContent = `${end ? tiles.length : first() + 1} / ${tiles.length}`;
  };
  const go = (d: number) => {
    const i = Math.max(0, Math.min(tiles.length - 1, first() + d));
    wall.scrollTo({
      left: tiles[i].offsetLeft - tiles[0].offsetLeft,
      behavior: reduce.matches ? "auto" : "smooth",
    });
  };
  let tick = 0;
  wall.addEventListener("scroll", () => {
    clearTimeout(tick);
    tick = window.setTimeout(sync, 80);
  });
  for (const b of steps)
    b.addEventListener("click", () => go(Number(b.dataset.gStep)));
  wall.addEventListener("keydown", (e) => {
    if (e.target !== wall) return;
    const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    go(d);
  });
  $("[data-nav]").hidden = false;
  sync();

  // The viewer.
  const dlg = $<HTMLDialogElement>("[data-viewer]");
  const stage = $("[data-vw-stage]", dlg);
  const histSlot = $("[data-vw-hist]", dlg);
  const SHARE: Record<string, [string, string]> = {
    private: ["Private", "Only you can open it."],
    team: ["Team", "Shared by email with 3 people on your team."],
    public: [
      "Public link",
      "Anyone with the link can view it. Search engines don't index it.",
    ],
  };
  let cur: HTMLElement | undefined;
  let art: HTMLElement;
  let hist: HTMLElement;

  const ver = () => {
    const top = hist.firstElementChild as HTMLElement;
    $("[data-vw-ver]", dlg).textContent =
      `${top.dataset.v} · by ${top.dataset.by}`;
    if (cur) $("[data-ver]", cur).textContent = top.dataset.v ?? "";
  };
  const share = (v: string) => {
    if (!cur) return;
    cur.dataset.share = v;
    const l = $("[data-share-label]", cur);
    l.textContent = SHARE[v][0];
    l.className = `share ${v}`;
    $("[data-vw-note]", dlg).textContent = SHARE[v][1];
  };

  const open = (t: HTMLElement) => {
    cur = t;
    art = $(".art", t);
    hist = $("[data-hist]", t);
    const slug = t.dataset.slug ?? "";
    $("[data-vw-slug]", dlg).textContent = slug;
    $("[data-vw-title]", dlg).textContent = t.dataset.title ?? "";
    $(".vw-copy", dlg).dataset.copy = `https://artifacts.example.com/a/${slug}`;
    $("[data-vw-status]", dlg).textContent = "";
    stage.append(art);
    histSlot.append(hist);
    hist.hidden = false;
    ver();
    $<HTMLInputElement>(`[value="${t.dataset.share}"]`, dlg).checked = true;
    share(t.dataset.share ?? "private");
    dlg.showModal();
    $<HTMLElement>("[data-close]", dlg).focus();
    if (reduce.matches) return;
    const a = t.getBoundingClientRect();
    const b = dlg.getBoundingClientRect();
    dlg.animate(
      [
        {
          transformOrigin: "0 0",
          transform: `translate(${a.left - b.left}px,${a.top - b.top}px) scale(${a.width / b.width},${a.height / b.height})`,
          opacity: 0.5,
        },
        { transformOrigin: "0 0", transform: "none", opacity: 1 },
      ],
      { duration: 260, easing: "cubic-bezier(.2,0,0,1)" },
    );
  };

  $("[data-wall]").addEventListener("click", (e) => {
    const el = e.target as Element;
    const t = el.closest<HTMLElement>("[data-tile]");
    if (
      t &&
      (el.closest("[data-open]") ||
        !el.closest("button,input,label,select,a,textarea"))
    )
      open(t);
  });

  dlg.addEventListener("close", () => {
    if (!cur) return;
    $(".t-body", cur).append(art);
    hist.hidden = true;
    cur.append(hist);
    $("[data-open]", cur).focus();
    cur = undefined;
  });

  dlg.addEventListener("click", (e) => {
    const el = e.target as Element;
    if (el === dlg || el.closest("[data-close]")) return dlg.close();
    const r = el.closest<HTMLElement>("[data-restore]");
    if (!r) return;
    const top = hist.firstElementChild as HTMLElement;
    const li = top.cloneNode(true) as HTMLElement;
    const v = `v${+(top.dataset.v ?? "v0").slice(1) + 1}`;
    li.dataset.v = v;
    li.dataset.by = "you";
    $("b", li).textContent = v;
    $("span", li).textContent = `Restored ${r.dataset.restore}`;
    $("small", li).textContent = "You · just now";
    $("[data-restore]", li).dataset.restore = v;
    hist.prepend(li);
    ver();
    $("[data-vw-status]", dlg).textContent =
      `Restored ${r.dataset.restore} as ${v}.`;
  });

  dlg.addEventListener("change", (e) => {
    const i = e.target as HTMLInputElement;
    if (i.name === "vw-share") share(i.value);
  });

  // Keep Tab inside the dialog.
  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Tab") return;
    const f = $$(
      "button:not([disabled]),input:not([disabled]),a[href],[tabindex]:not([tabindex='-1'])",
      dlg,
    ).filter(
      (x) =>
        x.getClientRects().length &&
        !(x instanceof HTMLInputElement && x.type === "radio" && !x.checked),
    );
    const first = f[0];
    const last = f[f.length - 1];
    if (
      e.shiftKey
        ? document.activeElement === first
        : document.activeElement === last
    ) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  });
}

export {};
