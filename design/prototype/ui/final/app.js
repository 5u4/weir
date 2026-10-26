const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-r5";
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
// Spread order: neighbours in this list sit far apart on the hue wheel, so the first buckets read as distinct.
const PALETTE = { red: 29, blue: 262, green: 158, purple: 305, amber: 75, cyan: 200, pink: 350, lime: 120, sky: 235, orange: 50, teal: 180, indigo: 280, yellow: 100, rose: 5 };
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "qq.com", "163.com", "126.com", "icloud.com", "me.com", "yahoo.com"]);
// Display names come from config in the real app; the run's data carries the ids.
const BUCKET_NAMES = { action: "Action", fyi: "FYI", feed: "Reading", reading: "Reading", notify: "Alerts", alerts: "Alerts" };
// Comes from config in the real app (`color` on a [[bucket]]), where an unknown name is a config error.
const BUCKET_COLORS = { action: "red", fyi: "blue", feed: "green", reading: "green", notify: "purple", alerts: "purple" };
const UNSORTED = "Unsorted";
const broken = { source: false, config: false, ...JSON.parse(localStorage.getItem(LS + "dev.break") || "{}") };
const sim = { unsorted: false, many: false, ...JSON.parse(localStorage.getItem(LS + "dev.sim") || "{}") };
const EXTRA_BUCKETS = ["Travel", "Family", "Finance", "Shopping", "School", "Health", "Home", "Projects", "Events", "Receipts"];

let data, source, storeKey, runs = [], runSlug = null, itemById, me, hues;
// convId -> { seenAt, clearedAt, muted }
let state = {};
const ui = {
  tab: null,
  selected: null,
  // Per open conversation; onLeave resets them.
  old: new Set(), // first item id of each expanded "N earlier" run
  sumOpen: false,
  fold: false, // context card folded into its one-line bar
  jump: null, // item id to scroll to and flash after the next paint
  snap: {}, // convId -> Set of item ids highlighted as new while the conversation is open
  sims: 0,
  busy: false,
  flash: false,
  tabJump: false,
  // { q, chips, group, at, prior }: q is the free text, chips the from:/in:/source: filters, prior the place to return to.
  search: null,
  restore: null, // { list, reader } scrollTops for the next paint
  typing: false,
  focusQ: false,
  jumpSmooth: false,
  status: null, // { prior: { list, reader } } while the status view replaces the reader
};
const narrow = matchMedia("(max-width: 899px)");
const favicon = new Map(); // domain -> true (real icon) | false (fallback to monogram)

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const root = document.documentElement;

marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook("afterSanitizeAttributes", (n) => {
  if (n.tagName === "A") {
    n.setAttribute("target", "_blank");
    n.setAttribute("rel", "noreferrer");
    const href = n.getAttribute("href") || "";
    if (n.textContent === href && href.length > 56) {
      try {
        const u = new URL(href);
        n.textContent = `${u.host}${u.pathname.length > 24 ? u.pathname.slice(0, 24) + "…" : u.pathname}${u.search ? " …" : ""}`;
        n.title = href;
        n.classList.add("url");
      } catch {}
    }
  }
});
const md = (s) => DOMPurify.sanitize(marked.parse(s || ""));

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function load() {
  runs = (await getJson("/data/runs/index.json"))?.runs || [];
  const pref = localStorage.getItem(LS + "run");
  const run = runs.find((r) => r.slug === pref) || runs.find((r) => r.slug === DEFAULT_RUN) || runs.find((r) => r.slug === "gpt-6-luna-low") || runs[0];
  const tries = [
    ...(run ? [[`/data/runs/${run.slug}/data.json`, `run:${run.slug}`, `runs/${run.slug}`]] : []),
    ["/data/data.json", "data.json", "data/data.json"],
    ["/ux/fixture.json", "fixture", "fixture.json"],
  ];
  for (const [url, key, name] of tries) {
    data = await getJson(url);
    if (data) {
      storeKey = key;
      source = name;
      runSlug = run && key === `run:${run.slug}` ? run.slug : null;
      break;
    }
  }
  if (!data) {
    document.body.textContent = "Could not load data.";
    return;
  }
  for (const i of data.items) {
    if (/（合成）$/.test(i.sourceLabel)) i.synthetic = true;
    i.sourceLabel = i.sourceLabel.replace(/（合成）$/, "");
  }
  for (const b of data.buckets) Object.assign(b, { name: BUCKET_NAMES[b.id] || b.id, color: BUCKET_COLORS[b.id] });
  if (sim.many) {
    data.buckets.push(...EXTRA_BUCKETS.map((name) => ({ id: name.toLowerCase(), name })));
    for (const c of data.conversations) c.bucket = data.buckets[hash(c.id) % data.buckets.length].id;
  }
  hues = bucketHues(data.buckets);
  if (sim.unsorted) {
    // Unread at the cutoff, so they reach the sentence; the first 4 are still being classified, the last 3 carry a bucket id the config no longer has.
    const picks = data.conversations.filter((c) => Date.parse(c.lastAt) > Date.parse(data.seenCutoff)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, 7);
    picks.forEach((c, i) => (i < 4 ? Object.assign(c, { bucket: null, pending: true }) : (c.bucket = "old-receipts")));
  }
  itemById = Object.fromEntries(data.items.map((i) => [i.id, i]));
  me = new Set(data.me.map((a) => a.toLowerCase()));
  state = JSON.parse(localStorage.getItem(LS + "state." + storeKey) || "{}");
  initStatus();
  window.weirDev = {
    runs,
    run: runSlug,
    source,
    setRun(slug) {
      localStorage.setItem(LS + "run", slug);
      location.reload();
    },
    simulate,
    reset,
    broken,
    toggleBreak(k) {
      broken[k] = !broken[k];
      localStorage.setItem(LS + "dev.break", JSON.stringify(broken));
      window.dispatchEvent(new Event("weirdev"));
      render();
    },
    sim,
    toggleSim(k) {
      sim[k] = !sim[k];
      localStorage.setItem(LS + "dev.sim", JSON.stringify(sim));
      location.reload();
    },
  };
  window.dispatchEvent(new Event("weirdev"));
  render();
}

const save = () => localStorage.setItem(LS + "state." + storeKey, JSON.stringify(state));
const S = (c) => state[c.id] || {};
function setS(c, patch) {
  state[c.id] = { ...S(c), ...patch };
  save();
}

const conv = (id) => data.conversations.find((c) => c.id === id);
const itemsOf = (c) => c.itemIds.map((id) => itemById[id]).filter(Boolean);
const lastItem = (c) => itemsOf(c).at(-1);
const lastIso = (c) => lastItem(c)?.occurredAt || c.lastAt;
const lastMs = (c) => Date.parse(lastIso(c));
const seenMs = (c) => Date.parse(S(c).seenAt || data.seenCutoff);
const isUnread = (c) => lastMs(c) > seenMs(c);
const isCleared = (c) => !!S(c).clearedAt && lastMs(c) <= Date.parse(S(c).clearedAt);
const isHidden = (c) => !!S(c).muted || isCleared(c);
const isMe = (p) => me.has(p.addr.toLowerCase());
const bucketName = (id) => data.buckets.find((b) => b.id === id)?.name || UNSORTED;
const lede = (c) => (c.summary || "").split(/(?<=[。！？])|\n/)[0];
// Each bucket owns one hue. The inline style carries only the hue; style.css turns it into a tone per surface and theme.
const tint = (id) => {
  const h = hues.get(id);
  return h == null ? "--bh:0;--bk:0" : `--bh:${h};--bk:1`;
};
/* Explicit colors claim their slots first. A bucket without one starts at a slot hashed from its id, so it keeps its
   hue when buckets are added or reordered, and walks forward past taken slots so the first 14 never share a hue. */
function bucketHues(buckets) {
  const names = Object.keys(PALETTE);
  const taken = new Set(buckets.map((b) => b.color).filter(Boolean));
  const out = new Map();
  for (const b of buckets) {
    if (b.color) {
      out.set(b.id, PALETTE[b.color]);
      continue;
    }
    let h = 2166136261;
    for (const byte of new TextEncoder().encode(b.id)) h = Math.imul(h ^ byte, 16777619);
    const start = (h >>> 0) % names.length;
    let i = start;
    while (taken.has(names[i]) && (i = (i + 1) % names.length) !== start);
    taken.add(names[i]);
    out.set(b.id, PALETTE[names[i]]);
  }
  return out;
}

function sections() {
  const out = data.buckets.map((b) => ({ id: b.id, name: b.name, convs: [] }));
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  const none = { id: NONE, name: UNSORTED, convs: [] };
  for (const c of data.conversations) {
    if (isHidden(c)) continue;
    (byId[c.bucket] || none).convs.push(c);
  }
  // Unsorted leads: it is the one place config has not spoken for yet, so it asks to be looked at first.
  if (none.convs.length) out.unshift(none);
  for (const s of out) {
    s.convs.sort((a, b) => lastMs(b) - lastMs(a));
    s.unread = s.convs.filter(isUnread).length;
  }
  return out;
}

const clearedList = () => data.conversations.filter(isHidden).sort((a, b) => lastMs(b) - lastMs(a));
const currentSection = (secs) => secs.find((s) => s.id === ui.tab) || secs.find((s) => s.convs.length) || secs[0];
const currentList = () => (searching() ? shown().map((r) => r.c) : ui.tab === CLEARED ? clearedList() : currentSection(sections())?.convs || []);

function onOpen(c) {
  const seen = seenMs(c);
  ui.snap[c.id] = new Set(itemsOf(c).filter((i) => Date.parse(i.occurredAt) > seen).map((i) => i.id));
  if (isUnread(c)) setS(c, { seenAt: lastIso(c) });
}

function onLeave(id) {
  delete ui.snap[id];
  ui.old.clear();
  ui.sumOpen = false;
  ui.fold = false;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const day = (iso) => {
  const t = new Date(iso);
  return `${MONTHS[t.getMonth()]} ${t.getDate()}`;
};
const hm = (iso) => {
  const t = new Date(iso);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
};
const abs = (iso) => `${day(iso)}, ${hm(iso)}`;
const daysAgo = (iso) => {
  const a = new Date(iso);
  const b = new Date();
  return Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
};
function relShort(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  const n = daysAgo(iso);
  if (d < 60) return "now";
  if (d < 3600) return `${Math.floor(d / 60)}m`;
  if (n === 0) return hm(iso);
  if (n === 1) return "Yesterday";
  if (n < 7) return WEEK[new Date(iso).getDay()];
  return day(iso);
}
function ago(ms) {
  const d = (Date.now() - ms) / 1000;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}
const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const ME = "Me";
const short = (p) => (isMe(p) ? ME : (p.name || p.addr.split("@")[0]).split(/\s+/)[0]);
const whoList = (names, max) => (names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max}` : names.join(", "));
const pad = (n) => String(n).padStart(2, "0");
const srcApp = (i) => String(i.sourceLabel).split("·")[0].trim();

function participants(c) {
  const names = [];
  for (const i of itemsOf(c)) {
    const n = short(i.from);
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

function orgDomain(addr) {
  const p = (addr.split("@")[1] || "").toLowerCase().split(".");
  const n = p.length > 2 && p.at(-1).length === 2 && ["com", "co", "org", "net", "edu", "gov", "ac"].includes(p.at(-2)) ? 3 : 2;
  return p.slice(-n).join(".");
}
const avKey = (p) => (PERSONAL.has(orgDomain(p.addr)) ? p.addr.toLowerCase() : orgDomain(p.addr));
function hash(s) {
  let h = 2166136261;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}
function monogram(p) {
  const n = (p.name || p.addr.split("@")[0]).replace(/^[^\p{L}\p{N}]+/u, "");
  const ch = [...n][0] || "?";
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}
function avatarHtml(p, person = false) {
  const d = orgDomain(p.addr);
  const known = favicon.get(d);
  const img = person || PERSONAL.has(d) || known === false ? "" : `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64" alt="" class="${known ? "ok" : ""}" data-d="${esc(d)}" onload="avLoad(this)" onerror="avErr(this)">`;
  return `<span class="av" style="--h:${hash(p.addr.toLowerCase()) % 360}" data-m="${esc(monogram(p))}" title="${esc(p.name || p.addr)}">${img}</span>`;
}
window.avLoad = (img) => {
  // Google answers unknown domains with a 16px globe; treat that as "no icon" and keep the monogram.
  const ok = img.naturalWidth > 16;
  favicon.set(img.dataset.d, ok);
  ok ? img.classList.add("ok") : img.remove();
};
window.avErr = (img) => {
  favicon.set(img.dataset.d, false);
  img.remove();
};

