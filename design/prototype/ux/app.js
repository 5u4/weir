const LS = "weir.proto.";
const prefs = {
  nav: localStorage.getItem(LS + "nav") === "C" ? "C" : "B",
  clean: localStorage.getItem(LS + "clean") || "D1",
  run: localStorage.getItem(LS + "run"),
};

const NAV = { B: "B Bucket tabs", C: "C 总览+tab" };
const CLEAN = { D1: "D1 手动完成", D2: "D2 看过即收", D3: "D3 分 bucket" };
const POLICY = { manual: "手动", auto: "看过即清" };
const NONE = "__none";
const CLEARED = "__cleared";
const PREVIEW = 3;

let data, source, storeKey, runs = [], itemById, me;
// convId -> { seenAt, clearedAt, muted, pinned }
let state = {};
// bucketId -> "manual" | "auto" (D3 only)
let policies = {};
const ui = {
  tab: null,
  selected: null,
  held: null, // D2: conversation opened while unread; stays in the main list until the selection leaves it
  seenOpen: new Set(),
  showOld: new Set(),
  showQuoted: new Set(),
  snap: {}, // convId -> Set of item ids highlighted as new while the conversation is open
  sims: 0,
};

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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
  const run = runs.find((r) => r.slug === prefs.run) || runs[0];
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
      prefs.run = run && key === `run:${run.slug}` ? run.slug : null;
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
  policies = JSON.parse(localStorage.getItem(LS + "policy." + storeKey) || "{}");
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

function policy(bucketId) {
  if (prefs.clean === "D1") return "manual";
  if (prefs.clean === "D2") return "sink";
  return policies[bucketId] || (bucketId === data.buckets[0]?.id ? "manual" : "auto");
}

function sections() {
  const out = data.buckets.map((b) => ({ id: b.id, name: b.name, convs: [] }));
  const byId = Object.fromEntries(out.map((s) => [s.id, s]));
  const none = { id: NONE, name: "未分类", convs: [] };
  for (const c of data.conversations) if (!isHidden(c)) (byId[c.bucket] || none).convs.push(c);
  if (none.convs.length) out.push(none);
  for (const s of out) {
    s.convs.sort((a, b) => !!S(b).pinned - !!S(a).pinned || lastMs(b) - lastMs(a));
    s.main = [];
    s.seen = [];
    for (const c of s.convs) {
      const sink = policy(s.id) === "sink" && !isUnread(c) && !S(c).pinned && c.id !== ui.held;
      (sink ? s.seen : s.main).push(c);
    }
    s.unread = s.convs.filter(isUnread).length;
  }
  return out;
}

const clearedList = () => data.conversations.filter(isHidden).sort((a, b) => lastMs(b) - lastMs(a));

function currentSection(secs) {
  return secs.find((s) => s.id === ui.tab) || (prefs.nav === "B" ? secs.find((s) => s.convs.length) || secs[0] : null);
}

// Rows in visible order, for j/k and "select next".
function currentList() {
  const secs = sections();
  if (ui.tab === CLEARED) return clearedList();
  const cur = currentSection(secs);
  if (!cur) return secs.flatMap((s) => s.main.slice(0, PREVIEW));
  return [...cur.main, ...(ui.seenOpen.has(cur.id) ? cur.seen : [])];
}

function onOpen(c) {
  const seen = seenMs(c);
  ui.snap[c.id] = new Set(itemsOf(c).filter((i) => Date.parse(i.occurredAt) > seen).map((i) => i.id));
  ui.held = isUnread(c) ? c.id : null;
  if (isUnread(c)) setS(c, { seenAt: lastIso(c) });
}

