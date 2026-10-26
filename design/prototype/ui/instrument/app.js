const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-low";

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
  snap: {}, // convId -> Set of item ids highlighted as new while the conversation is open
  sims: 0,
  busy: false,
};

const $ = (s, el = document) => el.querySelector(s);
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
function toastHtml(msg, undo, extra) {
  return `<span class="toast-msg">${esc(msg)}</span>${extra ? `<button data-act="toast-extra">${esc(extra.label)}</button>` : ""}${undo ? `<button data-act="undo">撤销</button>` : ""}<span class="toast-bar" aria-hidden="true"></span>`;
}
function toast(msg, undo, extra) {
  const el = $(".toast");
  el.innerHTML = toastHtml(msg, undo, extra);
  el.onclick = (e) => {
    const a = e.target.closest("button")?.dataset.act;
    if (!a) return;
    a === "undo" ? undo() : extra.run();
    el.classList.remove("on");
  };
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
  if (d < 86400) return `${Math.floor(d / 3600)}小时`;
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

function greetingHtml(secs) {
  const parts = secs.filter((s) => s.unread).map((s) => `<b class="g-n">${s.unread}</b> 个「${esc(s.name)}」`);
  const line = parts.length ? `你有 ${parts.join("、")}有更新。` : "没有新的更新。";
  return `<header class="top">
    <div class="top-row"><span class="mark">weir</span><span class="g-gen mono" title="${esc(data.generatedAt)}">数据 ${abs(data.generatedAt)} · ${rel(data.generatedAt)}</span></div>
    <h1 class="greet">${line}</h1>
  </header>`;
}

function tabsHtml(secs, cur) {
  const cleared = clearedList();
  const max = Math.max(1, ...secs.map((s) => s.convs.length));
  const tab = (id, name, on, pending, unread, cls = "") =>
    `<button class="tab ${cls} ${on ? "on" : ""}" role="tab" aria-selected="${on}" data-tab="${id}" data-pending="${pending}" data-max="${max}" data-unread="${unread}"><span class="tab-name">${esc(name)}</span><span class="tab-n mono">${unread ? `<b class="cnt">${unread}</b><span class="tot"><i>/</i>${pending}</span>` : pending}</span></button>`;
  return `<nav class="tabs" role="tablist">${secs.map((s) => tab(s.id, s.name, ui.tab !== CLEARED && s.id === cur?.id, s.convs.length, s.unread)).join("")}${tab(CLEARED, "已清理", ui.tab === CLEARED, cleared.length, 0, "tab-cleared")}</nav>`;
}

function rowHtml(c) {
  const unread = isUnread(c);
  const fresh = unread ? itemsOf(c).filter((i) => Date.parse(i.occurredAt) > seenMs(c)).length : 0;
  const tags = [...new Set(itemsOf(c).map((i) => i.sourceLabel))];
  const line = unread && c.update ? esc(c.update) : esc((c.summary || "").split(/(?<=。)|\n/)[0]);
  const inCleared = ui.tab === CLEARED;
  const who = participants(c);
  const whoTxt = who.length > 2 ? `${who.slice(0, 2).join("、")} +${who.length - 2}` : who.join("、");
  const tail = inCleared
    ? `<span class="badge ${S(c).muted ? "muted" : ""}">${S(c).muted ? "已静音" : "已完成"}</span><button class="restore" data-act="restore">恢复</button>`
    : `<span class="row-src mono" title="${esc(tags.join("、"))}">${srcCode(tags[0])}${tags.length > 1 ? `<i>+${tags.length - 1}</i>` : ""}</span>`;
  return `<article class="row ${unread ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-conv="${c.id}" data-open>
    <span class="dot" aria-label="${unread ? "未读" : "已读"}"></span>
    <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
    <span class="row-line">${unread && c.update ? `<i class="row-up">新</i>` : ""}${line}</span>
    <span class="row-who" title="${esc(who.join("、"))}">${esc(whoTxt)}</span>
    <span class="row-count mono" title="${c.itemIds.length} 封${fresh ? `，其中 ${fresh} 封是新的` : ""}">${fresh && fresh < c.itemIds.length ? `${c.itemIds.length - fresh}<b>+${fresh}</b>` : fresh ? `<b>${fresh}</b>` : c.itemIds.length}</span>
    ${tail}
    <span class="row-time mono" title="${esc(abs(lastIso(c)))}">${relShort(lastIso(c))}</span>
  </article>`;
}

const cols = (mid) => `<div class="cols mono" aria-hidden="true"><span></span><span>对话</span><span>最新一句</span><span>参与者</span><span class="r">封</span>${mid}<span class="r">时间</span></div>`;

function listHtml(secs) {
  const cur = currentSection(secs);
  const head = greetingHtml(secs) + tabsHtml(secs, cur);
  if (ui.tab === CLEARED) {
    const cl = clearedList();
    const muted = cl.filter((c) => S(c).muted).length;
    const bar = `<div class="bar"><span class="bar-read mono">${cl.length} 个已清理 · 完成 ${cl.length - muted} · 静音 ${muted}</span></div>`;
    return head + bar + `<div class="rows cleared">${cl.length ? cols("<span>状态</span><span></span>") + cl.map(rowHtml).join("") : `<div class="empty"><p class="empty-n mono">0</p><p>还没有清理过的对话。</p><p class="empty-sub">完成或静音的对话会出现在这里，可以随时恢复。</p></div>`}</div>`;
  }
  const bar = `<div class="bar"><span class="bar-read mono">${cur.convs.length} 个对话 · ${cur.unread} 未读</span>${cur.convs.length ? `<button class="clearall" data-act="clearall" data-bucket="${cur.id}">全部清掉</button>` : ""}</div>`;
  return head + bar + `<div class="rows">${cur.convs.length ? cols("<span>来源</span>") + cur.convs.map(rowHtml).join("") : `<div class="empty"><p class="empty-n mono">0 / 0</p><p>「${esc(cur.name)}」都处理完了。</p><p class="empty-sub">有新消息时，对话会以未读状态回到这里。</p></div>`}</div>`;
}

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
    <span class="tl-idx mono">${pad(n)}</span>
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
    ? `<li class="tl-older"><button data-act="old" data-conv="${c.id}"><span class="tl-idx mono">${pad(1)}–${pad(old.length)}</span><span>展开之前的 ${old.length} 条</span><span class="mono">${day(old[0].occurredAt)} → ${day(old.at(-1).occurredAt)}</span></button></li>`
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
  if (link) out.push(`<a class="ext" href="${esc(link)}" target="_blank" rel="noreferrer" title="在 Gmail 中打开">Gmail ↗</a>`);
  return `<div class="r-acts">${out.join("")}<button class="close" data-act="close" title="关闭 (Esc)" aria-label="关闭">✕</button></div>`;
}