// One avatar per unread conversation (its latest non-me sender), distinct by org domain or personal address.
function senders(convs, max = 3) {
  const out = [];
  const keys = new Set();
  for (const c of convs) {
    const from = [...itemsOf(c)].reverse().find((i) => !isMe(i.from))?.from;
    if (!from || keys.has(avKey(from))) continue;
    keys.add(avKey(from));
    out.push(from);
    if (out.length >= max) break;
  }
  return out;
}

const glue = (text, cls = "glue") => `<span class="${cls}">${text}</span>`;

// English enumeration without the Oxford comma: A, B and C. A comma binds to the widget before it and "and" to the widget
// after it, and the sentence's lead and tail bind to the first and last widget, so no connective starts or ends a line.
function enumerate(items, lead = "", end = "") {
  const n = items.length;
  return items.map((html, i) => `<span class="grp">${i === 0 ? lead : ""}${n > 1 && i === n - 1 ? glue("and ", "glue and") : ""}${html}${i < n - 2 ? glue(",", "glue sep") : ""}${i === n - 1 ? end : ""}</span>`).join(" ");
}
const verb = (n, one, many) => (n === 1 ? one : many);

function widgetHtml(s, v, active) {
  const on = s.id === active;
  const n = v === "main" ? s.unread : s.convs.length;
  const label = v === "main" ? `${n} ${s.name} with updates` : v === "tail" ? `${n} ${s.name} read but not done` : `${s.name} is clear`;
  const avs = v === "main" ? `<span class="avs">${senders(s.convs.filter(isUnread)).map(avatarHtml).join("")}</span>` : "";
  const count = v === "empty" ? "" : `<span class="w-n">${n}</span> `;
  return `<button class="w w-${v} ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${s.id}" style="${tint(s.id)}" aria-pressed="${on}" aria-label="${esc(label)}">${avs}${count}<span class="w-name">${esc(s.name)}</span></button>`;
}

const clearedWidget = (n, on) => `<button class="w w-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${CLEARED}" aria-pressed="${on}"><span class="w-u">Cleared</span> <span class="w-n">${n}</span></button>`;

function fullHtml(secs, active) {
  const hot = secs.filter((s) => s.unread);
  const quiet = secs.filter((s) => !s.unread && s.convs.length);
  const empty = secs.filter((s) => !s.convs.length);
  const cl = clearedList().length;
  const main = hot.length ? enumerate(hot.map((s) => widgetHtml(s, "main", active)), "", glue(` ${verb(hot.length, "has", "have")} updates.`, "glue end")) : glue("All caught up.", "allclear");
  const tail = [];
  if (quiet.length) tail.push(`<span class="cl">${enumerate(quiet.map((s) => widgetHtml(s, "tail", active)), glue("Read but not done: ", "glue lead"), glue(".", "glue end"))}</span>`);
  if (empty.length) tail.push(`<span class="cl">${enumerate(empty.map((s) => widgetHtml(s, "empty", active)), "", glue(` ${verb(empty.length, "is", "are")} clear.`, "glue end"))}</span>`);
  tail.push(`<span class="cl"><span class="grp">${clearedWidget(cl, active === CLEARED)}${glue(".", "glue end")}</span></span>`);
  return `<h1 class="s-main">${main}</h1>
    <p class="s-tail">${tail.join(" ")}</p><span class="cap-tools"><button class="q-go" data-q="open" aria-label="Search" title="Search (/)">${Q_ICON}</button>${statusBtn("st-go")}</span>`;
}

function chipHtml(s, active) {
  const on = s.id === active;
  const kind = s.unread ? "hot" : s.convs.length ? "quiet" : "empty";
  const label = s.unread ? `${s.unread} ${s.name} with updates` : s.convs.length ? `${s.convs.length} ${s.name} read but not done` : `${s.name} is clear`;
  const avs = s.unread ? `<span class="avs">${senders(s.convs.filter(isUnread)).map(avatarHtml).join("")}</span>` : "";
  const n = kind === "empty" ? "" : `<span class="w-n">${s.unread || s.convs.length}</span>`;
  return `<button class="cw cw-${kind} ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${s.id}" style="${tint(s.id)}" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}">${avs}${n}<span class="cw-name">${esc(s.name)}</span></button>`;
}

// Compact form keeps config order so a widget never changes place while counts move under it.
function pillHtml(secs, active) {
  const on = active === CLEARED;
  const n = clearedList().length;
  const cl = `<button class="cw cw-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${CLEARED}" aria-pressed="${on}" title="Cleared conversations"><span class="cw-name">Cleared</span><span class="w-n">${n}</span></button>`;
  const arrow = (d) => `<button class="cws-a ${d}" data-cws="${d}" tabindex="-1" aria-label="Scroll buckets ${d === "prev" ? "left" : "right"}">${CHEV(d)}</button>`;
  return `<button class="cw cw-q" data-q="open" aria-label="Search" title="Search (/)">${Q_ICON}</button><span class="cap-div"></span><span class="cws-w"><span class="cws">${secs.map((s) => chipHtml(s, active)).join("")}</span>${arrow("prev")}${arrow("next")}</span><span class="cap-div"></span>${cl}${statusBtn("cw cw-st")}`;
}

// The notch's shape follows (reading, search): the sentence over the digest, a pill over a conversation. Searching,
// the sentence's subject becomes the query field and the pill carries the query and the stepper.
const formOf = (reading) => (ui.search ? (reading ? "q-pill" : "q-full") : reading ? "pill" : "full");
const isFull = (form) => form === "full" || form === "q-full";
const navHtml = (form, secs, active) => (form === "q-pill" ? "" : form === "q-full" ? searchNavHtml() : form === "pill" ? pillHtml(secs, active) : fullHtml(secs, active));

// Drawn, not the ✕ character: each engine falls back to a different font for it.
const X_ICON = `<svg class="x-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;
const Q_ICON = `<svg class="q-i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4l3.4 3.4"/></svg>`;
const CHEV = (d) => `<svg class="ch-i" viewBox="0 0 16 16" aria-hidden="true"><path d="${d === "prev" ? "M10 3.5L5.5 8l4.5 4.5" : "M6 3.5L10.5 8 6 12.5"}"/></svg>`;
const EXT_ICON = `<svg class="ext-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 4.5h6v6M11.2 4.8L4.5 11.5"/></svg>`;
const ST_ICON = `<svg class="st-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8.5h2.8l1.9-4.6 3.4 8.2 1.9-3.6h3"/></svg>`;
// The status control: quiet when healthy, an amber dot when a source or the config needs attention.
function statusBtn(cls) {
  const alert = statusAlert();
  return `<button class="${cls} ${alert ? "alert" : ""} ${ui.status ? "on" : ""}" data-st="${ui.status ? "close" : "open"}" aria-label="Status" title="Status" aria-pressed="${!!ui.status}" ${alert ? `aria-description="Needs attention"` : ""}>${ST_ICON}<i class="st-dot" aria-hidden="true"></i></button>`;
}

function paintCap(secs, reading) {
  const cap = $(".cap");
  const nav = $(".cap-nav");
  const active = ui.tab === CLEARED ? CLEARED : currentSection(secs)?.id;
  const keyOf = (el) => el.dataset.tab ?? `sg:${el.dataset.sg}`;
  const before = new Map([...nav.querySelectorAll("[data-tab], [data-sg]")].map((el) => [keyOf(el), el.querySelector(".w-n")?.textContent]));
  const form = formOf(reading);
  cap.classList.toggle("compact", !isFull(form));
  cap.classList.toggle("q", !!ui.search);
  const prevLeft = nav.querySelector(".cws")?.scrollLeft ?? null;
  nav.innerHTML = navHtml(form, secs, active);
  paintCws(active, prevLeft);
  paintQ(form);
  if (isFull(form)) root.style.setProperty("--cap-h", `${cap.offsetHeight}px`);
  const rm = reduceMotion.matches;
  // Counts change in place: the new numeral rolls in from the direction it moved.
  for (const el of nav.querySelectorAll("[data-tab], [data-sg]")) {
    const n = el.querySelector(".w-n");
    const p = before.get(keyOf(el));
    if (!n || p == null || p === n.textContent) continue;
    const up = Number(n.textContent) > Number(p);
    n.animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${up ? 0.7 : -0.7}em)` }, { opacity: 1, transform: "none" }], { duration: ui.typing ? 280 : 460, delay: rm || ui.typing ? 0 : 200, easing: EASE, fill: "backwards" });
  }
}

/* The pill's bucket strip scrolls on its own between the fixed search and status ends. Each paint rebuilds it, so it
   keeps its offset; it centers the active chip only when what you are looking at moved (bucket, conversation, or the
   pill just appeared), never under a hand that is scrolling it. */
