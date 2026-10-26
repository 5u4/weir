const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-r5";
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const HUES = [29, 262, 158, 305, 75];
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "qq.com", "163.com", "126.com", "icloud.com", "me.com", "yahoo.com"]);

let data, source, storeKey, runs = [], runSlug = null, itemById, me, myName = "";
// convId -> { seenAt, clearedAt, muted }
let state = {};
const ui = {
  tab: null,
  selected: null,
  // Per open conversation; onLeave resets them.
  old: new Set(), // first item id of each expanded 之前 N 条 run
  orig: new Set(), // item ids whose bubble shows the English original
  full: new Set(), // item ids whose original is unclamped
  sumOpen: false,
  fold: false, // context card folded into its one-line bar
  anchor: null, // item id whose bubble must stay in view after the next paint
  jump: null, // item id to scroll to and flash after the next paint
  showQuoted: new Set(),
  snap: {}, // convId -> Set of item ids highlighted as new while the conversation is open
  sims: 0,
  busy: false,
  flash: false,
  tabJump: false,
  toast: null,
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
    document.body.textContent = "无法加载数据";
    return;
  }
  itemById = Object.fromEntries(data.items.map((i) => [i.id, i]));
  me = new Set(data.me.map((a) => a.toLowerCase()));
  const mine = data.items.find((i) => isMe(i.from) && i.from.name)?.from.name.trim().split(/\s+/) || [];
  myName = mine.length > 2 ? mine.slice(0, -1).join(" ") : mine[0] || "";
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
const lede = (c) => (c.summary || "").split(/(?<=。)|\n/)[0];
// Each bucket owns one hue: a light tint on the dark notch, a deep tone on the light ground and the reader island.
const hueOf = (id) => {
  const i = data.buckets.findIndex((b) => b.id === id);
  return i < 0 ? null : HUES[i % HUES.length];
};
const onDark = (h) => (h == null ? "oklch(0.86 0 0)" : `oklch(0.77 0.14 ${h})`);
const onLight = (h) => (h == null ? "oklch(0.5 0 0)" : `oklch(0.55 0.19 ${h})`);
const tint = (id) => `--c:${onDark(hueOf(id))};--cl:${onLight(hueOf(id))}`;

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
    s.unread = s.convs.filter(isUnread).length;
  }
  return out;
}

const clearedList = () => data.conversations.filter(isHidden).sort((a, b) => lastMs(b) - lastMs(a));
const currentSection = (secs) => secs.find((s) => s.id === ui.tab) || secs.find((s) => s.convs.length) || secs[0];
const currentList = () => (ui.tab === CLEARED ? clearedList() : currentSection(sections())?.convs || []);

function onOpen(c) {
  const seen = seenMs(c);
  ui.snap[c.id] = new Set(itemsOf(c).filter((i) => Date.parse(i.occurredAt) > seen).map((i) => i.id));
  if (isUnread(c)) setS(c, { seenAt: lastIso(c) });
}

function onLeave(id) {
  delete ui.snap[id];
  ui.old.clear();
  ui.orig.clear();
  ui.full.clear();
  ui.sumOpen = false;
  ui.fold = false;
}

function snapshot(cs) {
  const prev = cs.map((c) => [c.id, state[c.id] && { ...state[c.id] }]);
  return () => {
    for (const [id, s] of prev) s ? (state[id] = s) : delete state[id];
    save();
    render();
  };
}

let toastSeq = 0;
function toast(t) {
  ui.toast = { id: ++toastSeq, ...t };
  render();
}

const abs = (iso) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const day = (iso) => {
  const t = new Date(iso);
  return `${t.getMonth() + 1}/${t.getDate()}`;
};
function relShort(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 60) return "刚刚";
  if (d < 3600) return `${Math.floor(d / 60)} 分钟`;
  if (d < 86400) return `${Math.floor(d / 3600)} 小时`;
  if (d < 86400 * 7) return `${Math.floor(d / 86400)} 天`;
  return day(iso);
}
const short = (p) => (isMe(p) ? "我" : (p.name || p.addr.split("@")[0]).split(/\s+/)[0]);
const pad = (n) => String(n).padStart(2, "0");
const SRC = { Updates: "更新", Primary: "主要", Promotions: "推广", Sent: "已发送", Inbox: "收件箱", Social: "社交", Forums: "论坛" };
const srcName = (label) => {
  const k = String(label).split("·").pop().trim();
  return SRC[k] || k;
};

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

// Chinese enumeration: A、B、C和D. The 、 binds to the clause before it, 和 to the clause after it, and the sentence's
// opening and closing words bind to the first and last clause, so no function word starts or ends a line alone.
function enumerate(items, lead = "", end = "") {
  const n = items.length;
  return items
    .map((html, i) => {
      const and = n > 1 && i === n - 1 ? glue("和", "glue and") : "";
      const sep = i < n - 2 ? glue("、", "glue sep") : "";
      return `<span class="grp">${i === 0 ? lead : ""}${and}${html}${sep}${i === n - 1 ? end : ""}</span>`;
    })
    .join("");
}

