const LS = "weir.proto.";
const CLEARED = "__cleared";
const UNTAGGED = "__untagged";
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const GLIDE = "cubic-bezier(0.32, 0.72, 0, 1)";
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "qq.com", "163.com", "126.com", "icloud.com", "me.com", "yahoo.com"]);
// Each user tag owns one hue in config order; Untagged stays neutral. style.css turns it into a tone.
const HUES = [262, 200, 150, 75, 330, 20];
const STATE_NAMES = { open: "Open", resolved: "Resolved", fyi: "FYI" };
const broken = { source: false, config: false, ...JSON.parse(localStorage.getItem(LS + "dev.break") || "{}") };
// Dev switcher: how far Digest earlier reaches back, one model call ("step") or the whole gap ("run").
let earlierMode = localStorage.getItem(LS + "dev.earlier") === "run" ? "run" : "step";

let data, source, storeKey, itemById, me, views;
// convId -> { seenSeq, clearedSeq, muted }
let state = {};
const ui = {
  tab: null,
  selected: null,
  // Per open conversation; onLeave resets them.
  shape: new Map(), // digest id -> "row" | "card", overriding read-as-row, unread-as-card
  earlier: false, // the "N earlier digests" fold opened
  unf: new Set(), // topics (digestId:index) unfolded into their originals
  long: new Set(), // original bodies shown past their clamp
  fold: false, // header folded into its one-line bar
  jump: null, // seq to scroll to and flash after the next paint
  snap: {}, // convId -> seenSeq when the conversation was opened
  pending: {}, // convId -> the request ({ kind, ... }) plus { fromSeq, toSeq, n, error? } while its call runs or after it failed
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
  data = await getJson("/data/out/data.json");
  if (!data) {
    document.body.textContent = "Could not load data.";
    return;
  }
  storeKey = "out";
  source = "data/out";
  itemById = Object.fromEntries(data.items.map((i) => [i.id, i]));
  for (const c of data.conversations) c.bySeq = new Map(itemsOf(c).map((i) => [i.seq, i]));
  me = new Set(data.me.addrs.map((a) => a.toLowerCase()));
  views = [...data.tags.map((t, k) => ({ id: t.name, name: t.name, hue: HUES[k % HUES.length] })), { id: UNTAGGED, name: "Untagged" }];
  for (const c of data.conversations) c.views = c.tags.length ? c.tags : [UNTAGGED];
  state = JSON.parse(localStorage.getItem(LS + "state." + storeKey) || "{}");
  initStatus();
  window.weirDev = {
    source,
    simulate,
    reset,
    broken,
    toggleBreak(k) {
      broken[k] = !broken[k];
      localStorage.setItem(LS + "dev.break", JSON.stringify(broken));
      window.dispatchEvent(new Event("weirdev"));
      render();
    },
    get earlier() {
      return earlierMode;
    },
    toggleEarlier() {
      earlierMode = earlierMode === "step" ? "run" : "step";
      localStorage.setItem(LS + "dev.earlier", earlierMode);
      window.dispatchEvent(new Event("weirdev"));
      render();
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
const itemAt = (c, seq) => c.bySeq.get(seq);
const lastItem = (c) => itemsOf(c).at(-1);
const lastIso = (c) => lastItem(c)?.occurredAt || c.lastAt;
const lastMs = (c) => Date.parse(lastIso(c));
const lastSeq = (c) => lastItem(c)?.seq || 0;
const seenSeq = (c) => S(c).seenSeq ?? c.seenSeq;
const isUnread = (c) => lastSeq(c) > seenSeq(c);
const isCleared = (c) => S(c).clearedSeq != null && lastSeq(c) <= S(c).clearedSeq;
const isHidden = (c) => !!S(c).muted || isCleared(c);
const isMe = (p) => me.has(p.addr.toLowerCase());
const tagName = (id) => views.find((t) => t.id === id)?.name || id;
const tagsOf = (c) => views.filter((t) => c.views.includes(t.id)).map((t) => t.id);
const tint = (id) => {
  const h = views.find((t) => t.id === id)?.hue;
  return h == null ? "--bh:0;--bk:0" : `--bh:${h};--bk:1`;
};
// A conversation wears the hue of the tag you are looking at it through, or its first tag.
const homeTag = (c) => (c.views.includes(ui.tab) ? ui.tab : tagsOf(c)[0]);
const convTint = (c) => tint(homeTag(c));

// Digests of a conversation never overlap, so every one of them is shown, in seq order.
const shownDigests = (c) => data.digests.filter((d) => d.conversationId === c.id).sort((a, b) => a.fromSeq - b.fromSeq);
const floorOf = (c) => Math.max(0, ...shownDigests(c).map((d) => d.toSeq));
// What the next auto digest counts toward the threshold (contract §3): text from the first message after the last digest
// that arrived on or after since. null when no tag of the conversation has AI on.
function autoChars(c) {
  if (!c.since) return null;
  const start = itemsOf(c).find((i) => i.seq > floorOf(c) && Date.parse(i.occurredAt) >= Date.parse(c.since));
  return start ? itemsOf(c).filter((i) => i.seq >= start.seq).reduce((n, i) => n + i.bodyNew.length, 0) : 0;
}

// The conversation as chapters (one per shown digest) and raw runs between or after them; the last raw run is the tail.
function segments(c) {
  const its = itemsOf(c);
  const out = [];
  let k = 0;
  for (const d of shownDigests(c)) {
    const gap = [];
    while (k < its.length && its[k].seq < d.fromSeq) gap.push(its[k++]);
    if (gap.length) out.push({ items: gap });
    const ch = [];
    while (k < its.length && its[k].seq <= d.toSeq) ch.push(its[k++]);
    out.push({ d, items: ch });
  }
  const tail = its.slice(k);
  if (tail.length || ui.pending[c.id]?.kind === "now") out.push({ items: tail, tail: true });
  return out;
}

function sections() {
  const out = views.map((t) => ({ id: t.id, name: t.name, convs: [] }));
  for (const c of data.conversations) {
    if (isHidden(c)) continue;
    for (const s of out) if (c.views.includes(s.id)) s.convs.push(c);
  }
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
  ui.snap[c.id] = seenSeq(c);
  if (isUnread(c)) setS(c, { seenSeq: lastSeq(c) });
}

function onLeave(id) {
  delete ui.snap[id];
  ui.shape.clear();
  ui.unf.clear();
  ui.earlier = false;
  ui.long.clear();
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
const plural = (n, one, many = one + "s") => `${n.toLocaleString("en")} ${n === 1 ? one : many}`;
const ME = "Me";
const short = (p) => (isMe(p) ? ME : (p.name || p.addr.split("@")[0]).split(/\s+/)[0]);
const whoList = (names, max) => (names.length > max ? `${names.slice(0, max).join(", ")} +${names.length - max}` : names.join(", "));
const pad = (n) => String(n).padStart(2, "0");
const srcApp = (i) => String(i.sourceLabel).split("·")[0].trim();
const seqSpan = (a, b) => (a === b ? `#${a}` : `#${a}–#${b}`);
function timeSpan(items) {
  const a = items[0]?.occurredAt;
  const b = items.at(-1)?.occurredAt;
  if (!a) return "";
  if (a === b) return abs(a);
  return dayKey(a) === dayKey(b) ? `${day(a)} ${hm(a)}–${hm(b)}` : `${abs(a)} – ${abs(b)}`;
}

// One per distinct sender address.
function participants(c) {
  const by = new Map();
  for (const i of itemsOf(c)) if (!by.has(i.from.addr.toLowerCase())) by.set(i.from.addr.toLowerCase(), short(i.from));
  return [...by.values()];
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

const plainWidget = (id, name, n, on) => `<button class="w w-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${id}" aria-pressed="${on}"><span class="w-u">${esc(name)}</span> <span class="w-n">${n}</span></button>`;

// User tags with unread lead, then Untagged; Cleared closes the tail line and never counts as an update.
function fullHtml(tags, active) {
  const hot = tags.filter((s) => s.unread);
  const quiet = tags.filter((s) => !s.unread && s.convs.length);
  const empty = tags.filter((s) => !s.convs.length && s.id !== UNTAGGED);
  const main = hot.length ? enumerate(hot.map((s) => widgetHtml(s, "main", active)), "", glue(` ${verb(hot.length, "has", "have")} updates.`, "glue end")) : glue("All caught up.", "allclear");
  const tail = [];
  if (quiet.length) tail.push(`<span class="cl">${enumerate(quiet.map((s) => widgetHtml(s, "tail", active)), glue("Read but not done: ", "glue lead"), glue(".", "glue end"))}</span>`);
  if (empty.length) tail.push(`<span class="cl">${enumerate(empty.map((s) => widgetHtml(s, "empty", active)), "", glue(` ${verb(empty.length, "is", "are")} clear.`, "glue end"))}</span>`);
  const ends = [plainWidget(CLEARED, "Cleared", clearedList().length, active === CLEARED)];
  tail.push(`<span class="cl">${enumerate(ends, "", glue(".", "glue end"))}</span>`);
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

// Compact form keeps tag order so a widget never changes place while counts move under it.
function pillHtml(secs, active) {
  const on = active === CLEARED;
  const n = clearedList().length;
  const cl = `<button class="cw cw-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${CLEARED}" aria-pressed="${on}" title="Cleared conversations"><span class="cw-name">Cleared</span><span class="w-n">${n}</span></button>`;
  const arrow = (d) => `<button class="cws-a ${d}" data-cws="${d}" tabindex="-1" aria-label="Scroll tags ${d === "prev" ? "left" : "right"}">${CHEV(d)}</button>`;
  return `<button class="cw cw-q" data-q="open" aria-label="Search" title="Search (/)">${Q_ICON}</button><span class="cap-div"></span><span class="cws-w"><span class="cws">${secs.map((s) => chipHtml(s, active)).join("")}</span>${arrow("prev")}${arrow("next")}</span><span class="cap-div"></span>${cl}${statusBtn("cw cw-st")}`;
}

// The notch's shape follows (reading, search): the sentence over the empty reader, a pill over a conversation. Searching,
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

/* The pill's tag strip scrolls on its own between the fixed search and status ends. Each paint rebuilds it, so it
   keeps its offset; it centers the active chip only when what you are looking at moved (tag, conversation, or the
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

// The row says where the conversation stands: the newest digest's headline when it reaches the last message, else the
// last message itself.
function preview(c) {
  const last = lastItem(c);
  const d = shownDigests(c).at(-1);
  if (d && d.toSeq >= last.seq) return d.headline;
  return `${short(last.from)}: ${plain(last.bodyNew).slice(0, 160) || "(no text)"}`;
}

function rowHtml(c) {
  const unread = isUnread(c);
  const its = itemsOf(c);
  const fresh = unread ? lastSeq(c) - seenSeq(c) : 0;
  const apps = [...new Set(its.map(srcApp))];
  const inCleared = ui.tab === CLEARED;
  const who = participants(c);
  const whoTxt = whoList(who, 2);
  const from = [...its].reverse().find((i) => !isMe(i.from))?.from || its.at(-1).from;
  const tail = inCleared
    ? `<span class="row-badge">${S(c).muted ? "Muted" : "Done"}</span><button class="row-act restore" data-act="restore">Restore</button>`
    : `<button class="row-act" data-act="done" title="Done. It leaves the list until something new arrives.">Done</button>`;
  return `<article class="row ${unread ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-k="r-${c.id}" data-conv="${c.id}" data-open tabindex="0" aria-current="${ui.selected === c.id}" style="${convTint(c)}">
    <span class="row-av">${avatarHtml(from)}</span>
    <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
    <span class="row-line">${esc(preview(c))}</span>
    <span class="row-meta"><span class="row-who" title="${esc(who.join(", "))}">${esc(whoTxt)}</span><span class="row-n">${plural(its.length, "message")}${fresh ? `, ${fresh} new` : ""} · ${esc(apps.join(" · "))}</span></span>
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
  const head = `<div class="l-head" style="${tint(cur.id)}"><h2 class="l-name">${esc(cur.name)}</h2><span class="l-meta">${plural(cur.convs.length, "conversation")}${cur.unread ? ` · ${cur.unread} unread` : cur.convs.length ? " · all read" : ""}</span>${cur.convs.length ? `<button class="clearall" data-act="clearall" data-tag="${cur.id}">Clear all</button>` : ""}</div>`;
  return head + (cur.convs.length ? `<div class="rows">${cur.convs.map(rowHtml).join("")}</div>` : `<div class="empty"><p class="empty-big">${esc(cur.name)} is clear.</p><p class="empty-sub">New messages bring a conversation back here as unread.</p></div>`);
}

// With nothing open the reader never repeats the list; it shows sync status instead.
function emptyReaderHtml(secs) {
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
  rows.push(line(stopped ? "held" : "", "Digests", stopped ? "Stopped" : waiting ? `${plural(waiting, "conversation")} waiting` : "Caught up"));
  const alert = stopped ? `<p class="es-alert">Sync and digests stopped. The config did not load.</p>` : "";
  const open = statusAlert() ? `<button class="es-open" data-st="open">Open Status</button>` : "";
  return `<div class="calm es ${statusAlert() ? "warn" : ""}" ${cur ? `style="${tint(cur.id)}"` : ""}>${alert}<ul class="es-rows" aria-label="Sync">${rows.join("")}</ul>${open}</div>`;
}

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
const srcOf = (c) => srcApp(itemsOf(c)[0]);

const TIME_GAP = 5 * 60 * 1000;

// In a group chat everyone shares one org favicon, so people who share a domain get their own monogram instead.
function sharedDomains(c) {
  const addrs = new Map();
  for (const i of itemsOf(c)) addrs.set(i.from.addr.toLowerCase(), orgDomain(i.from.addr));
  const per = new Map();
  for (const d of addrs.values()) per.set(d, (per.get(d) || 0) + 1);
  return new Set([...per].filter(([, n]) => n > 1).map(([d]) => d));
}

/* The stream. Blocks that stand for messages carry data-seqs (the exact messages) and data-u (the kind of block): when a
   digest lands, the tail's originals fold into the topics that cite them through that mapping. Blocks that move when
   something above them opens carry data-k, so they slide instead of jump. */
const seqAttr = (seqs, u) => `data-seqs="${seqs.join(" ")}" data-u="${u}"`;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
const stateMark = (s) => `<i class="tsm tsm-${s}">${STATE_NAMES[s] || s}</i>`;
const tpKey = (d, ti) => `${d.id}:${ti}`;
const CHEV_D = `<svg class="cv" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4"/></svg>`;
const ARR_U = `<svg class="ar" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/></svg>`;
const ARR_D = `<svg class="ar" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/></svg>`;

function streamHtml(c) {
  const r = curResult();
  const seen = ui.snap[c.id] ?? seenSeq(c);
  const cx = {
    c,
    seen,
    n: lastSeq(c) - seen,
    marked: false,
    shared: sharedDomains(c),
    terms: r ? qTerms() : [],
    hits: r ? new Set(r.items.map((id) => itemById[id].seq)) : null,
    cur: r && curHit() ? itemById[curHit()].seq : null,
  };
  const segs = segments(c);
  const read = segs.filter((s) => s.d && s.d.toSeq <= seen);
  // A digest open as a card, one that just landed included, stays out of the fold.
  const fold = read.length > 4 && !ui.earlier ? read.slice(0, -4).filter((s) => ui.shape.get(s.d.id) !== "card") : [];
  const out = [];
  for (const s of segs) {
    if (fold.includes(s)) {
      if (s === fold[0]) out.push(earlierHtml(fold));
      continue;
    }
    if (s.d) out.push((ui.shape.get(s.d.id) ?? (s.d.toSeq <= seen ? "row" : "card")) === "row" ? digestRowHtml(cx, s) : cardHtml(cx, s));
    else if (s.tail) out.push(tailHtml(cx, s));
    else out.push(rawRunHtml(cx, s.items, s.items.at(-1).seq) + upBarHtml(cx, s));
  }
  return out.join("");
}

/* The bottom edge of a gap, where scrolling up from newer content arrives: what is still undigested above, and Digest
   earlier, the tail's Digest now mirrored. Its mark is the gap's first seq, which stays put while the gap shrinks from
   the bottom, so the bar keeps its place through the landing. */
function upBarHtml(cx, s) {
  const c = cx.c;
  const n = s.items.length;
  const req = { kind: "earlier", upTo: s.items.at(-1).seq };
  const [a, b] = reqRange(c, req);
  const p = ui.pending[c.id];
  const mine = p?.kind === "earlier" && p.upTo === req.upTo ? p : null;
  const at = `data-mk="ge-${s.items[0].seq}" data-up="${req.upTo}"`;
  if (mine?.error) return `<div class="tl-h ge err" ${at} role="alert"><span class="tl-k">Couldn't digest ${plural(mine.n, "message")}</span><span class="tl-e" title="${esc(mine.error)}">${esc(mine.error)}</span><button class="gp-go" data-act="dup" data-seq="${req.upTo}">Try again</button></div>`;
  const k = b - a + 1;
  return `<div class="tl-h ge" ${at}><span class="tl-k">Not digested</span><span class="tl-n">${plural(n, "message")} above</span><button class="gp-go ${mine ? "on" : ""}" data-act="dup" data-seq="${req.upTo}" data-pv="${a}-${b}" ${p && !p.error ? "disabled" : ""}>${ARR_U}${mine ? "Digesting…" : k < n ? `Digest ${k} earlier` : "Digest earlier"}</button></div>`;
}

// Last read sits before the first block that stands for a message newer than what was seen on opening.
function lrHtml(cx, seqs) {
  if (cx.marked || cx.n <= 0 || !seqs.length || Math.max(...seqs) <= cx.seen) return "";
  cx.marked = true;
  return `<div class="lr" role="separator" data-mk="lr" data-k="lr"><span><b>${cx.seen === 0 ? "All new from here" : "Last read"}</b>${cx.n} new</span></div>`;
}

const metaBits = (s) => [timeSpan(s.items), plural(s.items.length, "message")];

function earlierHtml(segs) {
  const a = segs[0].items[0]?.occurredAt;
  const b = segs.at(-1).items.at(-1)?.occurredAt;
  const span = a && b ? (day(a) === day(b) ? day(a) : `${day(a)} – ${day(b)}`) : "";
  const n = segs.reduce((k, s) => k + s.items.length, 0);
  return `<button class="older" data-act="earlier" data-k="older"><span class="o-n">${plural(segs.length, "earlier digest")}</span><span class="o-span">${span} · ${plural(n, "message")}</span><span class="o-go">Show</span></button>`;
}

// A digest as one quiet row (read ones by default, unread ones once collapsed); clicking it opens the full card in place.
function digestRowHtml(cx, s) {
  const d = s.d;
  return `${lrHtml(cx, range(d.fromSeq, d.toSeq))}<button class="rr" data-act="rr" data-ch="${d.id}" data-k="d-${d.id}" data-mk="h-${d.id}" aria-expanded="false"><span class="rr-m">${metaBits(s).join(" · ")}${d.trigger === "manual" ? " · Manual" : ""}</span><span class="rr-t">${hl(d.headline, cx.terms)}</span></button>`;
}

function cardHtml(cx, s) {
  const d = s.d;
  const read = d.toSeq <= cx.seen;
  const solo = d.topics.length === 1;
  const pin = solo && ui.unf.has(tpKey(d, 0));
  const meta = d.fromSeq === d.toSeq ? "" : `<p class="dc-m">${metaBits(s).map((b) => `<span>${b}</span>`).join("")}${d.trigger === "manual" ? `<span class="dc-man">Manual</span>` : ""}</p>`;
  const x = `<button class="dc-x" data-act="rrx" data-ch="${d.id}">Collapse</button>`;
  const p = ui.pending[cx.c.id];
  const mine = p?.kind === "redo" && p.id === d.id;
  const redo = `<button class="dc-redo" data-act="redo" data-ch="${d.id}" title="Digest this range again with the current prompt and model" ${p && !p.error ? "disabled" : ""}>${mine && !p.error ? "Redoing…" : "Redo"}</button>`;
  const err = mine && p.error ? `<p class="dc-err" role="alert" title="${esc(p.error)}">Couldn't redo. ${esc(p.error)}</p>` : "";
  const head = `<header class="dc-h ${pin ? "pin" : ""}" data-mk="h-${d.id}">${meta}<div class="dc-hl"><h3 class="dc-t">${hl(d.headline, cx.terms)}</h3>${pin ? pinX(tpKey(d, 0)) : ""}${x}${redo}</div>${err}</header>`;
  const tps = d.topics.map((t, ti) => topicHtml(cx, d, t, ti, solo)).join("");
  return `${lrHtml(cx, range(d.fromSeq, d.toSeq))}<section class="dc ${read ? "read" : ""} ${solo ? "solo" : ""} ${mine && !p.error ? "redoing" : ""}" data-k="d-${d.id}" data-ch="${d.id}" ${mine && !p.error ? 'aria-busy="true"' : ""}>${head}<div class="tps">${tps}</div></section>`;
}

const pinX = (key) => `<span class="pin-r"><span class="pin-n" aria-live="off"></span><button class="pin-x" data-act="unf" data-tp="${esc(key)}" aria-label="Fold the originals back">Fold<svg class="cv" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 10l4-4 4 4"/></svg></button></span>`;

/* A topic: title and state, what happened, then its originals behind a disclosure. Unfolded, the originals open right
   under it and the title pins to the top of the reader while you read through them. A one-topic digest skips the title:
   the headline already names it, so the card's head pins instead. */
function topicHtml(cx, d, t, ti, solo) {
  const key = tpKey(d, ti);
  const open = ui.unf.has(key);
  const head = solo ? "" : `<header class="tp-h ${open ? "pin" : ""}">${stateMark(t.state)}<h4 class="tp-t">${hl(t.title, cx.terms)}</h4>${open ? pinX(key) : ""}</header>`;
  const its = t.seqs.map((q) => itemAt(cx.c, q)).filter(Boolean);
  const who = [...new Map(its.map((i) => [i.from.addr.toLowerCase(), i.from])).values()];
  const avs = who.slice(0, 3).map((p) => avatarHtml(p, cx.shared.has(orgDomain(p.addr)))).join("");
  const btn = `<button class="tp-o ${open ? "on" : ""}" data-act="unf" data-tp="${esc(key)}" aria-expanded="${open}" title="${esc(who.map(short).join(", "))}"><span class="tp-av" aria-hidden="true">${avs}</span>${plural(t.seqs.length, "original")}${who.length > 3 ? `<span class="tp-n">· ${plural(who.length, "person", "people")}</span>` : ""}${CHEV_D}</button>`;
  const items = open ? its : [];
  return `<section class="tp ${open ? "open" : ""} ${solo ? "solo" : ""}" data-k="tp-${esc(key)}" data-tp="${esc(key)}" ${seqAttr(t.seqs, "tp")}>${head}<p class="tp-b">${hl(t.body, cx.terms)}</p>${btn}${open ? `<div class="unf">${rawRunHtml({ ...cx, marked: true }, items)}</div>` : ""}</section>`;
}

function bodyHtml(i) {
  const open = ui.long.has(i.id);
  return `<div class="body clip ${open ? "open" : ""}">${i.bodyNew.trim() ? originalMd(i.bodyNew) : `<p class="b-none">(no text)</p>`}</div><button class="more" data-act="long" data-item="${i.id}" aria-expanded="${open}">${open ? "Show less" : "Show all"}</button>`;
}

/* Original bubbles in final's grouping: one sender, no pause of 5 minutes, one group. end is the last seq of the
   undigested run they belong to, so each bubble offers Digest from here; originals unfolded under a topic pass none. */
function rawRunHtml(cx, items, end = null) {
  const out = [];
  let g = null;
  let prevDay = null;
  const flush = () => {
    if (!g) return;
    const f = g.items[0].from;
    const av = `<span class="g-av">${avatarHtml(f, cx.shared.has(orgDomain(f.addr)))}</span>`;
    const col = `<div class="g-col"><div class="g-head"><b title="${esc(f.addr)}">${esc(f.name || f.addr)}</b><time datetime="${esc(g.at)}" title="${esc(abs(g.at))}">${hm(g.at)}</time></div>${g.items.map((i) => rawHtml(cx, i, end)).join("")}</div>`;
    out.push(`<section class="sg ${g.me ? "me" : ""}">${g.me ? col + av : av + col}</section>`);
    g = null;
  };
  for (const i of items) {
    if (dayKey(i.occurredAt) !== prevDay && prevDay !== null) {
      flush();
      out.push(`<div class="day" role="separator"><span>${dayLabel(i.occurredAt)}</span></div>`);
    }
    prevDay = dayKey(i.occurredAt);
    const lr = lrHtml(cx, [i.seq]);
    if (lr) {
      flush();
      out.push(lr);
    }
    const prev = g?.items.at(-1);
    if (!prev || prev.from.addr.toLowerCase() !== i.from.addr.toLowerCase() || Date.parse(i.occurredAt) - Date.parse(prev.occurredAt) >= TIME_GAP) {
      flush();
      g = { me: isMe(i.from), at: i.occurredAt, items: [] };
    }
    g.items.push(i);
  }
  flush();
  return out.join("");
}

// Digest from here floats over the bubble's top corner, so revealing it never moves a bubble.
function rawHtml(cx, i, end) {
  const r = curResult();
  const hit = r?.byItem.get(i.id);
  const cur = cx.cur === i.seq;
  const f = hit && ["from", "source"].find((k) => hit.some((x) => x.f === k)) && !hit.some((x) => x.f === "body");
  const tag = f ? `<span class="bh" title="Matched in ${FIELD[f]}">${FIELD[f]}</span>` : "";
  const p = ui.pending[cx.c.id];
  const run = p && !p.error && (p.kind === "here" || p.kind === "earlier");
  const busy = run && p.fromSeq <= i.seq && i.seq <= p.toSeq;
  const mine = p?.kind === "here" && p.fromSeq === i.seq ? p : null;
  const label = mine && !p.error ? "Digesting…" : end === i.seq ? "Digest this message" : `Digest ${end - i.seq + 1} from here`;
  const here = end == null ? "" : `<span class="dfh-w"><button class="dfh ${mine && !p.error ? "on" : ""}" data-act="dfh" data-seq="${i.seq}" data-pv="${i.seq}-${end}" ${p && !p.error ? "disabled" : ""}>${ARR_D}${label}</button></span>`;
  const err = mine?.error ? `<p class="dfh-e" role="alert"><span title="${esc(mine.error)}">Couldn't digest ${plural(mine.n, "message")}. ${esc(mine.error)}</span><button class="gp-go" data-act="dfh" data-seq="${i.seq}">Try again</button></p>` : "";
  return `<div class="bl ${here ? "dg" : ""} ${busy ? "busy" : ""}" ${seqAttr([i.seq], "raw")}><div class="bb raw ${hit ? "hit" : ""} ${cur ? "cur" : ""}" data-item="${i.id}">${bodyHtml(i)}</div>${tag}${here}</div>${err}`;
}

// The undigested tail: how close it is to the next auto digest, a way to digest it now, then its originals.
function tailHtml(cx, s) {
  const c = cx.c;
  const p = ui.pending[c.id]?.kind === "now" ? ui.pending[c.id] : null;
  const n = s.items.length;
  const chars = autoChars(c);
  const thr = data.digest.threshold;
  let head;
  if (p && !p.error) {
    const bar = (w, cls = "") => `<span class="sk-b ${cls}" style="--w:${w}"></span>`;
    const topic = (a, b, z) => `<div class="sk-tp"><span class="sk-s"></span><div>${bar(a, "sk-tt")}${bar(b)}${bar(z)}</div></div>`;
    head = `<div class="dc sk" data-mk="sk" role="status" aria-live="polite"><p class="sk-l"><span class="sk-dot" aria-hidden="true"></span>Digesting ${plural(p.n, "message")}${p.kind === "auto" ? " automatically" : ""}…</p><div aria-hidden="true">${bar("64%", "sk-h")}${topic("30%", "92%", "58%")}${topic("24%", "84%", "40%")}</div></div>`;
  } else if (p?.error) {
    head = `<div class="tl-h err" data-mk="tl" role="alert"><span class="tl-k">Couldn't digest ${plural(p.n, "message")}</span><span class="tl-e" title="${esc(p.error)}">${esc(p.error)}</span><button class="tl-go" data-act="dnow">Try again</button></div>`;
  } else {
    const meter = chars == null ? "" : `<span class="tl-n">${chars.toLocaleString("en")} of ${thr.toLocaleString("en")}</span><span class="tl-m" role="meter" aria-label="Characters toward the next digest" aria-valuemin="0" aria-valuemax="${thr}" aria-valuenow="${chars}" style="--p:${Math.min(1, chars / thr)}"><i></i></span>`;
    const [a, b] = reqRange(c, { kind: "now" });
    head = `<div class="tl-h" data-mk="tl"><span class="tl-k">Not digested</span>${meter}<button class="tl-go" data-act="dnow" data-pv="${a}-${b}">Digest now</button></div>`;
  }
  return `<section class="tl ${p && !p.error ? "busy" : ""}" data-k="tl">${head}${n ? rawRunHtml(cx, s.items, lastSeq(c)) : ""}</section>`;
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
  const last = lastItem(c);
  if (last?.link) acts.push(`<a class="ext" href="${esc(last.link)}" target="_blank" rel="noreferrer">Open in ${esc(srcApp(last))}${EXT_ICON}</a>`);
  return `<div class="r-dock" data-conv="${c.id}" style="${convTint(c)}">${acts.join("")}</div><button class="r-x" data-act="close" title="Close (Esc)" aria-label="Close">${X_ICON}</button>`;
}

/* The header pinned under the notch: where the conversation lives and its title. Folded, it retracts into the notch's
   band and leaves a one-line bar; the stream scrolls underneath. */
const freshOf = (c) => Math.max(0, lastSeq(c) - (ui.snap[c.id] ?? seenSeq(c)));
function crumbHtml(c) {
  const its = itemsOf(c);
  const fresh = freshOf(c);
  const [first, ...more] = tagsOf(c).sort((a, b) => (a === homeTag(c) ? -1 : b === homeTag(c) ? 1 : 0));
  return `<b>${esc(tagName(first))}</b>${more.map((t) => `<span class="tg">${esc(tagName(t))}</span>`).join("")}<span>${esc(srcOf(c))}</span><span>${fresh ? `${fresh} new this time` : "Read"}</span><span>${plural(its.length, "message")} · ${plural(participants(c).length, "person", "people")}</span><span>${day(its[0]?.occurredAt || c.firstAt)} – ${day(lastIso(c))}</span>`;
}
const barMeta = (c) => (freshOf(c) ? `${freshOf(c)} new` : plural(itemsOf(c).length, "message"));
function ctxHtml(c) {
  const T = curResult() ? qTerms() : [];
  return `<div class="ctx ${ui.fold ? "fold" : ""}">
    <div class="ctx-full">
      <p class="r-crumb">${crumbHtml(c)}</p>
      <h2 class="r-title">${hl(c.title, T)}</h2>
    </div>
    <div class="ctx-bar"><button class="cb-main" data-act="unfold" tabindex="${ui.fold ? 0 : -1}" aria-label="Show header"><span class="cb-dot"></span><b>${esc(c.title)}</b><span class="cb-meta">${barMeta(c)}</span></button></div>
  </div>`;
}

function readerHtml(c) {
  return `<div class="conv" data-conv="${c.id}" style="${convTint(c)}">${ctxHtml(c)}<div class="st"><div class="st-in">${streamHtml(c)}</div></div></div>`;
}

// After the stream's HTML lands: clamp long originals, mark search terms inside them.
function afterStream() {
  const inner = $(".st-in");
  if (!inner) return;
  for (const b of inner.querySelectorAll(".body.clip:not(.open)")) b.classList.toggle("over", b.scrollHeight > b.clientHeight + 2);
  if (curResult()) for (const b of inner.querySelectorAll(".body")) markDom(b, qTerms());
}

function paintStream() {
  const c = ui.selected && conv(ui.selected);
  const inner = $(".st-in");
  if (!c || !inner) return;
  inner.innerHTML = streamHtml(c);
  $(".r-crumb").innerHTML = crumbHtml(c);
  $(".cb-meta").textContent = barMeta(c);
  afterStream();
  markStuck($(".st"));
}

function setFold(f) {
  ui.fold = f;
  $(".ctx")?.classList.toggle("fold", f);
  $(".cb-main")?.setAttribute("tabindex", f ? "0" : "-1");
  $(".st")?.style.setProperty("--vis", f ? "var(--bar-h)" : "var(--ctx-h)");
}

/* A pinned head is stuck once it has left its own section's top: then it gets a ground, its Fold button and where you
   are among the topic's originals. */
function markStuck(st) {
  if (!st) return;
  for (const h of st.querySelectorAll(".pin")) {
    const r = h.getBoundingClientRect();
    const stuck = r.top - h.parentElement.getBoundingClientRect().top > 1;
    h.classList.toggle("stuck", stuck);
    if (!stuck) continue;
    const bls = [...h.parentElement.querySelectorAll(".unf .bl")];
    const at = bls.findIndex((b) => b.getBoundingClientRect().bottom > r.bottom + 8);
    h.querySelector(".pin-n").textContent = bls.length < 2 ? "" : `${at < 0 ? bls.length : at + 1} of ${bls.length}`;
  }
}

// Scrolling down into the stream folds the header; reaching the top again unfolds it.
let lastY = 0;
let down = 0;
// A morph moves the scroll position to keep your place; that is not you scrolling, so it neither folds nor unfolds.
let quietUntil = 0;
function onStreamScroll(e) {
  const y = e.currentTarget.scrollTop;
  markStuck(e.currentTarget);
  if (performance.now() < quietUntil) return void (lastY = y);
  if (y <= 8) {
    if (ui.fold) setFold(false);
    down = 0;
  } else if (y > lastY) {
    down += y - lastY;
    if (!ui.fold && down > 24) setFold(true);
  } else down = 0;
  lastY = y;
}

const topIn = (st, el) => el.getBoundingClientRect().top - st.getBoundingClientRect().top;
// How much of the stream's top the header (or its folded bar) covers.
const cardH = () => (ui.fold ? $(".ctx-bar").offsetHeight + 12 : $(".ctx-full").offsetHeight);
const seqsOf = (el) => el.dataset.seqs.split(" ").map(Number);
// The block that shows message q: its own original if one is on screen, else whatever stands for it.
function unitFor(st, q) {
  const own = st.querySelector(`.bl[data-u="raw"][data-seqs="${q}"]`);
  return own || [...st.querySelectorAll("[data-seqs]")].find((el) => seqsOf(el).includes(q));
}
const ringOf = (el) => (el.matches(".bl") ? el.querySelector(".bb") : el);

// Scroll message q in under the folded header (and under its topic's pinned head), then ring it once.
function jumpTo(q, smooth) {
  const st = $(".st");
  const el = st && unitFor(st, q);
  if (!el) return;
  setFold(true);
  const pin = el.matches(".bl") ? el.closest(".tp.open")?.querySelector(".tp-h.pin") || el.closest(".dc.solo")?.querySelector(".dc-h.pin") : null;
  st.scrollTo({ top: st.scrollTop + topIn(st, el) - cardH() - (pin?.offsetHeight || 0) - (ui.search ? 44 : 16), behavior: reduceMotion.matches || !smooth ? "auto" : "smooth" });
  lastY = st.scrollTop;
  quietUntil = performance.now() + 700;
  ringOf(el).animate([{ opacity: 1 }, { opacity: 1, offset: 0.5 }, { opacity: 0 }], { pseudoElement: "::after", duration: 1800, easing: "ease-out" });
}

/* After a paint: size the stream under the header, then land, keep or jump. keepTop is the scroll position to keep
   when the same conversation repaints, or null when it was just opened. */
function settleReader(keepTop) {
  const st = $(".st");
  const full = $(".ctx-full");
  const h = full.offsetHeight;
  st.style.setProperty("--ctx-h", `${h}px`);
  // The stream's scrollbar eats into its right inset; the header above has none, so the stream gives that width back.
  st.style.setProperty("--sbw", `${st.offsetWidth - st.clientWidth}px`);
  st.style.setProperty("--bar-h", `${$(".ctx-bar").offsetHeight + 12}px`);
  setFold(ui.fold);
  afterStream();
  if (keepTop != null) st.scrollTop = keepTop;
  else {
    const mark = st.querySelector(".lr");
    st.scrollTop = mark ? Math.max(0, topIn(st, mark) - h - 4) : st.scrollHeight;
  }
  const jump = ui.jump;
  ui.jump = null;
  if (jump != null) jumpTo(jump, ui.jumpSmooth);
  ui.jumpSmooth = false;
  lastY = st.scrollTop;
  down = 0;
  markStuck(st);
  st.addEventListener("scroll", onStreamScroll, { passive: true });
}

/* The landing morph. Every block carries the messages it stands for, so when a digest lands on undigested originals each
   slides into the topic that cites it and fades while the topics rise out of them; blocks that only moved slide (FLIP
   on transform). Reduced motion: a 120ms crossfade, nothing moves. land(), when given, places the scroll
   instead of keeping the first visible message where it was. */
const overlap = (a, b) => a.some((q) => b.includes(q));
const sameSeqs = (a, b) => a.length === b.length && a.every((q, k) => q === b[k]);
let morphing = [];
function morph(mutate, land = null) {
  const st = $(".st");
  const inner = $(".st-in");
  if (!st || !inner) return mutate();
  for (const a of morphing) a.finish?.();
  morphing = [];
  inner.querySelectorAll(".ghost").forEach((g) => g.remove());
  const sr = st.getBoundingClientRect();
  const top = sr.top + cardH();
  const grab = () =>
    [...$(".st-in").querySelectorAll("[data-seqs], [data-mk]")]
      .map((el) => ({ el, r: el.getBoundingClientRect(), seqs: el.dataset.seqs ? seqsOf(el) : null, mk: el.dataset.mk, u: el.dataset.u }))
      .filter((x) => x.r.height && x.r.bottom > top - 80 && x.r.top < sr.bottom + 80);
  const before = grab();
  const anchor = before.find((x) => x.seqs && x.r.bottom > top + 8);
  const oldTop = st.scrollTop;
  const rm = reduceMotion.matches;
  const snapshot = rm ? inner.cloneNode(true) : null;
  mutate();
  if (land) land();
  else if (anchor) {
    const q = anchor.seqs[0];
    const els = [...$(".st-in").querySelectorAll("[data-seqs]")];
    const to = els.find((el) => seqsOf(el).includes(q)) || els.find((el) => seqsOf(el)[0] >= q);
    if (to) st.scrollTop += to.getBoundingClientRect().top - anchor.r.top;
  }
  lastY = st.scrollTop;
  quietUntil = performance.now() + 700;
  down = 0;
  markStuck(st);
  const now = $(".st-in");
  if (rm) {
    const ms = 120;
    snapshot.classList.add("ghost", "xf");
    snapshot.style.top = `${st.scrollTop - oldTop}px`;
    st.append(snapshot);
    morphing.push(snapshot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "linear", fill: "forwards" }));
    morphing.at(-1).finished.then(() => snapshot.remove(), () => snapshot.remove());
    morphing.push(now.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "linear" }));
    return;
  }
  const after = grab();
  const nr = now.getBoundingClientRect();
  const union = (rs) => ({ left: Math.min(...rs.map((r) => r.left)), top: Math.min(...rs.map((r) => r.top)) });
  let born = 0;
  for (const a of after) {
    const src = a.mk ? before.filter((b) => b.mk === a.mk) : before.filter((b) => b.seqs && overlap(b.seqs, a.seqs));
    let anim;
    if (!src.length) {
      anim = a.el.animate([{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: 140 + Math.min(born++, 10) * 18, easing: EASE, fill: "backwards" });
    } else if (src.length === 1 && (a.mk || (src[0].u === a.u && sameSeqs(src[0].seqs, a.seqs)))) {
      const dx = src[0].r.left - a.r.left;
      const dy = src[0].r.top - a.r.top;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      anim = a.el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 560, easing: GLIDE });
    } else {
      const u = union(src.map((b) => b.r));
      anim = a.el.animate([{ opacity: 0, transform: `translate(${u.left - a.r.left}px, ${u.top - a.r.top}px)` }, { opacity: 1, offset: 0.55 }, { opacity: 1, transform: "none" }], { duration: 560, delay: Math.min(born++, 10) * 16, easing: GLIDE, fill: "backwards" });
    }
    morphing.push(anim);
  }
  for (const b of before) {
    const dst = b.mk ? after.filter((a) => a.mk === b.mk) : after.filter((a) => a.seqs && overlap(a.seqs, b.seqs));
    if (dst.length === 1 && (b.mk || (dst[0].u === b.u && sameSeqs(dst[0].seqs, b.seqs)))) continue;
    // The old block lives on as a ghost at its old place, travels to where its messages went, and fades.
    const g = document.createElement("div");
    const sg = b.el.closest(".sg");
    g.className = `ghost ${sg?.classList.contains("me") ? "sg me" : sg ? "sg" : ""}`;
    g.style.cssText = `left:${b.r.left - nr.left}px;top:${b.r.top - nr.top}px;width:${b.r.width}px`;
    g.append(b.el.cloneNode(true));
    now.append(g);
    const u = dst.length ? union(dst.map((a) => a.r)) : null;
    const anim = g.animate(u ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translate(${u.left - b.r.left}px, ${u.top - b.r.top}px) scale(0.98)` }] : [{ opacity: 1 }, { opacity: 0 }], { duration: u ? 460 : 200, easing: u ? GLIDE : "linear", fill: "forwards" });
    anim.finished.then(() => g.remove(), () => g.remove());
    morphing.push(anim);
  }
}

/* The unfold. A topic opens into its originals right under it: the topic holds still, whatever sits below slides down,
   and the originals arrive group by group, each head before its bubbles. Folding plays it back up into the body; folding
   from deep inside the originals lands you on the topic you were in. Reduced motion: a 120ms crossfade. */
let unfolding = null;
function unfold(key, open) {
  const st = $(".st");
  const tp = st?.querySelector(`.tp[data-tp="${CSS.escape(key)}"]`);
  if (!tp || unfolding) return;
  const rm = reduceMotion.matches;
  const stTop = st.getBoundingClientRect().top;
  const head = tp.closest(".dc.solo") || tp;
  const anchor = head.getBoundingClientRect().top;
  const inside = !open && anchor < stTop + cardH();
  const before = new Map([...st.querySelectorAll("[data-k]")].map((el) => [el.dataset.k, el.getBoundingClientRect().top]));
  const paint = () => {
    unfolding = null;
    open ? ui.unf.add(key) : ui.unf.delete(key);
    paintStream();
    const now = st.querySelector(`.tp[data-tp="${CSS.escape(key)}"]`);
    const top = (now.closest(".dc.solo") || now).getBoundingClientRect().top;
    st.scrollTop += inside ? top - (stTop + cardH() + 8) : top - anchor;
    lastY = st.scrollTop;
    quietUntil = performance.now() + 500;
    down = 0;
    markStuck(st);
    const box = now.querySelector(".unf");
    if (rm || inside) return (box || now).animate([{ opacity: 0 }, { opacity: 1 }], { duration: rm ? 120 : 260, easing: rm ? "linear" : EASE });
    now.querySelector(".tp-o .cv")?.animate([{ transform: `rotate(${open ? 0 : 180}deg)` }, { transform: `rotate(${open ? 180 : 0}deg)` }], { duration: 380, easing: EASE });
    const moved = new Map();
    for (const el of st.querySelectorAll("[data-k]")) {
      const b = before.get(el.dataset.k);
      if (b != null) moved.set(el, b - el.getBoundingClientRect().top);
    }
    for (const [el, dy] of moved) {
      const rel = dy - (moved.get(el.parentElement.closest("[data-k]")) || 0);
      if (Math.abs(rel) >= 0.5) el.animate([{ transform: `translateY(${rel}px)` }, { transform: "none" }], { duration: 480, easing: GLIDE });
    }
    if (box) stagger(box, st);
  };
  const box = tp.querySelector(".unf");
  if (open || rm || inside || !box) return paint();
  const vb = st.getBoundingClientRect().bottom;
  const parts = [...box.querySelectorAll(":scope > .sg, :scope > .day")].filter((el) => el.getBoundingClientRect().top < vb);
  const anims = parts.reverse().map((el, k) => el.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-10px)" }], { duration: 200, delay: Math.min(k, 8) * 18, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" }));
  unfolding = Promise.all(anims.map((a) => a.finished)).then(paint, paint);
}

function stagger(box, st) {
  const vb = st.getBoundingClientRect().bottom;
  let k = 0;
  for (const g of box.querySelectorAll(":scope > .sg, :scope > .day")) {
    if (g.getBoundingClientRect().top > vb) break;
    const parts = g.matches(".sg") ? [g.querySelector(".g-av"), g.querySelector(".g-head"), ...g.querySelectorAll(".bl")].filter(Boolean) : [g];
    let b = 0;
    for (const el of parts) el.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 440, delay: 80 + Math.min(k, 10) * 55 + (el.matches(".bl") ? 40 + b++ * 30 : 0), easing: EASE, fill: "backwards" });
    k++;
  }
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
  // Pin the tag, so emptying it leaves you on its clear state instead of jumping to the next tag.
  ui.tab ??= currentSection(secs)?.id;
  const unread = data.conversations.filter((c) => !isHidden(c) && isUnread(c)).length;
  document.title = unread ? `(${unread}) weir` : "weir";
  const sel = !ui.status && ui.selected && conv(ui.selected);
  const reading = !!(sel || ui.status);
  const mode = !!last && last.reading !== reading;
  const prevConv = last?.conv || "";
  const listTop = $(".list")?.scrollTop || 0;
  const readerTop = ($(".st") || $(".r-scroll"))?.scrollTop || 0;
  const rkey = ui.status ? "status" : sel ? sel.id : searching() ? "search" : `empty:${ui.tab}`;
  const capH = root.style.getPropertyValue("--cap-h");
  const prev = last ? capture() : null;
  app.classList.toggle("reading", reading);
  const body = ui.status ? statusHtml() : sel ? readerHtml(sel) : emptyReaderHtml(secs);
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

// The list and the notch without touching the reader, so a morph playing in the stream keeps running.
function paintAround() {
  const list = $(".list");
  if (!list || !ui.selected) return render();
  const secs = sections();
  const top = list.scrollTop;
  list.innerHTML = listHtml(secs);
  list.scrollTop = top;
  paintCap(secs, true);
  last.key = capKey(secs, true);
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

/* Search: every conversation in the run, every tag, read, cleared and muted. A conversation matches when each
   whitespace-separated term appears somewhere in it (case-insensitive substring), which stands in for SQLite FTS5.
   Field chips mirror the weir-axi search flags: from: and source: narrow which messages count, in: the tag. An
   original matches only on what its message added (bodyNew), never on the history it quotes. */
const FIELD = { title: "Title", headline: "Digest headline", digest: "Digest", body: "Original", from: "Sender", source: "Source" };
const CHIP = /(^|\s)(from|in|source):(\S+)/gi;
const RECENT = LS + "digest.recent";
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

// in: takes a tag id or display name, case-insensitive.
function tagOf(v) {
  const x = v.toLowerCase();
  return views.find((t) => t.id.toLowerCase() === x || t.name.toLowerCase() === x)?.id;
}

// Lifts finished field tokens out of the typed text: a token a space has closed, or every token once done (blur, Enter).
// An in: naming no tag stays plain text.
function takeChips(text, done) {
  const chips = [];
  const rest = text.replace(CHIP, (m, pre, k, v, at, all) => {
    if (!done && at + m.length === all.length) return m;
    k = k.toLowerCase();
    if (k === "in") v = tagOf(v);
    if (!v) return m;
    chips.push({ k, v });
    return pre;
  });
  return { chips, rest: chips.length ? rest.replace(/^\s+/, "").replace(/\s{2,}/g, " ") : text };
}

// A topic counts as said where its first message was, so a hit on it steps there.
function buildIndex() {
  return data.conversations.map((c) => {
    const recs = [{ f: "title", text: c.title }];
    for (const d of shownDigests(c)) {
      recs.push({ f: "headline", text: d.headline });
      for (const t of d.topics) {
        const i = itemAt(c, t.seqs[0]);
        if (i) recs.push({ f: "digest", item: i.id, text: `${t.title} ${t.body}` });
      }
    }
    for (const i of itemsOf(c)) recs.push({ f: "body", item: i.id, text: i.bodyNew || "" }, { f: "from", item: i.id, text: `${i.from.name || ""} <${i.from.addr}>` }, { f: "source", item: i.id, text: i.sourceLabel || "" });
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
    if (!ins.every((t) => c.views.includes(t))) continue;
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

// A result counts in every tag its conversation carries; a done or muted one only under Cleared.
const inGroup = (c, g) => (g === CLEARED ? isHidden(c) : !isHidden(c) && c.views.includes(g));
const groupName = (g) => (g === CLEARED ? "Cleared" : tagName(g));
const shown = () => results().filter((r) => !ui.search.group || inGroup(r.c, ui.search.group));
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
    if (n.parentElement.closest("mark")) continue;
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

// The topic that cites message seq, if a shown digest covers it.
function topicFor(c, seq) {
  const d = shownDigests(c).find((x) => x.fromSeq <= seq && seq <= x.toSeq);
  return d && d.topics.find((t) => t.seqs.includes(seq));
}

// Up to 3 lines per result: matching messages first, in conversation order, then the conversation's own fields.
function hitLines(r) {
  const out = [];
  for (const id of r.items.slice(0, 3)) {
    const recs = r.byItem.get(id);
    const f = ["digest", "body", "from", "source"].find((k) => recs.some((x) => x.f === k));
    out.push({ f, i: itemById[id], text: recs.find((x) => x.f === f).text, n: itemById[id].seq, c: r.c });
  }
  for (const x of r.conv) if (out.length < 3 && x.f !== "title") out.push({ f: x.f, text: x.text });
  return out;
}

function hitLineHtml(h, terms) {
  if (!h.i) return `<li class="hl"><span class="hl-k"><i>${FIELD[h.f]}</i></span><span class="hl-t hl-z">${hl(excerpt(h.text, terms, 16, 60) || h.text, terms)}</span></li>`;
  const k = `<span class="hl-k"><b>#${h.n}</b><span class="hl-who">${esc(short(h.i.from))}</span><i>${FIELD[h.f]}</i></span>`;
  if (h.f === "digest") return `<li class="hl">${k}<span class="hl-t hl-z">${hl(h.text, terms)}</span></li>`;
  const t = h.f === "body" ? excerpt(h.i.bodyNew, terms) : h.f === "from" ? `${h.i.from.name || ""} <${h.i.from.addr}>`.trim() : h.i.sourceLabel;
  const tp = topicFor(h.c, h.n);
  return `<li class="hl hl-${h.f}">${k}<span class="hl-t hl-o">${hl(t, h.f === "body" ? terms : [...terms, ...chipVals(h.f)])}</span>${tp ? `<span class="hl-g">${esc(tp.title)}</span>` : ""}</li>`;
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
  return `<article class="row res ${isUnread(c) ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-k="s-${c.id}" data-conv="${c.id}" data-open tabindex="0" aria-current="${ui.selected === c.id}" style="${convTint(c)}">
    <span class="row-av">${avatarHtml(from)}</span>
    <span class="row-title" title="${esc(c.title)}">${hl(c.title, terms)}</span>
    <span class="row-time" title="${esc(abs(iso))}">${relShort(iso)}</span>
    <span class="row-meta"><span class="row-b">${esc(tagsOf(c).map(tagName).join(" · "))}</span>${st}<span class="row-n">${r.items.length ? plural(r.items.length, "matching message") : "Matched the conversation"}</span></span>
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

const groupsOf = (res) => [...views.map((t) => t.id), CLEARED].map((g) => ({ g, rs: res.filter((r) => inGroup(r.c, g)) })).filter((x) => x.rs.length);

// The tag sentence turned into the results sentence: the query in the field above is its subject, so the line
// below reads on from it: “freeze” appears in 3 Me, 1 On-call and 2 Untagged.
function searchNavHtml() {
  if (!searching()) {
    const recent = JSON.parse(localStorage.getItem(RECENT) || "[]");
    return `<p class="s-tail q-hint"><span class="grp">Searches titles, digests, originals, senders and sources,</span> <span class="grp">cleared and muted included.</span> <span class="grp">Every word must appear.</span> <span class="grp">Narrow with <code>from:</code> <code>in:</code> <code>source:</code></span></p>${recent.length ? `<p class="s-tail q-recent"><span class="glue">Recent</span>${recent.map((r) => `<button class="w" data-recent="${esc(r)}">${esc(r)}</button>`).join("")}</p>` : ""}`;
  }
  const res = results();
  if (!res.length) return `<h1 class="s-main"><span class="allclear">${nothing()}</span></h1><p class="s-tail">Try fewer words, or drop a filter.</p>`;
  const on = ui.search.group;
  const ws = groupsOf(res).map(({ g, rs }) => {
    const avs = `<span class="avs">${senders(rs.map((r) => r.c)).map(avatarHtml).join("")}</span>`;
    const sel = g === on;
    return `<button class="w w-main ${sel ? "on" : ""}" data-sg="${g}" style="${g === CLEARED ? "" : tint(g)}" aria-pressed="${sel}" aria-label="${esc(`${rs.length} ${groupName(g)}. ${sel ? "Show all" : "Show only these"}`)}">${avs}<span class="w-n">${rs.length}</span> <span class="w-name">${esc(groupName(g))}</span></button>`;
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
    if (p.snap != null) ui.snap[p.selected] = p.snap;
    ui.fold = p.fold;
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
    prior: { tab: ui.tab, selected: ui.selected, snap: ui.snap[ui.selected], fold: ui.fold, listTop: sv ? sv.list : $(".list").scrollTop, readerTop: sv ? sv.reader : ($(".st") || $(".r-scroll")).scrollTop },
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
    if (s.group && !results().some((r) => inGroup(r.c, s.group))) s.group = null;
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

/* Land on a matching message: open the read digest it sits in and, when the match is in an original, unfold the topic
   that cites it, then scroll it in under the folded header. */
function goHit(k) {
  const r = curResult();
  if (!r?.items.length) return render();
  ui.search.at = Math.max(0, Math.min(r.items.length - 1, k));
  const id = r.items[ui.search.at];
  const seq = itemById[id].seq;
  const ds = shownDigests(r.c);
  const d = ds.find((x) => x.fromSeq <= seq && seq <= x.toSeq);
  if (d) {
    ui.shape.set(d.id, "card");
    if (d.toSeq <= (ui.snap[r.c.id] ?? seenSeq(r.c))) ui.earlier = true;
  }
  const inBody = r.byItem.get(id).some((x) => x.f !== "digest");
  const ti = d ? d.topics.findIndex((t) => t.seqs.includes(seq)) : -1;
  if (d && inBody && ti >= 0) ui.unf.add(tpKey(d, ti));
  ui.jump = seq;
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

const done = (c) => dismiss(c, () => setS(c, { seenSeq: lastSeq(c), clearedSeq: lastSeq(c) }));
const mute = (c) => dismiss(c, () => setS(c, { muted: true }));

function restore(c) {
  setS(c, { clearedSeq: null, muted: false });
  render();
}

function clearAll(tagId) {
  const s = sections().find((x) => x.id === tagId);
  if (!s?.convs.length) return;
  for (const c of s.convs) setS(c, { seenSeq: lastSeq(c), clearedSeq: lastSeq(c) });
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

// The last digested seq before q, 0 when no digest sits before it.
const floorBelow = (c, q) => Math.max(0, ...shownDigests(c).filter((d) => d.toSeq < q).map((d) => d.toSeq));

/* The seqs a manual request covers, as manualRange in data/digest.ts computes them on the server. now: the undigested
   tail. here: an undigested message to the end of its run. earlier: an undigested message back toward the previous
   digest, the whole gap in "run" mode, else one model call's worth (maxInput chars of bodyNew, at least one message).
   redo: one digest's exact range. */
function reqRange(c, req) {
  switch (req.kind) {
    case "now":
      return [floorOf(c) + 1, lastSeq(c)];
    case "here":
      return [req.fromSeq, Math.min(lastSeq(c) + 1, ...shownDigests(c).filter((d) => d.fromSeq > req.fromSeq).map((d) => d.fromSeq)) - 1];
    case "earlier": {
      const floor = floorBelow(c, req.upTo);
      if (earlierMode === "run") return [floor + 1, req.upTo];
      let from = req.upTo;
      let n = itemAt(c, from).bodyNew.length;
      while (from - 1 > floor && n + itemAt(c, from - 1).bodyNew.length <= data.digest.maxInput) n += itemAt(c, --from).bodyNew.length;
      return [from, req.upTo];
    }
    case "redo": {
      const d = shownDigests(c).find((x) => x.id === req.id);
      return d ? [d.fromSeq, d.toSeq] : null;
    }
  }
}

/* One POST /__digest per manual request ({ kind: "now" | "here" | "earlier" | "redo" }); the server picks the range from
   the stored digests and answers 409 instead of writing an overlap. A failure keeps everything as it was and says so
   where the action was. What lands opens as a card. Digest earlier keeps its bar where it was on screen, so the new card
   opens below it and pushes the digest underneath down. */
async function runDigest(c, req) {
  if (ui.pending[c.id] && !ui.pending[c.id].error) return;
  const range = reqRange(c, req);
  if (!range || range[1] < range[0]) return;
  const [fromSeq, toSeq] = range;
  const p = (ui.pending[c.id] = { ...req, fromSeq, toSeq, n: toSeq - fromSeq + 1 });
  if (ui.selected === c.id) morph(paintStream);
  const wire = { now: {}, here: { fromSeq }, earlier: { upTo: req.upTo, whole: earlierMode === "run" }, redo: { redo: { fromSeq, toSeq } } }[req.kind];
  let made = [];
  try {
    const r = await fetch("/__digest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: c.id, ...wire }) });
    const body = await r.json().catch(() => ({ error: `The server answered ${r.status} without a digest.` }));
    if (!r.ok || body.error) throw new Error(body.error || `The server answered ${r.status}.`);
    made = body.digests;
    data.digests = [...data.digests.filter((d) => d.id !== body.replaced), ...made];
    for (const d of made) ui.shape.set(d.id, "card");
    delete ui.pending[c.id];
    index = null;
  } catch (e) {
    ui.pending[c.id] = { ...p, error: e.message || String(e) };
    console.info("weir digest:", e.message || e);
  }
  const st = ui.selected === c.id && $(".st");
  if (!st) return render();
  const mk = req.kind === "earlier" ? `ge-${floorBelow(c, req.upTo) + 1}` : null;
  const r = mk && st.querySelector(`[data-mk="${mk}"]`)?.getBoundingClientRect();
  const sr = st.getBoundingClientRect();
  const at = r && r.bottom > sr.top && r.top < sr.bottom ? r.top : null;
  const land = () => {
    const el = st.querySelector(`[data-mk="${mk}"]`) || (made[0] && st.querySelector(`[data-k="d-${made[0].id}"]`));
    if (el) st.scrollTop += el.getBoundingClientRect().top - at;
  };
  morph(paintStream, at == null ? null : land);
  paintAround();
}

/* Simulated traffic: a plausible reply lands in the open Teams conversation (or payments-oncall) and is stored by
   POST /__sim. In an AI-enabled conversation the server digests at once when the text since the last digest reaches the
   threshold, and the reply carries that digest. */
const SIM_LINES = [
  "Update on the retry storm: the second wave of 502s from the acquirer gateway lined up with their TLS cert rotation at 14:05. Their status page now confirms it. Our circuit breaker opened after 40s as designed, but the retry queue kept re-enqueuing the same 1.2k authorizations because the idempotency key is built from the cart id, not the attempt. So we are double-counting in the dashboard, not double-charging. I checked 30 samples in the ledger and none settled twice.",
  "I can take the follow-up with the acquirer. What I need from our side before I call them: the exact window (first and last failed auth with timestamps in UTC), the share of traffic on the affected BIN ranges, and whether any merchant saw a hard decline instead of a soft one. If someone can pull those by 17:00 I will send the incident note tonight so their account manager has it before the Thursday sync.",
  "Pulled the numbers. Window is 14:04:51 to 14:31:07 UTC. 18.4% of card traffic was on the affected BIN ranges, mostly the two big EU issuers. Soft declines only, code 91 (issuer unavailable), so customers saw 'try again' and 71% of them did succeed on the second attempt. Three merchants opened tickets: Fernhill, Lumen Rides and Okapi Books. Lumen is the loud one, they want a credit for the failed rides during their evening peak.",
  "Heads up for the postmortem: the runbook step that says 'fail over to the secondary acquirer' did not work, because the secondary still has the old webhook secret from the September rotation. Failover requests were accepted but the callbacks bounced, so those payments stayed in pending for up to 20 minutes. I rotated the secret just now and verified one test transaction end to end. We should add a weekly synthetic check that exercises the failover path, otherwise we only learn about this during the next incident.",
  "On the Lumen credit: finance is fine with a goodwill credit capped at the fees for the affected window, which comes to about 1,900 EUR. They need a decision owner on our side and a written summary of the impact before they issue it. I suggest we offer it proactively on the Thursday call instead of waiting for the escalation. Can someone confirm they own the customer comms for this one?",
  "Last thing for today: I drafted the timeline in the incident doc, sections 1 to 3 are done (detection, mitigation, customer impact). Section 4 (root cause) is waiting on the acquirer's written confirmation, and section 5 (actions) has the failover synthetic check, the idempotency key change and the dashboard dedupe as candidates. Please add owners and dates next to each action before the review on Friday at 10:00.",
];
let sims = 0;

async function simulate() {
  const open = ui.selected && conv(ui.selected);
  const c = open?.source === "teams" ? open : conv("c-teams:payments-oncall");
  if (!c || (ui.pending[c.id] && !ui.pending[c.id].error)) return console.info("weir dev: no Teams conversation to simulate into, or a digest is running.");
  const its = itemsOf(c);
  const people = [...new Map(its.filter((i) => !isMe(i.from) && !/bot@/.test(i.from.addr)).map((i) => [i.from.addr.toLowerCase(), i.from])).values()];
  const from = people[(lastSeq(c) + 1) % Math.max(1, people.length)] || its.at(-1).from;
  const text = SIM_LINES[sims++ % SIM_LINES.length];
  const r = await fetch("/__sim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: c.id, from, text }) }).catch(() => null);
  const body = r && (await r.json().catch(() => null));
  if (!body?.item) return console.info("weir dev: /__sim failed", body?.error);
  const item = body.item;
  data.items.push(item);
  itemById[item.id] = item;
  c.itemIds = [...c.itemIds, item.id];
  c.bySeq.set(item.seq, item);
  c.lastSeq = item.seq;
  c.lastAt = item.occurredAt;
  data.digests.push(...body.digests);
  index = null;
  if (ui.selected === c.id && !ui.status && $(".st-in")) {
    setS(c, { seenSeq: item.seq });
    morph(paintStream);
    paintAround();
    const st = $(".st");
    st.scrollTo({ top: st.scrollHeight, behavior: reduceMotion.matches ? "auto" : "smooth" });
  } else render();
}

/* The status view answers "is it working right now": sources, digests, the config with Reload, and the theme. The
   daemon serves this in the real app; here it is faked from the run, and the dev switcher breaks a source or the config. */
const THEME_KEY = LS + "theme";
const THEMES = ["system", "light", "dark"];
const CONFIG_ERRORS = [
  { file: "~/.weir/config.toml", path: "ai.digest", msg: 'unknown AI profile "carefull"' },
  { file: "prompts/digest.md", msg: "file not found" },
];
let status = null;

function initStatus() {
  const now = Date.now();
  const teams = data.items.filter((i) => i.source === "teams").length;
  const ds = data.digests.filter((d) => Array.isArray(d.topics));
  status = {
    sources: [
      { id: "gmail", name: "Personal Gmail", app: "Gmail", syncedAt: now - 3 * 60e3, lastGoodAt: now - 26 * 60e3, items: data.items.length - teams, error: 'oauth2: "invalid_grant" "Token has been expired or revoked."' },
      { id: "teams", name: "Teams", app: "Teams", syncedAt: now - 60e3, items: teams },
    ],
    enrich: { profile: ds[0]?.model || "luna", lastAt: Date.parse(data.generatedAt), digests: ds.length, ms: ds.length ? ds.reduce((n, d) => n + d.ms, 0) / ds.length : 0 },
    config: { path: "~/.weir/config.toml", loadedAt: now - 42 * 60e3, failedAt: null, errors: [], reloading: false },
  };
}

const failing = (s) => s.id === "gmail" && broken.source;
const statusAlert = () => broken.source || status.config.errors.length > 0;
const waitingCount = () => data.conversations.filter((c) => (ui.pending[c.id] && !ui.pending[c.id].error) || autoChars(c) >= data.digest.threshold).length;

function statusHtml() {
  const { sources, enrich, config } = status;
  const stopped = config.errors.length > 0;
  const down = sources.filter(failing);
  const verdict = stopped
    ? ["warn", "Sync and digests stopped", "The config did not load. Fix it and Reload. Everything synced so far stays readable."]
    : down.length
      ? ["warn", `${down[0].name} can't sync.`, "The other sources and digests keep running."]
      : ["ok", "Everything is running.", `Last sync ${ago(Math.max(...sources.map((s) => s.syncedAt)))}.`];
  const waiting = waitingCount();
  const aiTags = data.tags.filter((t) => t.ai);
  const running = data.conversations.filter((c) => ui.pending[c.id] && !ui.pending[c.id].error);
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
    <section class="sv-sec" aria-labelledby="sv-h-en"><h3 class="sv-h" id="sv-h-en">Digests</h3><dl class="sv-dl">
      ${row("AI on", aiTags.length ? `<ul class="sv-tags">${aiTags.map((t) => `<li><b>${esc(t.name)}</b><span class="sv-dim">since ${abs(t.aiSince)} · ${plural(data.conversations.filter((c) => c.tags.includes(t.name)).length, "conversation")}</span></li>`).join("")}</ul>` : `No tag has <code>ai = true</code>`)}
      ${row("Queue", running.length ? `<ul class="sv-tags">${running.map((c) => `<li><b>${esc(c.title)}</b><span class="sv-dim">${seqSpan(ui.pending[c.id].fromSeq, ui.pending[c.id].toSeq)} · running</span></li>`).join("")}</ul>` : waiting ? plural(waiting, "conversation") : "Empty", stopped ? "held" : "")}
      ${row("Last run", `${abs(new Date(enrich.lastAt).toISOString())}<span class="sv-dim">${plural(enrich.digests, "digest")}, ${(enrich.ms / 1000).toFixed(1)}s each on average</span>`)}
      ${row("Threshold", `${data.digest.threshold.toLocaleString("en")} characters of new text`)}
      ${row("AI profile", `<code>${esc(enrich.profile)}</code>`)}
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
// A vertical wheel over an overflowing tag strip scrolls it sideways; a trackpad's horizontal swipe passes through.
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
  if (act === "rr" || act === "rrx") {
    const id = t.dataset.ch;
    return morph(() => {
      ui.shape.set(id, act === "rr" ? "card" : "row");
      paintStream();
    });
  }
  if (act === "earlier") {
    return morph(() => {
      ui.earlier = true;
      paintStream();
    });
  }
  if (act === "unf") {
    const k = t.dataset.tp;
    if (ui.unf.has(k)) return unfold(k, false);
    return unfold(k, true);
  }
  if (act === "long") {
    const id = t.dataset.item;
    ui.long.has(id) ? ui.long.delete(id) : ui.long.add(id);
    const body = t.previousElementSibling;
    body.classList.toggle("open", ui.long.has(id));
    t.textContent = ui.long.has(id) ? "Show less" : "Show all";
    t.setAttribute("aria-expanded", String(ui.long.has(id)));
    if (!ui.long.has(id)) body.closest("[data-seqs]")?.scrollIntoView({ block: "nearest", behavior: reduceMotion.matches ? "auto" : "smooth" });
    return;
  }
  if (act === "dnow" && c) return runDigest(c, { kind: "now" });
  if (act === "dfh" && c) return runDigest(c, { kind: "here", fromSeq: Number(t.dataset.seq) });
  if (act === "dup" && c) return runDigest(c, { kind: "earlier", upTo: Number(t.dataset.seq) });
  if (act === "redo" && c) return runDigest(c, { kind: "redo", id: t.dataset.ch });
  if (act === "unfold") return setFold(false);
  if (act === "clearall") return clearAll(t.dataset.tag);
  if (act === "done" && c) return done(c);
  if (act === "mute" && c) return mute(c);
  if (act === "restore" && c) return restore(c);
  if (act === "unread" && c) {
    setS(c, { seenSeq: lastSeq(c) - 1 });
    ui.snap[c.id] = lastSeq(c) - 1;
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

/* The range preview: while a digest action is hovered or focused, the bubbles it would digest take a rail and a tint.
   Touch has no hover, so tapping a bubble reveals its Digest from here and previews that range; tapping elsewhere hides
   both. */
const coarse = matchMedia("(hover: none)");
let pvBy = null;
function previewRange(el) {
  if (el === pvBy) return;
  pvBy = el;
  const [a, b] = el ? el.dataset.pv.split("-").map(Number) : [1, 0];
  for (const bl of document.querySelectorAll(".st-in .bl.dg")) {
    const q = Number(bl.dataset.seqs);
    bl.classList.toggle("pv", a <= q && q <= b);
  }
}
const pvOf = (t) => t?.closest?.("[data-pv]") || null;
document.addEventListener("pointerover", (e) => e.pointerType !== "touch" && previewRange(pvOf(e.target) || pvOf(document.activeElement)));
document.addEventListener("focusin", (e) => previewRange(pvOf(e.target) || (pvBy?.matches(":hover") ? pvBy : null)));
document.addEventListener("focusout", (e) => !e.relatedTarget && !pvBy?.matches(":hover") && previewRange(null));
document.addEventListener("click", (e) => {
  if (!coarse.matches || e.target.closest(".bl.dg a, .bl.dg button")) return;
  const bl = e.target.closest(".st-in .bl.dg");
  for (const x of document.querySelectorAll(".bl.tap")) if (x !== bl) x.classList.remove("tap");
  bl?.classList.toggle("tap");
  previewRange(bl?.classList.contains("tap") ? bl.querySelector("[data-pv]") : null);
});

document.addEventListener("keydown", (e) => {
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
