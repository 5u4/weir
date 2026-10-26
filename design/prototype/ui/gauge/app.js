const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-low";
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const EASE_IN = "cubic-bezier(0.4, 0, 1, 1)";
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const NARROW = matchMedia("(max-width: 899px)");

let data, source, storeKey, runs = [], runSlug = null, itemById, me;
// Conversation whose reader scrolled past the update block to reach the last-read marker; the marker then repeats the update.
let travelled = null;
// convId -> { seenAt, clearedAt, muted }
let state = {};
const ui = {
  tab: null,
  selected: null,
  showOld: new Set(),
  showQuoted: new Set(),
  snap: {}, // convId -> Set of item ids that were new when the conversation was opened
  sims: 0,
  busy: false,
};

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

marked.setOptions({ breaks: true, gfm: true });
DOMPurify.addHook("afterSanitizeAttributes", (n) => {
  if (n.tagName === "A") {
    n.setAttribute("target", "_blank");
    n.setAttribute("rel", "noreferrer");
    const href = n.getAttribute("href") || "";
    // Tracking URLs pasted as link text run for hundreds of characters; show host + path head and keep the full URL on hover.
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
  const run = runs.find((r) => r.slug === pref) || runs.find((r) => r.slug === DEFAULT_RUN) || runs[0];
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
    document.body.textContent = "无法加载数据";
    return;
  }
  itemById = Object.fromEntries(data.items.map((i) => [i.id, i]));
  me = new Set(data.me.map((a) => a.toLowerCase()));
  state = JSON.parse(localStorage.getItem(LS + "state." + storeKey) || "{}");
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
  };
  window.dispatchEvent(new Event("weirdev"));
  render();
  document.fonts?.ready.then(() => placePlate(true));
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
const bucketName = (id) => data.buckets.find((b) => b.id === id)?.name || "未分类";
// The open conversation was marked read on open, but the readout keeps counting it until the reader lets go of it (完成, next, close).
const held = (c) => c.id === ui.selected && ui.snap[c.id]?.size > 0 && !isHidden(c);
const live = (c) => isUnread(c) || held(c);

function sections() {
  const out = data.buckets.map((b) => ({ id: b.id, name: b.name, convs: [] }));
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  const none = { id: NONE, name: "未分类", convs: [] };
  for (const c of data.conversations) {
    if (isHidden(c)) continue;
    (byId[c.bucket] || none).convs.push(c);
  }
  if (none.convs.length) out.push(none);
  for (const s of out) {
    s.convs.sort((a, b) => lastMs(b) - lastMs(a));
    s.unread = s.convs.filter(live).length;
  }
  return out;
}

const clearedList = () => data.conversations.filter(isHidden).sort((a, b) => lastMs(b) - lastMs(a));
const currentSection = (secs) => secs.find((s) => s.id === ui.tab) || secs.find((s) => s.unread) || secs.find((s) => s.convs.length) || secs[0];
const currentList = () => (ui.tab === CLEARED ? clearedList() : currentSection(sections())?.convs || []);

function onOpen(c) {
  const seen = seenMs(c);
  ui.snap[c.id] = new Set(itemsOf(c).filter((i) => Date.parse(i.occurredAt) > seen).map((i) => i.id));
  if (isUnread(c)) setS(c, { seenAt: lastIso(c) });
}

function onLeave(id) {
  delete ui.snap[id];
  ui.showOld.delete(id);
}

function snapshot(cs) {
  const prev = cs.map((c) => [c.id, state[c.id] && { ...state[c.id] }]);
  return () => {
    for (const [id, s] of prev) s ? (state[id] = s) : delete state[id];
    save();
    render();
  };
}

let toastTimer;
function toast(msg, undo, extra) {
  const el = $(".toast");
  el.innerHTML = `<span class="toast-msg">${esc(msg)}</span>${extra ? `<button data-act="toast-extra">${esc(extra.label)}</button>` : ""}${undo ? `<button data-act="undo">撤销</button>` : ""}<span class="toast-bar" aria-hidden="true"></span>`;
  el.onclick = (e) => {
    const a = e.target.closest("button")?.dataset.act;
    if (!a) return;
    a === "undo" ? undo() : extra.run();
    el.classList.remove("on");
  };
  el.classList.remove("on");
  void el.offsetWidth;
  el.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("on"), 5000);
}