let chipAt = null;
const cwsRO = new ResizeObserver((es) => es.forEach((e) => fadeCws(e.target)));
function paintCws(active, prevLeft) {
  const el = $(".cap-nav .cws");
  cwsRO.disconnect();
  if (!el) return void (chipAt = null);
  if (prevLeft != null) el.scrollLeft = prevLeft;
  const at = `${active}|${ui.selected}`;
  const chip = el.querySelector(".cw.on");
  if (at !== chipAt && chip) {
    const left = chip.offsetLeft + chip.offsetWidth / 2 - el.clientWidth / 2;
    el.scrollTo({ left, behavior: prevLeft == null || reduceMotion.matches ? "auto" : "smooth" });
  }
  chipAt = at;
  el.addEventListener("scroll", () => fadeCws(el), { passive: true });
  cwsRO.observe(el);
  fadeCws(el);
}
function fadeCws(el) {
  el.classList.toggle("fl", el.scrollLeft > 1);
  el.classList.toggle("fr", el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
}

function rowHtml(c) {
  const unread = isUnread(c);
  const its = itemsOf(c);
  const fresh = unread ? its.filter((i) => Date.parse(i.occurredAt) > seenMs(c)).length : 0;
  const tags = [...new Set(its.map(srcTag))];
  const line = unread && c.update ? esc(c.update) : esc(lede(c));
  const inCleared = ui.tab === CLEARED;
  const who = participants(c);
  const whoTxt = whoList(who, 2);
  const from = [...its].reverse().find((i) => !isMe(i.from))?.from || its.at(-1).from;
  const tail = inCleared
    ? `<span class="row-badge">${S(c).muted ? "Muted" : "Done"}</span><button class="row-act restore" data-act="restore">Restore</button>`
    : `<button class="row-act" data-act="done" title="Done. It leaves the list until something new arrives.">Done</button>`;
  return `<article class="row ${unread ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-k="r-${c.id}" data-conv="${c.id}" data-open tabindex="0" aria-current="${ui.selected === c.id}" style="${tint(c.bucket)}">
    <span class="row-av">${avatarHtml(from)}</span>
    <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
    <span class="row-line">${unread && c.update ? `<i class="row-new">New</i>` : ""}${line}</span>
    <span class="row-meta">${c.pending && homeOf(c) === NONE ? `<span class="row-sort" title="Still being sorted into a bucket">Sorting</span>` : ""}<span class="row-who" title="${esc(who.join(", "))}">${esc(whoTxt)}</span><span class="row-n">${plural(its.length, "message")}${fresh ? `, ${fresh} new` : ""} · ${esc(tags.join(" · "))}</span></span>
    <span class="row-time" title="${esc(abs(lastIso(c)))}">${relShort(lastIso(c))}</span>
    ${tail}
  </article>`;
}

function listHtml(secs) {
  if (searching()) return resListHtml();
  if (ui.tab === CLEARED) {
    const cl = clearedList();
    const muted = cl.filter((c) => S(c).muted).length;
    const head = `<div class="l-head"><h2 class="l-name">Cleared</h2><span class="l-meta">${cl.length} · ${cl.length - muted} done · ${muted} muted</span></div>`;
    return head + (cl.length ? `<div class="rows cleared">${cl.map(rowHtml).join("")}</div>` : `<div class="empty"><p class="empty-big">Nothing cleared yet.</p><p class="empty-sub">Done and muted conversations land here. Restore any of them at any time.</p></div>`);
  }
  const cur = currentSection(secs);
  const head = `<div class="l-head" style="${tint(cur.id)}"><h2 class="l-name">${esc(cur.name)}</h2><span class="l-meta">${plural(cur.convs.length, "conversation")}${cur.unread ? ` · ${cur.unread} unread` : cur.convs.length ? " · all read" : ""}</span>${cur.convs.length ? `<button class="clearall" data-act="clearall" data-bucket="${cur.id}">Clear all</button>` : ""}</div>`;
  return head + (cur.convs.length ? `<div class="rows">${cur.convs.map(rowHtml).join("")}</div>` : `<div class="empty"><p class="empty-big">${esc(cur.name)} is clear.</p><p class="empty-sub">New messages bring a conversation back here as unread.</p></div>`);
}

// With nothing open the reader never repeats the list; it shows sync status instead.
function digestHtml(secs) {
  if (searching()) return searchCalmHtml();
  return esHtml(ui.tab === CLEARED ? null : currentSection(secs));
}

function esHtml(cur) {
  const { sources, config } = status;
  const stopped = config.errors.length > 0;
  const waiting = waitingCount();
  const line = (cls, name, state, extra = "") => `<li class="es-row ${cls}"><span class="sv-led" aria-hidden="true"></span><b>${name}</b><span class="es-st">${state}</span>${extra}</li>`;
  const rows = sources.map((s) => {
    const bad = failing(s);
    return line(`${bad ? "bad" : ""} ${stopped ? "held" : ""}`, esc(s.name), bad ? "Sync failed" : stopped ? "Stopped" : `Synced ${ago(s.syncedAt)}`, bad ? `<code class="es-err">${esc(s.error)}</code>` : "");
  });
  rows.push(line(stopped ? "held" : "", "Enrichment", stopped ? "Stopped" : waiting ? `${plural(waiting, "conversation")} waiting` : "Caught up"));
  const alert = stopped ? `<p class="es-alert">Sync and enrich stopped. The config did not load.</p>` : "";
  const open = statusAlert() ? `<button class="es-open" data-st="open">Open Status</button>` : "";
  return `<div class="calm es ${statusAlert() ? "warn" : ""}" ${cur ? `style="${tint(cur.id)}"` : ""}>${alert}<ul class="es-rows" aria-label="Sync">${rows.join("")}</ul>${open}</div>`;
}

function relText(c) {
  const its = itemsOf(c);
  const out = [];
  if (its.some((i) => i.to.some(isMe))) out.push("To you");
  if (its.some((i) => i.cc.some(isMe))) out.push("Cc you");
  if (its.some((i) => isMe(i.from))) out.push("You replied");
  if (c.threadIds.length > 1) out.push(`Merged ${c.threadIds.length} threads`);
  return out;
}

const KINDS = { ask: "Ask", decision: "Decided", date: "Date", info: "Info" };
const dayKey = (iso) => new Date(iso).toDateString();
const dayLabel = (iso) => {
  const n = daysAgo(iso);
  return n === 0 ? "Today" : n === 1 ? "Yesterday" : `${WEEK[new Date(iso).getDay()]}, ${day(iso)}`;
};
// GitHub notification bodies arrive as markdown with inline HTML; the reader shows that HTML as plain text.
const TAGS = /<\/?(?:details|summary|picture|source|img|sub|sup|br|div|span|p|a|b|i|em|strong|code|kbd|table|thead|tbody|tr|td|th|ul|ol|li|hr|h[1-6]|blockquote|pre|g-emoji)\b[^<>]*>/gi;
const stripTags = (s) => (s || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(TAGS, "");
// Review notifications paste suggestion hunks as bare "-    code" lines, which markdown reads as nested lists of code
// blocks. A run of +/- lines with at least three indented ones is fenced as a diff, so its short "+})" lines and
// "> +" context lines stay in the hunk too.
const DIFF = /^(?:[+\->] {2,}\S|[+-]\s*$)/;
const HUNK = /^(?:> ?)?[+-](?![-+]{2})/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const LIST = /^(?:[-*•]|\d+\.)\s+\S/;
const MARKER = /^(?:[-*•]|\d+\.)$/;
const RULE = /^(?:-{3,}|_{3,}|\*{3,}|={3,})$/;
/* Mail bodies are plain text that only looks like markdown. Each line keeps its break; only real "- ", "* " and "1. "
   runs become lists; a bullet alone on its line takes the next line as its text; every other block (list, table, quote,
   fence) is fenced off with a blank line so markdown's lazy continuation cannot fold the next plain line into it. */
function originalMd(s) {
  const lines = (s || "").replace(/<!--[\s\S]*?-->/g, "").replace(/&zwnj;|\u200c/g, "").split("\n");
  const out = [];
  let kind = "";
  const gap = () => {
    if (out.length && out.at(-1) !== "") out.push("");
    kind = "";
  };
  const emit = (k, l) => {
    if (kind && k !== kind) gap();
    out.push(l);
    kind = k;
  };
  const block = (lang, body) => {
    gap();
    out.push("```" + lang, ...body, "```");
    gap();
  };
  const text = (j) => stripTags(lines[j] ?? "").trim();
  for (let j = 0; j < lines.length; j++) {
    const f = lines[j].match(FENCE);
    if (f) {
      const end = lines.findIndex((l, x) => x > j && l.trim().startsWith(f[1]));
      const stop = end < 0 ? lines.length : end;
      block(f[2], lines.slice(j + 1, stop));
      j = stop;
      continue;
    }
    if (HUNK.test(lines[j])) {
      let k = j;
      while (k < lines.length && HUNK.test(lines[k])) k++;
      if (lines.slice(j, k).filter((l) => DIFF.test(l)).length > 2) {
        block("diff", lines.slice(j, k).map((l) => l.replace(/^> ?/, " ")));
        j = k - 1;
        continue;
      }
    }
    const l = text(j);
    if (!l) gap();
    else if (MARKER.test(l) && text(j + 1)) emit("list", `${/\d/.test(l) ? l : "-"} ${text(++j)}`);
    else if (LIST.test(l)) emit("list", l.replace(/^•/, "-"));
    else if (RULE.test(l)) {
      gap();
      out.push(l[0] === "=" ? "\\" + l : l);
      gap();
    } else if (l[0] === "|") emit("table", l);
    else if (l[0] === ">") emit("quote", l);
    else emit("text", l.replace(/^\+(?=\s)/, "\\+").replace(/^(\d+)\)(?=\s)/, "$1\\)"));
  }
  return md(out.join("\n"));
}
const plain = (s) =>
  stripTags(s)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#>*_`|~]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const firstSentence = (s) => {
  const p = plain(s);
  return p.match(/^.{8,}?[.!?。！？](?=\s|$)/)?.[0] || p || "(no text)";
};
// The tag names where a message was said. A mail thread is one place whatever folder each copy sits in, so mail tags
// by app; a chat tags by channel.
const srcTag = (i) => `${srcApp(i) === "Teams" ? i.sourceLabel : srcApp(i)}${i.synthetic ? " (synthetic)" : ""}`;

const TIME_GAP = 5 * 60 * 1000;

/* The stream as flat rows: day breaks, the Last read divider, collapsed read runs, and runs of one sender.
   A read run longer than 3 collapses except a tail kept as context for what follows: two messages for long runs, one
   for short runs, since hiding two behind a row as tall as two bubbles saves nothing. */
function streamRows(c) {
  const its = itemsOf(c);
  const fresh = ui.snap[c.id] || new Set();
  const seq = [];
  let run = [];
  const flushRun = () => {
    const keep = run.length > 5 ? 2 : 1;
    if (run.length > 3 && !ui.old.has(run[0].i.id)) seq.push({ older: run.slice(0, -keep).map((e) => e.i) }, ...run.slice(-keep));
    else seq.push(...run);
    run = [];
  };
  its.forEach((i, j) => {
    const e = { i, n: j + 1 };
    if (fresh.has(i.id)) {
      flushRun();
      seq.push(e);
    } else run.push(e);
  });
  flushRun();
  const rows = [];
  let prevDay = null;
  let group = null;
  let marked = false;
  for (const e of seq) {
    if (e.older) {
      rows.push({ k: "older", items: e.older });
      prevDay = dayKey(e.older.at(-1).occurredAt);
      group = null;
      continue;
    }
    const { i } = e;
    if (dayKey(i.occurredAt) !== prevDay) {
      rows.push({ k: "day", iso: i.occurredAt });
      prevDay = dayKey(i.occurredAt);
      group = null;
    }
    if (!marked && fresh.has(i.id)) {
      marked = true;
      rows.push({ k: "mark", first: i === its[0], n: fresh.size });
      group = null;
    }
    const prev = group?.msgs.at(-1).i;
    if (prev?.from.addr.toLowerCase() !== i.from.addr.toLowerCase() || Date.parse(i.occurredAt) - Date.parse(prev.occurredAt) >= TIME_GAP) {
      group = { k: "group", from: i.from, me: isMe(i.from), at: i.occurredAt, msgs: [] };
      rows.push(group);
    }
    group.msgs.push(e);
  }
  return rows;
}

function gistHtml(i, terms = []) {
  return i.gist ? `<span class="gist">${hl(i.gist, terms)}</span>` : `<span class="gist fb">${hl(firstSentence(i.bodyNew), terms)}</span>`;
}

// Searching, a matching message is marked where it matched: terms in the gist, or a quiet tag naming the field.
function bubbleHtml({ i }) {
  const r = curResult();
  const hit = r?.byItem.get(i.id);
  const cur = hit && r.items[ui.search.at] === i.id;
  const f = hit && !hit.some((x) => x.f === "gist") && ["body", "from", "source"].find((k) => hit.some((x) => x.f === k));
  const tag = f ? `<span class="bh" title="Matched in ${FIELD[f]}">${FIELD[f]}</span>` : "";
  return `<div class="bl"><div class="bb ${i.gist ? "" : "fbk"} ${hit ? "hit" : ""} ${cur ? "cur" : ""}" data-item="${i.id}">${gistHtml(i, r ? qTerms() : [])}</div>${tag}</div>`;
}

// In a group chat everyone shares one org favicon, so people who share a domain get their own monogram instead.
function groupHtml(c, g, tag, shared) {
  const name = g.me ? ME : g.from.name || g.from.addr;
  return `<section class="sg ${g.me ? "me" : ""}">
    ${g.me ? "" : `<span class="g-av">${avatarHtml(g.from, shared.has(orgDomain(g.from.addr)))}</span>`}
    <div class="g-col"><div class="g-head"><b title="${esc(g.from.addr)}">${esc(name)}</b>${tag ? `<span class="g-src">${esc(tag)}</span>` : ""}<time datetime="${esc(g.at)}" title="${esc(abs(g.at))}">${hm(g.at)}</time></div>${g.msgs.map(bubbleHtml).join("")}</div>
  </section>`;
}

function olderHtml(items) {
  const who = [];
  for (const i of items) if (!who.includes(short(i.from))) who.push(short(i.from));
  const a = day(items[0].occurredAt);
  const b = day(items.at(-1).occurredAt);
  return `<button class="older" data-act="old" data-item="${items[0].id}"><span class="o-n">${items.length} earlier</span><span class="o-span">${a === b ? a : `${a} – ${b}`} · <span class="o-who">${esc(whoList(who, 3))}</span></span><span class="o-go">Show</span></button>`;
}

// Domains more than one sender of c writes from; in a group chat everyone shares one org favicon.
function sharedDomains(c) {
  const addrs = new Map();
  for (const i of itemsOf(c)) addrs.set(i.from.addr.toLowerCase(), orgDomain(i.from.addr));
  const per = new Map();
  for (const d of addrs.values()) per.set(d, (per.get(d) || 0) + 1);
  return new Set([...per].filter(([, n]) => n > 1).map(([d]) => d));
}

function streamHtml(c) {
  const shared = sharedDomains(c);
  // A source tag only shows where it changes, so a one-channel chat says where it is once.
  let prevTag = null;
  return streamRows(c)
    .map((r) => {
      if (r.k === "day") return `<div class="day" role="separator"><span>${dayLabel(r.iso)}</span></div>`;
      if (r.k === "mark") return `<div class="lr" role="separator"><span><b>${r.first ? "All new from here" : "Last read"}</b>${r.n} new</span></div>`;
      if (r.k === "older") {
        prevTag = null;
        return olderHtml(r.items);
      }
      const tag = srcTag(r.msgs[0].i);
      const show = tag !== prevTag;
      prevTag = tag;
      return groupHtml(c, r, show ? tag : "", shared);
    })
    .join("");
}

