import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Status, ViewList } from "@weir/daemon/Api";
import { FIXTURE_NOW, seedThreads, type Thread } from "@weir/fixtures";
import * as Schema from "effect/Schema";

const GATE_MS = 100;
const THREADS = 1000;
const PAGE_SIZE = 100;
const SEARCH_WORD = "quarterly";

const { values: flags } = parseArgs({
  options: {
    url: { type: "string" },
    duration: { type: "string", default: "600" },
    idle: { type: "string", default: "10" },
  },
});
const backfillCapMs = Number(flags.duration) * 1000;
const idleMs = Number(flags.idle) * 1000;
if (!(backfillCapMs > 0) || !(idleMs > 0)) {
  console.error("usage: bun scripts/bench-read.ts [--url <daemon>] [--duration <s>] [--idle <s>]");
  process.exit(2);
}

const random = (() => {
  let state = 0x5eed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();

const VOCABULARY = (
  "the a to of and in for on with we our team plan update review next week meeting notes budget " +
  "release design customer invoice report draft deadline launch question thanks please schedule " +
  "project status follow call agenda numbers proposal contract timeline feedback summary details"
).split(" ");

const gmailBodyLength = () => {
  const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
  return Math.round(Math.min(60_000, Math.max(200, 3200 * Math.exp(0.807 * normal))));
};

const bodyText = (length: number, mentionsSearchWord: boolean) => {
  const paragraphs: Array<string> = [];
  let size = 0;
  while (size < length) {
    const words = Array.from(
      { length: 20 + Math.floor(random() * 40) },
      () => VOCABULARY[Math.floor(random() * VOCABULARY.length)],
    );
    const paragraph = words.join(" ");
    paragraphs.push(`${paragraph[0]?.toUpperCase()}${paragraph.slice(1)}.`);
    size += paragraph.length + 3;
  }
  if (mentionsSearchWord) paragraphs.splice(1, 0, `The ${SEARCH_WORD} numbers are attached.`);
  return paragraphs.join("\n\n").slice(0, Math.max(length, 60));
};

const syntheticThreads = (): Array<Thread> => {
  const senders = ["priya", "marcus", "tomas", "hannah", "jenna", "dev", "lisa"];
  const newest = Date.parse(FIXTURE_NOW);
  return Array.from({ length: THREADS }, (_, i) => {
    const sender = senders[i % senders.length] ?? "priya";
    const at = (offsetMs: number) =>
      new Date(newest - (i + 1) * 30 * 60_000 + offsetMs)
        .toISOString()
        .replace(/\.\d+Z$/, "+00:00");
    return {
      id: `bench-${i}`,
      subject: `Bench thread ${i}`,
      labels: i % 5 === 0 ? ["INBOX", "CATEGORY_PROMOTIONS"] : ["INBOX", "CATEGORY_PERSONAL"],
      messages: [
        {
          at: at(0),
          from: sender,
          to: ["me"],
          text: bodyText(gmailBodyLength(), random() < 0.05),
        },
        {
          at: at(10 * 60_000),
          from: "me",
          to: [sender],
          text: bodyText(gmailBodyLength(), random() < 0.05),
        },
      ],
    };
  });
};

const freePort = () => {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  return port;
};

const startDaemon = async () => {
  const root = mkdtempSync(join(tmpdir(), "weir-bench-"));
  const mailbox = join(root, "mailbox");
  const { delivered } = seedThreads(mailbox, syntheticThreads(), {
    now: FIXTURE_NOW,
    pageSize: PAGE_SIZE,
  });
  const port = freePort();
  const fakeGws = [
    process.execPath,
    join(import.meta.dirname, "../packages/fixtures/src/bin/fake-gws.ts"),
  ];
  writeFileSync(
    join(root, "config.toml"),
    `port = ${port}

[[source]]
id = "gmail"
plugin = "gws"
sync_every = "5m"

[source.config]
command = ${JSON.stringify([...fakeGws, "--mailbox", mailbox])}
backfill = "newer_than:30d"

[[tag]]
name = "Promos"
match = { type = "some", target = "/raw/labelIds", rule = { type = "eq", target = "", is = "CATEGORY_PROMOTIONS" } }

[[tag]]
name = "Priya"
match = { type = "regex", target = "/from/address", regex = "priya", flags = "i" }
`,
  );
  const daemon = Bun.spawn(
    [process.execPath, join(import.meta.dirname, "../apps/daemon/src/main.ts")],
    {
      env: { ...process.env, WEIR_HOME: root },
      stdout: "ignore",
      stderr: Bun.file(join(root, "daemon.log")),
    },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(`${url}/status`).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) break;
    if (attempt > 300) throw new Error(`daemon at ${url} did not start; see ${root}/daemon.log`);
    await Bun.sleep(100);
  }
  return {
    url,
    delivered,
    stop: async () => {
      daemon.kill("SIGTERM");
      await daemon.exited;
      rmSync(root, { recursive: true, force: true });
    },
  };
};

type Endpoint = "list" | "counts" | "conversation" | "search" | "status";
type Phase = "during backfill" | "idle";
type Sample = { readonly endpoint: Endpoint; readonly ms: number; readonly ok: boolean };
type Measured = {
  readonly samples: Record<Phase, ReadonlyArray<Sample>>;
  readonly items: Record<Phase, { readonly first: number; readonly last: number }>;
  readonly capped: boolean;
};

const paths: Record<Endpoint, string> = {
  list: "/conversations?view=untagged",
  counts: "/counts",
  conversation: "/conversations/:id",
  search: `/search?q=${SEARCH_WORD}`,
  status: "/status",
};
const order: ReadonlyArray<Endpoint> = ["list", "counts", "conversation", "search", "status"];

const decodeStatus = Schema.decodeUnknownSync(Schema.fromJsonString(Status));
const decodeList = Schema.decodeUnknownSync(Schema.fromJsonString(ViewList));

const backfillOf = (body: string) => {
  const streams = decodeStatus(body).sources.flatMap(({ streams }) => streams);
  return {
    state:
      streams.length === 0
        ? ("pending" as const)
        : streams.some(({ backfill }) => backfill === "running")
          ? ("running" as const)
          : ("done" as const),
    items: streams.reduce((sum, { items }) => sum + items, 0),
  };
};

const measure = async (url: string): Promise<Measured> => {
  const request = async (path: string) => {
    const start = performance.now();
    const response = await fetch(`${url}${path}`);
    const body = await response.text();
    return { ms: performance.now() - start, ok: response.ok, body };
  };
  const started = performance.now();
  let initial = backfillOf((await request(paths.status)).body);
  while (initial.state === "pending" && performance.now() - started < backfillCapMs) {
    await Bun.sleep(50);
    initial = backfillOf((await request(paths.status)).body);
  }
  const samples: Record<Phase, Array<Sample>> = { "during backfill": [], idle: [] };
  const items: Record<Phase, { first: number; last: number }> = {
    "during backfill": { first: initial.items, last: initial.items },
    idle: { first: initial.items, last: initial.items },
  };
  const running = initial.state === "running";
  let phase: Phase = running ? "during backfill" : "idle";
  let idleUntil = running ? Number.POSITIVE_INFINITY : performance.now() + idleMs;
  let capped = false;
  let ids: ReadonlyArray<number> = [];
  let round = 0;
  while (performance.now() < idleUntil) {
    if (phase === "during backfill" && performance.now() - started > backfillCapMs) {
      capped = true;
      break;
    }
    const endpoint = order[round % order.length] ?? "status";
    round++;
    const path =
      endpoint !== "conversation"
        ? paths[endpoint]
        : ids.length === 0
          ? null
          : `/conversations/${ids[round % ids.length]}`;
    if (path === null) continue;
    const { ms, ok, body } = await request(path);
    samples[phase].push({ endpoint, ms, ok });
    if (!ok) continue;
    if (endpoint === "list") ids = decodeList(body).conversations.map(({ id }) => id);
    if (endpoint === "status") {
      const backfill = backfillOf(body);
      items[phase].last = backfill.items;
      if (phase === "during backfill" && backfill.state === "done") {
        phase = "idle";
        items.idle = { first: backfill.items, last: backfill.items };
        idleUntil = performance.now() + idleMs;
      }
    }
  }
  return { samples, items, capped };
};

const nearestRank = (sorted: ReadonlyArray<number>, p: number) =>
  sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? Number.NaN;

const summarize = (samples: ReadonlyArray<Sample>) => {
  const ms = samples.map(({ ms }) => ms).toSorted((a, b) => a - b);
  return {
    n: ms.length,
    p50: nearestRank(ms, 0.5),
    p95: nearestRank(ms, 0.95),
    max: ms.at(-1) ?? Number.NaN,
    errors: samples.filter(({ ok }) => !ok).length,
  };
};

const report = (result: Measured) => {
  const fixed = (n: number) => (Number.isNaN(n) ? "-" : n.toFixed(1));
  const rows: Array<Array<string>> = [
    ["phase", "endpoint", "n", "p50 ms", "p95 ms", "max ms", "errors"],
  ];
  for (const phase of ["during backfill", "idle"] as const) {
    const all = result.samples[phase];
    for (const endpoint of order) {
      const path = paths[endpoint];
      const s = summarize(all.filter((sample) => sample.endpoint === endpoint));
      rows.push([
        phase,
        path,
        String(s.n),
        fixed(s.p50),
        fixed(s.p95),
        fixed(s.max),
        String(s.errors),
      ]);
    }
    const s = summarize(all);
    rows.push([
      phase,
      "overall",
      String(s.n),
      fixed(s.p50),
      fixed(s.p95),
      fixed(s.max),
      String(s.errors),
    ]);
  }
  const widths =
    rows[0]?.map((_, column) => Math.max(...rows.map((row) => row[column]?.length ?? 0))) ?? [];
  for (const row of rows) {
    console.log(row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  "));
  }
  const during = result.items["during backfill"];
  console.log(
    `items during backfill: ${during.first} -> ${during.last}; idle: ${result.items.idle.first} -> ${result.items.idle.last}`,
  );
};

const local = flags.url === undefined ? await startDaemon() : null;
const url = flags.url ?? local?.url ?? "";
if (local !== null) {
  console.log(
    `bench-read: ${local.delivered} messages in ${THREADS} threads, fake-gws page size ${PAGE_SIZE}, daemon ${url}`,
  );
} else {
  console.log(`bench-read: measuring ${url}`);
}
const result = await measure(url).finally(() => local?.stop());
report(result);

const during = summarize(result.samples["during backfill"]);
const errors = during.errors + summarize(result.samples.idle).errors;
if (result.capped) console.log(`backfill still running after --duration ${flags.duration}s`);
if (errors > 0) {
  console.log(`FAIL: ${errors} request(s) did not return 2xx`);
  process.exit(1);
}
if (during.n === 0) {
  console.log("no samples during a backfill: the backfill was not running, gate not evaluated");
  process.exit(2);
}
if (during.p95 > GATE_MS) {
  console.log(`FAIL: during-backfill p95 ${during.p95.toFixed(1)} ms > ${GATE_MS} ms`);
  process.exit(1);
}
console.log(`ok: during-backfill p95 ${during.p95.toFixed(1)} ms <= ${GATE_MS} ms`);