function rel(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天前`;
  return new Date(iso).toLocaleDateString("zh-CN");
}

const abs = (iso) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (iso) => {
  const t = new Date(iso);
  return `${t.getMonth() + 1}/${t.getDate()}`;
};
function relShort(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)}分`;
  if (d < 86400) return `${Math.floor(d / 3600)}时`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)}天`;
  return day(iso);
}
const short = (p) => (isMe(p) ? "我" : (p.name || p.addr.split("@")[0]).split(/\s+/)[0]);
const pad = (n) => String(n).padStart(2, "0");
const SRC = { Updates: "UPD", Primary: "PRI", Promotions: "PRO", Sent: "SNT", Inbox: "INB", Social: "SOC", Forums: "FOR" };
const srcCode = (label) => {
  const k = String(label).split("·").pop().trim();
  return SRC[k] || k.slice(0, 3).toUpperCase();
};

function participants(c) {
  const names = [];
  for (const i of itemsOf(c)) {
    const n = short(i.from);
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

/* avatars */

const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "qq.com", "163.com", "126.com", "icloud.com", "me.com", "yahoo.com"]);
function siteOf(addr) {
  const p = (addr.split("@")[1] || "").toLowerCase().split(".");
  const two = p.slice(-2).join(".");
  return p.length > 2 && /^(com|co|net|org|edu|gov|ac)\.[a-z]{2}$/.test(two) ? p.slice(-3).join(".") : two;
}
function hue(s) {
  let h = 7;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}
// One face per sender identity: a company domain shows once even if three of its addresses wrote.
function senders(convs, max = 3) {
  const out = [];
  const seen = new Set();
  for (const c of convs) {
    const from = itemsOf(c).reverse().find((i) => !isMe(i.from))?.from;
    if (!from) continue;
    const site = siteOf(from.addr);
    const k = PERSONAL.has(site) ? from.addr.toLowerCase() : site;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(from);
    if (out.length === max) break;
  }
  return out;
}
function avatarHtml(p) {
  const addr = p.addr.toLowerCase();
  const site = siteOf(addr);
  const name = p.name || addr.split("@")[0];
  const ch = (name.match(/[\p{L}\p{N}]/u)?.[0] || "?").toUpperCase();
  const img = PERSONAL.has(site) ? "" : `<img src="https://www.google.com/s2/favicons?domain=${esc(site)}&sz=64" alt="" onload="weirAv(this)" onerror="this.remove()">`;
  return `<span class="av" style="--h:${hue(addr)}" title="${esc(name)}"><b>${esc(ch)}</b>${img}</span>`;
}
// Google answers unknown domains with a 16px globe; anything that small falls back to the monogram.
window.weirAv = (img) => (img.naturalWidth < 32 ? img.remove() : img.classList.add("ok"));

/* the readout: every number in the sentence is an odometer keyed u:<bucket>, p:<bucket>, c */

const digits = (v) => [...String(v)].map((d) => `<span class="d"><span class="s">${d}</span></span>`).join("");
const odo = (k, v) => `<span class="odo" data-k="${k}" data-v="${v}" aria-hidden="true">${digits(v)}</span>`;
const odoMap = (el) => new Map($$(".odo", el).map((o) => [o.dataset.k, +o.dataset.v]));

function steps(a, b, down) {
  if (a === " " || b === " ") return [a, b];
  const seq = [a];
  for (let x = +a; x !== +b; ) seq.push(String((x = down ? (x + 9) % 10 : (x + 1) % 10)));
  return seq;
}

function roll(el, to) {
  const from = +el.dataset.v;
  if (from === to) return;
  el.dataset.v = to;
  for (const a of el.getAnimations({ subtree: true })) a.cancel();
  if (el.dataset.k.startsWith("u:")) delta(el, to - from);
  if (RM.matches) {
    el.innerHTML = digits(to);
    el.animate([{ opacity: 0.15 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
    return requestAnimationFrame(() => placePlate());
  }
  const n = Math.max(String(from).length, String(to).length);
  const A = String(from).padStart(n, " ");
  const B = String(to).padStart(n, " ");
  const down = to < from;
  const glyph = (g) => (g === " " ? `<i class="b">0</i>` : `<i>${g}</i>`);
  el.innerHTML = [...B]
    .map((g, i) => {
      const seq = steps(A[i], g, down);
      if (seq.length === 1) return `<span class="d"><span class="s">${g === " " ? `<i class="b">0</i>` : g}</span></span>`;
      const strip = down ? [...seq].reverse() : seq;
      return `<span class="d"><span class="s strip" data-n="${seq.length}" data-p="${n - 1 - i}">${strip.map(glyph).join("")}</span></span>`;
    })
    .join("");
  const runs = $$(".strip", el).map((s) => {
    const len = +s.dataset.n;
    const top = -(len - 1);
    const [start, end] = down ? [top, 0] : [0, top];
    const over = down ? 0.07 : -0.07;
    return s.animate(
      [
        { transform: `translateY(${start}em)` },
        { transform: `translateY(${end + over}em)`, offset: 0.82 },
        { transform: `translateY(${end}em)` },
      ],
      { duration: 460 + Math.min(len, 8) * 60, delay: 70 + +s.dataset.p * 110, easing: "cubic-bezier(0.45, 0, 0.2, 1)", fill: "both" },
    ).finished;
  });
  Promise.all(runs)
    .then(() => {
      if (+el.dataset.v !== to) return;
      el.innerHTML = digits(to);
      placePlate();
    })
    .catch(() => {});
}

function delta(el, d) {
  const host = el.closest(".w, .wq");
  if (!host || !d) return;
  const t = document.createElement("span");
  t.className = "delta";
  t.setAttribute("aria-hidden", "true");
  t.textContent = d < 0 ? `−${-d}` : `+${d}`;
  host.append(t);
  const a = RM.matches
    ? t.animate([{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 900 })
    : t.animate(
        [
          { opacity: 0, transform: "translateY(0.3em)" },
          { opacity: 1, transform: "translateY(0)", offset: 0.18 },
          { opacity: 1, transform: "translateY(-0.5em)", offset: 0.6 },
          { opacity: 0, transform: "translateY(-1.1em)" },
        ],
        { duration: 1100, easing: "cubic-bezier(0.2, 0, 0.2, 1)" },
      );
  a.finished.then(() => t.remove()).catch(() => t.remove());
}

/* sentence */

function hi() {
  const h = new Date().getHours();
  return h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
}
// Each clause carries its trailing connector (and the last one the predicate) so a line never starts with 、 or 和.
function joinZh(parts, end) {
  const sep = (i) => (i === parts.length - 1 ? end : i === parts.length - 2 ? `<span class="cj cj-h">和</span>` : `<span class="cj cj-d">、</span>`);
  return parts.map((p, i) => `<span class="g">${p}${sep(i)}</span>`).join("");
}
const mode = () => (ui.selected && !NARROW.matches ? "split" : "home");

function headModel(secs) {
  return {
    live: secs.filter((s) => s.unread),
    quiet: secs.filter((s) => !s.unread && s.convs.length),
    empty: secs.filter((s) => !s.convs.length),
    cleared: clearedList().length,
  };
}
const headKey = (m) => [mode(), m.live.map((s) => s.id).join(), m.quiet.map((s) => s.id).join(), m.empty.map((s) => s.id).join()].join("|");

function widget(s, on) {
  const who = senders(s.convs.filter(live));
  return `<button class="w ${on ? "sel" : ""}" data-w="${s.id}" data-tab="${s.id}" aria-pressed="${on}" aria-label="${s.unread} 个「${esc(s.name)}」有更新，共 ${s.convs.length} 个待清">
    <span class="w-av" data-sig="${esc(who.map((p) => p.addr).join())}">${who.map(avatarHtml).join("")}</span><span class="w-n">${odo("u:" + s.id, s.unread)}<span class="w-of">/${odo("p:" + s.id, s.convs.length)}</span></span><span class="w-l">个「${esc(s.name)}」</span>
  </button>`;
}
const quietW = (s, on) =>
  `<button class="wq ${on ? "sel" : ""}" data-w="q:${s.id}" data-tab="${s.id}" aria-pressed="${on}" aria-label="${s.convs.length} 个「${esc(s.name)}」已读未清">${odo("p:" + s.id, s.convs.length)}<span class="wq-l">个「${esc(s.name)}」</span></button>`;
const emptyW = (s, on) => `<button class="wq we ${on ? "sel" : ""}" data-w="e:${s.id}" data-tab="${s.id}" aria-pressed="${on}"><span class="wq-l">「${esc(s.name)}」</span></button>`;
const clearedW = (n, on) =>
  `<button class="wc ${on ? "sel" : ""}" data-w="c" data-tab="${CLEARED}" aria-pressed="${on}" aria-label="已清理 ${n} 个"><span class="wc-l">已清理</span>${odo("c", n)}</button>`;

function scaleHtml(secs, curId) {
  const segs = secs.filter((s) => s.convs.length);
  const total = segs.reduce((n, s) => n + s.convs.length, 0);
  if (!total) return "";
  return `<div class="scale" aria-hidden="true">${segs
    .map(
      (s) => `<span class="sc-seg ${s.id === curId ? "on" : ""}" style="--n:${s.convs.length}"><span class="sc-bar"><i style="--f:${s.unread / s.convs.length}"></i></span><span class="sc-l mono"><span>${esc(s.name)}</span><span>${s.unread}<i>/${s.convs.length}</i></span></span></span>`,
    )
    .join("")}</div>`;
}

function headHtml(secs, m, curId) {
  const lead = m.live.length ? `你有${joinZh(m.live.map((s) => widget(s, s.id === curId)), "有更新。")}` : m.quiet.length ? "没有新的更新。" : "全部清完了。";
  const quiet = m.quiet.length ? `<span class="t-c">${m.live.length ? "另有" : "还有"}${joinZh(m.quiet.map((s) => quietW(s, s.id === curId)), "已读未清。")}</span>` : "";
  const empty = m.empty.length ? `<span class="t-c">${joinZh(m.empty.map((s) => emptyW(s, s.id === curId)), "已清空。")}</span>` : "";
  return `<div class="top mono"><span class="mark">weir</span><span class="g-gen" title="${esc(data.generatedAt)}">数据 ${abs(data.generatedAt)} · ${rel(data.generatedAt)}</span></div>
    <h1 class="sent ${m.live.length ? "" : "quiet"}"><span class="g-hi">${hi()}。</span>${lead}</h1>
    <div class="tail"><p class="t-q">${quiet}${empty}</p>${clearedW(m.cleared, curId === CLEARED)}</div>
    ${scaleHtml(secs, curId)}`;
}

let hKey = null;
let hTimer = 0;
function renderHead(secs, curId, force = false) {
  const m = headModel(secs);
  const key = headKey(m);
  const hc = $(".hc");
  const tmp = document.createElement("div");
  tmp.innerHTML = headHtml(secs, m, curId);
  clearTimeout(hTimer);
  if (key === hKey) return patchHead(hc, tmp);
  const next = odoMap(tmp);
  // A clause about to leave the sentence first rolls to its new value in place, then the grammar re-flows.
  if (!force && hKey && hKey.split("|")[0] === key.split("|")[0]) {
    let moved = false;
    for (const o of $$(".odo", hc)) {
      const v = next.get(o.dataset.k) ?? (o.dataset.k === "c" ? null : 0);
      if (v != null && v !== +o.dataset.v) roll(o, v), (moved = true);
    }
    if (moved) {
      hTimer = setTimeout(() => {
        const s = sections();
        renderHead(s, curTab(s), true);
      }, RM.matches ? 320 : 820);
      return;
    }
  }
  const prev = odoMap(hc);
  const before = new Set($$("[data-w]", hc).map((w) => w.dataset.w));
  const sameMode = hKey && hKey.split("|")[0] === key.split("|")[0];
  hc.replaceChildren(...tmp.childNodes);
  hKey = key;
  for (const o of $$(".odo", hc)) {
    const v = prev.get(o.dataset.k);
    if (v == null || v === +o.dataset.v) continue;
    const to = +o.dataset.v;
    o.dataset.v = v;
    o.innerHTML = digits(v);
    roll(o, to);
  }
  if (sameMode)
    for (const w of $$("[data-w]", hc))
      if (!before.has(w.dataset.w)) w.animate([{ opacity: 0, transform: RM.matches ? "none" : "translateY(0.25em)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
  placePlate(!sameMode);
}

function patchHead(hc, tmp) {
  const next = odoMap(tmp);
  for (const n of $$("[data-w]", tmp)) {
    const o = $(`[data-w="${n.dataset.w}"]`, hc);
    if (!o) continue;
    o.className = n.className;
    o.setAttribute("aria-pressed", n.getAttribute("aria-pressed"));
    if (n.hasAttribute("aria-label")) o.setAttribute("aria-label", n.getAttribute("aria-label"));
    const na = $(".w-av", n);
    const oa = $(".w-av", o);
    if (na && oa && na.dataset.sig !== oa.dataset.sig) oa.replaceWith(na);
  }
  for (const o of $$(".odo", hc)) if (next.has(o.dataset.k)) roll(o, next.get(o.dataset.k));
  const sc = $(".scale", hc);
  const nsc = $(".scale", tmp);
  if (sc && nsc) sc.replaceWith(nsc);
  else if (nsc) hc.append(nsc);
  else sc?.remove();
  placePlate();
}

// The black plate under the selected clause is one element that travels between clauses.
function placePlate(instant = false) {
  const hd = $(".hd");
  const plate = $(".plate");
  if (!hd || !plate) return;
  const t = $(".hc .sel", hd);
  if (!t) return void (plate.style.opacity = 0);
  const a = hd.getBoundingClientRect();
  const r = t.getBoundingClientRect();
  plate.style.transition = instant || RM.matches ? "none" : "";
  plate.style.opacity = 1;
  plate.style.transform = `translate(${r.left - a.left}px, ${r.top - a.top}px) scale(${r.width / 100}, ${r.height / 100})`;
  if (instant) void plate.offsetWidth;
}
addEventListener("resize", () => placePlate(true));

/* list */

function rowHtml(c, inCleared) {
  const unread = isUnread(c);
  const hot = live(c);
  const fresh = unread ? itemsOf(c).filter((i) => Date.parse(i.occurredAt) > seenMs(c)).length : 0;
  const tags = [...new Set(itemsOf(c).map((i) => i.sourceLabel))];
  const line = hot && c.update ? esc(c.update) : esc((c.summary || "").split(/(?<=。)|\n/)[0]);
  const who = participants(c);
  const whoTxt = who.length > 2 ? `${who.slice(0, 2).join("、")} +${who.length - 2}` : who.join("、");
  const tail = inCleared
    ? `<span class="badge ${S(c).muted ? "muted" : ""}">${S(c).muted ? "已静音" : "已完成"}</span><button class="restore" data-act="restore">恢复</button>`
    : `<span class="row-src mono" title="${esc(tags.join("、"))}">${srcCode(tags[0])}${tags.length > 1 ? `<i>+${tags.length - 1}</i>` : ""}</span>`;
  const dot = unread ? "未读" : hot ? "正在读" : "已读";
  return `<article class="row ${unread ? "unread" : hot ? "held" : ""} ${ui.selected === c.id ? "sel" : ""}" data-conv="${c.id}" data-open>
    <span class="dot" role="img" aria-label="${dot}"></span>
    <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
    <span class="row-line">${hot && c.update ? `<i class="row-up">新</i>` : ""}${line}</span>
    <span class="row-who" title="${esc(who.join("、"))}">${esc(whoTxt)}</span>
    <span class="row-count mono" title="${c.itemIds.length} 封${fresh ? `，其中 ${fresh} 封是新的` : ""}">${fresh && fresh < c.itemIds.length ? `${c.itemIds.length - fresh}<b>+${fresh}</b>` : fresh ? `<b>${fresh}</b>` : c.itemIds.length}</span>
    ${tail}
    <span class="row-time mono" title="${esc(abs(lastIso(c)))}">${relShort(lastIso(c))}</span>
  </article>`;
}

const cols = (mid) => `<div class="cols mono" aria-hidden="true"><span></span><span>对话</span><span>最新一句</span><span>参与者</span><span class="r">封</span>${mid}<span class="r">时间</span></div>`;

function emptyHtml(n, title, sub) {
  return `<div class="empty"><span class="empty-n">${n}</span><div class="empty-t"><p>${title}</p><p class="empty-sub">${sub}</p></div></div>`;
}

function bodyHtml(secs, cur) {
  if (ui.tab === CLEARED) {
    const cl = clearedList();
    const muted = cl.filter((c) => S(c).muted).length;
    const bar = `<div class="bar"><span class="b-t"><b>已清理</b><span class="mono">${cl.length} 个 · 完成 ${cl.length - muted} · 静音 ${muted}</span></span></div>`;
    return (
      bar +
      `<div class="rows cleared">${cl.length ? cols("<span>状态</span><span></span>") + cl.map((c) => rowHtml(c, true)).join("") : emptyHtml(0, "还没有清理过的对话。", "完成或静音的对话会出现在这里，可以随时恢复。")}</div>`
    );
  }
  const bar = `<div class="bar"><span class="b-t"><b>${esc(cur.name)}</b><span class="mono">${cur.convs.length} 个对话 · ${cur.unread} 未读</span></span>${cur.convs.length ? `<button class="clearall" data-act="clearall" data-bucket="${cur.id}">全部清掉</button>` : ""}</div>`;
  return (
    bar +
    `<div class="rows">${cur.convs.length ? cols("<span>来源</span>") + cur.convs.map((c) => rowHtml(c, false)).join("") : emptyHtml(0, `「${esc(cur.name)}」都处理完了。`, "有新消息时，对话会以未读状态回到这里。")}</div>`
  );
}

/* reader */

function chipsHtml(c) {
  const its = itemsOf(c);
  const out = [];
  if (its.some((i) => i.to.some(isMe))) out.push(`<span class="chip">直接发给我</span>`);
  if (its.some((i) => i.cc.some(isMe))) out.push(`<span class="chip">抄送我</span>`);
  if (its.some((i) => isMe(i.from))) out.push(`<span class="chip">我参与过</span>`);
  if (c.threadIds.length > 1) out.push(`<span class="chip merge" title="${esc(c.mergeReason || "")}">合并 ${c.threadIds.length} 个 thread</span>`);
  return out.length ? `<span class="r-chips">${out.join("")}</span>` : "";
}

function itemHtml(c, i, n, k) {
  const hl = ui.snap[c.id]?.has(i.id);
  const q = ui.showQuoted.has(i.id);
  return `<li class="tl-item ${hl ? "unread" : ""}" data-item="${i.id}" style="--k:${k}">
    <span class="tl-idx">${pad(n)}</span>
    <div class="tl-main">
      <div class="tl-meta"><b class="tl-from" title="${esc(i.from.addr)}">${esc(isMe(i.from) ? "我" : i.from.name || i.from.addr)}</b>${hl ? `<span class="tl-new mono">新</span>` : ""}<span class="tl-src mono" title="${esc(i.sourceLabel)}">${srcCode(i.sourceLabel)}</span><span class="tl-time mono" title="${esc(i.occurredAt)}">${abs(i.occurredAt)}</span></div>
      <div class="body">${md(i.bodyNew)}</div>
      ${i.bodyQuoted ? `<button class="q-toggle mono" data-act="quote" data-item="${i.id}" aria-expanded="${q}">${q ? "隐藏引用" : "显示引用"}</button>${q ? `<div class="quoted">${esc(i.bodyQuoted)}</div>` : ""}` : ""}
    </div>
  </li>`;
}

function markHtml(c, its, firstNew) {
  const n = its.length - its.indexOf(firstNew);
  const label = its[0] === firstNew ? "从这里开始都是新的" : "上次读到这里";
  const cap = c.update ? `<p class="mk-cap"><span>${esc(c.update)}</span></p>` : "";
  return `<li class="tl-mark" role="separator" aria-label="${label}"><div class="mk-line"><span class="mk-rule" aria-hidden="true"></span><span class="mk-l"><span>${label}</span></span><span class="mk-r mono"><span>↓ ${n} 条新 · ${abs(firstNew.occurredAt)} 起</span></span></div>${cap}</li>`;
}

function timelineHtml(c) {
  const its = itemsOf(c);
  const hl = ui.snap[c.id] || new Set();
  const firstNew = its.find((i) => hl.has(i.id));
  let old = its.filter((i) => !hl.has(i.id));
  // With nothing new, keep the latest old item visible so the timeline is never just one collapsed row.
  if (old.length === its.length) old = old.slice(0, -1);
  const collapse = !(its.length <= 3 || old.length < 2 || ui.showOld.has(c.id));
  const start = collapse ? old.length : 0;
  let k = 0;
  const rows = its.slice(start).map((i, j) => (i === firstNew ? markHtml(c, its, i) : "") + itemHtml(c, i, start + j + 1, hl.has(i.id) ? k++ : 0));
  const older = collapse
    ? `<li class="tl-older"><button data-act="old" data-conv="${c.id}"><span class="tl-idx">${pad(1)}–${pad(old.length)}</span><span>之前的 ${old.length} 条</span><span class="mono">${day(old[0].occurredAt)} → ${day(old.at(-1).occurredAt)}</span></button></li>`
    : "";
  return `<ol class="tl">${older}${rows.join("")}</ol>`;
}

function actsHtml(c) {
  const st = S(c);
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${label}</button>`;
  const out = [`<button class="back" data-act="close">‹ 返回</button>`];
  if (isHidden(c)) out.push(b("restore", `恢复（${st.muted ? "已静音" : "已完成"}）`, "primary"));
  else out.push(b("done", `完成<kbd>E</kbd>`, "primary"));
  if (!isUnread(c)) out.push(b("unread", "标为未读"));
  if (!st.muted) out.push(b("mute", "静音"));
  const link = lastItem(c)?.link;
  if (link) out.push(`<a class="ext" href="${esc(link)}" target="_blank" rel="noreferrer" title="在 Gmail 中打开">在 Gmail 中打开 ↗</a>`);
  return `<div class="r-acts">${out.join("")}<button class="close" data-act="close" title="关闭 (Esc)" aria-label="关闭">✕</button></div>`;
}

