(() => {
  const LINKS = [["final", "final"]];
  const here = location.pathname.split("/")[2];
  const css = `
#weir-switch{position:fixed;left:10px;bottom:10px;z-index:2147483000;display:flex;gap:6px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 20px);
  font:11px/1.4 -apple-system,system-ui,sans-serif;color:#ddd;background:rgba(30,30,30,.88);padding:4px 8px;border-radius:999px;box-shadow:0 2px 8px rgba(0,0,0,.25)}
#weir-switch a{color:#bbb;text-decoration:none;padding:1px 6px;border-radius:999px}
#weir-switch a.on{background:#eee;color:#111}
#weir-switch button,#weir-switch select{font:inherit;color:#ddd;background:#444;border:0;border-radius:999px;padding:1px 7px;cursor:pointer;max-width:160px}
#weir-switch button.lit{background:#c58a1c;color:#111}
#weir-switch .sep{opacity:.4}
#weir-switch .src{opacity:.6}
#weir-switch.min .dev{display:none}`;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  const el = document.createElement("div");
  el.id = "weir-switch";
  document.body.append(el);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function draw() {
    const d = window.weirDev;
    const links = LINKS.map(([k, l]) => `<a href="/ui/${k}/" class="${k === here ? "on" : ""}">${l}</a>`).join("");
    const brk = (k, l) => `<button class="dev ${d.broken[k] ? "lit" : ""}" data-a="break" data-k="${k}" aria-pressed="${d.broken[k]}">${l}${d.broken[k] ? "：开" : "：关"}</button>`;
    const dev = d
      ? `<span class="sep dev">|</span><button class="dev" data-a="sim">模拟新消息</button><button class="dev" data-a="reset">重置状态</button>${brk("source", "break source")}${brk("config", "break config")}<button class="dev ${d.earlier === "run" ? "lit" : ""}" data-a="earlier" title="Digest earlier: one model call (step) or the whole gap (run)">earlier：${d.earlier}</button><span class="src dev">已加载：${esc(d.source)}</span>`
      : "";
    el.innerHTML = `${links}${dev}<button data-a="min" title="收起">${el.classList.contains("min") ? "›" : "‹"}</button>`;
  }
  el.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    const a = b?.dataset.a;
    if (a === "sim") window.weirDev?.simulate();
    else if (a === "reset") window.weirDev?.reset();
    else if (a === "break") window.weirDev?.toggleBreak(b.dataset.k);
    else if (a === "earlier") window.weirDev?.toggleEarlier();
    else if (a === "min") el.classList.toggle("min"), draw();
  });
  window.addEventListener("weirdev", draw);
  draw();
})();