function emptyReaderHtml(secs) {
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  const total = secs.reduce((n, s) => n + s.convs.length, 0);
  const stat = (n, l, cls = "") => `<div class="ro ${cls}"><span class="ro-n mono">${n}</span><span class="ro-l">${l}</span></div>`;
  const rows = secs
    .map((s) => `<tr class="${s.unread ? "has" : ""}"><th>${esc(s.name)}</th><td class="mono">${s.unread || "·"}</td><td class="mono">${s.convs.length}</td><td class="lvl"><span style="--f:${total ? s.convs.length / total : 0}"></span></td></tr>`)
    .join("");
  return `<div class="r-empty">
    <div class="readout">${stat(unread, "未读对话", unread ? "hot" : "")}${stat(total, "全部对话")}${stat(clearedList().length, "已清理")}</div>
    <table class="ro-table"><thead class="mono"><tr><th>分类</th><td>未读</td><td>对话</td><td></td></tr></thead><tbody>${rows}</tbody></table>
    <p class="r-empty-hint">从左侧选一个对话开始读。<kbd>J</kbd> <kbd>K</kbd> 上下移动，<kbd>E</kbd> 完成。</p>
  </div>`;
}

function readerHtml(c, secs) {
  if (!c) return emptyReaderHtml(secs);
  const unread = isUnread(c);
  const its = itemsOf(c);
  const fresh = ui.snap[c.id]?.size || 0;
  return `<div class="conv ${travelled === c.id ? "travel" : ""}" data-conv="${c.id}">
    <header class="r-head">
      <div class="r-l1">
        <span class="r-meta mono"><span class="r-bucket">${esc(bucketName(c.bucket))}</span><span class="r-state ${unread ? "is-unread" : ""}">${unread ? "未读" : fresh ? `已读 · 本次 ${fresh} 条新` : "已读"}</span><span class="r-stats">${its.length} 封 · ${participants(c).length} 人 · ${day(its[0]?.occurredAt || c.firstAt)} → ${day(lastIso(c))}</span></span>
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

function render() {
  const secs = sections();
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  document.title = unread ? `(${unread}) weir` : "weir";
  const sel = ui.selected && conv(ui.selected);
  const app = $("#app");
  app.classList.toggle("reading", !!sel);
  app.innerHTML = `<div class="list">${listHtml(secs)}</div><section class="reader">${readerHtml(sel, secs)}</section>`;
  window.weirHooks?.afterRender?.();
}

function select(c) {
  if (ui.selected) onLeave(ui.selected);
  ui.selected = c ? c.id : null;
  const firstUnreadItemId = c ? itemsOf(c).find((i) => Date.parse(i.occurredAt) > seenMs(c))?.id || null : null;
  if (c) onOpen(c);
  render();
  $(".reader")?.scrollTo(0, 0);
  if (c) {
    $(`.row[data-conv="${c.id}"]`)?.scrollIntoView({ block: "nearest" });
    window.weirHooks?.afterOpen?.($(".reader"), c, { firstUnreadItemId });
  }
}

function step(d) {
  const list = currentList();
  if (!list.length) return;
  const idx = list.findIndex((c) => c.id === ui.selected);
  const next = list[idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + d))];
  if (next.id !== ui.selected) select(next);
}

async function beforeHide(c) {
  const fn = window.weirHooks?.beforeHide;
  const row = $(`.row[data-conv="${c.id}"]`);
  if (!fn || !row) return;
  try {
    await Promise.race([fn(row, c), new Promise((r) => setTimeout(r, 1000))]);
  } catch (e) {
    console.warn(e);
  }
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
  toast(`「${s.name}」${s.convs.length} 个对话已全部清掉`, undo);
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
    ui.tab = t.dataset.tab;
    select(null);
    return window.scrollTo(0, 0);
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

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
window.weirHooks = {
  beforeHide(row) {
    if (reduceMotion.matches) return;
    row.classList.add("leaving");
    return new Promise((r) => row.addEventListener("animationend", r, { once: true }));
  },
  afterOpen(reader, c, { firstUnreadItemId }) {
    const mark = firstUnreadItemId && reader.querySelector(".tl-mark");
    const conv = reader.querySelector(".conv");
    travelled = null;
    conv?.classList.remove("travel");
    if (!mark || !conv) return;
    conv.classList.add("arm");
    const sweep = () => conv.isConnected && conv.classList.add("sweep");
    const top = mark.getBoundingClientRect().top - reader.getBoundingClientRect().top;
    // Only travel when the marker is below the reading line; otherwise the summary stays in view and the sweep alone marks the boundary.
    if (top < reader.clientHeight * 0.55) return requestAnimationFrame(sweep);
    travelled = c.id;
    conv.classList.add("travel");
    reader.scrollTo({ top: top - reader.clientHeight * 0.3, behavior: reduceMotion.matches ? "auto" : "smooth" });
    if (reduceMotion.matches) return sweep();
    let fired = false;
    const go = () => !fired && ((fired = true), sweep());
    reader.addEventListener("scrollend", go, { once: true });
    setTimeout(go, 600);
  },
};

new EventSource("/__reload").onmessage = () => location.reload();
load();