function readerHtml(c) {
  const unread = isUnread(c);
  const its = itemsOf(c);
  const fresh = ui.snap[c.id]?.size || 0;
  return `<div class="conv ${travelled === c.id ? "travel" : ""}" data-conv="${c.id}">
    <header class="r-head">
      <div class="r-l1">
        <span class="r-meta mono"><span class="r-bucket">${esc(bucketName(c.bucket))}</span><span class="r-state ${unread || fresh ? "is-unread" : ""}">${unread ? "未读" : fresh ? `本次 ${fresh} 条新` : "已读"}</span><span class="r-stats">${its.length} 封 · ${participants(c).length} 人 · ${day(its[0]?.occurredAt || c.firstAt)} → ${day(lastIso(c))}</span></span>
        ${actsHtml(c)}
      </div>
      <div class="r-l2"><h2 class="r-title">${esc(c.title)}</h2>${chipsHtml(c)}</div>
    </header>
    <div class="r-body">
      ${c.update ? `<div class="r-update"><span class="r-update-l mono">自你上次查看</span><p>${esc(c.update)}</p></div>` : ""}
      <p class="r-summary">${esc(c.summary)}</p>
      ${c.threadIds.length > 1 && c.mergeReason ? `<p class="r-merge"><span class="mono">合并 ${c.threadIds.length} 个 thread</span>${esc(c.mergeReason)}</p>` : ""}
      ${timelineHtml(c)}
    </div>
  </div>`;
}

