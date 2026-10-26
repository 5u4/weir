const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-r5";
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const HUES = [29, 262, 158, 305, 75];
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "qq.com", "163.com", "126.com", "icloud.com", "me.com", "yahoo.com"]);

let data, source, storeKey, runs = [], runSlug = null, itemById, me;
// convId -> { seenAt, clearedAt, muted }
let state = {};
const ui = {
  tab: null,
  selected: null,
  // Per open conversation; onLeave resets them.
  old: new Set(), // first item id of each expanded 之前 N 条 run
  sumOpen: false,
  fold: false, // context card folded into its one-line bar
  jump: null, // item id to scroll to and flash after the next paint
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
// Each bucket owns one hue. The inline style carries only the hue; style.css turns it into a tone per surface and theme.
const hueOf = (id) => {
  const i = data.buckets.findIndex((b) => b.id === id);
  return i < 0 ? null : HUES[i % HUES.length];
};
const tint = (id) => {
  const h = hueOf(id);
  return h == null ? "--bh:0;--bk:0" : `--bh:${h};--bk:1`;
};

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
  return `<h1 class="s-main">${main}</h1>
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
  return `<span class="cws">${secs.map((s) => chipHtml(s, active)).join("")}</span><span class="cap-div"></span>${cl}`;
}

// Toast form keeps only the bucket the action touched, so its count is the thing you watch change.
function toastNavHtml(secs, active) {
  const s = secs.find((x) => x.id === (ui.toast.bucket || NONE));
  return s ? chipHtml(s, active) : "";
}

// The notch's shape follows (reading, toast): the sentence over the digest, a pill over a conversation. Over the digest a
// toast takes the sentence's top line instead of the whole notch, so the sentence never leaves while you read the digest.
const formOf = (reading) => (reading ? (ui.toast ? "toast" : "pill") : ui.toast ? "full-toast" : "full");
const isFull = (form) => form.startsWith("full");
const navHtml = (form, secs, active) => (form === "toast" ? toastNavHtml : form === "pill" ? pillHtml : fullHtml)(secs, active);

// Drawn, not the ✕ character: each engine falls back to a different font for it.
const X_ICON = `<svg class="x-i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>`;
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
  const tags = [...new Set(its.map(srcTag))];
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
  return p.match(/^.{8,}?[.!?。！？](?=\s|$)/)?.[0] || p || "（没有正文）";
};
// The tag names where a message was said. A mail thread is one place whatever folder each copy sits in, so mail tags
// by app; a chat tags by channel.
const srcTag = (i) => (srcApp(i) === "Teams" ? i.sourceLabel : `${srcApp(i)}${i.synthetic ? "（合成）" : ""}`);

const TIME_GAP = 5 * 60 * 1000;

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
    const prev = group?.msgs.at(-1).i;
    if (prev?.from.addr.toLowerCase() !== i.from.addr.toLowerCase() || Date.parse(i.occurredAt) - Date.parse(prev.occurredAt) >= TIME_GAP) {
      group = { k: "group", from: i.from, me: isMe(i.from), at: i.occurredAt, msgs: [] };
      rows.push(group);
    }
    group.msgs.push(e);
  }
  return rows;
}

function gistHtml(i) {
  return i.gist ? `<span class="gist">${esc(i.gist)}</span>` : `<span class="gist fb">${esc(firstSentence(i.bodyNew))}</span>`;
}

function bubbleHtml({ i }) {
  return `<div class="bl"><div class="bb ${i.gist ? "" : "fbk"}" data-item="${i.id}">${gistHtml(i)}</div></div>`;
}

