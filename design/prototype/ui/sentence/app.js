const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-low";
const EASE = "cubic-bezier(0.2, 0, 0, 1)";
const PALETTE = ["oklch(0.575 0.215 29)", "oklch(0.49 0.2 262)", "oklch(0.53 0.13 158)", "oklch(0.5 0.2 305)", "oklch(0.58 0.14 62)"];
const PERSONAL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "qq.com", "163.com", "126.com", "icloud.com", "me.com", "yahoo.com"]);

let data, source, storeKey, runs = [], runSlug = null, itemById, me, myName = "";
// convId -> { seenAt, clearedAt, muted }
let state = {};
const ui = {
  tab: null,
  selected: null,
  showOld: new Set(),
  showQuoted: new Set(),
  snap: {}, // convId -> Set of item ids highlighted as new while the conversation is open
  sims: 0,
  busy: false,
  flash: false,
  homeScroll: 0,
};
const favicon = new Map(); // domain -> true (real icon) | false (fallback to monogram)

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const narrow = matchMedia("(max-width: 899px)");

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

function sections() {
  const out = data.buckets.map((b, i) => ({ id: b.id, name: b.name, color: PALETTE[i % PALETTE.length], convs: [] }));
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  const none = { id: NONE, name: "未分类", color: "oklch(0.45 0 0)", convs: [] };
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
    el.classList.remove("on");
    a === "undo" ? undo() : extra.run();
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
function avatarHtml(p) {
  const d = orgDomain(p.addr);
  const known = favicon.get(d);
  const img = PERSONAL.has(d) || known === false ? "" : `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=64" alt="" class="${known ? "ok" : ""}" data-d="${esc(d)}" onload="avLoad(this)" onerror="avErr(this)">`;
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

const tok = (k, text, cls = "") => `<span class="t ${cls}" data-k="${k}" data-v="${esc(text)}">${text}</span>`;

// Chinese enumeration: A、B、C和D. The 、 binds to the clause before it, 和 to the clause after it, and the sentence's
// opening and closing words bind to the first and last clause, so no function word starts or ends a line alone.
function enumerate(items, prefix, lead = "", end = "") {
  const n = items.length;
  return items
    .map((it, i) => {
      const and = n > 1 && i === n - 1 ? tok(`${prefix}and-${it.id}`, "和", "and") : "";
      const sep = i < n - 2 ? tok(`${prefix}sep-${it.id}`, "、", "sep") : "";
      return `<span class="grp">${i === 0 ? lead : ""}${and}${it.html}${sep}${i === n - 1 ? end : ""}</span>`;
    })
    .join("");
}

function widgetHtml(s, v, active) {
  const on = s.id === active;
  const n = v === "main" ? s.unread : s.convs.length;
  const label = v === "main" ? `${n} 个「${s.name}」有更新` : v === "tail" ? `「${s.name}」还有 ${n} 个已读未清` : `「${s.name}」已清空`;
  const avs = v === "main" ? `<span class="avs">${senders(s.convs.filter(isUnread)).map(avatarHtml).join("")}</span>` : "";
  const count = v === "empty" ? "" : `<span class="w-n">${n}</span><span class="w-u">个</span>`;
  return `<button class="w w-${v} ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-k="w-${s.id}" data-v="${v}" data-tab="${s.id}" style="--c:${s.color}" aria-pressed="${on}" aria-label="${esc(label)}">${avs}${count}<span class="w-name">「${esc(s.name)}」</span></button>`;
}

function greeting() {
  const h = new Date().getHours();
  const g = h < 5 ? "夜深了" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  return myName ? `${g}，${myName}。` : `${g}。`;
}

function topHtml(secs) {
  const active = ui.tab === CLEARED ? CLEARED : currentSection(secs)?.id;
  const hot = secs.filter((s) => s.unread);
  const quiet = secs.filter((s) => !s.unread && s.convs.length);
  const empty = secs.filter((s) => !s.convs.length);
  const cl = clearedList().length;
  const main = hot.length
    ? enumerate(hot.map((s) => ({ id: s.id, html: widgetHtml(s, "main", active) })), "m-", tok("lead", "你有", "glue"), tok("end", "有更新。", "glue"))
    : tok("allclear", "全部看完了。", "allclear");
  const tail = [];
  if (quiet.length) tail.push(`<span class="cl">${enumerate(quiet.map((s) => ({ id: s.id, html: widgetHtml(s, "tail", active) })), "q-", tok("q-lead", "另有", "glue"), tok("q-end", "已读未清。", "glue"))}</span>`);
  if (empty.length) tail.push(`<span class="cl">${enumerate(empty.map((s) => ({ id: s.id, html: widgetHtml(s, "empty", active) })), "e-", "", tok("e-end", empty.length > 1 ? "都已清空。" : "已清空。", "glue"))}</span>`);
  const on = active === CLEARED;
  tail.push(`<span class="cl"><span class="grp"><button class="w w-cl ${on ? "on" : ""} ${on && ui.flash ? "flash" : ""}" data-k="w-cleared" data-v="cleared" data-tab="${CLEARED}" aria-pressed="${on}"><span class="w-u">已清理</span><span class="w-n">${cl}</span><span class="w-u">个</span></button>${tok("c-end", "。", "glue")}</span></span>`);
  return `<div class="mast">
      ${tok("mark", `weir<i>堰</i>`, "mark")}
      <span class="t stamp" data-k="stamp" data-v="stamp" title="${esc(data.generatedAt)}">数据更新于 ${abs(data.generatedAt)}</span>
    </div>
    <p class="hello">${tok("hello", esc(greeting()))}</p>
    <div class="say">
      <h1 class="s-main">${main}</h1>
      <p class="s-tail">${tail.join("")}</p>
    </div>`;
}

function rowHtml(c) {
  const unread = isUnread(c);
  const its = itemsOf(c);
  const fresh = unread ? its.filter((i) => Date.parse(i.occurredAt) > seenMs(c)).length : 0;
  const tags = [...new Set(its.map((i) => srcName(i.sourceLabel)))];
  const line = unread && c.update ? esc(c.update) : esc((c.summary || "").split(/(?<=。)|\n/)[0]);
  const inCleared = ui.tab === CLEARED;
  const who = participants(c);
  const whoTxt = who.length > 2 ? `${who.slice(0, 2).join("、")} 等 ${who.length} 人` : who.join("、");
  const from = [...its].reverse().find((i) => !isMe(i.from))?.from || its.at(-1).from;
  const tail = inCleared
    ? `<span class="row-badge">${S(c).muted ? "已静音" : "已完成"}</span><button class="row-act restore" data-act="restore">恢复</button>`
    : `<button class="row-act" data-act="done" title="完成，不再出现在列表里">完成</button>`;
  return `<article class="row ${unread ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-k="r-${c.id}" data-conv="${c.id}" data-open tabindex="0" aria-current="${ui.selected === c.id}">
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
  const head = `<div class="l-head"><h2 class="l-name">「${esc(cur.name)}」</h2><span class="l-meta">${cur.convs.length} 个对话${cur.unread ? ` · ${cur.unread} 个未读` : cur.convs.length ? " · 都读过了" : ""}</span>${cur.convs.length ? `<button class="clearall" data-act="clearall" data-bucket="${cur.id}">全部清掉</button>` : ""}</div>`;
  return head + (cur.convs.length ? `<div class="rows">${cur.convs.map(rowHtml).join("")}</div>` : `<div class="empty"><p class="empty-big">「${esc(cur.name)}」清空了。</p><p class="empty-sub">有新消息时，对话会以未读状态回到这里。</p></div>`);
}

function chipsHtml(c) {
  const its = itemsOf(c);
  const out = [];
  if (its.some((i) => i.to.some(isMe))) out.push(`<span class="chip">直接发给我</span>`);
  if (its.some((i) => i.cc.some(isMe))) out.push(`<span class="chip">抄送我</span>`);
  if (its.some((i) => isMe(i.from))) out.push(`<span class="chip">我参与过</span>`);
  if (c.threadIds.length > 1) out.push(`<span class="chip merge">合并了 ${c.threadIds.length} 个邮件串</span>`);
  return out.join("");
}

function itemHtml(c, i, n) {
  const hl = ui.snap[c.id]?.has(i.id);
  const q = ui.showQuoted.has(i.id);
  return `<li class="tl-item ${hl ? "unread" : ""}" data-item="${i.id}">
    <span class="tl-av">${avatarHtml(i.from)}</span>
    <div class="tl-main">
      <div class="tl-meta"><b class="tl-from" title="${esc(i.from.addr)}">${esc(isMe(i.from) ? "我" : i.from.name || i.from.addr)}</b>${hl ? `<span class="tl-new">新</span>` : ""}<span class="tl-src">${esc(srcName(i.sourceLabel))}</span><span class="tl-time" title="${esc(i.occurredAt)}">${abs(i.occurredAt)}</span><span class="tl-idx">${pad(n)}</span></div>
      <div class="body">${md(i.bodyNew)}</div>
      ${i.bodyQuoted ? `<button class="q-toggle" data-act="quote" data-item="${i.id}" aria-expanded="${q}">${q ? "收起引用" : "显示引用"}</button>${q ? `<div class="quoted">${esc(i.bodyQuoted)}</div>` : ""}` : ""}
    </div>
  </li>`;
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
  const mark = (i) =>
    i === firstNew ? `<li class="tl-mark" role="separator"><span>${its[0] === firstNew ? "从这里开始都是新的" : "上次读到这里"}</span><span>${its.length - its.indexOf(firstNew)} 条新</span></li>` : "";
  const rows = its.slice(start).map((i, j) => mark(i) + itemHtml(c, i, start + j + 1));
  const older = collapse ? `<li class="tl-older"><button data-act="old" data-conv="${c.id}"><span>之前的 ${old.length} 条</span><span>${day(old[0].occurredAt)} – ${day(old.at(-1).occurredAt)}</span></button></li>` : "";
  return `<ol class="tl">${older}${rows.join("")}</ol>`;
}

function readerHtml(c) {
  const unread = isUnread(c);
  const its = itemsOf(c);
  const st = S(c);
  const fresh = ui.snap[c.id]?.size || 0;
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${label}</button>`;
  const acts = [];
  if (isHidden(c)) acts.push(b("restore", `恢复（${st.muted ? "已静音" : "已完成"}）`, "primary"));
  else acts.push(b("done", `完成<kbd>E</kbd>`, "primary"));
  if (!unread) acts.push(b("unread", "标为未读"));
  if (!st.muted) acts.push(b("mute", "静音"));
  const link = lastItem(c)?.link;
  if (link) acts.push(`<a class="ext" href="${esc(link)}" target="_blank" rel="noreferrer">在 Gmail 中打开 ↗</a>`);
  const chips = chipsHtml(c);
  return `<div class="conv" data-conv="${c.id}">
    <header class="r-bar">
      <button class="back" data-act="close">‹ 返回</button>
      <div class="r-acts">${acts.join("")}</div>
      <button class="close" data-act="close" title="关闭 (Esc)" aria-label="关闭">✕</button>
    </header>
    <div class="r-body">
      <p class="r-crumb">「${esc(bucketName(c.bucket))}」<span>${unread ? "未读" : fresh ? `本次 ${fresh} 条新` : "已读"}</span><span>${its.length} 封 · ${participants(c).length} 人</span><span>${day(its[0]?.occurredAt || c.firstAt)} – ${day(lastIso(c))}</span></p>
      <h2 class="r-title">${esc(c.title)}</h2>
      <p class="r-summary">${esc(c.summary)}</p>
      ${c.update ? `<div class="r-update"><span class="r-label">自你上次查看</span><p>${esc(c.update)}</p></div>` : ""}
      ${chips || (c.threadIds.length > 1 && c.mergeReason) ? `<div class="r-rel"><span class="r-label">和你的关系</span><div class="r-chips">${chips}</div>${c.threadIds.length > 1 && c.mergeReason ? `<p class="r-merge">${esc(c.mergeReason)}</p>` : ""}</div>` : ""}
      <div class="r-label r-orig">原文 · ${its.length} 封</div>
      ${timelineHtml(c)}
    </div>
  </div>`;
}

/* FLIP: every [data-k] element is a keyed token. Before a render we record where each token was; after it we
   play each one from its old box to its new box, fade in tokens that appeared and float out ghosts of tokens that left. */
function capture() {
  const m = new Map();
  for (const el of document.querySelectorAll("#app [data-k]")) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.bottom < -60 || r.top > innerHeight + 60) continue;
    const row = el.dataset.k.startsWith("r-");
    const cs = row ? null : getComputedStyle(el);
    m.set(el.dataset.k, {
      r,
      el,
      row,
      v: el.dataset.v,
      n: el.querySelector(".w-n")?.textContent,
      st: cs && { fontSize: cs.fontSize, fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, color: cs.color, letterSpacing: cs.letterSpacing, fontFeatureSettings: cs.fontFeatureSettings },
    });
  }
  return m;
}