// The reader is the device: the notch is its status bar on top, the actions are a toolbar docked at its bottom.
function dockHtml(c) {
  const unread = isUnread(c);
  const st = S(c);
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${label}</button>`;
  const acts = [`<button class="back" data-act="close" aria-label="Back">‹</button>`];
  if (isHidden(c)) acts.push(b("restore", "Restore", "primary"));
  else acts.push(b("done", `Done<kbd>E</kbd>`, "primary"));
  if (!unread) acts.push(b("unread", "Mark unread"));
  if (!st.muted) acts.push(b("mute", "Mute"));
  acts.push(`<button data-act="tx" aria-haspopup="dialog">Original</button>`);
  const last = lastItem(c);
  if (last?.link) acts.push(`<a class="ext" href="${esc(last.link)}" target="_blank" rel="noreferrer">Open in ${esc(srcApp(last))}${EXT_ICON}</a>`);
  return `<div class="r-dock" data-conv="${c.id}" style="${tint(c.bucket)}">${acts.join("")}</div><button class="r-x" data-act="close" title="Close (Esc)" aria-label="Close">${X_ICON}</button>`;
}

function pointsHtml(c) {
  const pts = (c.points || []).filter((p) => itemById[p.itemId]);
  if (!pts.length) return "";
  const rows = pts.map((p) => {
    const n = c.itemIds.indexOf(p.itemId) + 1;
    return `<li><button class="pt" data-act="jump" data-item="${p.itemId}" title="Jump to #${n}"><i class="pk pk-${p.kind}">${KINDS[p.kind] || "Info"}</i><span class="pt-t">${hl(p.text, curResult() ? qTerms() : [])}</span><span class="pt-n">#${n}</span></button></li>`;
  });
  return `<ol class="pts" aria-label="Points">${rows.join("")}</ol>`;
}

/* Summary, update and points pinned under the notch. Folded, the card retracts up into the notch's band and leaves
   a one-line bar; the stream scrolls underneath both. */
function ctxHtml(c) {
  const its = itemsOf(c);
  const fresh = ui.snap[c.id]?.size || 0;
  const rel = relText(c);
  const nPts = (c.points || []).length;
  const merge = c.threadIds.length > 1 && c.mergeReason;
  const T = curResult() ? qTerms() : [];
  return `<div class="ctx ${ui.fold ? "fold" : ""}">
    <div class="ctx-full">
      <p class="r-crumb"><b>${esc(bucketName(c.bucket))}</b><span>${fresh ? `${fresh} new this time` : "Read"}</span><span>${plural(its.length, "message")} · ${plural(participants(c).length, "person", "people")}</span><span>${day(its[0]?.occurredAt || c.firstAt)} – ${day(lastIso(c))}</span>${rel.map((r) => `<span class="rel">${r}</span>`).join("")}</p>
      <h2 class="r-title">${hl(c.title, T)}</h2>
      <div class="ctx-sumrow"><p class="ctx-sum ${ui.sumOpen ? "open" : ""}">${hl(c.summary, T)}${ui.sumOpen && merge ? `<span class="ctx-merge">${esc(c.mergeReason)}</span>` : ""}</p><button class="ctx-more" data-act="sum" aria-expanded="${ui.sumOpen}">${ui.sumOpen ? "Less" : "Full summary"}</button></div>
      ${c.update ? `<p class="r-update"><span class="r-label">Since you last looked</span>${hl(c.update, T)}</p>` : ""}
      ${pointsHtml(c)}
    </div>
    <button class="ctx-bar" data-act="unfold" tabindex="${ui.fold ? 0 : -1}" aria-label="Show summary and points"><span class="cb-dot"></span><b>${esc(c.title)}</b><span class="cb-meta">${fresh ? `${fresh} new` : plural(its.length, "message")}${nPts ? ` · ${plural(nPts, "point")}` : ""}</span><span class="cb-go">Summary and points</span></button>
  </div>`;
}

function readerHtml(c) {
  return `<div class="conv" data-conv="${c.id}" style="${tint(c.bucket)}">${ctxHtml(c)}<div class="st"><div class="st-in">${streamHtml(c)}</div></div></div>`;
}

function setFold(f) {
  ui.fold = f;
  $(".ctx")?.classList.toggle("fold", f);
  $(".ctx-bar")?.setAttribute("tabindex", f ? "0" : "-1");
  $(".st")?.style.setProperty("--vis", f ? "var(--bar-h)" : "var(--ctx-h)");
}

// Scrolling down into the stream folds the card; reaching the top again unfolds it.
let lastY = 0;
let down = 0;
function onStreamScroll(e) {
  const y = e.currentTarget.scrollTop;
  if (y <= 8) {
    if (ui.fold) setFold(false);
    down = 0;
  } else if (y > lastY) {
    down += y - lastY;
    if (!ui.fold && down > 24) setFold(true);
  } else down = 0;
  lastY = y;
}

const bubble = (st, id) => st.querySelector(`.bb[data-item="${CSS.escape(id)}"]`);
const topIn = (st, el) => el.getBoundingClientRect().top - st.getBoundingClientRect().top;
// How much of the stream's top the context card (or its folded bar) covers.
const cardH = () => (ui.fold ? $(".ctx-bar").offsetHeight + 12 : $(".ctx-full").offsetHeight);
// The first bubble whose middle is below the card: where you are reading.
function topVisibleItem() {
  const st = $(".st");
  const edge = st.getBoundingClientRect().top + cardH();
  const bbs = [...st.querySelectorAll(".bb")];
  const b = bbs.find((el) => { const r = el.getBoundingClientRect(); return (r.top + r.bottom) / 2 > edge; }) || bbs.at(-1);
  return b?.dataset.item;
}

/* After a paint: size the stream under the card, then land, keep or jump. keepTop is the scroll position to keep when
   the same conversation repaints, or null when it was just opened. */
function settleReader(keepTop) {
  const st = $(".st");
  const full = $(".ctx-full");
  const sum = $(".ctx-sum");
  if (!ui.sumOpen && sum.scrollHeight <= sum.clientHeight + 2) $(".ctx-more").remove();
  const h = full.offsetHeight;
  st.style.setProperty("--ctx-h", `${h}px`);
  // The stream's scrollbar eats into its right inset; the card above has none, so the stream gives that width back.
  st.style.setProperty("--sbw", `${st.offsetWidth - st.clientWidth}px`);
  st.style.setProperty("--bar-h", `${$(".ctx-bar").offsetHeight + 12}px`);
  setFold(ui.fold);
  if (keepTop != null) st.scrollTop = keepTop;
  else {
    const mark = st.querySelector(".lr");
    st.scrollTop = mark ? Math.max(0, mark.offsetTop - h - 4) : 0;
  }
  const jump = ui.jump && bubble(st, ui.jump);
  ui.jump = null;
  if (jump) {
    setFold(true);
    st.scrollTo({ top: st.scrollTop + topIn(st, jump) - cardH() - (ui.search ? 44 : 16), behavior: reduceMotion.matches || !ui.jumpSmooth ? "auto" : "smooth" });
    ui.jumpSmooth = false;
    jump.animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { pseudoElement: "::after", duration: 1800, easing: "ease-out" });
  }
  lastY = st.scrollTop;
  down = 0;
  st.addEventListener("scroll", onStreamScroll, { passive: true });
}

/* List rows FLIP between renders: removed rows close their gap, new rows rise in. The notch's shape and the reader's
   content are View Transitions instead; see flush(). */
function capture() {
  const m = new Map();
  for (const el of document.querySelectorAll("#app .row[data-k]")) {
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom > -60 && r.top < innerHeight + 60) m.set(el.dataset.k, r);
  }
  return m;
}

function play(prev) {
  const rm = reduceMotion.matches;
  let entering = 0;
  for (const el of document.querySelectorAll("#app .row[data-k]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom < -60 || r.top > innerHeight + 60) continue;
    const p = prev.get(el.dataset.k);
    if (!p) {
      el.animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: rm ? 200 : 420, delay: rm ? 0 : 40 + Math.min(entering++, 12) * 24, easing: EASE, fill: "backwards" });
      continue;
    }
    const dx = p.left - r.left;
    const dy = p.top - r.top;
    if (!rm && (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 440, easing: EASE });
  }
}

function keepVisible(list, id) {
  const row = list.querySelector(`.row[data-conv="${id}"]`);
  if (!row) return;
  const head = list.querySelector(".l-head")?.offsetHeight || 0;
  const lr = list.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (rr.top < lr.top + head) list.scrollTop -= lr.top + head - rr.top + 8;
  else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom + 8;
}

const capKey = (secs, reading) => formOf(reading) + navHtml(formOf(reading), secs, null).replace(/ class="ok"/g, ' class=""');

// last: what the screen currently shows, so flush() can tell which kind of change the next paint is.
let last = null;
let queued = false;
let inVT = false;
let dirty = false;
let liveVT = null;

function render() {
  if (inVT) return void (dirty = true);
  if (queued) return;
  queued = true;
  queueMicrotask(flush);
}

function flush() {
  queued = false;
  const secs = sections();
  const reading = !!(ui.status || (ui.selected && conv(ui.selected)));
  const kind = !last ? null : reading !== last.reading ? "mode" : capKey(secs, reading) !== last.key ? "tick" : null;
  // Typing never waits on a View Transition: its snapshot would freeze the field mid-word.
  if (!kind || ui.typing || !document.startViewTransition || reduceMotion.matches || document.hidden) return paint(kind);
  root.classList.toggle("vt-mode", kind === "mode");
  const types = kind === "mode" ? ["mode", reading ? "open" : "close"] : [kind];
  inVT = true;
  const update = () => {
    inVT = false;
    paint(kind, true);
  };
  let vt;
  try {
    vt = document.startViewTransition({ update, types });
  } catch {
    vt = document.startViewTransition(update);
  }
  liveVT = vt;
  vt.ready.catch(() => {});
  vt.updateCallbackDone.finally(() => {
    if (!dirty) return;
    dirty = false;
    render();
  });
  vt.finished.finally(() => {
    if (liveVT === vt) root.classList.remove("vt-mode");
  });
}

function paint(kind, viaVT = false) {
  const app = $("#app");
  const secs = sections();
  // Pin the bucket, so emptying it leaves you on its clear state instead of jumping to the next bucket.
  ui.tab ??= currentSection(secs)?.id;
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  document.title = unread ? `(${unread}) weir` : "weir";
  const sel = !ui.status && ui.selected && conv(ui.selected);
  const reading = !!(sel || ui.status);
  const mode = !!last && last.reading !== reading;
  const prevConv = last?.conv || "";
  const listTop = $(".list")?.scrollTop || 0;
  const readerTop = ($(".st") || $(".r-scroll"))?.scrollTop || 0;
  const rkey = ui.status ? "status" : sel ? sel.id : searching() ? "search" : `digest:${ui.tab}`;
  const capH = root.style.getPropertyValue("--cap-h");
  const prev = last ? capture() : null;
  app.classList.toggle("reading", reading);
  const body = ui.status ? statusHtml() : sel ? readerHtml(sel) : digestHtml(secs);
  const tools = ui.status ? `<button class="r-x" data-st="close" title="Close (Esc)" aria-label="Close">${X_ICON}</button>` : sel ? dockHtml(sel) : "";
  app.innerHTML = `<div class="list">${listHtml(secs)}</div><section class="reader ${ui.status ? "sv-open" : ""}" aria-label="Reader"><div class="r-scroll ${sel ? "pane" : ""}">${body}</div>${tools}</section>`;
  paintCap(secs, reading);
  ui.flash = false;
  // Both columns are rebuilt on every paint but never move, so each keeps the scroll position it had.
  const list = $(".list");
  const back = ui.restore;
  ui.restore = null;
  list.scrollTop = back ? back.list : ui.tabJump ? 0 : listTop;
  ui.tabJump = false;
  if (sel && sel.id !== prevConv && !back) keepVisible(list, sel.id);
  if (sel) settleReader(back ? back.reader : rkey === last?.rkey ? readerTop : null);
  else if (back) $(".r-scroll").scrollTop = back.reader;
  else if (rkey === last?.rkey) $(".r-scroll").scrollTop = readerTop;
  if (ui.status?.focus) {
    $(ui.status.focus)?.focus({ preventScroll: true });
    ui.status.focus = null;
  }
  if (ui.focusQ) {
    ui.focusQ = false;
    qIn.focus({ preventScroll: true });
  }
  if (prev) play(prev);
  const rm = reduceMotion.matches;
  const form = formOf(reading);
  if (!viaVT && last && (mode || form !== last.form)) {
    for (const el of [$(".cap"), mode && $(".r-scroll"), mode && reading && $(".r-dock")]) el && el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  } else if (!viaVT && !mode && reading && sel && prevConv && sel.id !== prevConv && !rm) {
    $(".conv").animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
  } else if (!viaVT && !mode && last && rkey !== last.rkey && (ui.status || last.rkey === "status") && !rm) {
    $(".r-scroll").animate([{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: EASE });
  }
  // On a phone the list hangs below the expanded notch; when the sentence re-wraps, slide the list instead of jumping.
  const capH2 = root.style.getPropertyValue("--cap-h");
  if (narrow.matches && !reading && capH && capH !== capH2 && !rm) list.animate([{ transform: `translateY(${parseFloat(capH) - parseFloat(capH2)}px)` }, { transform: "none" }], { duration: 520, easing: EASE });
  last = { reading, form, key: capKey(secs, reading), conv: sel ? sel.id : "", rkey };
  ui.typing = false;
}

function select(c) {
  if (ui.selected) onLeave(ui.selected);
  ui.selected = c ? c.id : null;
  ui.status = null;
  if (c) onOpen(c);
  render();
}

function step(d) {
  const list = currentList();
  if (!list.length) return;
  const idx = list.findIndex((c) => c.id === ui.selected);
  const next = list[idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + d))];
  if (next.id !== ui.selected) (searching() ? openResult : select)(next);
}