function widgetHtml(s, v, active) {
  const on = s.id === active;
  const n = v === "main" ? s.unread : s.convs.length;
  const label = v === "main" ? `${n} 个「${s.name}」有更新` : v === "tail" ? `「${s.name}」还有 ${n} 个已读未清` : `「${s.name}」已清空`;
  const avs = v === "main" ? `<span class="avs">${senders(s.convs.filter(isUnread)).map(avatarHtml).join("")}</span>` : "";
  const count = v === "empty" ? "" : `<span class="w-n">${n}</span><span class="w-u">个</span>`;
  return `<button class="w w-${v} ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${s.id}" style="${tint(s.id)}" aria-pressed="${on}" aria-label="${esc(label)}">${avs}${count}<span class="w-name">「${esc(s.name)}」</span></button>`;
}

function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  return myName ? `${g}，${myName}。` : `${g}。`;
}

const markHtml = `<span class="mark">weir<i>堰</i></span>`;

function fullHtml(secs, active) {
  const hot = secs.filter((s) => s.unread);
  const quiet = secs.filter((s) => !s.unread && s.convs.length);
  const empty = secs.filter((s) => !s.convs.length);
  const cl = clearedList().length;
  const main = hot.length ? enumerate(hot.map((s) => widgetHtml(s, "main", active)), glue("你有", "glue lead"), glue("有更新。", "glue end")) : glue("全部看完了。", "allclear");
  const tail = [];
  if (quiet.length) tail.push(`<span class="cl">${enumerate(quiet.map((s) => widgetHtml(s, "tail", active)), glue("另有", "glue lead"), glue("已读未清。", "glue end"))}</span>`);
  if (empty.length) tail.push(`<span class="cl">${enumerate(empty.map((s) => widgetHtml(s, "empty", active)), "", glue(empty.length > 1 ? "都已清空。" : "已清空。", "glue end"))}</span>`);
  const on = active === CLEARED;
  tail.push(`<span class="cl"><span class="grp"><button class="w w-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${CLEARED}" aria-pressed="${on}"><span class="w-u">已清理</span><span class="w-n">${cl}</span><span class="w-u">个</span></button>${glue("。", "glue end")}</span></span>`);
  return `<div class="cap-meta">${markHtml}<span class="hello">${esc(greeting())}</span><span class="stamp" title="${esc(data.generatedAt)}">数据更新于 ${abs(data.generatedAt)}</span></div>
    <h1 class="s-main">${main}</h1>
    <p class="s-tail">${tail.join("")}</p>`;
}

function chipHtml(s, active) {
  const on = s.id === active;
  const kind = s.unread ? "hot" : s.convs.length ? "quiet" : "empty";
  const label = s.unread ? `「${s.name}」${s.unread} 个有更新` : s.convs.length ? `「${s.name}」${s.convs.length} 个已读未清` : `「${s.name}」已清空`;
  const avs = s.unread ? `<span class="avs">${senders(s.convs.filter(isUnread)).map(avatarHtml).join("")}</span>` : "";
  const n = kind === "empty" ? "" : `<span class="w-n">${s.unread || s.convs.length}</span>`;
  return `<button class="cw cw-${kind} ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${s.id}" style="${tint(s.id)}" aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}">${avs}${n}<span class="cw-name">${esc(s.name)}</span></button>`;
}

// Compact form keeps config order so a widget never changes place while counts move under it.
function pillHtml(secs, active) {
  const on = active === CLEARED;
  const cl = `<button class="cw cw-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-tab="${CLEARED}" aria-pressed="${on}" title="已清理的对话"><span class="cw-name">已清理</span><span class="w-n">${clearedList().length}</span></button>`;
  return `${markHtml}<span class="cap-div"></span><span class="cws">${secs.map((s) => chipHtml(s, active)).join("")}</span><span class="cap-div"></span>${cl}`;
}

// Toast form keeps only the bucket the action touched, so its count is the thing you watch change.
function toastNavHtml(secs, active) {
  const s = secs.find((x) => x.id === (ui.toast.bucket || NONE));
  return s ? chipHtml(s, active) : markHtml;
}

// The notch's shape follows (reading, toast): the sentence over the digest, a pill over a conversation. Over the digest a
// toast takes the sentence's top line instead of the whole notch, so the sentence never leaves while you read the digest.
const formOf = (reading) => (reading ? (ui.toast ? "toast" : "pill") : ui.toast ? "full-toast" : "full");
const isFull = (form) => form.startsWith("full");
const navHtml = (form, secs, active) => (form === "toast" ? toastNavHtml : form === "pill" ? pillHtml : fullHtml)(secs, active);

const ICON = {
  done: `<path d="M3.5 8.4l2.9 2.9L12.6 5"/>`,
  mute: `<path d="M4.6 10.8V7.3a3.4 3.4 0 0 1 6.1-2M11.4 7.6v3.2l1.3 1.4H5.4M6.9 13.9h2.2M2.6 2.6l10.8 10.8"/>`,
  clear: `<path d="M1.8 8.6l2.7 2.7L10.4 5M7.6 11l.3.3L13.8 5"/>`,
  restore: `<path d="M3.4 6.6h6.1a3.2 3.2 0 0 1 0 6.4H6.6M5.9 3.8L3.1 6.6l2.8 2.8"/>`,
  new: `<circle cx="8" cy="8" r="2.6"/>`,
};