function ghost(p, kind) {
  if (!p.st) return;
  const g = p.el.cloneNode(true);
  g.removeAttribute("data-k");
  g.classList.remove("flash");
  g.classList.add("ghost");
  Object.assign(g.style, p.st, { position: "absolute", left: `${p.r.left}px`, top: `${p.r.top}px`, width: `${p.r.width}px`, height: `${p.r.height}px`, margin: "0", transformOrigin: "0 0" });
  $(".ghosts").append(g);
  const frames =
    kind === "leave" && !reduceMotion.matches
      ? [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(0.35em) scale(0.96)" }]
      : [{ opacity: 1 }, { opacity: 0 }];
  const a = g.animate(frames, { duration: kind === "leave" ? 300 : 200, easing: EASE, fill: "forwards" });
  a.onfinish = () => g.remove();
}

function play(prev, anchor) {
  if (!prev) return;
  const rm = reduceMotion.matches;
  const D = anchor ? 620 : 480;
  const seen = new Set();
  let entering = 0;
  for (const el of document.querySelectorAll("#app [data-k]")) {
    const k = el.dataset.k;
    const r = el.getBoundingClientRect();
    if (!r.width) continue;
    seen.add(k);
    if (r.bottom < -60 || r.top > innerHeight + 60) continue;
    // On a home/split switch the list moves as one sheet, anchored on the opened row, instead of row by row.
    if (anchor && k.startsWith("r-")) continue;
    const p = prev.get(k);
    if (!p) {
      const delay = p === undefined && k.startsWith("r-") ? 40 + Math.min(entering++, 12) * 22 : 160;
      el.animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: "translateY(0.4em)" }, { opacity: 1, transform: "none" }], { duration: rm ? 200 : 420, delay: rm ? 0 : delay, easing: EASE, fill: "backwards" });
      continue;
    }
    const changed = p.v !== el.dataset.v;
    if (changed) ghost(p, "swap");
    const s = p.row ? 1 : parseFloat(p.st.fontSize) / parseFloat(getComputedStyle(el).fontSize);
    const dx = p.r.left - r.left;
    const dy = p.r.top - r.top;
    const moved = Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5 || Math.abs(s - 1) > 0.001;
    if (rm) {
      if (changed || (moved && !p.row)) el.animate([{ opacity: changed ? 0 : 0.35 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
    } else if (moved) {
      const from = { transform: `translate(${dx}px, ${dy}px) scale(${s})` };
      el.animate(changed ? [{ ...from, opacity: 0 }, { opacity: 1, offset: 0.45 }, { transform: "none", opacity: 1 }] : [from, { transform: "none" }], { duration: D, easing: EASE });
    } else if (changed) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 80, easing: EASE, fill: "backwards" });
    }
    const n = el.querySelector(".w-n");
    if (n && !changed && p.n !== undefined && p.n !== n.textContent) {
      const up = Number(n.textContent) > Number(p.n);
      n.animate(rm ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateY(${up ? 0.5 : -0.5}em)` }, { opacity: 1, transform: "none" }], { duration: 380, delay: rm ? 0 : 60, easing: EASE, fill: "backwards" });
    }
  }
  for (const [k, p] of prev) if (!seen.has(k)) ghost(p, "leave");
  if (!anchor) return;
  const list = $(".list");
  const a = prev.get(anchor);
  const r = $(`#app [data-k="${anchor}"]`)?.getBoundingClientRect();
  if (rm || !a || !r) return list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, easing: "ease-out" });
  list.animate([{ transform: `translate(${a.r.left - r.left}px, ${a.r.top - r.top}px)` }, { transform: "none" }], { duration: D, easing: EASE });
}