/* render */

const curTab = (secs) => (ui.tab === CLEARED ? CLEARED : currentSection(secs)?.id);

function render() {
  const secs = sections();
  if (ui.tab !== CLEARED) ui.tab = currentSection(secs)?.id ?? null;
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  document.title = unread ? `(${unread}) weir` : "weir";
  const app = $("#app");
  if (!app.firstElementChild) {
    app.innerHTML = `<div class="list"><div class="col"><header class="hd"><span class="plate" aria-hidden="true"></span><div class="hc"></div></header><div class="pane"></div></div></div><section class="reader" aria-label="对话"></section>`;
    new ResizeObserver(([e]) => $(".col").style.setProperty("--hd-h", `${Math.round(e.borderBoxSize[0].blockSize)}px`)).observe($(".hd"));
  }
  app.classList.toggle("split", !!ui.selected);
  renderHead(secs, curTab(secs));
  $(".pane").innerHTML = bodyHtml(secs, currentSection(secs));
  const reader = $(".reader");
  const sel = ui.selected && conv(ui.selected);
  const same = sel && reader.firstElementChild?.dataset.conv === sel.id;
  const top = reader.scrollTop;
  reader.innerHTML = sel ? readerHtml(sel) : "";
  if (same) reader.scrollTop = top;
}

