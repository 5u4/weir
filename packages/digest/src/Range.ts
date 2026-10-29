import type { DigestId, Seq } from "@weir/store/Rows";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

export interface ItemLite {
  readonly seq: Seq;
  readonly occurredAt: DateTime.Utc;
  readonly chars: number;
}

export interface Span {
  readonly id: DigestId;
  readonly fromSeq: Seq;
  readonly toSeq: Seq;
}

export interface Range {
  readonly fromSeq: Seq;
  readonly toSeq: Seq;
}

export type Request =
  | { readonly _tag: "Now" }
  | { readonly _tag: "From"; readonly seq: Seq }
  | { readonly _tag: "UpTo"; readonly seq: Seq }
  | { readonly _tag: "Redo"; readonly id: DigestId };

export interface Backlog {
  readonly chars: number;
  readonly range: Range | null;
}

const floorOf = (spans: ReadonlyArray<Pick<Span, "toSeq">>) =>
  Math.max(0, ...spans.map(({ toSeq }) => toSeq));

export const backlog = (
  items: ReadonlyArray<ItemLite>,
  spans: ReadonlyArray<Span>,
  since: DateTime.Utc,
): Backlog => {
  const floor = floorOf(spans);
  const start = items.findIndex(
    (item) => item.seq > floor && DateTime.isGreaterThanOrEqualTo(item.occurredAt, since),
  );
  const last = items.at(-1);
  if (start === -1 || last === undefined) return { chars: 0, range: null };
  const tail = items.slice(start);
  return {
    chars: tail.reduce((sum, item) => sum + item.chars, 0),
    range: { fromSeq: tail[0]?.seq ?? last.seq, toSeq: last.seq },
  };
};

export const autoRange = (
  items: ReadonlyArray<ItemLite>,
  spans: ReadonlyArray<Span>,
  since: DateTime.Utc,
  threshold: number,
): Range | null => {
  const { chars, range } = backlog(items, spans, since);
  return chars >= threshold ? range : null;
};

export const manualRange = (
  items: ReadonlyArray<ItemLite>,
  spans: ReadonlyArray<Span>,
  request: Request,
  maxInput: number,
): Result.Result<Range, string> => {
  const first = items[0];
  const last = items.at(-1);
  if (first === undefined || last === undefined)
    return Result.fail("the conversation has no items");
  if (request._tag === "Redo") {
    const span = spans.find(({ id }) => id === request.id);
    if (span === undefined) return Result.fail(`no digest ${request.id} in this conversation`);
    const range = { fromSeq: span.fromSeq, toSeq: span.toSeq };
    return chunks(items, range, maxInput).length > 1
      ? Result.fail(
          `#${range.fromSeq}-#${range.toSeq} is over max_input ${maxInput}; raise max_input to redo it`,
        )
      : Result.succeed(range);
  }
  if (request._tag === "Now") {
    const floor = floorOf(spans);
    const start = items.find(({ seq }) => seq > floor);
    return start === undefined
      ? Result.fail("nothing after the last digest")
      : Result.succeed({ fromSeq: start.seq, toSeq: last.seq });
  }
  const at = items.findIndex(({ seq }) => seq === request.seq);
  if (at === -1) {
    return Result.fail(
      request.seq < first.seq || request.seq > last.seq
        ? `#${request.seq} is outside #${first.seq}-#${last.seq}`
        : `#${request.seq} is not a message in this conversation`,
    );
  }
  if (spans.some(({ fromSeq, toSeq }) => fromSeq <= request.seq && request.seq <= toSeq)) {
    return Result.fail(`#${request.seq} is already in a digest`);
  }
  if (request._tag === "From") {
    const next = Math.min(
      Number.POSITIVE_INFINITY,
      ...spans.filter(({ fromSeq }) => fromSeq > request.seq).map(({ fromSeq }) => fromSeq),
    );
    const before = items.filter(({ seq }) => seq < next).at(-1) ?? last;
    return Result.succeed({ fromSeq: request.seq, toSeq: before.seq });
  }
  const floor = floorOf(spans.filter(({ toSeq }) => toSeq < request.seq));
  let from = at;
  let chars = items[at]?.chars ?? 0;
  for (let index = at - 1; index >= 0; index--) {
    const item = items[index];
    if (item === undefined || item.seq <= floor || chars + item.chars > maxInput) break;
    chars += item.chars;
    from = index;
  }
  return Result.succeed({ fromSeq: items[from]?.seq ?? request.seq, toSeq: request.seq });
};

export interface Gap extends Range {
  readonly items: number;
  readonly runItems: number;
}

export interface EarlierGap extends Gap {
  readonly beforeDigest: DigestId;
}

export interface Gaps {
  readonly earlier: ReadonlyArray<EarlierGap>;
  readonly now: Gap | null;
}

const gap = (
  items: ReadonlyArray<ItemLite>,
  spans: ReadonlyArray<Span>,
  run: ReadonlyArray<ItemLite>,
  request: Request,
  maxInput: number,
): Gap | null => {
  if (run.length === 0) return null;
  const range = manualRange(items, spans, request, maxInput);
  if (Result.isFailure(range)) return null;
  const { fromSeq, toSeq } = range.success;
  return {
    fromSeq,
    toSeq,
    items: run.filter(({ seq }) => fromSeq <= seq && seq <= toSeq).length,
    runItems: run.length,
  };
};

export const gaps = (
  items: ReadonlyArray<ItemLite>,
  spans: ReadonlyArray<Span>,
  maxInput: number,
): Gaps => {
  const earlier: Array<EarlierGap> = [];
  let cursor = 0;
  let reach = 0;
  for (const span of spans.toSorted((a, b) => a.fromSeq - b.fromSeq)) {
    while (cursor < items.length && (items[cursor]?.seq ?? 0) <= reach) cursor++;
    const start = cursor;
    while (cursor < items.length && (items[cursor]?.seq ?? 0) < span.fromSeq) cursor++;
    const run = items.slice(start, cursor);
    const last = run.at(-1);
    if (last !== undefined) {
      const found = gap(run, [], run, { _tag: "UpTo", seq: last.seq }, maxInput);
      if (found !== null) earlier.push({ ...found, beforeDigest: span.id });
    }
    reach = Math.max(reach, span.toSeq);
  }
  const floor = floorOf(spans);
  const tail = items.filter(({ seq }) => seq > floor);
  return { earlier, now: gap(items, spans, tail, { _tag: "Now" }, maxInput) };
};

export const chunks = (
  items: ReadonlyArray<ItemLite>,
  range: Range,
  maxInput: number,
): Array<Range> => {
  const result: Array<Range> = [];
  let chars = 0;
  for (const item of items) {
    if (item.seq < range.fromSeq || item.seq > range.toSeq) continue;
    const last = result.at(-1);
    if (last === undefined || chars + item.chars > maxInput) {
      result.push({ fromSeq: item.seq, toSeq: item.seq });
      chars = item.chars;
    } else {
      result[result.length - 1] = { fromSeq: last.fromSeq, toSeq: item.seq };
      chars += item.chars;
    }
  }
  return result;
};
