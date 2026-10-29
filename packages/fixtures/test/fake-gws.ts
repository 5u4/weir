import { join } from "node:path";

export const FAKE_GWS = join(import.meta.dirname, "../../../node_modules/.bin/fake-gws");

export type Run = { stdout: string; stderr: string; exitCode: number };

export const fakeGws = (args: string[], mailboxDir?: string): Run => {
  const proc = Bun.spawnSync([FAKE_GWS, ...(mailboxDir ? ["--mailbox", mailboxDir] : []), ...args]);
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode,
  };
};

export const gmail = (command: string, params: Record<string, unknown>, mailboxDir?: string) => {
  const run = fakeGws(
    ["gmail", "users", ...command.split(" "), "--params", JSON.stringify(params)],
    mailboxDir,
  );
  if (run.exitCode !== 0)
    throw new Error(`fake-gws ${command} exited ${run.exitCode}: ${run.stderr}`);
  return JSON.parse(run.stdout);
};

export const listAll = (params: Record<string, unknown>, mailboxDir?: string) => {
  const threads: string[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const page = gmail(
      "threads list",
      { userId: "me", ...params, ...(pageToken ? { pageToken } : {}) },
      mailboxDir,
    );
    threads.push(...(page.threads ?? []).map((t: { id: string }) => t.id));
    pageToken = page.nextPageToken;
    pages++;
  } while (pageToken);
  const messages: { id: string; threadId: string; labelIds: string[]; payload: unknown }[] =
    threads.flatMap(
      (id) => gmail("threads get", { userId: "me", id, format: "full" }, mailboxDir).messages,
    );
  return { threads, messages, pages };
};