/* transitions */

const fade = (el, ms = 180) => el?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: "ease-out" });

// Home and split share one column element; it slides between the centered slot and the list slot while the body keeps the anchor row steady.
function morph(x0, anchor) {
  const col = $(".col");
  const list = $(".list");
  let dy = 0;
  const now = anchor && anchor.find();
  if (now && anchor.y != null) {
    if (anchor.keep) list.scrollTop += now.getBoundingClientRect().top - anchor.y;
    dy = anchor.y - now.getBoundingClientRect().top;
  }
  const dx = x0 - col.getBoundingClientRect().left;
  if (RM.matches) {
    fade($(".hc"), 200);
    fade($(".pane"), 200);
    return;
  }
  col.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 560, easing: EASE });
  $(".pane").animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 560, easing: EASE });
  for (const el of [$(".hc"), $(".plate")]) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 200, easing: "ease-out", fill: "backwards" });
}

function openSplit(c) {
  const x0 = $(".col").getBoundingClientRect().left;
  const y0 = $(`.row[data-conv="${c.id}"]`)?.getBoundingClientRect().top;
  render();
  const reader = $(".reader");
  if (NARROW.matches) {
    RM.matches ? fade(reader) : reader.animate([{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 420, easing: EASE });
    return;
  }
  morph(x0, { y: y0, keep: true, find: () => $(`.row[data-conv="${c.id}"]`) });
  RM.matches ? fade(reader, 200) : reader.animate([{ opacity: 0, transform: "translateX(72px)" }, { opacity: 1, transform: "none" }], { duration: 520, delay: 80, easing: EASE, fill: "backwards" });
}

async function closeSplit() {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const reader = $(".reader");
    const out = NARROW.matches
      ? [{ transform: "none" }, { transform: "translateY(100%)" }]
      : [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(56px)" }];
    if (!RM.matches) await reader.animate(out, { duration: NARROW.matches ? 300 : 220, easing: EASE_IN, fill: "forwards" }).finished;
    const x0 = $(".col").getBoundingClientRect().left;
    const y0 = $(".pane").getBoundingClientRect().top;
    if (ui.selected) onLeave(ui.selected);
    ui.selected = null;
    render();
    for (const a of reader.getAnimations()) a.cancel();
    if (!NARROW.matches) morph(x0, { y: y0, keep: false, find: () => $(".pane") });
  } finally {
    ui.busy = false;
  }
}

function enterReader() {
  const c = $(".reader .conv");
  c?.animate(RM.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 260, easing: EASE });
}