/* Search: every conversation in the run, every bucket, read, cleared and muted. A conversation matches when each
   whitespace-separated term appears somewhere in it (case-insensitive substring), which stands in for SQLite FTS5.
   Field chips mirror the weir-axi search flags: from: and source: narrow which messages count, in: the bucket. An
   original matches only on what its message added (bodyNew), never on the history it quotes. */
const FIELD = { title: "Title", summary: "Conversation summary", point: "Point", gist: "Summary", body: "Original", from: "Sender", source: "Source" };
const CHIP = /(^|\s)(from|in|source):(\S+)/gi;
const RECENT = LS + "seek.recent";
const qIn = $(".q-in");
let index = null;
let memo = { key: null, index: null, res: [] };
let composing = false;

const termsOf = (q) => [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))];
const searching = () => !!ui.search && (!!ui.search.q.trim() || ui.search.chips.length > 0);
const qTerms = () => (searching() ? termsOf(ui.search.q) : []);
const chipVals = (k) => (ui.search?.chips || []).filter((c) => c.k === k).map((c) => c.v.toLowerCase());
const chipText = (c) => `${c.k}:${c.k === "in" ? groupName(c.v) : c.v}`;
const qText = () => [...ui.search.chips.map(chipText), ui.search.q.trim()].filter(Boolean).join(" ");
const homeOf = (c) => (data.buckets.some((b) => b.id === c.bucket) ? c.bucket : NONE);

// in: takes a bucket id or display name, case-insensitive.
function bucketOf(v) {
  const x = v.toLowerCase();
  if (x === UNSORTED.toLowerCase()) return NONE;
  return data.buckets.find((b) => b.id.toLowerCase() === x || b.name.toLowerCase() === x)?.id;
}

// Lifts finished field tokens out of the typed text: a token a space has closed, or every token once done (blur, Enter).
// An in: naming no bucket stays plain text.
function takeChips(text, done) {
  const chips = [];
  const rest = text.replace(CHIP, (m, pre, k, v, at, all) => {
    if (!done && at + m.length === all.length) return m;
    k = k.toLowerCase();
    if (k === "in") v = bucketOf(v);
    if (!v) return m;
    chips.push({ k, v });
    return pre;
  });
  return { chips, rest: chips.length ? rest.replace(/^\s+/, "").replace(/\s{2,}/g, " ") : text };
}

function buildIndex() {
  return data.conversations.map((c) => {
    const recs = [{ f: "title", text: c.title }, { f: "summary", text: c.summary || "" }, ...(c.points || []).map((p) => ({ f: "point", text: p.text }))];
    for (const i of itemsOf(c)) recs.push({ f: "gist", item: i.id, text: i.gist || "" }, { f: "body", item: i.id, text: i.bodyNew || "" }, { f: "from", item: i.id, text: `${i.from.name || ""} <${i.from.addr}>` }, { f: "source", item: i.id, text: i.sourceLabel || "" });
    for (const r of recs) r.low = r.text.toLowerCase();
    return { c, recs };
  });
}

/* Each result: the matching messages in conversation order (what the stepper walks), the fields each one matched, and
   the time of its newest matching message. Results are ordered newest matching message first. With from: or source:
   only the messages they admit count, and with no terms every admitted message is a match. */
function results() {
  if (!searching()) return [];
  index ||= buildIndex();
  const key = JSON.stringify([ui.search.chips, ui.search.q.trim()]);
  if (memo.key === key && memo.index === index) return memo.res;
  const terms = termsOf(ui.search.q);
  const ins = ui.search.chips.filter((x) => x.k === "in").map((x) => x.v);
  const narrow = { from: chipVals("from"), source: chipVals("source") };
  const narrowed = narrow.from.length + narrow.source.length > 0;
  const res = [];
  for (const { c, recs } of index) {
    if (!ins.every((b) => homeOf(c) === b)) continue;
    const admitted = new Set(c.itemIds.filter((id) => ["from", "source"].every((k) => narrow[k].every((v) => recs.some((r) => r.item === id && r.f === k && r.low.includes(v))))));
    if (narrowed && !admitted.size) continue;
    const pool = narrowed ? recs.filter((r) => !r.item || admitted.has(r.item)) : recs;
    if (!terms.every((t) => pool.some((r) => r.low.includes(t)))) continue;
    const byItem = new Map();
    const conv = [];
    for (const r of pool) {
      if (terms.length ? !terms.some((t) => r.low.includes(t)) : !(r.item && narrow[r.f]?.length)) continue;
      if (!r.item) conv.push(r);
      else byItem.has(r.item) ? byItem.get(r.item).push(r) : byItem.set(r.item, [r]);
    }
    const items = c.itemIds.filter((id) => byItem.has(id));
    const at = items.length ? Math.max(...items.map((id) => Date.parse(itemById[id].occurredAt))) : lastMs(c);
    res.push({ c, items, byItem, conv, at });
  }
  res.sort((a, b) => b.at - a.at);
  memo = { key, index, res };
  return res;
}

const groupOf = (c) => (isHidden(c) ? CLEARED : homeOf(c));
const groupName = (g) => (g === CLEARED ? "Cleared" : g === NONE ? UNSORTED : bucketName(g));
const shown = () => results().filter((r) => !ui.search.group || groupOf(r.c) === ui.search.group);
const curResult = () => (searching() && ui.selected ? results().find((r) => r.c.id === ui.selected) : null);
const curHit = () => curResult()?.items[ui.search.at];

function hl(s, terms) {
  s = String(s ?? "");
  const low = s.toLowerCase();
  const rs = [];
  for (const t of terms) for (let k = low.indexOf(t); k >= 0; k = low.indexOf(t, k + 1)) rs.push([k, k + t.length]);
  if (!rs.length) return esc(s);
  rs.sort((a, b) => a[0] - b[0]);
  let out = "";
  let pos = 0;
  for (const [a, b] of rs) {
    if (b <= pos) continue;
    const from = Math.max(a, pos);
    out += `${esc(s.slice(pos, from))}<mark>${esc(s.slice(from, b))}</mark>`;
    pos = b;
  }
  return (out + esc(s.slice(pos))).replace(/<\/mark><mark>/g, "");
}

function markDom(el, terms) {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walk.nextNode()) nodes.push(walk.currentNode);
  for (const n of nodes) {
    const html = hl(n.data, terms);
    if (!html.includes("<mark>")) continue;
    const box = document.createElement("template");
    box.innerHTML = html;
    n.replaceWith(box.content);
  }
}

// About 120 characters of the original around the first hit, cut at word edges; the raw text is the fallback when the
// hit sits inside a link or a tag that the plain reading drops.
function excerpt(body, terms, before = 48, span = 120) {
  const dec = document.createElement("textarea");
  for (const raw of [plain(body), (body || "").replace(/\s+/g, " ").trim()]) {
    dec.innerHTML = raw;
    const s = dec.value;
    const low = s.toLowerCase();
    const ks = terms.map((t) => [low.indexOf(t), t.length]).filter(([k]) => k >= 0);
    if (!ks.length) continue;
    const [k, len] = ks.reduce((a, b) => (b[0] < a[0] ? b : a));
    let start = Math.max(0, k - before);
    if (start > 0) {
      const sp = s.indexOf(" ", start);
      if (sp >= 0 && sp < k) start = sp + 1;
    }
    let end = Math.min(s.length, Math.max(start + span, k + len + 12));
    const sp = s.indexOf(" ", end);
    if (end < s.length && sp > 0 && sp - end < 16) end = sp;
    return `${start > 0 ? "…" : ""}${s.slice(start, end)}${end < s.length ? "…" : ""}`;
  }
  return "";
}

// Up to 3 lines per result: matching messages first, in conversation order, then the conversation's own fields.
function hitLines(r) {
  const out = [];
  for (const id of r.items.slice(0, 3)) {
    const recs = r.byItem.get(id);
    out.push({ f: ["gist", "body", "from", "source"].find((k) => recs.some((x) => x.f === k)), i: itemById[id], n: r.c.itemIds.indexOf(id) + 1 });
  }
  for (const x of r.conv) if (out.length < 3 && x.f !== "title") out.push({ f: x.f, text: x.text });
  return out;
}

function hitLineHtml(h, terms) {
  if (!h.i) return `<li class="hl"><span class="hl-k"><i>${FIELD[h.f]}</i></span><span class="hl-t hl-z">${hl(excerpt(h.text, terms, 16, 60), terms)}</span></li>`;
  const k = `<span class="hl-k"><b>#${h.n}</b><span class="hl-who">${esc(short(h.i.from))}</span><i>${FIELD[h.f]}</i></span>`;
  if (h.f === "gist") return `<li class="hl">${k}<span class="hl-t hl-z">${hl(h.i.gist, terms)}</span></li>`;
  const t = h.f === "body" ? excerpt(h.i.bodyNew, terms) : h.f === "from" ? `${h.i.from.name || ""} <${h.i.from.addr}>`.trim() : h.i.sourceLabel;
  return `<li class="hl hl-${h.f}">${k}<span class="hl-t hl-o">${hl(t, h.f === "body" ? terms : [...terms, ...chipVals(h.f)])}</span><span class="hl-g">${esc(h.i.gist || firstSentence(h.i.bodyNew))}</span></li>`;
}

const stateLabel = (c) => (S(c).muted ? "Muted" : "Done");

function resRowHtml(r, terms) {
  const c = r.c;
  const its = itemsOf(c);
  const from = [...its].reverse().find((i) => !isMe(i.from))?.from || its.at(-1).from;
  const lines = hitLines(r);
  const more = r.items.length - lines.filter((h) => h.i).length;
  const st = isHidden(c) ? `<span class="row-st">${stateLabel(c)}</span>` : "";
  const iso = new Date(r.at).toISOString();
  return `<article class="row res ${isUnread(c) ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-k="s-${c.id}" data-conv="${c.id}" data-open tabindex="0" aria-current="${ui.selected === c.id}" style="${tint(c.bucket)}">
    <span class="row-av">${avatarHtml(from)}</span>
    <span class="row-title" title="${esc(c.title)}">${hl(c.title, terms)}</span>
    <span class="row-time" title="${esc(abs(iso))}">${relShort(iso)}</span>
    <span class="row-meta"><span class="row-b">${esc(bucketName(c.bucket))}</span>${st}<span class="row-n">${r.items.length ? plural(r.items.length, "matching message") : "Matched the conversation"}</span></span>
    ${lines.length ? `<ol class="hits">${lines.map((h) => hitLineHtml(h, terms)).join("")}${more > 0 ? `<li class="hl-more">${more} more</li>` : ""}</ol>` : ""}
  </article>`;
}

const nothing = () => `Nothing matches “${esc(qText())}”.`;

function resListHtml() {
  const all = results();
  const rs = shown();
  const g = ui.search.group;
  const head = `<div class="l-head"><h2 class="l-name">${g ? `In ${esc(groupName(g))}` : "Results"}</h2><span class="l-meta">${plural(rs.length, "conversation")} · newest match first</span>${g ? `<button class="clearall" data-sg="">Show all ${all.length}</button>` : ""}</div>`;
  if (!rs.length) return `${head}<div class="empty"><p class="empty-big">${nothing()}</p><p class="empty-sub">Cleared and muted conversations were searched too.</p></div>`;
  const terms = qTerms();
  return `${head}<div class="rows res">${rs.map((r) => resRowHtml(r, terms)).join("")}</div>`;
}

const groupsOf = (res) => {
  const order = [NONE, ...data.buckets.map((b) => b.id), CLEARED];
  return order.map((g) => ({ g, rs: res.filter((r) => groupOf(r.c) === g) })).filter((x) => x.rs.length);
};