// In a group chat everyone shares one org favicon, so people who share a domain get their own monogram instead.
function groupHtml(c, g, tag, shared) {
  const name = g.me ? "我" : g.from.name || g.from.addr;
  return `<section class="sg ${g.me ? "me" : ""}">
    ${g.me ? "" : `<span class="g-av">${avatarHtml(g.from, shared.has(orgDomain(g.from.addr)))}</span>`}
    <div class="g-col"><div class="g-head"><b title="${esc(g.from.addr)}">${esc(name)}</b>${tag ? `<span class="g-src">${esc(tag)}</span>` : ""}<time datetime="${esc(g.at)}" title="${esc(abs(g.at))}">${hm(g.at)}</time></div>${g.msgs.map(bubbleHtml).join("")}</div>
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
  acts.push(`<button data-act="tx" aria-haspopup="dialog">原文</button>`);
  const last = lastItem(c);
  if (last?.link) acts.push(`<a class="ext" href="${esc(last.link)}" target="_blank" rel="noreferrer">在 ${esc(srcApp(last))} 中打开 ↗</a>`);
  return `<div class="r-dock" data-conv="${c.id}" style="${tint(c.bucket)}">${acts.join("")}</div><button class="r-x" data-act="close" title="关闭 (Esc)" aria-label="关闭">${X_ICON}</button>`;
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
      ${c.update ? `<p class="r-update"><span class="r-label">自你上次查看</span>${esc(c.update)}</p>` : ""}
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
    st.scrollTo({ top: st.scrollTop + topIn(st, jump) - cardH() - 16, behavior: reduceMotion.matches ? "auto" : "smooth" });
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

/* 原文对照: the whole conversation as a parallel text, gists on the left, originals on the right.
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
      L.push(`<li class="tx-lr" aria-hidden="true"><span>上次读到这里</span></li>`);
      R.push(`<div class="tx-lr" role="separator"><span>上次读到这里</span></div>`);
    }
    const me = isMe(i.from);
    const cls = `${i.id === picked ? "picked" : ""} ${fresh.has(i.id) ? "new" : ""} ${me ? "me" : ""}`;
    const gist = esc(i.gist || firstSentence(i.bodyNew));
    const tnew = fresh.has(i.id) ? `<i class="tx-new">新</i>` : "";
    L.push(`<li class="xg ${cls}" data-item="${i.id}"><button class="xg-b" data-tx="go" data-item="${i.id}"><span class="xg-meta"><b class="tx-n">#${n}</b><span class="xg-who">${esc(short(i.from))}</span><time datetime="${esc(i.occurredAt)}">${hm(i.occurredAt)}</time>${tnew}</span><span class="xg-gist"><span>${gist}</span><span class="xg-w" aria-hidden="true">${gist}</span></span></button></li>`);
    const tag = srcTag(i);
    const showTag = tag !== prevTag;
    prevTag = tag;
    R.push(`<article class="to ${cls}" data-item="${i.id}" tabindex="-1" aria-labelledby="toh-${j}">
      <header class="to-h" id="toh-${j}"><span class="to-av">${avatarHtml(i.from, shared.has(orgDomain(i.from.addr)))}</span><span class="to-who"><b>${esc(me ? "我" : i.from.name || i.from.addr)}</b><span class="to-addr">${esc(i.from.addr)}</span></span><span class="to-meta"><span class="to-src ${showTag ? "" : "same"}">${esc(tag)}</span><time datetime="${esc(i.occurredAt)}">${abs(i.occurredAt)}</time><b class="tx-n">#${n}</b></span></header>
      <p class="to-lede">${gist}</p>
      <div class="body">${i.bodyNew.trim() ? originalMd(i.bodyNew) : `<p class="b-none">（没有正文）</p>`}</div>
      ${i.bodyQuoted ? `<button class="q-toggle" data-tx="quote" data-item="${i.id}" aria-expanded="false">显示引用</button>` : ""}
    </article>`);
  });
  return `<div class="tx-scrim" data-tx="close"></div>
  <div class="tx-sheet">
    <header class="tx-head">
      <div class="tx-id"><p class="tx-crumb"><b>「${esc(bucketName(c.bucket))}」</b><span>${its.length} 条 · ${participants(c).length} 人</span><span>${day(its[0].occurredAt)} – ${day(lastIso(c))}</span></p><h2 class="tx-title" id="tx-title">${esc(c.title)}</h2></div>
      <button class="tx-x" data-tx="close" aria-label="关闭" title="关闭 (Esc)">${X_ICON}</button>
    </header>
    <div class="tx-cols">
      <section class="tx-lc" aria-label="摘要"><p class="tx-lab">摘要<span>${its.length} 条</span></p><ol class="tx-l">${L.join("")}<li class="tx-end" aria-hidden="true"></li></ol></section>
      <section class="tx-rc" aria-label="原文"><p class="tx-lab">原文<span class="tx-pos"></span><a class="tx-ext" target="_blank" rel="noreferrer"></a></p><div class="tx-r"><div class="tx-r-in">${R.join("")}<div class="tx-end"><span>${its.length} 条，到这里为止</span></div></div></div></section>
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

// Rects keep the fractional offsets that offsetTop rounds away; dividing by the sheet's scale undoes the open animation.
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
  $(".tx-pos", tx.dlg).textContent = `第 ${k} / ${P.length - 1} 条`;
  const item = itemById[P[k].id];
  const ext = $(".tx-ext", tx.dlg);
  ext.textContent = `在 ${srcApp(item)} 中打开 ↗`;
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
  btn.textContent = open ? "显示引用" : "收起引用";
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
  if (act === "tx" && c) return openTx(c, topVisibleItem(), `.r-dock [data-act="tx"]`);
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
  if (tx) return txKey(e);
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