let drain = null;
function paintToast(box) {
  const t = ui.toast;
  if (String(t?.id || "") === box.dataset.id) return;
  drain?.cancel();
  drain = null;
  box.dataset.id = t ? t.id : "";
  if (!t) return void (box.innerHTML = "");
  box.innerHTML = `<span class="tg tg-${t.kind}" style="${tint(t.bucket)}"><svg viewBox="0 0 16 16" aria-hidden="true">${ICON[t.kind]}</svg></span><span class="t-msg"><b>${esc(t.verb)}</b>${esc(t.obj || "")}${t.tail ? `<span class="t-tail">${esc(t.tail)}</span>` : ""}</span>${t.extra ? `<button class="t-btn" data-cap="extra">${esc(t.extra.label)}</button>` : ""}${t.undo ? `<button class="t-btn" data-cap="undo">撤销</button>` : ""}<span class="t-drain" aria-hidden="true"></span>`;
  drain = box.querySelector(".t-drain").animate([{ transform: "scaleX(1)" }, { transform: "scaleX(0)" }], { duration: 5000, easing: "linear", fill: "forwards" });
  const id = t.id;
  drain.finished.then(
    () => {
      if (ui.toast?.id !== id) return;
      ui.toast = null;
      render();
    },
    () => {},
  );
}