// The bucket sentence turned into the results sentence: the query in the field above is its subject, so the line
// below reads on from it: “freeze” appears in 1 Action and 2 Reading.
function searchNavHtml() {
  if (!searching()) {
    const recent = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return `<p class="s-tail q-hint"><span class="grp">Searches titles, summaries, originals, senders and sources,</span> <span class="grp">cleared and muted included.</span> <span class="grp">Every word must appear.</span> <span class="grp">Narrow with <code>from:</code> <code>in:</code> <code>source:</code></span></p>${recent.length ? `<p class="s-tail q-recent"><span class="glue">Recent</span>${recent.map((r) => `<button class="w" data-recent="${esc(r)}">${esc(r)}</button>`).join("")}</p>` : ""}`;
  }
  const res = results();
  if (!res.length) return `<h1 class="s-main"><span class="allclear">${nothing()}</span></h1><p class="s-tail">Try fewer words, or drop a filter.</p>`;
  const on = ui.search.group;
  const ws = groupsOf(res).map(({ g, rs }) => {
    const avs = `<span class="avs">${senders(rs.map((r) => r.c)).map(avatarHtml).join("")}</span>`;
    const sel = g === on;
    return `<button class="w w-main ${sel ? "on" : ""}" data-sg="${g}" style="${g === CLEARED ? "" : tint(g === NONE ? null : g)}" aria-pressed="${sel}" aria-label="${esc(`${rs.length} ${groupName(g)}. ${sel ? "Show all" : "Show only these"}`)}">${avs}<span class="w-n">${rs.length}</span> <span class="w-name">${esc(groupName(g))}</span></button>`;
  });
  const msgs = res.reduce((n, r) => n + r.items.length, 0);
  return `<h1 class="s-main">${enumerate(ws, glue("appears in ", "glue lead"), glue(".", "glue end"))}</h1>
    <p class="s-tail">${plural(res.length, "conversation")}${msgs ? `, ${plural(msgs, "message")}` : ""}. ${on ? "Click the lit group again to see all." : "Click a group to see only it."}</p>`;
}

// With no result open the reader stays calm; the list already holds every result.
function searchCalmHtml() {
  return `<div class="calm calm-q">${Q_ICON}<p>${results().length ? "Pick a result to read it." : nothing()}</p></div>`;
}

function paintQ(form) {
  const s = ui.search;
  if (!s) return;
  if (!composing && qIn.value !== s.q) qIn.value = s.q;
  qIn.placeholder = "Search";
  $(".q-box").dataset.v = qIn.value || qIn.placeholder;
  $(".cap-q").classList.toggle("blank", !qIn.value);
  $(".q-chips").innerHTML = s.chips.map((c, i) => `<span class="q-chip"><span class="qc-k">${c.k}:</span><span class="qc-v">${esc(c.k === "in" ? groupName(c.v) : c.v)}</span><button class="qc-x" data-q="unchip" data-i="${i}" aria-label="${esc(`Remove ${chipText(c)}`)}" title="Remove">${X_ICON}</button></span>`).join("");
  const r = curResult();
  let st = "";
  if (r?.items.length) {
    const n = r.items.length;
    st = `<span class="q-n" aria-live="polite" aria-label="Match ${s.at + 1} of ${n}"><b>${s.at + 1}</b><span>/</span>${n}</span><button class="q-b" data-q="prev" aria-label="Previous match" title="Previous match" ${s.at ? "" : "disabled"}>${CHEV("prev")}</button><button class="q-b" data-q="next" aria-label="Next match" title="Next match" ${s.at < n - 1 ? "" : "disabled"}>${CHEV("next")}</button>`;
  } else if (r) st = `<span class="q-n q-conv">Matched in ${[...new Set(r.conv.map((x) => FIELD[x.f]))].join(", ") || "filters"}</span>`;
  $(".q-st").innerHTML = st;
}

function restorePrior() {
  const p = ui.search.prior;
  if (ui.selected && ui.selected !== p.selected) onLeave(ui.selected);
  ui.tab = p.tab;
  ui.selected = p.selected;
  if (p.selected) {
    if (p.snap) ui.snap[p.selected] = p.snap;
    ui.fold = p.fold;
    ui.old = new Set(p.old);
    ui.sumOpen = p.sumOpen;
  }
  ui.restore = { list: p.listTop, reader: p.readerTop };
}

function openSearch() {
  if (ui.search) return qIn.focus();
  // Search starts from what the status view covered, so leaving search lands there, not on the status view.
  const sv = ui.status?.prior;
  ui.status = null;
  ui.restore = sv || null;
  ui.search = {
    q: "",
    chips: [],
    group: null,
    at: 0,
    prior: { tab: ui.tab, selected: ui.selected, snap: ui.snap[ui.selected], fold: ui.fold, old: [...ui.old], sumOpen: ui.sumOpen, listTop: sv ? sv.list : $(".list").scrollTop, readerTop: sv ? sv.reader : ($(".st") || $(".r-scroll")).scrollTop },
  };
  ui.focusQ = true;
  render();
}

function leaveSearch() {
  if (!ui.search) return;
  if (searching()) restorePrior();
  ui.search = null;
  qIn.value = "";
  qIn.blur();
  render();
}

function setQuery(q, chips = ui.search?.chips) {
  const s = ui.search;
  if (!s || (s.q === q && s.chips === chips)) return;
  const was = searching();
  s.q = q;
  s.chips = chips;
  if (!searching()) {
    if (was) restorePrior();
  } else {
    if (ui.selected) onLeave(ui.selected);
    ui.selected = null;
    s.at = 0;
    if (s.group && !results().some((r) => groupOf(r.c) === s.group)) s.group = null;
    ui.tabJump = true;
  }
  ui.typing = true;
  render();
}

// The field's text as typed, with finished field tokens moved into chips.
function syncField(done) {
  const { chips, rest } = takeChips(qIn.value, done);
  const have = ui.search.chips;
  const add = chips.filter((c) => !have.some((x) => x.k === c.k && x.v === c.v));
  if (chips.length) qIn.value = rest;
  $(".q-box").dataset.v = qIn.value || qIn.placeholder;
  $(".cap-q").classList.toggle("blank", !qIn.value);
  setQuery(qIn.value, add.length ? [...have, ...add] : have);
}

function openResult(c) {
  const q = qText();
  localStorage.setItem(RECENT, JSON.stringify([q, ...JSON.parse(localStorage.getItem(RECENT) || "[]").filter((x) => x !== q)].slice(0, 5)));
  if (ui.selected !== c.id) select(c);
  goHit(0);
}

// Land on a matching message: open the "N earlier" run that hides it, then scroll it in under the folded card.
function goHit(k) {
  const r = curResult();
  if (!r?.items.length) return render();
  ui.search.at = Math.max(0, Math.min(r.items.length - 1, k));
  const id = r.items[ui.search.at];
  const run = streamRows(r.c).find((x) => x.k === "older" && x.items.some((i) => i.id === id));
  if (run) ui.old.add(run.items[0].id);
  ui.jump = id;
  render();
}

function onQ(a, el) {
  if (a === "open") return openSearch();
  if (a === "close") return leaveSearch();
  if (a === "unchip") {
    setQuery(ui.search.q, ui.search.chips.filter((_, i) => i !== +el.dataset.i));
    return qIn.focus();
  }
  ui.jumpSmooth = true;
  goHit(ui.search.at + (a === "next" ? 1 : -1));
}

qIn.addEventListener("compositionstart", () => (composing = true));
qIn.addEventListener("compositionend", () => {
  composing = false;
  syncField(false);
});
qIn.addEventListener("input", (e) => {
  $(".q-box").dataset.v = qIn.value || qIn.placeholder;
  $(".cap-q").classList.toggle("blank", !qIn.value);
  if (!e.isComposing && !composing) syncField(false);
});
qIn.addEventListener("blur", () => ui.search && syncField(true));

async function beforeHide(c) {
  const row = $(`.row[data-conv="${c.id}"]`);
  if (!row || reduceMotion.matches) return;
  const a = row.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(40px)" }], { duration: 240, easing: EASE, fill: "forwards" });
  await Promise.race([a.finished, new Promise((r) => setTimeout(r, 600))]);
}

// Hide c (via mutate), then move selection to the row that took its place.
async function dismiss(c, mutate) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const list = currentList();
    const idx = list.findIndex((x) => x.id === c.id);
    await beforeHide(c);
    mutate();
    if (ui.selected === c.id) {
      onLeave(c.id);
      ui.selected = null;
      const rest = list.filter((x) => x.id !== c.id);
      const next = rest[Math.min(idx, rest.length - 1)];
      if (next) (searching() ? openResult : select)(next);
    }
    render();
  } finally {
    ui.busy = false;
  }
}

const done = (c) => dismiss(c, () => setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) }));
const mute = (c) => dismiss(c, () => setS(c, { muted: true }));

function restore(c) {
  setS(c, { clearedAt: null, muted: false });
  render();
}

function clearAll(bucketId) {
  const s = sections().find((x) => x.id === bucketId);
  if (!s?.convs.length) return;
  for (const c of s.convs) setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) });
  if (s.convs.some((c) => c.id === ui.selected)) {
    onLeave(ui.selected);
    ui.selected = null;
  }
  render();
}

function reset() {
  state = {};
  save();
  ui.selected = null;
  ui.snap = {};
  render();
}

function simulate() {
  ui.sims++;
  index = null;
  const muted = data.conversations.filter((c) => S(c).muted);
  const cleared = data.conversations.filter((c) => !S(c).muted && isCleared(c));
  const pool = ui.sims % 2 === 0 && muted.length ? muted : cleared.length ? cleared : muted;
  if (!pool.length) return console.info("weir dev: nothing to simulate; mark one Done or Mute it first.");
  const c = pool[Math.floor(Math.random() * pool.length)];
  const now = new Date().toISOString();
  const item = { ...lastItem(c), id: `sim-${Date.now()}`, subject: `Re: ${c.title}`, bodyNew: "(simulated reply)", bodyQuoted: "", gist: "", occurredAt: now };
  data.items.push(item);
  itemById[item.id] = item;
  c.itemIds = [...c.itemIds, item.id];
  c.lastAt = now;
  c.update = "(simulated) New reply";
  c.pending = true;
  render();
}

/* The Original view: the whole conversation as a parallel text, gists on the left, originals on the right.
   pairs[k] (k >= 1, pairs[0] is the column tops) holds G and H, the scrollTop that brings gist k and original k to the
   top of their column. Both columns are tied through that table: while you read inside original k its gist holds at
   the top; over the last stretch before original k+1 arrives, gist k+1 rises with it at the same speed, so the two
   reach the top line together. Scrolling the gist column alone browses it freely until the originals move again. */
let tx = null;

function txHtml(c, picked) {
  const its = itemsOf(c);
  const fresh = ui.snap[c.id] || new Set();
  const shared = sharedDomains(c);
  const L = [];
  const R = [];
  let prevDay = null;
  let marked = false;
  let prevTag = null;
  its.forEach((i, j) => {
    const n = j + 1;
    if (dayKey(i.occurredAt) !== prevDay) {
      prevDay = dayKey(i.occurredAt);
      L.push(`<li class="tx-day" aria-hidden="true"><span>${dayLabel(i.occurredAt)}</span></li>`);
      R.push(`<div class="tx-day" role="separator"><span>${dayLabel(i.occurredAt)}</span></div>`);
    }
    if (!marked && fresh.has(i.id)) {
      marked = true;
      L.push(`<li class="tx-lr" aria-hidden="true"><span>Last read</span></li>`);
      R.push(`<div class="tx-lr" role="separator"><span>Last read</span></div>`);
    }
    const me = isMe(i.from);
    const cls = `${i.id === picked ? "picked" : ""} ${fresh.has(i.id) ? "new" : ""} ${me ? "me" : ""}`;
    const gist = esc(i.gist || firstSentence(i.bodyNew));
    const tnew = fresh.has(i.id) ? `<i class="tx-new">New</i>` : "";
    L.push(`<li class="xg ${cls}" data-item="${i.id}"><button class="xg-b" data-tx="go" data-item="${i.id}"><span class="xg-meta"><b class="tx-n">#${n}</b><span class="xg-who">${esc(short(i.from))}</span><time datetime="${esc(i.occurredAt)}">${hm(i.occurredAt)}</time>${tnew}</span><span class="xg-gist"><span>${gist}</span><span class="xg-w" aria-hidden="true">${gist}</span></span></button></li>`);
    const tag = srcTag(i);
    const showTag = tag !== prevTag;
    prevTag = tag;
    R.push(`<article class="to ${cls}" data-item="${i.id}" tabindex="-1" aria-labelledby="toh-${j}">
      <header class="to-h" id="toh-${j}"><span class="to-av">${avatarHtml(i.from, shared.has(orgDomain(i.from.addr)))}</span><span class="to-who"><b>${esc(me ? ME : i.from.name || i.from.addr)}</b><span class="to-addr">${esc(i.from.addr)}</span></span><span class="to-meta"><span class="to-src ${showTag ? "" : "same"}">${esc(tag)}</span><time datetime="${esc(i.occurredAt)}">${abs(i.occurredAt)}</time><b class="tx-n">#${n}</b></span></header>
      <p class="to-lede">${gist}</p>
      <div class="body">${i.bodyNew.trim() ? originalMd(i.bodyNew) : `<p class="b-none">(no text)</p>`}</div>
      ${i.bodyQuoted ? `<button class="q-toggle" data-tx="quote" data-item="${i.id}" aria-expanded="false">Show quoted</button>` : ""}
    </article>`);
  });
  return `<div class="tx-scrim" data-tx="close"></div>
  <div class="tx-sheet">
    <header class="tx-head">
      <div class="tx-id"><p class="tx-crumb"><b>${esc(bucketName(c.bucket))}</b><span>${plural(its.length, "message")} · ${plural(participants(c).length, "person", "people")}</span><span>${day(its[0].occurredAt)} – ${day(lastIso(c))}</span></p><h2 class="tx-title" id="tx-title">${esc(c.title)}</h2></div>
      <button class="tx-x" data-tx="close" aria-label="Close" title="Close (Esc)">${X_ICON}</button>
    </header>
    <div class="tx-cols">
      <section class="tx-lc" aria-label="Summary"><p class="tx-lab">Summary<span>${its.length}</span></p><ol class="tx-l">${L.join("")}<li class="tx-end" aria-hidden="true"></li></ol></section>
      <section class="tx-rc" aria-label="Original"><p class="tx-lab">Original<span class="tx-pos"></span><a class="tx-ext" target="_blank" rel="noreferrer"></a></p><div class="tx-r"><div class="tx-r-in">${R.join("")}<div class="tx-end"><span>End of conversation · ${plural(its.length, "message")}</span></div></div></div></section>
    </div>
  </div>`;
}