function exitReader(reader) {
  if (!reader?.firstChild) return;
  const r = reader.getBoundingClientRect();
  const g = reader.cloneNode(true);
  g.classList.add("ghost");
  Object.assign(g.style, { position: "absolute", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, overflow: "hidden" });
  $(".ghosts").append(g);
  g.firstElementChild.style.transform = `translateY(${-reader.scrollTop}px)`;
  const out = reduceMotion.matches ? "none" : narrow.matches ? "translateY(100%)" : "translateX(64px)";
  const a = g.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: out }], { duration: reduceMotion.matches ? 180 : narrow.matches ? 360 : 340, easing: EASE, fill: "forwards" });
  a.onfinish = () => g.remove();
}

function enterReader(reader) {
  const from = reduceMotion.matches ? "none" : narrow.matches ? "translateY(100%)" : "translateX(64px)";
  reader.animate([{ opacity: narrow.matches && !reduceMotion.matches ? 1 : 0, transform: from }, { opacity: 1, transform: "none" }], { duration: reduceMotion.matches ? 200 : narrow.matches ? 460 : 620, delay: narrow.matches || reduceMotion.matches ? 0 : 60, easing: EASE, fill: "backwards" });
}

function keepVisible(list, id) {
  const row = list.querySelector(`.row[data-conv="${id}"]`);
  if (!row) return;
  const lr = list.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (rr.top < lr.top) list.scrollTop -= lr.top - rr.top + 12;
  else if (rr.bottom > lr.bottom) list.scrollTop += rr.bottom - lr.bottom + 12;
}

