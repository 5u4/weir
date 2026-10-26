const LS = "weir.proto.";
const NONE = "__none";
const CLEARED = "__cleared";
const DEFAULT_RUN = "gpt-6-luna-low";

let data, source, storeKey, runs = [], runSlug = null, itemById, me;
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
  return `<span class="toast-msg">${esc(msg)}</span>${extra ? `<button data-act="toast-extra">${esc(extra.label)}</button>` : ""}${undo ? `<button data-act="undo">撤销</button>` : ""}`;
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
const short = (p) => (isMe(p) ? "我" : (p.name || p.addr.split("@")[0]).split(/\s+/)[0]);

function participants(c) {
  const names = [];
  for (const i of itemsOf(c)) {
    const n = short(i.from);
    if (!names.includes(n)) names.push(n);
  }
  return names;
}

function greetingHtml(secs) {
  const parts = secs.filter((s) => s.unread).map((s) => `<span class="g-n">${s.unread}</span> 个「${esc(s.name)}」`);
  const line = parts.length ? `你有 ${parts.join("、")}有更新。` : "没有新的更新。";
  return `<header class="greeting"><h1>${line}</h1><p class="g-gen">数据生成于 ${abs(data.generatedAt)}（${rel(data.generatedAt)}）</p></header>`;
}

function tabsHtml(secs, cur) {
  const cleared = clearedList();
  const max = Math.max(1, ...secs.map((s) => s.convs.length));
  const tab = (id, name, on, pending, unread) =>
    `<button class="tab ${on ? "on" : ""}" data-tab="${id}" data-pending="${pending}" data-max="${max}" data-unread="${unread}"><span class="tab-name">${esc(name)}</span>${unread ? ` <span class="cnt">${unread}</span>` : ""}</button>`;
  return `<nav class="tabs">${secs.map((s) => tab(s.id, s.name, ui.tab !== CLEARED && s.id === cur?.id, s.convs.length, s.unread)).join("")}${tab(CLEARED, "已清理", ui.tab === CLEARED, cleared.length, 0).replace("</button>", ` <span class="n">${cleared.length}</span></button>`)}</nav>`;
}

function rowHtml(c) {
  const unread = isUnread(c);
  const tags = [...new Set(itemsOf(c).map((i) => i.sourceLabel))];
  const line = unread && c.update ? esc(c.update) : esc((c.summary || "").split(/(?<=。)|\n/)[0]);
  const inCleared = ui.tab === CLEARED;
  return `<article class="row ${unread ? "unread" : ""} ${ui.selected === c.id ? "sel" : ""}" data-conv="${c.id}" data-open>
    <div class="row-top">${unread ? `<span class="dot"></span>` : ""}<span class="row-title">${esc(c.title)}</span>${inCleared ? `<span class="badge">${S(c).muted ? "已静音" : "已完成"}</span>` : ""}<span class="row-time">${rel(lastIso(c))}</span></div>
    <div class="row-line">${line}</div>
    <div class="row-meta"><span class="row-who">${esc(participants(c).join("、"))}</span><span class="row-count">${c.itemIds.length} 封</span>${tags.map((t) => `<span class="src-tag">${esc(t)}</span>`).join("")}${inCleared ? `<button data-act="restore">恢复</button>` : ""}</div>
  </article>`;
}

function listHtml(secs) {
  const cur = currentSection(secs);
  const head = greetingHtml(secs) + tabsHtml(secs, cur);
  if (ui.tab === CLEARED) {
    const cl = clearedList();
    return head + `<div class="rows">${cl.map(rowHtml).join("") || `<p class="empty">没有已清理的对话</p>`}</div>`;
  }
  const tools = cur.convs.length ? `<div class="btools"><button class="link" data-act="clearall" data-bucket="${cur.id}">全部清掉</button></div>` : "";
  return head + tools + `<div class="rows">${cur.convs.map(rowHtml).join("") || `<p class="empty">都处理完了</p>`}</div>`;
}