function paintCap(secs, reading) {
  const cap = $(".cap");
  const nav = $(".cap-nav");
  const active = ui.tab === CLEARED ? CLEARED : currentSection(secs)?.id;
  const before = new Map([...nav.querySelectorAll("[data-tab]")].map((el) => [el.dataset.tab, el.querySelector(".w-n")?.textContent]));
  const form = formOf(reading);
  cap.classList.toggle("compact", !isFull(form));
  cap.classList.toggle("toasting", !!ui.toast);
  nav.innerHTML = navHtml(form, secs, active);
  paintToast($(".cap-toast"));
  if (isFull(form)) root.style.setProperty("--cap-h", `${cap.offsetHeight}px`);
  const rm = reduceMotion.matches;
  // Counts change in place: the new numeral rolls in from the direction it moved.
  for (const el of nav.querySelectorAll("[data-tab]")) {
    const n = el.querySelector(".w-n");
    const p = before.get(el.dataset.tab);
    if (!n || p == null || p === n.textContent) continue;
    const up = Number(n.textContent) > Number(p);
    n.animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${up ? 0.7 : -0.7}em)` }, { opacity: 1, transform: "none" }], { duration: 460, delay: rm ? 0 : 200, easing: EASE, fill: "backwards" });
  }
}

function rowHtml(c) {
  const unread = isUnread(c);
  const its = itemsOf(c);
  const fresh = unread ? its.filter((i) => Date.parse(i.occurredAt) > seenMs(c)).length : 0;
  const tags = [...new Set(its.map((i) => srcName(i.sourceLabel)))];
  const line = unread && c.update ? esc(c.update) : esc(lede(c));
  const inCleared = ui.tab === CLEARED;
  const who = participants(c);
  const whoTxt = who.length > 2 ? `${who.slice(0, 2).join("、")} 等 ${who.length} 人` : who.join("、");
  const from = [...its].reverse().find((i) => !isMe(i.from))?.from || its.at(-1).from;
  const tail = inCleared
    ? `<span class="row-badge">${S(c).muted ? "已静音" : "已完成"}</span><button class="row-act restore" data-act="restore">恢复</button>`
    : `<button class="row-act" data-act="done" title="完成，不再出现在列表里">完成</button>`;
  return `<article class="row ${unread ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-k="r-${c.id}" data-conv="${c.id}" data-open tabindex="0" aria-current="${ui.selected === c.id}" style="${tint(c.bucket)}">
    <span class="row-av">${avatarHtml(from)}</span>
    <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
    <span class="row-line">${unread && c.update ? `<i class="row-new">新</i>` : ""}${line}</span>
    <span class="row-meta"><span class="row-who" title="${esc(who.join("、"))}">${esc(whoTxt)}</span><span class="row-n">${its.length} 封${fresh ? `，${fresh} 封新` : ""} · ${esc(tags.join(" · "))}</span></span>
    <span class="row-time" title="${esc(abs(lastIso(c)))}">${relShort(lastIso(c))}</span>
    ${tail}
  </article>`;
}

function listHtml(secs) {
  if (ui.tab === CLEARED) {
    const cl = clearedList();
    const muted = cl.filter((c) => S(c).muted).length;
    const head = `<div class="l-head"><h2 class="l-name">已清理</h2><span class="l-meta">${cl.length} 个 · 完成 ${cl.length - muted} · 静音 ${muted}</span></div>`;
    return head + (cl.length ? `<div class="rows cleared">${cl.map(rowHtml).join("")}</div>` : `<div class="empty"><p class="empty-big">还没有清理过的对话。</p><p class="empty-sub">完成或静音的对话会放在这里，随时可以恢复。</p></div>`);
  }
  const cur = currentSection(secs);
  const head = `<div class="l-head" style="${tint(cur.id)}"><h2 class="l-name">「${esc(cur.name)}」</h2><span class="l-meta">${cur.convs.length} 个对话${cur.unread ? ` · ${cur.unread} 个未读` : cur.convs.length ? " · 都读过了" : ""}</span>${cur.convs.length ? `<button class="clearall" data-act="clearall" data-bucket="${cur.id}">全部清掉</button>` : ""}</div>`;
  return head + (cur.convs.length ? `<div class="rows">${cur.convs.map(rowHtml).join("")}</div>` : `<div class="empty"><p class="empty-big">「${esc(cur.name)}」清空了。</p><p class="empty-sub">有新消息时，对话会以未读状态回到这里。</p></div>`);
}

// The reader is never blank: with nothing open it briefs the selected bucket, one line per unread conversation.
function digestHtml(secs) {
  if (ui.tab === CLEARED) return calmHtml(secs, null);
  const cur = currentSection(secs);
  const fresh = cur.convs.filter(isUnread);
  if (!fresh.length) return calmHtml(secs, cur);
  const read = cur.convs.length - fresh.length;
  const line = (c, i) => {
    const from = [...itemsOf(c)].reverse().find((x) => !isMe(x.from))?.from || lastItem(c).from;
    return `<li><button class="dg-item" data-open data-conv="${c.id}" style="${tint(c.bucket)}">
      <span class="dg-i">${pad(i + 1)}</span>
      <span class="dg-meta">${avatarHtml(from)}<b>${esc(c.title)}</b></span>
      <span class="dg-time" title="${esc(abs(lastIso(c)))}">${relShort(lastIso(c))}</span>
      <span class="dg-line">${esc(c.update || lede(c))}</span>
    </button></li>`;
  };
  return `<div class="dg" style="${tint(cur.id)}">
    <header class="dg-head"><h2 class="dg-name">「${esc(cur.name)}」</h2><p class="dg-sum"><b>${fresh.length}</b> 个有更新<span>共 ${cur.convs.length} 个对话${read ? `，${read} 个已读` : ""}</span></p></header>
    <ol class="dg-list">${fresh.map(line).join("")}</ol>
  </div>`;
}

function calmHtml(secs, cur) {
  const others = secs.filter((s) => s !== cur && s.convs.length);
  const hot = others.filter((s) => s.unread);
  const quiet = others.filter((s) => !s.unread);
  const cl = clearedList();
  const tail = [];
  if (hot.length) tail.push(enumerate(hot.map((s) => widgetHtml(s, "main", null)), glue(cur ? "别处还有" : "你有", "glue lead"), glue("有更新。", "glue end")));
  if (quiet.length) tail.push(enumerate(quiet.map((s) => widgetHtml(s, "tail", null)), glue("另有", "glue lead"), glue("已读未清。", "glue end")));
  if (cur) tail.push(`<span class="grp"><button class="w w-cl" data-tab="${CLEARED}"><span class="w-u">已清理</span><span class="w-n">${cl.length}</span><span class="w-u">个</span></button>${glue("。", "glue end")}</span>`);
  let big, sub;
  if (!cur) {
    const muted = cl.filter((c) => S(c).muted).length;
    big = cl.length ? `已清理 ${cl.length} 个对话。` : "还没有清理过的对话。";
    sub = cl.length ? `完成 ${cl.length - muted} 个，静音 ${muted} 个。打开左边任意一个可以看原文，点 恢复 让它回到原来的分类。` : "完成或静音的对话会放在这里，随时可以恢复。";
  } else if (cur.convs.length) {
    big = "这里没有新的了。";
    sub = `「${esc(cur.name)}」还有 ${cur.convs.length} 个读过的对话没清。看完的点 完成，或者 <button class="calm-act" data-act="clearall" data-bucket="${cur.id}">全部清掉</button>`;
  } else {
    big = "这里看完了。";
    sub = `「${esc(cur.name)}」没有待处理的对话。有新消息时，对话会以未读回到这里。`;
  }
  return `<div class="calm" ${cur ? `style="${tint(cur.id)}"` : ""}>
    <h2 class="calm-big">${big}</h2>
    <p class="calm-sub">${sub}</p>
    ${tail.length ? `<p class="calm-tail">${tail.join("")}</p>` : ""}
  </div>`;
}

function relText(c) {
  const its = itemsOf(c);
  const out = [];
  if (its.some((i) => i.to.some(isMe))) out.push("直接发给我");
  if (its.some((i) => i.cc.some(isMe))) out.push("抄送我");
  if (its.some((i) => isMe(i.from))) out.push("我参与过");
  if (c.threadIds.length > 1) out.push(`合并了 ${c.threadIds.length} 个邮件串`);
  return out;
}

const KINDS = { ask: "要你做", decision: "已决定", date: "时间", info: "信息" };
const WEEK = "日一二三四五六";
const hm = (iso) => {
  const t = new Date(iso);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
};
const dayKey = (iso) => new Date(iso).toDateString();
const dayLabel = (iso) => {
  const t = new Date(iso);
  return `${t.getMonth() + 1}月${t.getDate()}日 周${WEEK[t.getDay()]}`;
};
// GitHub notification bodies arrive as markdown with inline HTML; the reader shows that HTML as plain text.
const TAGS = /<\/?(?:details|summary|picture|source|img|sub|sup|br|div|span|p|a|b|i|em|strong|code|kbd|table|thead|tbody|tr|td|th|ul|ol|li|hr|h[1-6]|blockquote|pre|g-emoji)\b[^<>]*>/gi;
const stripTags = (s) => (s || "").replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(TAGS, "");
// Review notifications paste suggestion hunks as bare "-    code" lines, which markdown reads as nested lists of code
// blocks. Fence each run of such lines as a diff and keep tag stripping out of the fences.
const DIFF = /^(?:[+\->] {2,}\S|[+-]\s*$)/;
function originalMd(s) {
  const out = [];
  let hunk = [];
  const flush = () => {
    if (hunk.length > 2) out.push("```diff", ...hunk, "```");
    else out.push(...hunk.map(stripTags));
    hunk = [];
  };
  for (const line of (s || "").replace(/<!--[\s\S]*?-->/g, "").split("\n")) {
    if (DIFF.test(line)) hunk.push(line.replace(/^>/, " "));
    else {
      flush();
      out.push(stripTags(line));
    }
  }
  flush();
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
  return p.match(/^.{8,}?[.!?。！？](?=\s|$)/)?.[0] || p || "（没有正文）";
};
const srcTag = (i) => (i.synthetic ? i.sourceLabel : srcName(i.sourceLabel));

/* The stream as flat rows: day breaks, the 上次读到这里 divider, collapsed read runs, and runs of one sender.
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
    if (group?.from.addr.toLowerCase() !== i.from.addr.toLowerCase()) {
      group = { k: "group", from: i.from, me: isMe(i.from), msgs: [] };
      rows.push(group);
    }
    group.msgs.push(e);
  }
  return rows;
}

function gistHtml(i) {
  return i.gist ? `<span class="gist">${esc(i.gist)}</span>` : `<span class="gist fb" lang="en" title="${esc(firstSentence(i.bodyNew))}">${esc(firstSentence(i.bodyNew))}</span>`;
}

function bubbleHtml(c, { i, n }) {
  const fresh = ui.snap[c.id]?.has(i.id) ? "new" : "";
  const time = `<time datetime="${esc(i.occurredAt)}" title="${esc(abs(i.occurredAt))}">${hm(i.occurredAt)}</time>`;
  if (!ui.orig.has(i.id))
    return `<div class="bb ${fresh} ${i.gist ? "" : "fbk"}" data-item="${i.id}">${gistHtml(i)}<span class="b-meta">${time}<button class="b-o" data-act="orig" data-item="${i.id}" aria-label="看第 ${n} 条的英文原文">原文</button></span></div>`;
  const full = ui.full.has(i.id);
  const q = ui.showQuoted.has(i.id);
  const body = i.bodyNew.trim() ? originalMd(i.bodyNew) : `<p class="b-none">（没有正文）</p>`;
  return `<div class="bb orig ${fresh}" data-item="${i.id}">
    <div class="b-bar"><button class="b-back" data-act="orig" data-item="${i.id}" aria-label="收起原文，回到中文">中文</button><span class="b-cap">${esc(i.gist || firstSentence(i.bodyNew))}</span><span class="b-at">#${n} · ${time}</span>${full ? `<button class="b-full" data-act="full" data-item="${i.id}">收起全文</button>` : `<button class="b-full" data-act="full" data-item="${i.id}">全文</button>`}</div>
    <div class="body ${full ? "" : "clamp"}" lang="en">${body}</div>
    ${i.bodyQuoted ? `<button class="q-toggle" data-act="quote" data-item="${i.id}" aria-expanded="${q}">${q ? "收起引用" : "显示引用"}</button>${q ? `<div class="quoted" lang="en">${esc(i.bodyQuoted)}</div>` : ""}` : ""}
  </div>`;
}

// In a group chat everyone shares one org favicon, so people who share a domain get their own monogram instead.
function groupHtml(c, g, tag, shared) {
  const name = g.me ? "我" : g.from.name || g.from.addr;
  return `<section class="sg ${g.me ? "me" : ""}">
    ${g.me ? "" : `<span class="g-av">${avatarHtml(g.from, shared.has(orgDomain(g.from.addr)))}</span>`}
    <div class="g-col"><div class="g-head"><b title="${esc(g.from.addr)}">${esc(name)}</b>${tag ? `<span class="g-src">${esc(tag)}</span>` : ""}</div>${g.msgs.map((e) => bubbleHtml(c, e)).join("")}</div>
  </section>`;
}

function olderHtml(items) {
  const who = [];
  for (const i of items) if (!who.includes(short(i.from))) who.push(short(i.from));
  const whoTxt = who.length > 3 ? `${who.slice(0, 3).join("、")} 等 ${who.length} 人` : who.join("、");
  const a = day(items[0].occurredAt);
  const b = day(items.at(-1).occurredAt);
  return `<button class="older" data-act="old" data-item="${items[0].id}"><span class="o-n">之前 ${items.length} 条</span><span class="o-span">${a === b ? a : `${a} – ${b}`} · ${esc(whoTxt)}</span><span class="o-go">展开</span></button>`;
}

function streamHtml(c) {
  const addrs = new Map();
  for (const i of itemsOf(c)) addrs.set(i.from.addr.toLowerCase(), orgDomain(i.from.addr));
  const per = new Map();
  for (const d of addrs.values()) per.set(d, (per.get(d) || 0) + 1);
  const shared = new Set([...per].filter(([, n]) => n > 1).map(([d]) => d));
  // A source tag only shows where it changes, so a one-channel chat says where it is once.
  let prevTag = null;
  return streamRows(c)
    .map((r) => {
      if (r.k === "day") return `<div class="day" role="separator"><span>${dayLabel(r.iso)}</span></div>`;
      if (r.k === "mark") return `<div class="lr" role="separator"><span><b>${r.first ? "从这里开始都是新的" : "上次读到这里"}</b>${r.n} 条新</span></div>`;
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
  const acts = [`<button class="back" data-act="close" aria-label="返回">‹</button>`];
  if (isHidden(c)) acts.push(b("restore", `恢复（${st.muted ? "已静音" : "已完成"}）`, "primary"));
  else acts.push(b("done", `完成<kbd>E</kbd>`, "primary"));
  if (!unread) acts.push(b("unread", "标为未读"));
  if (!st.muted) acts.push(b("mute", "静音"));
  const link = lastItem(c)?.link;
  if (link) acts.push(`<a class="ext" href="${esc(link)}" target="_blank" rel="noreferrer">在 Gmail 中打开 ↗</a>`);
  return `<div class="r-dock" data-conv="${c.id}" style="${tint(c.bucket)}">${acts.join("")}</div><button class="r-x" data-act="close" title="关闭 (Esc)" aria-label="关闭">✕</button>`;
}

function pointsHtml(c) {
  const pts = (c.points || []).filter((p) => itemById[p.itemId]);
  if (!pts.length) return "";
  const rows = pts.map((p) => {
    const n = c.itemIds.indexOf(p.itemId) + 1;
    return `<li><button class="pt" data-act="jump" data-item="${p.itemId}" title="跳到第 ${n} 条"><i class="pk pk-${p.kind}">${KINDS[p.kind] || "信息"}</i><span class="pt-t">${esc(p.text)}</span><span class="pt-n">#${n}</span></button></li>`;
  });
  return `<ol class="pts" aria-label="要点">${rows.join("")}</ol>`;
}

