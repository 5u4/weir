import type {
  DigestConflict,
  DigestFailed,
  DigestInterrupted,
  DigestRun,
  Event,
  NotFound,
} from "@weir/daemon/Api";

export type Action =
  | { readonly _tag: "Now" }
  | { readonly _tag: "From"; readonly seq: number }
  | { readonly _tag: "UpTo"; readonly seq: number }
  | { readonly _tag: "Redo"; readonly id: number };

export type Range = { readonly from: number; readonly to: number };

export type Here = { readonly range: Range; readonly items: number };

export type Cause =
  | { readonly _tag: "Failed"; readonly error: string; readonly log_path: string | null }
  | { readonly _tag: "Conflict"; readonly message: string }
  | { readonly _tag: "NotFound"; readonly message: string }
  | { readonly _tag: "Interrupted"; readonly message: string };

export type Origin =
  | { readonly _tag: "Tab"; readonly action: Action }
  | { readonly _tag: "Remote" };

export type Run =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Running"; readonly range: Range; readonly origin: Origin }
  | {
      readonly _tag: "Failed";
      readonly action: Action;
      readonly range: Range;
      readonly items: number;
      readonly cause: Cause;
    };

export const idle: Run = { _tag: "Idle" };

export type Payload = { readonly from?: number; readonly up_to?: number };

export const payload = (action: Exclude<Action, { readonly _tag: "Redo" }>): Payload => {
  switch (action._tag) {
    case "Now":
      return {};
    case "From":
      return { from: action.seq };
    case "UpTo":
      return { up_to: action.seq };
  }
};

export const heres = (run: ReadonlyArray<{ readonly seq: number }>): ReadonlyArray<Here> => {
  const to = run.at(-1)?.seq ?? 0;
  return run.map(({ seq }, index) => ({ range: { from: seq, to }, items: run.length - index }));
};

export const hereLabel = (items: number) =>
  items === 1 ? "Digest this message" : `Digest ${items} from here`;

export const earlierLabel = (gap: { readonly items: number; readonly run_items: number }) =>
  gap.items === gap.run_items ? "Digest earlier" : `Digest ${gap.items} earlier`;

export const within = (range: Range, seq: number) => range.from <= seq && seq <= range.to;

export type Rejection = NotFound | DigestConflict | DigestFailed | DigestInterrupted;

export const cause = (error: Rejection): Cause => {
  switch (error._tag) {
    case "DigestFailed":
      return { _tag: "Failed", error: error.error, log_path: error.log_path };
    case "DigestConflict":
      return { _tag: "Conflict", message: error.message };
    case "NotFound":
      return { _tag: "NotFound", message: error.message };
    case "DigestInterrupted":
      return { _tag: "Interrupted", message: error.message };
  }
};

export const reason = (cause: Cause) => (cause._tag === "Failed" ? cause.error : cause.message);

export type DigestEvent = Extract<Event, { readonly type: "digest" }>;

export const observe = (run: Run, event: DigestEvent): Run => {
  if (run._tag === "Running" && run.origin._tag === "Tab") return run;
  switch (event.status) {
    case "queued":
    case "running":
      return {
        _tag: "Running",
        range: { from: event.from_seq, to: event.to_seq },
        origin: { _tag: "Remote" },
      };
    case "done":
    case "failed":
      return run._tag === "Running" ? idle : run;
  }
};

export const settle = (run: Run): Run =>
  run._tag === "Running" && run.origin._tag === "Remote" ? idle : run;

export const seeded = (
  run: Run,
  failure: DigestRun | null,
  items: ReadonlyArray<{ readonly seq: number }>,
): Run => {
  if (run._tag !== "Idle" || failure === null) return run;
  const range = { from: failure.from_seq, to: failure.to_seq };
  return {
    _tag: "Failed",
    action: { _tag: "From", seq: failure.from_seq },
    range,
    items: items.filter(({ seq }) => within(range, seq)).length,
    cause: {
      _tag: "Failed",
      error: failure.error ?? "the digest run failed",
      log_path: failure.log_path,
    },
  };
};

const actionKey = (action: Action) =>
  action._tag === "Now"
    ? "Now"
    : `${action._tag}:${action._tag === "Redo" ? action.id : action.seq}`;

export const runs = (run: Run, action: Action) =>
  run._tag === "Running" &&
  run.origin._tag === "Tab" &&
  actionKey(run.origin.action) === actionKey(action);

export const failedAt = (run: Run, action: Action) =>
  run._tag === "Failed" && actionKey(run.action) === actionKey(action) ? run : undefined;