function chipsHtml(c) {
  const its = itemsOf(c);
  const out = [];
  if (its.some((i) => i.to.some(isMe))) out.push(`<span class="chip">直接发给我</span>`);
  if (its.some((i) => i.cc.some(isMe))) out.push(`<span class="chip">抄送我</span>`);
  if (its.some((i) => isMe(i.from))) out.push(`<span class="chip">我参与过</span>`);
  if (c.threadIds.length > 1) out.push(`<span class="chip merge" title="${esc(c.mergeReason || "")}">合并了 ${c.threadIds.length} 个 thread</span>`);
  return out.length ? `<div class="r-chips">${out.join("")}</div>` : "";
}

function itemHtml(c, i) {
  const hl = ui.snap[c.id]?.has(i.id);
  const q = ui.showQuoted.has(i.id);
  return `<li class="tl-item ${hl ? "unread" : ""}" data-item="${i.id}">
    <div class="tl-meta"><b class="tl-from">${esc(isMe(i.from) ? "我" : i.from.name || i.from.addr)}</b><span class="tl-time" title="${esc(i.occurredAt)}">${abs(i.occurredAt)}</span><span class="src-tag">${esc(i.sourceLabel)}</span></div>
    <div class="body">${md(i.bodyNew)}</div>
    ${i.bodyQuoted ? `<button class="link q-toggle" data-act="quote" data-item="${i.id}">${q ? "隐藏引用" : "显示引用"}</button>${q ? `<div class="quoted">${esc(i.bodyQuoted)}</div>` : ""}` : ""}
  </li>`;
}

function timelineHtml(c) {
  const its = itemsOf(c);
  const hl = ui.snap[c.id] || new Set();
  let old = its.filter((i) => !hl.has(i.id));
  // With nothing new, keep the latest old item visible so the timeline is never just one collapsed row.
  if (old.length === its.length) old = old.slice(0, -1);
  if (its.length <= 3 || old.length < 2 || ui.showOld.has(c.id)) return `<ol class="tl">${its.map((i) => itemHtml(c, i)).join("")}</ol>`;
  const rest = its.slice(old.length);
  return `<ol class="tl"><li class="tl-older"><button class="link" data-act="old" data-conv="${c.id}">之前的 ${old.length} 条</button></li>${rest.map((i) => itemHtml(c, i)).join("")}</ol>`;
}

function actsHtml(c) {
  const st = S(c);
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${label}</button>`;
  const out = [`<button class="back" data-act="close">返回</button>`];
  if (isHidden(c)) out.push(b("restore", `恢复（${st.muted ? "已静音" : "已完成"}）`, "primary"));
  else out.push(b("done", "完成", "primary"));
  if (!isUnread(c)) out.push(b("unread", "标为未读"));
  if (!st.muted) out.push(b("mute", "静音"));
  const link = lastItem(c)?.link;
  if (link) out.push(`<a href="${esc(link)}" target="_blank" rel="noreferrer">在 Gmail 中打开</a>`);
  return `<div class="r-acts">${out.join("")}<button class="close" data-act="close" title="关闭 (Esc)">✕</button></div>`;
}

function readerHtml(c, secs) {
  if (!c) {
    const unread = secs.reduce((n, s) => n + s.unread, 0);
    const total = secs.reduce((n, s) => n + s.convs.length, 0);
    return `<div class="empty r-empty"><p>选择左侧的对话</p><p class="r-empty-n">${unread} 个未读 · 共 ${total} 个对话 · 已清理 ${clearedList().length}</p></div>`;
  }
  const unread = isUnread(c);
  return `<div class="conv" data-conv="${c.id}">
    ${actsHtml(c)}
    <h2 class="r-title">${esc(c.title)}</h2>
    <p class="r-meta"><span class="r-bucket">${esc(bucketName(c.bucket))}</span> · <span class="r-state">${unread ? "未读" : "已读"}</span></p>
    ${c.update ? `<div class="r-update"><b>自你上次查看</b><p>${esc(c.update)}</p></div>` : ""}
    <p class="r-summary">${esc(c.summary)}</p>
    ${chipsHtml(c)}
    ${timelineHtml(c)}
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

new EventSource("/__reload").onmessage = () => location.reload();
load();