// opener: a selector, not an element, so focus finds its way back even if a repaint replaced the control meanwhile.
function openTx(c, id, opener) {
  if (tx) return;
  const dlg = document.createElement("dialog");
  dlg.className = "tx";
  dlg.setAttribute("aria-labelledby", "tx-title");
  dlg.setAttribute("aria-modal", "true");
  dlg.style.cssText = tint(c.bucket);
  dlg.innerHTML = txHtml(c, id);
  if (searching()) markDom($(".tx-cols", dlg), qTerms());
  document.body.append(dlg);
  const ids = c.itemIds.filter((x) => itemById[x]);
  const at = (sel, x) => dlg.querySelector(`${sel}[data-item="${CSS.escape(x)}"]`);
  tx = {
    dlg,
    opener,
    left: $(".tx-l", dlg),
    right: $(".tx-r", dlg),
    pairs: [{ G: 0, H: 0 }, ...ids.map((x) => ({ id: x, gist: at(".xg", x), art: at(".to", x), G: 0, H: 0 }))],
    landK: ids.indexOf(id) + 1,
    mode: "lock", // lock: gists follow the originals; free: gist column browsed on its own; catch: easing back; glide: a gist click in flight
    touched: false,
    active: 0,
    expectL: 0,
    expectR: 0,
    raf: 0,
    glide: 0,
  };
  dlg.showModal();
  txMeasure();
  txLand(tx.landK);
  $(".to.picked", dlg).focus({ preventScroll: true });
  tx.right.addEventListener("scroll", txOnRight, { passive: true });
  tx.left.addEventListener("scroll", txOnLeft, { passive: true });
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeTx();
  });
  dlg.addEventListener("click", txOnClick);
  tx.ro = new ResizeObserver(() => {
    if (!tx) return;
    txMeasure();
    if (!tx.touched) txLand(tx.landK);
    else if (tx.mode === "lock") txFollow();
  });
  for (const el of [tx.left, tx.right, $(".tx-r-in", dlg)]) tx.ro.observe(el);
  const rm = reduceMotion.matches;
  $(".tx-scrim", dlg).animate([{ opacity: 0 }, { opacity: 1 }], { duration: rm ? 160 : 280, easing: "linear" });
  $(".tx-sheet", dlg).animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(22px) scale(0.985)" }, { opacity: 1, transform: "none" }], { duration: rm ? 160 : 520, easing: "cubic-bezier(0.32, 0.72, 0, 1)" });
  if (rm) return;
  // The gist column arrives a beat late and settles onto the original's line.
  tx.left.animate([{ opacity: 0, transform: "translateY(44px)" }, { opacity: 1, transform: "none" }], { duration: 640, delay: 90, easing: "cubic-bezier(0.32, 0.72, 0, 1)", fill: "backwards" });
}

// Rects keep the fractional offsets that offsetTop rounds away; dividing by the sheet's scale cancels the open animation.
function txMeasure() {
  const { pairs, left, right, dlg } = tx;
  const sheet = $(".tx-sheet", dlg);
  const s = sheet.getBoundingClientRect().height / sheet.offsetHeight || 1;
  const lt = left.getBoundingClientRect().top - left.scrollTop * s;
  const rt = $(".tx-r-in", dlg).getBoundingClientRect().top;
  for (const p of pairs.slice(1)) {
    p.G = (p.gist.getBoundingClientRect().top - lt) / s;
    p.H = (p.art.getBoundingClientRect().top - rt) / s;
  }
  const last = pairs.at(-1);
  $(".tx-l > .tx-end", dlg).style.height = `${Math.max(0, left.clientHeight - last.gist.offsetHeight)}px`;
  $(".tx-r-in > .tx-end", dlg).style.height = `${Math.max(72, right.clientHeight - last.art.offsetHeight)}px`;
}

function txLeftFor(p) {
  const P = tx.pairs;
  let k = 0;
  while (k + 1 < P.length && P[k + 1].H <= p) k++;
  const a = P[k];
  const b = P[k + 1];
  if (!b) return a.G;
  const d = b.G - a.G;
  const z = Math.min(d, b.H - a.H);
  const s = b.H - z;
  return p <= s || z <= 0 ? a.G : a.G + ((p - s) * d) / z;
}

// The active pair is the one at the top line, or the one rising to it in lockstep.
function txActive(p) {
  const P = tx.pairs;
  let k = 1;
  for (let j = 2; j < P.length; j++) {
    const z = Math.min(P[j].G - P[j - 1].G, P[j].H - P[j - 1].H);
    if (p > (z > 0 ? P[j].H - z + 0.5 : P[j].H - 0.5)) k = j;
    else break;
  }
  return k;
}

function txSetL(y) {
  tx.left.scrollTop = y;
  tx.expectL = tx.left.scrollTop;
}
function txSetR(y) {
  tx.right.scrollTop = y;
  tx.expectR = tx.right.scrollTop;
}

function txLand(k) {
  txSetR(tx.pairs[k].H);
  txSetL(tx.pairs[k].G);
  tx.mode = "lock";
  txSpy();
}

function txSpy(k = txActive(tx.right.scrollTop)) {
  if (k === tx.active) return;
  const P = tx.pairs;
  const prev = P[tx.active];
  prev?.gist?.classList.remove("on");
  prev?.art?.classList.remove("on");
  prev?.gist?.firstElementChild.removeAttribute("aria-current");
  tx.active = k;
  P[k].gist.classList.add("on");
  P[k].art.classList.add("on");
  P[k].gist.firstElementChild.setAttribute("aria-current", "true");
  $(".tx-pos", tx.dlg).textContent = `${k} of ${P.length - 1}`;
  const item = itemById[P[k].id];
  const ext = $(".tx-ext", tx.dlg);
  ext.innerHTML = `Open in ${esc(srcApp(item))}${EXT_ICON}`;
  item.link ? ext.setAttribute("href", item.link) : ext.removeAttribute("href");
}

function txFollow() {
  if (!tx) return;
  tx.raf = 0;
  const target = txLeftFor(tx.right.scrollTop);
  const cur = tx.left.scrollTop;
  if (tx.mode === "catch" && !reduceMotion.matches && Math.abs(target - cur) > 2) {
    txSetL(cur + (target - cur) * 0.24);
    tx.raf = requestAnimationFrame(txFollow);
  } else {
    txSetL(target);
    tx.mode = "lock";
  }
  txSpy();
}

function txOnRight() {
  if (!tx || tx.mode === "glide") return;
  if (Math.abs(tx.right.scrollTop - tx.expectR) > 1) tx.touched = true;
  if (tx.mode === "free") tx.mode = "catch";
  if (!tx.raf) tx.raf = requestAnimationFrame(txFollow);
}

function txOnLeft() {
  if (!tx || tx.mode === "glide" || Math.abs(tx.left.scrollTop - tx.expectL) <= 1) return;
  tx.touched = true;
  tx.mode = "free";
}

function txGo(k) {
  cancelAnimationFrame(tx.glide);
  const r0 = tx.right.scrollTop;
  const l0 = tx.left.scrollTop;
  const { H: r1, G: l1 } = tx.pairs[k];
  txSpy(k);
  if (reduceMotion.matches || (Math.abs(r1 - r0) < 2 && Math.abs(l1 - l0) < 2)) {
    txSetR(r1);
    txSetL(l1);
    tx.mode = "lock";
    return;
  }
  tx.mode = "glide";
  const dur = Math.min(760, 380 + Math.abs(r1 - r0) * 0.05);
  const t0 = performance.now();
  const frame = (now) => {
    if (!tx) return;
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - (1 - t) ** 4;
    txSetR(r0 + (r1 - r0) * e);
    txSetL(l0 + (l1 - l0) * e);
    if (t < 1) return void (tx.glide = requestAnimationFrame(frame));
    tx.mode = "lock";
    txSpy();
  };
  tx.glide = requestAnimationFrame(frame);
}

function txQuote(btn) {
  const open = btn.getAttribute("aria-expanded") === "true";
  if (open) btn.nextElementSibling?.remove();
  else btn.insertAdjacentHTML("afterend", `<div class="quoted">${esc(itemById[btn.dataset.item].bodyQuoted)}</div>`);
  btn.textContent = open ? "Show quoted" : "Hide quoted";
  btn.setAttribute("aria-expanded", String(!open));
}

function txOnClick(e) {
  if (!tx) return;
  const t = e.target.closest("[data-tx]");
  if (!t) return;
  const act = t.dataset.tx;
  if (act === "close") return closeTx();
  tx.touched = true;
  if (act === "go") return txGo(tx.pairs.findIndex((p) => p.id === t.dataset.item));
  if (act === "quote") return txQuote(t);
}

function txKey(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    return closeTx();
  }
  if (e.key !== "Tab") return;
  e.preventDefault();
  const f = [...tx.dlg.querySelectorAll("button, a[href]")].filter((el) => el.getClientRects().length);
  const cur = document.activeElement;
  const i = f.indexOf(cur);
  let next;
  if (i >= 0) next = f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length];
  else if (e.shiftKey) next = f.findLast((el) => cur.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING) || f.at(-1);
  else next = f.find((el) => cur.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || f[0];
  next.focus();
}

function closeTx() {
  if (!tx || tx.closing) return;
  const t = tx;
  t.closing = true;
  const finish = () => {
    t.ro.disconnect();
    cancelAnimationFrame(t.raf);
    cancelAnimationFrame(t.glide);
    t.dlg.close();
    t.dlg.remove();
    tx = null;
    document.querySelector(t.opener)?.focus({ preventScroll: true });
  };
  const rm = reduceMotion.matches;
  $(".tx-scrim", t.dlg).animate([{ opacity: 1 }, { opacity: 0 }], { duration: rm ? 120 : 220, easing: "linear", fill: "forwards" });
  $(".tx-sheet", t.dlg)
    .animate(rm ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(12px) scale(0.99)" }], { duration: rm ? 120 : 200, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" })
    .finished.then(finish, finish);
}

/* The status view answers "is it working right now": sources, enrichment, the config with Reload, and the theme. The
   daemon serves this in the real app; here it is faked from the run, and the dev switcher breaks a source or the config. */
const THEME_KEY = LS + "theme";
const THEMES = ["system", "light", "dark"];
const CONFIG_ERRORS = [
  { file: "~/.weir/config.toml", path: "bucket[2].ai", msg: 'unknown AI profile "carefull"' },
  { file: "prompts/action.md", msg: "file not found" },
];
let status = null;

