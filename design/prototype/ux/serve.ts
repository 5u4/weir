import { watch, existsSync } from "node:fs";
import { join, normalize } from "node:path";

const root = normalize(join(import.meta.dir, ".."));
const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();

let pending: Timer | undefined;
function reload() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    for (const c of clients) c.enqueue(enc.encode("data: reload\n\n"));
  }, 100);
}

watch(join(root, "ux"), reload);
watch(join(root, "ui"), { recursive: true }, (_, f) => !String(f).startsWith("shots") && reload());
// Watch the dir, not the file: data.json may not exist yet and is likely replaced by rename.
const dataDir = join(root, "data");
if (existsSync(dataDir)) watch(dataDir, (_, f) => f === "data.json" && reload());

setInterval(() => {
  for (const c of clients) c.enqueue(enc.encode(": ping\n\n"));
}, 15000);

const server = Bun.serve({
  port: 9347,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return Response.redirect("/ui/", 302);
    if (url.pathname === "/__reload") {
      let ctrl: ReadableStreamDefaultController;
      const stream = new ReadableStream({
        start(c) {
          ctrl = c;
          clients.add(c);
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      });
    }
    let p = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!p.startsWith(root)) return new Response("forbidden", { status: 403 });
    if (url.pathname.endsWith("/")) p = join(p, "index.html");
    const file = Bun.file(p);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "cache-control": "no-store" } });
  },
});

console.log(`weir proto on http://localhost:${server.port}/`);