function enterBody() {
  $(".pane").animate(RM.matches ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "none" }], { duration: 340, easing: EASE });
}

function ghostOf(c) {
  const row = $(`.row[data-conv="${c.id}"]`);
  return row && { el: row.cloneNode(true), top: row.offsetTop, h: row.offsetHeight };
}

// The leaving row is a clone laid over the re-rendered list: it lights up, slides off, and the rows under it close the gap.
function leaveRow(g, idx) {
  const rows = $(".rows");
  if (!g || !rows) return;
  const el = g.el;
  el.classList.add("ghost");
  el.classList.remove("sel");
  for (const a of ["data-open", "data-conv"]) el.removeAttribute(a);
  el.setAttribute("aria-hidden", "true");
  el.style.top = `${g.top}px`;
  rows.append(el);
  const after = $$(".row:not(.ghost)", rows).slice(Math.max(idx, 0));
  if (RM.matches) {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 240, fill: "forwards" }).finished.then(() => el.remove());
    return;
  }
  el.animate(
    [
      { transform: "none", opacity: 1 },
      { transform: "none", opacity: 1, offset: 0.38 },
      { transform: "translateX(72px)", opacity: 0 },
    ],
    { duration: 560, easing: EASE, fill: "forwards" },
  ).finished.then(() => el.remove());
  for (const r of after) r.animate([{ transform: `translateY(${g.h}px)` }, { transform: "none" }], { duration: 420, delay: 200, easing: EASE, fill: "backwards" });
}

