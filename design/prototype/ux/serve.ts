import { watch } from "node:fs";
import { join, normalize } from "node:path";
import { autoRange, generate, graphMessage, itemsOfConv, loadConfig, manualRange, overlaps, readData, ruleInput, sinceOf, tagsOfInput, writeData, type Digest, type Item, type ManualReq } from "../data/digest";

const root = normalize(join(import.meta.dir, ".."));
const clients = new Set<ReadableStreamDefaultController>();
const enc = new TextEncoder();
// Requests that read and rewrite data.json run one at a time, so two digests can never be written over the same seqs.
let queue: Promise<unknown> = Promise.resolve();
function exclusive(fn: () => Promise<Response>): Promise<Response> {
  const run = queue.then(fn, fn).catch((e) => Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 }));
  queue = run;
  return run;
}

let pending: Timer | undefined;
function reload() {
  clearTimeout(pending);
  pending = setTimeout(() => {
    for (const c of clients) c.enqueue(enc.encode("data: reload\n\n"));
  }, 100);
}

watch(join(root, "ux"), reload);
watch(join(root, "ui"), { recursive: true }, (_, f) => !String(f).startsWith("shots") && reload());

setInterval(() => {
  for (const c of clients) c.enqueue(enc.encode(": ping\n\n"));
}, 15000);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 9347),
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return Response.redirect("/ui/final/", 302);
    if (url.pathname === "/__digest" && req.method === "POST") {
      const body: ManualReq & { conversationId: string } = await req.json();
      return exclusive(async () => {
        const data = await readData();
        const conv = data.conversations.find((c) => c.id === body.conversationId);
        if (!conv) return Response.json({ error: `unknown conversation ${body.conversationId}` }, { status: 404 });
        const items = itemsOfConv(data, conv.id);
        const own = data.digests.filter((d) => d.conversationId === conv.id);
        const range = manualRange(items, own, body, data.digest.maxInput);
        if (typeof range === "string") return Response.json({ error: range }, { status: 409 });
        const [fromSeq, toSeq] = range;
        const kept = body.redo ? own.filter((d) => !(d.fromSeq === fromSeq && d.toSeq === toSeq)) : own;
        if (overlaps(kept, fromSeq, toSeq)) return Response.json({ error: `#${fromSeq}-#${toSeq} overlaps a digest` }, { status: 409 });
        const old = own.find((d) => d.fromSeq === fromSeq && d.toSeq === toSeq);
        const trigger = body.redo && old ? old.trigger : "manual";
        const { made, logs } = await generate({ conv, items, digests: kept, data, fromSeq, toSeq, trigger, logPrefix: "live-" });
        if (!made.length) return Response.json({ error: logs.at(-1)?.error ?? "no digest" }, { status: 502 });
        data.digests = [...data.digests.filter((d) => d !== old), ...made];
        await writeData(data);
        return Response.json({ replaced: old?.id ?? null, digests: made });
      });
    }
    if (url.pathname === "/__sim" && req.method === "POST") {
      const body: { conversationId: string; from: { name: string; addr: string }; text: string } = await req.json();
      return exclusive(async () => {
        const data = await readData();
        const conv = data.conversations.find((c) => c.id === body.conversationId && c.source === "teams");
        if (!conv) return Response.json({ error: `unknown Teams conversation ${body.conversationId}` }, { status: 404 });
        const items = itemsOfConv(data, conv.id);
        const last = items.at(-1)!;
        const at = new Date().toISOString();
        const seq = last.seq + 1;
        const item: Item = { ...last, id: `sim-${conv.id}-${seq}`, seq, from: body.from, fromMe: false, occurredAt: at, bodyNew: body.text, bodyQuoted: "" };
        const config = loadConfig();
        const raw = graphMessage({ id: String(Date.parse(at)), at, text: body.text, sender: body.from, replyToId: null, chatId: last.containerId, channel: conv.kind === "channel" }, []);
        conv.tags = (config.tag ?? []).map((t) => t.name).filter((n) => conv.tags.includes(n) || tagsOfInput(config, ruleInput({ ...item, raw }, false)).includes(n));
        conv.since = sinceOf(config, conv.tags);
        conv.itemIds.push(item.id);
        conv.lastSeq = seq;
        conv.lastAt = at;
        data.items.push(item);
        items.push(item);
        let made: Digest[] = [];
        const own = data.digests.filter((d) => d.conversationId === conv.id);
        const r = autoRange(items, own, conv.since, data.digest.threshold);
        if (r) {
          await writeData(data);
          made = (await generate({ conv, items, digests: own, data, fromSeq: r[0], toSeq: r[1], trigger: "auto", logPrefix: "live-" })).made;
          data.digests.push(...made);
        }
        await writeData(data);
        return Response.json({ item, conv, digests: made, auto: r });
      });
    }
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