/* Summary, update and points pinned under the notch. Folded, the card retracts up into the notch's band and leaves
   a one-line bar; the stream scrolls underneath both. */
function ctxHtml(c) {
  const its = itemsOf(c);
  const fresh = ui.snap[c.id]?.size || 0;
  const rel = relText(c);
  const nPts = (c.points || []).length;
  const merge = c.threadIds.length > 1 && c.mergeReason;
  return `<div class="ctx ${ui.fold ? "fold" : ""}">
    <div class="ctx-full">
      <p class="r-crumb"><b>「${esc(bucketName(c.bucket))}」</b><span>${fresh ? `本次 ${fresh} 条新` : "已读"}</span><span>${its.length} 条 · ${participants(c).length} 人</span><span>${day(its[0]?.occurredAt || c.firstAt)} – ${day(lastIso(c))}</span>${rel.map((r) => `<span class="rel">${r}</span>`).join("")}</p>
      <h2 class="r-title">${esc(c.title)}</h2>
      <div class="ctx-sumrow"><p class="ctx-sum ${ui.sumOpen ? "open" : ""}">${esc(c.summary)}${ui.sumOpen && merge ? `<span class="ctx-merge">${esc(c.mergeReason)}</span>` : ""}</p><button class="ctx-more" data-act="sum" aria-expanded="${ui.sumOpen}">${ui.sumOpen ? "收起" : "展开摘要"}</button></div>
      ${c.update ? `<p class="ctx-up"><span class="ctx-k">自你上次查看</span>${esc(c.update)}</p>` : ""}
      ${pointsHtml(c)}
    </div>
    <button class="ctx-bar" data-act="unfold" tabindex="${ui.fold ? 0 : -1}" aria-label="展开摘要和要点"><span class="cb-dot"></span><b>${esc(c.title)}</b><span class="cb-meta">${fresh ? `${fresh} 条新` : `${its.length} 条`}${nPts ? ` · ${nPts} 个要点` : ""}</span><span class="cb-go">摘要和要点</span></button>
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

/* After a paint: size the stream under the card, then land, keep, anchor or jump. keepTop is the scroll position to keep
   when the same conversation repaints, or null when it was just opened. */
function settleReader(keepTop) {
  const st = $(".st");
  const full = $(".ctx-full");
  const sum = $(".ctx-sum");
  if (!ui.sumOpen && sum.scrollHeight <= sum.clientHeight + 2) $(".ctx-more").remove();
  for (const b of st.querySelectorAll(".body.clamp"))
    if (b.scrollHeight <= b.clientHeight + 4) {
      b.classList.add("fits");
      b.closest(".bb").querySelector(".b-full")?.remove();
    }
  const h = full.offsetHeight;
  st.style.setProperty("--ctx-h", `${h}px`);
  st.style.setProperty("--bar-h", `${$(".ctx-bar").offsetHeight + 12}px`);
  setFold(ui.fold);
  if (keepTop != null) st.scrollTop = keepTop;
  else {
    const mark = st.querySelector(".lr");
    st.scrollTop = mark ? Math.max(0, mark.offsetTop - h - 4) : 0;
  }
  const vis = () => (ui.fold ? $(".ctx-bar").offsetHeight + 12 : h);
  const anchor = ui.anchor && bubble(st, ui.anchor);
  ui.anchor = null;
  if (anchor && topIn(st, anchor) < vis()) st.scrollTop += topIn(st, anchor) - vis() - 8;
  const jump = ui.jump && bubble(st, ui.jump);
  ui.jump = null;
  if (jump) {
    setFold(true);
    st.scrollTo({ top: st.scrollTop + topIn(st, jump) - vis() - 16, behavior: reduceMotion.matches ? "auto" : "smooth" });
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
  const reading = !!(ui.selected && conv(ui.selected));
  const kind = !last ? null : reading !== last.reading ? "mode" : (ui.toast?.id || 0) !== last.toastId ? "toast" : capKey(secs, reading) !== last.key ? "tick" : null;
  if (!kind || !document.startViewTransition || reduceMotion.matches || document.hidden) return paint(kind);
  root.classList.toggle("vt-mode", kind === "mode");
  // Over the digest a toast only swaps the notch's top line, so the notch crossfades instead of morphing.
  const types = kind === "mode" ? ["mode", reading ? "open" : "close"] : [kind === "toast" && !reading ? "tick" : kind];
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
  // Pin the bucket, so emptying it leaves you on its 这里看完了 state instead of jumping to the next bucket.
  ui.tab ??= currentSection(secs)?.id;
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  document.title = unread ? `(${unread}) weir` : "weir";
  const sel = ui.selected && conv(ui.selected);
  const reading = !!sel;
  const mode = !!last && last.reading !== reading;
  const prevConv = last?.conv || "";
  const listTop = $(".list")?.scrollTop || 0;
  const readerTop = ($(".st") || $(".r-scroll"))?.scrollTop || 0;
  const rkey = sel ? sel.id : `digest:${ui.tab}`;
  const capH = root.style.getPropertyValue("--cap-h");
  const prev = last ? capture() : null;
  app.classList.toggle("reading", reading);
  app.innerHTML = `<div class="list">${listHtml(secs)}</div><section class="reader" aria-label="阅读"><div class="r-scroll ${sel ? "pane" : ""}">${sel ? readerHtml(sel) : digestHtml(secs)}</div>${sel ? dockHtml(sel) : ""}</section>`;
  paintCap(secs, reading);
  ui.flash = false;
  // Both columns are rebuilt on every paint but never move, so each keeps the scroll position it had.
  const list = $(".list");
  list.scrollTop = ui.tabJump ? 0 : listTop;
  ui.tabJump = false;
  if (reading && sel.id !== prevConv) keepVisible(list, sel.id);
  if (reading) settleReader(rkey === last?.rkey ? readerTop : null);
  else if (rkey === last?.rkey) $(".r-scroll").scrollTop = readerTop;
  if (prev) play(prev);
  const rm = reduceMotion.matches;
  const form = formOf(reading);
  if (!viaVT && last && (mode || form !== last.form)) {
    for (const el of [$(".cap"), mode && $(".r-scroll"), mode && reading && $(".r-dock")]) el && el.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
  } else if (!viaVT && !mode && reading && prevConv && sel.id !== prevConv && !rm) {
    $(".conv").animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
  }
  // On a phone the list hangs below the expanded notch; when the sentence re-wraps, slide the list instead of jumping.
  const capH2 = root.style.getPropertyValue("--cap-h");
  if (narrow.matches && !reading && capH && capH !== capH2 && !rm) list.animate([{ transform: `translateY(${parseFloat(capH) - parseFloat(capH2)}px)` }, { transform: "none" }], { duration: 520, easing: EASE });
  last = { reading, form, key: capKey(secs, reading), toastId: ui.toast?.id || 0, conv: sel ? sel.id : "", rkey };
}

function select(c) {
  if (ui.selected) onLeave(ui.selected);
  ui.selected = c ? c.id : null;
  if (c) onOpen(c);
  render();
}

function step(d) {
  const list = currentList();
  if (!list.length) return;
  const idx = list.findIndex((c) => c.id === ui.selected);
  const next = list[idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + d))];
  if (next.id !== ui.selected) select(next);
}

async function beforeHide(c) {
  const row = $(`.row[data-conv="${c.id}"]`);
  if (!row || reduceMotion.matches) return;
  const a = row.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateX(40px)" }], { duration: 240, easing: EASE, fill: "forwards" });
  await Promise.race([a.finished, new Promise((r) => setTimeout(r, 600))]);
}

// Hide c (via mutate), then move selection to the row that took its place.
async function dismiss(c, mutate, t) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const list = currentList();
    const idx = list.findIndex((x) => x.id === c.id);
    const undo = snapshot([c]);
    await beforeHide(c);
    mutate();
    if (ui.selected === c.id) {
      onLeave(c.id);
      ui.selected = null;
      const rest = list.filter((x) => x.id !== c.id);
      const next = rest[Math.min(idx, rest.length - 1)];
      if (next) select(next);
    }
    toast({ ...t, undo, bucket: c.bucket });
  } finally {
    ui.busy = false;
  }
}

const done = (c) => dismiss(c, () => setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) }), { kind: "done", verb: "已完成", obj: `「${c.title}」` });
const mute = (c) => dismiss(c, () => setS(c, { muted: true }), { kind: "mute", verb: "已静音", obj: `「${c.title}」`, tail: "，有新消息也不再出现" });

function restore(c) {
  const undo = snapshot([c]);
  setS(c, { clearedAt: null, muted: false });
  toast({ kind: "restore", verb: "已恢复", obj: `「${c.title}」`, tail: `，回到「${bucketName(c.bucket)}」`, undo, bucket: c.bucket });
}

function clearAll(bucketId) {
  const s = sections().find((x) => x.id === bucketId);
  if (!s?.convs.length) return;
  const undo = snapshot(s.convs);
  for (const c of s.convs) setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) });
  if (s.convs.some((c) => c.id === ui.selected)) {
    onLeave(ui.selected);
    ui.selected = null;
  }
  toast({ kind: "clear", verb: "已清掉", obj: `「${s.name}」的 ${s.convs.length} 个对话`, undo, bucket: s.id });
}

function reset() {
  state = {};
  save();
  ui.selected = null;
  ui.snap = {};
  ui.toast = null;
  render();
}

function simulate() {
  ui.sims++;
  const muted = data.conversations.filter((c) => S(c).muted);
  const cleared = data.conversations.filter((c) => !S(c).muted && isCleared(c));
  const pool = ui.sims % 2 === 0 && muted.length ? muted : cleared.length ? cleared : muted;
  if (!pool.length) return toast({ kind: "new", verb: "没有可模拟的对话", tail: "：先完成或静音一个" });
  const c = pool[Math.floor(Math.random() * pool.length)];
  const now = new Date().toISOString();
  const item = { ...lastItem(c), id: `sim-${Date.now()}`, subject: `Re: ${c.title}`, bodyNew: "（模拟的新回复）", bodyQuoted: "", occurredAt: now };
  data.items.push(item);
  itemById[item.id] = item;
  c.itemIds = [...c.itemIds, item.id];
  c.lastAt = now;
  c.update = "（模拟）有新回复";
  if (S(c).muted) return toast({ kind: "mute", verb: "新回复", obj: `「${c.title}」`, tail: "：已静音，保持隐藏", bucket: c.bucket });
  toast({
    kind: "new",
    verb: "新回复",
    obj: `「${c.title}」`,
    tail: `，回到了「${bucketName(c.bucket)}」`,
    bucket: c.bucket,
    extra: {
      label: "查看",
      run: () => {
        ui.tab = c.bucket || NONE;
        ui.tabJump = true;
        select(c);
      },
    },
  });
}

const cap = $(".cap");
cap.addEventListener("pointerenter", () => drain?.pause());
cap.addEventListener("pointerleave", () => cap.matches(":focus-within") || drain?.play());
cap.addEventListener("focusin", () => drain?.pause());
cap.addEventListener("focusout", (e) => cap.contains(e.relatedTarget) || cap.matches(":hover") || drain?.play());

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act], [data-tab], [data-open], [data-cap]");
  if (!t || !t.closest("#app, .cap")) return;
  if (t.dataset.cap) {
    const tt = ui.toast;
    if (!tt) return;
    ui.toast = null;
    return t.dataset.cap === "undo" ? tt.undo() : (tt.extra.run(), render());
  }
  const act = t.dataset.act;
  const c = conv(t.dataset.conv || t.closest("[data-conv]")?.dataset?.conv);
  const id = t.dataset.item;
  // Every collapse anchors its bubble, so closing a long original never leaves you scrolled past it.
  if (act === "quote") {
    ui.showQuoted.has(id) ? (ui.showQuoted.delete(id), (ui.anchor = id)) : ui.showQuoted.add(id);
    return render();
  }
  if (act === "orig") {
    ui.orig.has(id) ? (ui.orig.delete(id), ui.full.delete(id)) : ui.orig.add(id);
    ui.anchor = id;
    return render();
  }
  if (act === "full") {
    ui.full.has(id) ? (ui.full.delete(id), (ui.anchor = id)) : ui.full.add(id);
    return render();
  }
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
  if (t.dataset.open !== undefined && c) return select(ui.selected === c.id ? null : c);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, select, textarea")) return;
  if (e.key === "Escape" && ui.selected) return select(null);
  if (e.key === "Enter" && e.target.matches?.(".row")) return e.target.click();
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