/* actions */

function select(c) {
  if (ui.busy) return;
  const was = ui.selected;
  if (was === (c?.id ?? null)) return;
  if (!c) return closeSplit();
  const firstUnreadItemId = itemsOf(c).find((i) => Date.parse(i.occurredAt) > seenMs(c))?.id || null;
  if (was) onLeave(was);
  ui.selected = c.id;
  onOpen(c);
  if (!was) openSplit(c);
  else {
    render();
    enterReader();
    $(`.row[data-conv="${c.id}"]`)?.scrollIntoView({ block: "nearest" });
  }
  $(".reader").scrollTo(0, 0);
  afterOpen($(".reader"), c, firstUnreadItemId);
}

function step(d) {
  const list = currentList();
  if (!list.length) return;
  const idx = list.findIndex((c) => c.id === ui.selected);
  const next = list[idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + d))];
  if (next.id !== ui.selected) select(next);
}

function dismiss(c, mutate, msg) {
  if (ui.busy) return;
  const list = currentList();
  const idx = list.findIndex((x) => x.id === c.id);
  const undo = snapshot([c]);
  const ghost = ghostOf(c);
  mutate();
  toast(msg, undo);
  if (ui.selected !== c.id) {
    render();
    return leaveRow(ghost, idx);
  }
  const rest = list.filter((x) => x.id !== c.id);
  const next = rest[Math.min(idx, rest.length - 1)];
  if (!next) return closeSplit();
  const firstUnreadItemId = itemsOf(next).find((i) => Date.parse(i.occurredAt) > seenMs(next))?.id || null;
  onLeave(c.id);
  ui.selected = next.id;
  onOpen(next);
  render();
  enterReader();
  leaveRow(ghost, idx);
  $(`.row[data-conv="${next.id}"]`)?.scrollIntoView({ block: "nearest" });
  $(".reader").scrollTo(0, 0);
  afterOpen($(".reader"), next, firstUnreadItemId);
}