function initStatus() {
  const now = Date.now();
  const runs = data.enrichRuns || [];
  const fail = runs.findLast((r) => !r.ok);
  const teams = data.items.filter((i) => srcApp(i) === "Teams").length;
  status = {
    sources: [
      { id: "gmail", name: "Personal Gmail", app: "Gmail", syncedAt: now - 3 * 60e3, lastGoodAt: now - 26 * 60e3, items: data.items.length - teams, error: 'oauth2: "invalid_grant" "Token has been expired or revoked."' },
      { id: "teams", name: "#release-war-room", app: "Teams (synthetic)", syncedAt: now - 60e3, items: teams },
    ],
    enrich: {
      profile: "luna",
      lastAt: Date.parse(data.generatedAt),
      ms: runs.reduce((n, r) => n + r.ms, 0),
      failure: fail && { what: `${fail.stage} batch ${fail.batch}`, error: fail.error, log: `~/.weir/logs/enrich/${fail.stage}-${fail.batch}.txt`, retried: runs.some((r) => r.ok && r.stage === fail.stage && r.batch === fail.batch) },
    },
    config: { path: "~/.weir/config.toml", loadedAt: now - 42 * 60e3, failedAt: null, errors: [], reloading: false },
  };
}

const failing = (s) => s.id === "gmail" && broken.source;
const statusAlert = () => broken.source || status.config.errors.length > 0;
const dur = (ms) => `${Math.floor(ms / 60000)}m ${pad(Math.round((ms % 60000) / 1000))}s`;
const waitingCount = () => data.conversations.filter((c) => !c.summary || c.pending).length;

function statusHtml() {
  const { sources, enrich, config } = status;
  const stopped = config.errors.length > 0;
  const down = sources.filter(failing);
  const verdict = stopped
    ? ["warn", "Sync and enrich stopped", "The config did not load. Fix it and Reload. Everything synced so far stays readable."]
    : down.length
      ? ["warn", `${down[0].name} can't sync.`, "The other sources and enrichment keep running."]
      : ["ok", "Everything is running.", `Last sync ${ago(Math.max(...sources.map((s) => s.syncedAt)))}.`];
  const waiting = waitingCount();
  const row = (k, v, cls = "") => `<div class="sv-row ${cls}"><dt>${k}</dt><dd>${v}</dd></div>`;
  const src = sources
    .map((s) => {
      const bad = failing(s);
      return `<li class="sv-src ${bad ? "bad" : ""} ${stopped ? "held" : ""}">
        <span class="sv-led" aria-hidden="true"></span>
        <span class="sv-src-name"><b>${esc(s.name)}</b><span>${esc(s.app)}</span></span>
        <span class="sv-src-state">${bad ? "Sync failed" : `Synced ${ago(s.syncedAt)}`}</span>
        <span class="sv-src-meta">${bad ? `Last good sync ${ago(s.lastGoodAt)} · ` : ""}${s.items.toLocaleString("en")} items</span>
        ${bad ? `<p class="sv-err"><code>${esc(s.error)}</code></p>` : ""}
      </li>`;
    })
    .join("");
  const f = enrich.failure;
  const cfgState = config.reloading
    ? `<span class="sv-busy">Reloading…</span>`
    : stopped
      ? `<span class="sv-bad">Reload failed</span><time>${hm(new Date(config.failedAt).toISOString())}</time>`
      : `<span class="sv-good">Config loaded</span><time>${hm(new Date(config.loadedAt).toISOString())}</time>`;
  const themeAt = THEMES.indexOf(themePref());
  const draw = ui.status.drawn !== verdict[0];
  ui.status.drawn = verdict[0];
  return `<div class="sv">
    <header class="sv-head sv-${verdict[0]} ${draw ? "draw" : ""}">
      <h2 class="sv-title">Status</h2><svg class="sv-pulse" viewBox="0 0 160 24" aria-hidden="true"><path pathLength="1" d="${verdict[0] === "ok" ? "M0 13h56l7-10 10 19 8-14 5 5h74" : "M0 13h56l7-10 10 19 4-7h83"}"/></svg>
      <p class="sv-verdict"><b>${verdict[1]}</b><span>${verdict[2]}</span></p>
    </header>
    <section class="sv-sec" aria-labelledby="sv-h-src"><h3 class="sv-h" id="sv-h-src">Sources</h3><ul class="sv-srcs">${src}</ul></section>
    <section class="sv-sec" aria-labelledby="sv-h-en"><h3 class="sv-h" id="sv-h-en">Enrichment</h3><dl class="sv-dl">
      ${row("Waiting", waiting ? plural(waiting, "conversation") : "None", stopped ? "held" : "")}
      ${row("Last run", `${abs(new Date(enrich.lastAt).toISOString())}<span class="sv-dim">took ${dur(enrich.ms)}</span>`)}
      ${row("AI profile", `<code>${esc(enrich.profile)}</code>`)}
      ${f ? row("Last failure", `<span>${esc(f.what)}: ${esc(f.error)}</span><code class="sv-path">${esc(f.log)}</code>${f.retried ? `<span class="sv-dim">Retried and succeeded.</span>` : ""}`, "stack") : ""}
    </dl></section>
    <section class="sv-sec" aria-labelledby="sv-h-cfg"><h3 class="sv-h" id="sv-h-cfg">Config</h3><dl class="sv-dl">
      ${row("File", `<code class="sv-path">${esc(config.path)}</code>`)}
      ${row("State", `<span class="sv-state" role="status" aria-live="polite">${cfgState}</span>`)}
    </dl>
    ${stopped && !config.reloading ? `<ul class="sv-errs" aria-label="Config errors">${config.errors.map((e) => `<li><code>${esc(e.file)}</code><span>${e.path ? `<code>${esc(e.path)}</code>: ` : ""}${esc(e.msg)}</span></li>`).join("")}</ul>` : ""}
    <div class="sv-reload-row"><button class="sv-reload" data-st="reload" aria-disabled="${config.reloading}">${config.reloading ? `<span class="sv-spin" aria-hidden="true"></span>Reloading…` : "Reload"}</button><p class="sv-note">Reads <code>config.toml</code> and <code>prompts/</code> again, after running sync and AI calls finish.</p></div>
    </section>
    <section class="sv-sec" aria-labelledby="sv-h-ap"><h3 class="sv-h" id="sv-h-ap">Appearance</h3>
      <div class="sv-seg" role="radiogroup" aria-labelledby="sv-h-ap" style="--i:${themeAt}"><span class="sv-thumb" aria-hidden="true"></span>${THEMES.map((t, i) => `<button role="radio" data-pick="${t}" aria-checked="${i === themeAt}" tabindex="${i === themeAt ? 0 : -1}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>
    </section>
  </div>`;
}

const themePref = () => (THEMES.includes(localStorage.getItem(THEME_KEY)) ? localStorage.getItem(THEME_KEY) : "system");

function setTheme(p, focus) {
  localStorage.setItem(THEME_KEY, p);
  const seg = $(".sv-seg");
  seg?.style.setProperty("--i", THEMES.indexOf(p));
  for (const b of document.querySelectorAll(".sv-seg button")) {
    b.setAttribute("aria-checked", String(b.dataset.pick === p));
    b.tabIndex = b.dataset.pick === p ? 0 : -1;
    if (focus && b.dataset.pick === p) b.focus();
  }
  if (!reduceMotion.matches) {
    root.classList.add("theming");
    setTimeout(() => root.classList.remove("theming"), 320);
  }
  root.dataset.theme = p === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
}

function openStatus() {
  if (ui.search) return;
  ui.status = { prior: { list: $(".list").scrollTop, reader: ($(".st") || $(".r-scroll")).scrollTop } };
  render();
}

function closeStatus() {
  if (!ui.status) return;
  ui.restore = ui.status.prior;
  ui.status = null;
  render();
}

// The daemon waits for running sync and AI calls before it reads the config; failing, it stops instead of falling back.
function reloadConfig() {
  const cfg = status.config;
  if (cfg.reloading) return;
  cfg.reloading = true;
  ui.status.focus = ".sv-reload";
  render();
  setTimeout(() => {
    cfg.reloading = false;
    cfg.errors = broken.config ? CONFIG_ERRORS : [];
    if (cfg.errors.length) cfg.failedAt = Date.now();
    else cfg.loadedAt = Date.now();
    if (ui.status) ui.status.focus = ".sv-reload";
    render();
  }, 1000);
}

const cap = $(".cap");
// A vertical wheel over an overflowing bucket strip scrolls it sideways; a trackpad's horizontal swipe passes through.
cap.addEventListener(
  "wheel",
  (e) => {
    const el = e.target.closest(".cws");
    if (!el || el.scrollWidth <= el.clientWidth || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
    e.preventDefault();
    el.scrollLeft += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  },
  { passive: false },
);
// A mouse without horizontal wheel needs a visible way along the strip: one click moves a page, minus the two fades.
cap.addEventListener("click", (e) => {
  const a = e.target.closest("[data-cws]");
  if (!a) return;
  const el = a.parentElement.querySelector(".cws");
  const step = (el.clientWidth - 64) * (a.dataset.cws === "prev" ? -1 : 1);
  el.scrollBy({ left: step, behavior: reduceMotion.matches ? "auto" : "smooth" });
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act], [data-tab], [data-open], [data-q], [data-sg], [data-recent], [data-st], [data-pick]");
  if (!t || !t.closest("#app, .cap")) return;
  if (t.dataset.q) return onQ(t.dataset.q, t);
  if (t.dataset.st) return t.dataset.st === "open" ? openStatus() : t.dataset.st === "close" ? closeStatus() : reloadConfig();
  if (t.dataset.pick) return setTheme(t.dataset.pick);
  if (t.dataset.sg != null) {
    ui.search.group = t.dataset.sg && t.dataset.sg !== ui.search.group ? t.dataset.sg : null;
    ui.tabJump = true;
    return render();
  }
  if (t.dataset.recent != null) {
    const { chips, rest } = takeChips(t.dataset.recent, true);
    qIn.value = rest;
    setQuery(rest, chips);
    return qIn.focus();
  }
  const act = t.dataset.act;
  const c = conv(t.dataset.conv || t.closest("[data-conv]")?.dataset?.conv);
  const id = t.dataset.item;
  if (act === "tx" && c) return openTx(c, curHit() || topVisibleItem(), `.r-dock [data-act="tx"]`);
  if (act === "old") {
    ui.old.add(id);
    return render();
  }
  if (act === "jump" && c) {
    const run = streamRows(c).find((r) => r.k === "older" && r.items.some((i) => i.id === id));
    if (run) ui.old.add(run.items[0].id);
    ui.jump = id;
    return render();
  }
  if (act === "sum") {
    ui.sumOpen = !ui.sumOpen;
    return render();
  }
  if (act === "unfold") return setFold(false);
  if (act === "clearall") return clearAll(t.dataset.bucket);
  if (act === "done" && c) return done(c);
  if (act === "mute" && c) return mute(c);
  if (act === "restore" && c) return restore(c);
  if (act === "unread" && c) {
    setS(c, { seenAt: new Date(lastMs(c) - 1).toISOString() });
    ui.snap[c.id] = new Set([lastItem(c).id]);
    return render();
  }
  if (act === "close") return select(null);
  if (t.dataset.tab) {
    ui.flash = ui.tab !== t.dataset.tab;
    if (ui.flash) ui.tabJump = true;
    ui.tab = t.dataset.tab;
    return select(null);
  }
  if (t.dataset.open !== undefined && c) return searching() ? openResult(c) : select(ui.selected === c.id ? null : c);
});

document.addEventListener("keydown", (e) => {
  if (tx) return txKey(e);
  if (ui.status && e.key === "Escape") {
    e.preventDefault();
    return closeStatus();
  }
  if (ui.search && e.key === "Escape" && !e.isComposing) {
    e.preventDefault();
    return leaveSearch();
  }
  if (e.target === qIn) {
    if (e.key === "Backspace" && !e.isComposing && !qIn.value && ui.search.chips.length) {
      e.preventDefault();
      return setQuery("", ui.search.chips.slice(0, -1));
    }
    if (e.key === "Enter" && !e.isComposing) {
      syncField(true);
      if (shown()[0]) openResult(shown()[0].c);
    }
    return;
  }
  if (e.target.matches?.(".sv-seg button") && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    e.preventDefault();
    return setTheme(THEMES[(THEMES.indexOf(themePref()) + (e.key === "ArrowRight" ? 1 : 2)) % 3], true);
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, select, textarea")) return;
  if (e.key === "/") {
    e.preventDefault();
    return openSearch();
  }
  if (e.key === "Enter" && e.target.matches?.(".row")) return e.target.click();
  if (ui.status) return;
  if (e.key === "Escape" && ui.selected) return select(null);
  if (e.key === "j") step(1);
  else if (e.key === "k") step(-1);
  else if (e.key === "e" && ui.selected) {
    const c = conv(ui.selected);
    if (!isHidden(c)) done(c);
  }
});

addEventListener("resize", () => {
  if (isFull(last?.form || "full")) root.style.setProperty("--cap-h", `${$(".cap").offsetHeight}px`);
});

new EventSource("/__reload").onmessage = () => location.reload();
load();