function render() {
  const app = $("#app");
  const secs = sections();
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  document.title = unread ? `(${unread}) weir` : "weir";
  const sel = ui.selected && conv(ui.selected);
  const reading = !!sel;
  const first = !app.firstChild;
  const modeChange = !first && app.classList.contains("reading") !== reading;
  const wide = !narrow.matches;
  const prev = first ? null : capture();
  const prevConv = app.dataset.conv || "";
  const listTop = $(".list")?.scrollTop || 0;
  const readerTop = $(".reader")?.scrollTop || 0;
  let anchor = null;
  if (modeChange && reading) {
    ui.homeScroll = scrollY;
    anchor = $(`.row[data-conv="${sel.id}"]`)?.getBoundingClientRect().top ?? null;
  }
  if (modeChange && !reading) exitReader($(".reader"));
  app.classList.toggle("reading", reading);
  app.dataset.conv = sel ? sel.id : "";
  app.innerHTML = `<header class="top">${topHtml(secs)}</header><div class="list">${listHtml(secs)}</div><section class="reader" aria-label="阅读">${sel ? readerHtml(sel) : ""}</section>`;
  ui.flash = false;
  const list = $(".list");
  const reader = $(".reader");
  if (reading && wide) {
    const row = list.querySelector(`.row[data-conv="${sel.id}"]`);
    if (modeChange) {
      window.scrollTo(0, 0);
      if (row) list.scrollTop = anchor == null ? row.offsetTop - list.clientHeight / 3 : row.getBoundingClientRect().top - Math.min(Math.max(anchor, list.getBoundingClientRect().top + 72), innerHeight - 200);
    } else {
      list.scrollTop = listTop;
      if (sel.id !== prevConv) keepVisible(list, sel.id);
    }
  }
  if (modeChange && !reading && wide) window.scrollTo(0, ui.homeScroll);
  if (reading && sel.id === prevConv) reader.scrollTop = readerTop;
  play(prev, modeChange ? `r-${sel ? sel.id : prevConv}` : null);
  if (reading && modeChange) enterReader(reader);
  else if (reading && prevConv && sel.id !== prevConv && !reduceMotion.matches) $(".conv").animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE });
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
async function dismiss(c, mutate, msg) {
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
      if (next) return select(next), toast(msg, undo);
    }
    render();
    toast(msg, undo);
  } finally {
    ui.busy = false;
  }
}