const done = (c) => dismiss(c, () => setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) }), `已完成「${c.title}」`);
const mute = (c) => dismiss(c, () => setS(c, { muted: true }), `已静音「${c.title}」，有新消息也不会再出现`);

function clearAll(bucketId) {
  const s = sections().find((x) => x.id === bucketId);
  if (!s?.convs.length || ui.busy) return;
  const undo = snapshot(s.convs);
  for (const c of s.convs) setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) });
  toast(`「${s.name}」${s.convs.length} 个对话已全部清掉`, undo);
  if (ui.selected) return closeSplit();
  render();
  enterBody();
}

function restore(c) {
  const idx = currentList().findIndex((x) => x.id === c.id);
  const ghost = ui.tab === CLEARED ? ghostOf(c) : null;
  setS(c, { clearedAt: null, muted: false });
  render();
  leaveRow(ghost, idx);
  toast(`已恢复「${c.title}」到「${bucketName(c.bucket)}」`);
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
  const muted = data.conversations.filter((c) => S(c).muted);
  const cleared = data.conversations.filter((c) => !S(c).muted && isCleared(c));
  const pool = ui.sims % 2 === 0 && muted.length ? muted : cleared.length ? cleared : muted;
  if (!pool.length) return toast("没有已完成或已静音的对话可以模拟");
  const c = pool[Math.floor(Math.random() * pool.length)];
  const now = new Date().toISOString();
  const item = { ...lastItem(c), id: `sim-${Date.now()}`, subject: `Re: ${c.title}`, bodyNew: "（模拟的新回复）", bodyQuoted: "", occurredAt: now };
  data.items.push(item);
  itemById[item.id] = item;
  c.itemIds = [...c.itemIds, item.id];
  c.lastAt = now;
  c.update = "（模拟）有新回复";
  render();
  if (S(c).muted) return toast(`「${c.title}」来了新回复：已静音，保持隐藏`);
  toast(`「${c.title}」来了新回复：重新出现在「${bucketName(c.bucket)}」（未读）`, null, {
    label: "查看",
    run: () => {
      ui.tab = c.bucket || NONE;
      select(c);
    },
  });
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act], [data-tab], [data-open]");
  if (!t || !t.closest("#app")) return;
  const act = t.dataset.act;
  const c = conv(t.dataset.conv || t.closest("[data-conv]")?.dataset?.conv);
  if (act === "quote") {
    const id = t.dataset.item;
    ui.showQuoted.has(id) ? ui.showQuoted.delete(id) : ui.showQuoted.add(id);
    return render();
  }
  if (act === "old") {
    ui.showOld.add(t.dataset.conv);
    return render();
  }
  if (act === "clearall") return clearAll(t.dataset.bucket);
  if (act === "done" && c) return done(c);
  if (act === "mute" && c) return mute(c);
  if (act === "restore" && c) {
    e.stopPropagation();
    return restore(c);
  }
  if (act === "unread" && c) {
    setS(c, { seenAt: new Date(lastMs(c) - 1).toISOString() });
    ui.snap[c.id] = new Set([lastItem(c).id]);
    return render();
  }
  if (act === "close") return select(null);
  if (t.dataset.tab) {
    if (ui.busy) return;
    const changed = t.dataset.tab !== ui.tab;
    ui.tab = t.dataset.tab;
    if (ui.selected) return closeSplit();
    if (!changed) return;
    render();
    return enterBody();
  }
  if (t.dataset.open !== undefined && c) return select(ui.selected === c.id ? null : c);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, select, textarea")) return;
  if (e.key === "Escape" && ui.selected) return select(null);
  if (e.key === "j") step(1);
  else if (e.key === "k") step(-1);
  else if (e.key === "e" && ui.selected) {
    const c = conv(ui.selected);
    if (!isHidden(c)) done(c);
  }
});

function afterOpen(reader, c, firstUnreadItemId) {
  const mark = firstUnreadItemId && reader.querySelector(".tl-mark");
  const cv = reader.querySelector(".conv");
  travelled = null;
  cv?.classList.remove("travel");
  if (!mark || !cv) return;
  cv.classList.add("arm");
  const sweep = () => cv.isConnected && cv.classList.add("sweep");
  const top = mark.getBoundingClientRect().top - reader.getBoundingClientRect().top;
  // Only travel when the marker is below the reading line; otherwise the summary stays in view and the sweep alone marks the boundary.
  if (top < reader.clientHeight * 0.55) return requestAnimationFrame(sweep);
  travelled = c.id;
  cv.classList.add("travel");
  reader.scrollTo({ top: top - reader.clientHeight * 0.3, behavior: RM.matches ? "auto" : "smooth" });
  if (RM.matches) return sweep();
  let fired = false;
  const go = () => !fired && ((fired = true), sweep());
  reader.addEventListener("scrollend", go, { once: true });
  setTimeout(go, 600);
}

new EventSource("/__reload").onmessage = () => location.reload();
load();