function onLeave(id) {
  const c = conv(id);
  delete ui.snap[id];
  ui.showOld.delete(id);
  ui.held = null;
  if (!c || isHidden(c) || isUnread(c) || S(c).pinned || policy(c.bucket || NONE) !== "auto") return;
  const undo = snapshot([c]);
  setS(c, { clearedAt: lastIso(c) });
  toast(`已自动清理「${c.title}」`, undo);
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
  const el = $("#toast");
  el.innerHTML = `<span>${esc(msg)}</span>${extra ? `<button data-act="toast-extra">${esc(extra.label)}</button>` : ""}${undo ? `<button data-act="undo">撤销</button>` : ""}`;
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

function bar() {
  const group = (key, map, label) =>
    `<span class="grp"><b>${label}</b>${Object.entries(map)
      .map(([k, v]) => `<button data-pref="${key}" data-val="${k}" class="${prefs[key] === k ? "on" : ""}">${esc(v)}</button>`)
      .join("")}</span>`;
  const runSel = runs.length
    ? `<span class="grp"><b>数据</b><select id="run">${runs.map((r) => `<option value="${esc(r.slug)}" ${r.slug === prefs.run ? "selected" : ""}>${esc(r.label)}</option>`).join("")}</select></span>`
    : "";
  $("#bar").innerHTML = `<span class="tag">PROTO</span>${group("nav", NAV, "导航")}${group("clean", CLEAN, "清理")}
    <span class="grp"><button data-act="sim">模拟新消息</button><button data-act="reset">重置状态</button></span>
    ${runSel}<span class="src">已加载：${esc(source)}</span>`;
}

function greeting(secs) {
  const parts = secs.filter((s) => s.unread).map((s) => `${s.unread} 个「${esc(s.name)}」`);
  const line = parts.length ? `你有 ${parts.join("、")}有更新。` : "没有新的更新。";
  return `<header class="hello"><h1>${line}</h1><p>数据生成于 ${abs(data.generatedAt)}（${rel(data.generatedAt)}）</p></header>`;
}

function rowActs(c) {
  if (ui.tab === CLEARED) return `<button data-act="restore">恢复</button>`;
  return policy(c.bucket || NONE) === "sink" ? "" : `<button data-act="done">完成</button>`;
}

function card(c) {
  const unread = isUnread(c);
  const tags = [...new Set(itemsOf(c).map((i) => i.sourceLabel))];
  const line = unread && c.update ? `<span class="upd">新进展：</span>${esc(c.update)}` : esc((c.summary || "").split("\n")[0]);
  const st = S(c);
  const badge = ui.tab === CLEARED ? `<span class="badge">${st.muted ? "已静音" : "已完成"}</span>` : st.pinned ? `<span class="badge">置顶</span>` : "";
  return `<article class="card ${unread ? "" : "read"} ${ui.selected === c.id ? "sel" : ""}" data-conv="${c.id}"><div class="head">
    <div class="row1">${unread ? `<span class="dot"></span>` : ""}<span class="title">${esc(c.title)}</span>${badge}<span class="time">${rel(lastIso(c))}</span></div>
    <div class="row3">${line}</div>
    <div class="row2"><span class="who">${esc(participants(c).join("、"))}</span><span>${c.itemIds.length} 封</span>${tags.map((t) => `<span class="src-tag">${esc(t)}</span>`).join("")}</div>
    <span class="acts">${rowActs(c)}</span>
  </div></article>`;
}

function policyToggle(s) {
  if (prefs.clean !== "D3" || s.id === CLEARED) return "";
  const p = policy(s.id);
  return `<span class="pol" data-act="policy" data-bucket="${s.id}" title="点击切换">${POLICY[p]}</span>`;
}

function bucketTools(s) {
  return `<div class="btools">${policyToggle(s)}<button class="link" data-act="clearall" data-bucket="${s.id}">全部清掉</button></div>`;
}

function seenGroup(s) {
  if (!s.seen.length) return "";
  const open = ui.seenOpen.has(s.id);
  return `<div class="seen"><button class="link seen-h" data-act="seen" data-bucket="${s.id}">${open ? "▾" : "▸"} 已看过 (${s.seen.length})</button>
    ${open ? `<div class="cards">${s.seen.map(card).join("")}</div>` : ""}</div>`;
}

function listHtml(secs) {
  const cur = ui.tab === CLEARED ? null : currentSection(secs);
  const cleared = clearedList();
  const tabs = `<nav class="tabs">${prefs.nav === "C" ? `<button data-act="home" class="${!ui.tab ? "on" : ""}">总览</button>` : ""}${secs
    .map((s) => `<button data-tab="${s.id}" class="${s.id === cur?.id ? "on" : ""}">${esc(s.name)}${s.unread ? ` <span class="cnt">${s.unread}</span>` : ""}${policyToggle(s)}</button>`)
    .join("")}<button data-tab="${CLEARED}" class="${ui.tab === CLEARED ? "on" : ""}">已清理 <span class="n">${cleared.length}</span></button></nav>`;
  if (ui.tab === CLEARED) return tabs + `<div class="cards">${cleared.map(card).join("") || `<p class="empty">没有已清理的对话</p>`}</div>`;
  if (!cur) return tabs + secs.filter((s) => s.convs.length).map(overviewSection).join("");
  return tabs + bucketTools(cur) + `<div class="cards">${cur.main.map(card).join("") || `<p class="empty">都处理完了</p>`}</div>${seenGroup(cur)}`;
}

function overviewSection(s) {
  const shown = s.main.slice(0, PREVIEW);
  const more = s.convs.length - shown.length;
  return `<section class="sec">
    <h3><button class="link sec-h" data-tab="${s.id}">${esc(s.name)} <span class="sec-n">${s.unread ? `${s.unread} 个未读 · ` : ""}共 ${s.convs.length}</span> →</button>${bucketTools(s)}</h3>
    <div class="cards">${shown.map(card).join("") || `<p class="empty">都看过了</p>`}</div>
    ${more > 0 ? `<button class="link more" data-tab="${s.id}">还有 ${more} 个 →</button>` : ""}
  </section>`;
}

function chips(c) {
  const its = itemsOf(c);
  const out = [];
  if (its.some((i) => i.to.some(isMe))) out.push(`<span class="chip">直接发给我</span>`);
  if (its.some((i) => i.cc.some(isMe))) out.push(`<span class="chip">抄送我</span>`);
  if (its.some((i) => isMe(i.from))) out.push(`<span class="chip">我参与过</span>`);
  if (c.threadIds.length > 1) out.push(`<span class="chip merge" title="${esc(c.mergeReason || "")}">合并了 ${c.threadIds.length} 个 thread</span>`);
  return out.length ? `<div class="chips"><span class="lbl">与我相关</span>${out.join("")}</div>` : "";
}

function itemHtml(c, i) {
  const hl = ui.snap[c.id]?.has(i.id);
  const q = ui.showQuoted.has(i.id);
  return `<li class="item ${hl ? "unread" : ""}">
    <div class="meta"><span class="src-tag">${esc(i.sourceLabel)}</span><b>${esc(isMe(i.from) ? "我" : i.from.name || i.from.addr)}</b><span class="time" title="${esc(i.occurredAt)}">${abs(i.occurredAt)}</span></div>
    <div class="body">${esc(i.bodyNew)}</div>
    ${i.bodyQuoted ? `<button class="link" data-act="quote" data-item="${i.id}">${q ? "隐藏引用" : "显示引用"}</button>${q ? `<div class="quoted">${esc(i.bodyQuoted)}</div>` : ""}` : ""}
  </li>`;
}

function timeline(c) {
  const its = itemsOf(c);
  const hl = ui.snap[c.id] || new Set();
  let old = its.filter((i) => !hl.has(i.id));
  // With nothing new, keep the latest old item visible so the timeline is never just one collapsed row.
  if (old.length === its.length) old = old.slice(0, -1);
  if (its.length <= 3 || old.length < 2 || ui.showOld.has(c.id)) return `<ol class="tl">${its.map((i) => itemHtml(c, i)).join("")}</ol>`;
  const rest = its.slice(old.length);
  return `<ol class="tl"><li class="older"><button class="link" data-act="old" data-conv="${c.id}">之前的 ${old.length} 条</button></li>${rest.map((i) => itemHtml(c, i)).join("")}</ol>`;
}

function readerActs(c) {
  const st = S(c);
  const b = (act, label, cls = "") => `<button data-act="${act}" class="${cls}">${label}</button>`;
  const out = [];
  if (isHidden(c)) out.push(b("restore", `恢复（${st.muted ? "已静音" : "已完成"}）`, "primary"));
  else if (policy(c.bucket || NONE) !== "sink") out.push(b("done", "完成 (e)", "primary"));
  if (!isUnread(c)) out.push(b("unread", "标为未读"));
  if (prefs.clean === "D2" && !isHidden(c)) out.push(b("pin", st.pinned ? "取消置顶" : "置顶"));
  if (!st.muted) out.push(b("mute", "静音"));
  const link = lastItem(c)?.link;
  if (link) out.push(`<a href="${esc(link)}" target="_blank" rel="noreferrer">在 Gmail 中打开</a>`);
  return `<div class="racts">${out.join("")}<button class="close" data-act="close" title="关闭 (Esc)">✕</button></div>`;
}

function convBody(c) {
  const unread = isUnread(c);
  return `<div class="conv" data-conv="${c.id}">
    ${readerActs(c)}
    <h2>${esc(c.title)}</h2>
    <p class="state">${esc(bucketName(c.bucket))} · ${unread ? "未读" : "已读"}</p>
    <p class="summary">${esc(c.summary)}</p>
    ${c.update ? `<div class="news"><b>新进展</b>${esc(c.update)}</div>` : ""}
    ${chips(c)}
    ${timeline(c)}
  </div>`;
}

function render() {
  bar();
  const secs = sections();
  const unread = secs.reduce((n, s) => n + s.unread, 0);
  document.title = unread ? `(${unread}) weir` : "weir";
  const app = $("#app");
  const sel = ui.selected && conv(ui.selected);
  // Render closed, then open next frame, so the column width change actually transitions.
  const animate = sel && !$(".layout.split-open");
  app.innerHTML = `<div class="layout ${sel && !animate ? "split-open" : ""}">
    <div class="list">${greeting(secs)}${listHtml(secs)}</div>
    <div class="pane">${sel ? convBody(sel) : ""}</div>
  </div>`;
  if (animate) {
    void app.offsetWidth;
    $(".layout").classList.add("split-open");
  }
}

function select(c) {
  if (ui.selected) onLeave(ui.selected);
  ui.selected = c ? c.id : null;
  if (c) onOpen(c);
  render();
  $(".pane")?.scrollTo(0, 0);
  if (c) $(`.card[data-conv="${c.id}"]`)?.scrollIntoView({ block: "nearest" });
}

function step(d) {
  const list = currentList();
  if (!list.length) return;
  const idx = list.findIndex((c) => c.id === ui.selected);
  const next = list[idx < 0 ? 0 : Math.max(0, Math.min(list.length - 1, idx + d))];
  if (next.id !== ui.selected) select(next);
}

// Hide c (via mutate), then move selection to the row that took its place.
function dismiss(c, mutate, msg) {
  const list = currentList();
  const idx = list.findIndex((x) => x.id === c.id);
  const undo = snapshot([c]);
  mutate();
  if (ui.selected === c.id) {
    delete ui.snap[c.id];
    ui.held = null;
    ui.selected = null;
    const rest = list.filter((x) => x.id !== c.id);
    const next = rest[Math.min(idx, rest.length - 1)];
    if (next) return select(next), toast(msg, undo);
  }
  render();
  toast(msg, undo);
}

function done(c) {
  dismiss(c, () => setS(c, { seenAt: lastIso(c), clearedAt: lastIso(c) }), `已完成「${c.title}」`);
}

function mute(c) {
  dismiss(c, () => setS(c, { muted: true }), `已静音「${c.title}」，有新消息也不会再出现`);
}

function clearAll(bucketId) {
  const s = sections().find((x) => x.id === bucketId);
  if (!s?.convs.length) return;
  const undo = snapshot(s.convs);
  const sink = policy(bucketId) === "sink";
  for (const c of s.convs) setS(c, sink ? { seenAt: lastIso(c) } : { seenAt: lastIso(c), clearedAt: lastIso(c) });
  if (!sink && s.convs.some((c) => c.id === ui.selected)) {
    delete ui.snap[ui.selected];
    ui.selected = ui.held = null;
  }
  render();
  toast(`「${s.name}」${s.convs.length} 个对话已${sink ? "标为已读" : "全部清掉"}`, undo);
}

function simulate() {
  ui.sims++;
  const muted = data.conversations.filter((c) => S(c).muted);
  const cleared = data.conversations.filter((c) => !S(c).muted && isCleared(c));
  const pool = ui.sims % 2 === 0 && muted.length ? muted : cleared.length ? cleared : muted;
  if (!pool.length) return toast("没有已完成或已静音的对话可以模拟");
  const c = pool[Math.floor(Math.random() * pool.length)];
  const last = lastItem(c);
  const now = new Date().toISOString();
  const item = { ...last, id: `sim-${Date.now()}`, subject: `Re: ${c.title}`, bodyNew: "（模拟的新回复）", bodyQuoted: "", occurredAt: now };
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

document.addEventListener("change", (e) => {
  if (e.target.id !== "run") return;
  localStorage.setItem(LS + "run", e.target.value);
  location.reload();
});

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act], [data-tab], [data-pref], .head");
  if (!t || t.closest("#toast")) return;
  if (t.dataset.pref) {
    prefs[t.dataset.pref] = t.dataset.val;
    localStorage.setItem(LS + t.dataset.pref, t.dataset.val);
    ui.selected = ui.held = null;
    ui.snap = {};
    if (t.dataset.pref === "nav") ui.tab = null;
    return render();
  }
  const act = t.dataset.act;
  const c = conv(t.dataset.conv || t.closest(".card, .conv")?.dataset?.conv);
  if (act === "reset") {
    state = {};
    policies = {};
    save();
    localStorage.removeItem(LS + "policy." + storeKey);
    ui.selected = ui.held = null;
    ui.snap = {};
    return render();
  }
  if (act === "sim") return simulate();
  if (act === "quote") {
    const id = t.dataset.item;
    ui.showQuoted.has(id) ? ui.showQuoted.delete(id) : ui.showQuoted.add(id);
    return render();
  }
  if (act === "old") {
    ui.showOld.add(t.dataset.conv);
    return render();
  }
  if (act === "policy") {
    e.stopPropagation();
    const b = t.dataset.bucket;
    policies[b] = policy(b) === "auto" ? "manual" : "auto";
    localStorage.setItem(LS + "policy." + storeKey, JSON.stringify(policies));
    return render();
  }
  if (act === "seen") {
    const b = t.dataset.bucket;
    ui.seenOpen.has(b) ? ui.seenOpen.delete(b) : ui.seenOpen.add(b);
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
  if (act === "pin" && c) {
    setS(c, { pinned: !S(c).pinned });
    return render();
  }
  if (act === "close") return select(null);
  if (act === "home") {
    ui.tab = null;
    return select(null);
  }
  if (t.dataset.tab) {
    ui.tab = t.dataset.tab;
    select(null);
    return window.scrollTo(0, 0);
  }
  if (t.classList.contains("head") && c) return select(ui.selected === c.id ? null : c);
});

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches("input, select, textarea")) return;
  if (e.key === "Escape" && ui.selected) return select(null);
  if (e.key === "j") step(1);
  else if (e.key === "k") step(-1);
  else if (e.key === "e" && ui.selected) {
    const c = conv(ui.selected);
    if (isHidden(c)) return;
    policy(c.bucket || NONE) === "sink" ? step(1) : done(c);
  }
});

new EventSource("/__reload").onmessage = () => location.reload();
load();