const done = (c) => dismiss(c, () => setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) }), `已完成「${c.title}」`);
const mute = (c) => dismiss(c, () => setS(c, { muted: true }), `已静音「${c.title}」，有新消息也不会再出现`);

function clearAll(bucketId) {
  const s = sections().find((x) => x.id === bucketId);
  if (!s?.convs.length) return;
  const undo = snapshot(s.convs);
  for (const c of s.convs) setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) });
  if (s.convs.some((c) => c.id === ui.selected)) {
    onLeave(ui.selected);
    ui.selected = null;
  }
  render();
  toast(`「${s.name}」的 ${s.convs.length} 个对话已全部清掉`, undo);
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
  toast(`「${c.title}」来了新回复，回到了「${bucketName(c.bucket)}」`, null, {
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
    setS(c, { clearedAt: null, muted: false });
    render();
    return toast(`已恢复「${c.title}」到「${bucketName(c.bucket)}」`);
  }
  if (act === "unread" && c) {
    setS(c, { seenAt: new Date(lastMs(c) - 1).toISOString() });
    ui.snap[c.id] = new Set([lastItem(c).id]);
    return render();
  }
  if (act === "close") return select(null);
  if (t.dataset.tab) {
    ui.flash = ui.tab !== t.dataset.tab;
    ui.tab = t.dataset.tab;
    if (ui.selected) ui.homeScroll = 0;
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

new EventSource("/__reload").onmessage = () => location.reload();
load();
