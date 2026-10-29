import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { CSSProperties, KeyboardEvent, PointerEvent, UIEvent } from "react";
import { Avatar } from "./Avatar.tsx";
import {
  type Block,
  type Bubbles,
  type Detail,
  type Digest,
  type ItemSummary,
  participants,
  reader,
  revealing,
  span,
  type TopicKey,
  type TopicView,
} from "./Blocks.ts";
import {
  type Action,
  earlierLabel,
  failedAt,
  type Here,
  hereLabel,
  type Range,
  type Run,
  reason,
  runs,
  within,
} from "./Digest.ts";
import type { DockAction } from "./Dock.ts";
import { clockTime, dayAndTime, plural } from "./Health.ts";
import { monogram } from "./Notch.ts";
import { dock, type Preview, pins, preview, readerUi, reading } from "./Reading.ts";
import { type ConversationId, route } from "./Route.ts";
import { homeTag, tagHue } from "./Rows.ts";
import { conversation, digestRun, dismiss, runDigest, tagOrder } from "./Weir.ts";

type Controls = {
  readonly run: Run;
  readonly act: (action: Action, range: Range, items: number, anchor?: Element | null) => void;
};

type Failed = Extract<Run, { readonly _tag: "Failed" }>;

const previewing = (set: (preview: Preview) => void, range: Range) => ({
  onPointerEnter: (event: PointerEvent) => {
    if (event.pointerType !== "touch") set({ range, tapped: false });
  },
  onPointerLeave: (event: PointerEvent) => {
    if (event.pointerType !== "touch") set(null);
  },
  onFocus: () => set({ range, tapped: false }),
  onBlur: () => set(null),
});

function Arrow({ up = false }: { up?: boolean }) {
  return (
    <svg className="ar" viewBox="0 0 16 16" aria-hidden="true">
      <path d={up ? "M8 12.5v-9M4.5 7L8 3.5 11.5 7" : "M8 3.5v9M4.5 9L8 12.5 11.5 9"} />
    </svg>
  );
}

function LogPath({ failed }: { failed: Failed }) {
  return failed.cause._tag === "Failed" && failed.cause.log_path !== null ? (
    <span className="dg-log">
      Raw output <code>{failed.cause.log_path}</code>
    </span>
  ) : null;
}

function Failure({
  failed,
  controls,
  className,
  gap,
}: {
  failed: Failed;
  controls: Controls;
  className: string;
  gap?: number;
}) {
  const why = reason(failed.cause);
  return (
    <div className={`tl-h err ${className}`} role="alert" data-gap={gap}>
      <span className="tl-k">Couldn't digest {plural(failed.items, "message")}</span>
      <span className="tl-e" title={why}>
        {why}
      </span>
      <button
        type="button"
        className="gp-go"
        onClick={(event) =>
          controls.act(
            failed.action,
            failed.range,
            failed.items,
            event.currentTarget.closest("[data-gap]"),
          )
        }
      >
        Try again
      </button>
      <LogPath failed={failed} />
    </div>
  );
}

function Skeleton({ items }: { items: number }) {
  const bar = (width: string, className = "") => (
    <span className={`sk-b ${className}`} style={{ "--w": width } as CSSProperties} />
  );
  const topic = (title: string, line: string, short: string) => (
    <div className="sk-tp">
      <span className="sk-s" />
      <div>
        {bar(title, "sk-tt")}
        {bar(line)}
        {bar(short)}
      </div>
    </div>
  );
  return (
    <div className="dc sk" role="status" aria-live="polite">
      <p className="sk-l">
        <span className="sk-dot" aria-hidden="true" />
        Digesting {plural(items, "message")}…
      </p>
      <div aria-hidden="true">
        {bar("64%", "sk-h")}
        {topic("30%", "92%", "58%")}
        {topic("24%", "84%", "40%")}
      </div>
    </div>
  );
}

const scrollKeys: Record<string, true> = {
  ArrowDown: true,
  ArrowUp: true,
  PageDown: true,
  PageUp: true,
  Home: true,
  End: true,
  " ": true,
};

const day = (iso: string) =>
  DateTime.formatLocal(DateTime.makeUnsafe(iso), { month: "short", day: "numeric" });

const timeSpan = (items: ReadonlyArray<ItemSummary>) => {
  const covered = span(items);
  if (covered === null) return "";
  const { first, last } = covered;
  const from = DateTime.makeUnsafe(first);
  const to = DateTime.makeUnsafe(last);
  if (first === last) return dayAndTime(from);
  return day(first) === day(last)
    ? `${day(first)} ${clockTime(from)}–${clockTime(to)}`
    : `${dayAndTime(from)} – ${dayAndTime(to)}`;
};

const stateNames: Record<TopicView["topic"]["state"], string> = {
  open: "Open",
  resolved: "Resolved",
  fyi: "FYI",
};

function Chevron({ up = false }: { up?: boolean }) {
  return (
    <svg className="cv" viewBox="0 0 16 16" aria-hidden="true">
      <path d={up ? "M4 10l4-4 4 4" : "M4 6l4 4 4-4"} />
    </svg>
  );
}

type Watch = (end: HTMLElement) => () => void;

type Mark = { readonly seen: number; readonly unread: (from: number) => void };

function End({ seq, watch }: { seq: number; watch: Watch }) {
  return <span className="read-end" data-seq={seq} ref={watch} aria-hidden="true" />;
}

function Bubble({
  item,
  here,
  controls,
  watch,
  mark,
}: {
  item: ItemSummary;
  here: Here | undefined;
  controls: Controls | null;
  watch: Watch | undefined;
  mark: Mark;
}) {
  const [shown, setPreview] = useAtom(preview);
  const run = controls?.run;
  const action: Action = { _tag: "From", seq: item.seq };
  const digestible = here !== undefined && controls !== null;
  const failed = digestible && run !== undefined ? failedAt(run, action) : undefined;
  const tapped = shown?.tapped === true && shown.range.from === item.seq;
  const classes = [
    "bl",
    digestible && "dg",
    digestible && run?._tag === "Running" && within(run.range, item.seq) && "busy",
    digestible && shown !== null && within(shown.range, item.seq) && "pv",
    tapped && "tap",
  ];
  return (
    <>
      <div
        className={classes.filter(Boolean).join(" ")}
        onClick={(event) => {
          if (!digestible || !(event.nativeEvent instanceof globalThis.PointerEvent)) return;
          if (event.nativeEvent.pointerType !== "touch") return;
          if (event.target instanceof Element && event.target.closest("button, a") !== null) return;
          setPreview(tapped ? null : { range: here.range, tapped: true });
        }}
      >
        <div className="bb">
          {item.body_new.trim() === "" ? (
            <p className="body b-none">(no text)</p>
          ) : (
            <p className="body">{item.body_new}</p>
          )}
        </div>
        {(digestible || item.seq <= mark.seen) && (
          <span className="dfh-w">
            {item.seq <= mark.seen && (
              <button type="button" className="mu" onClick={() => mark.unread(item.seq)}>
                Mark unread from here
              </button>
            )}
            {digestible && (
              <button
                type="button"
                className={`dfh${runs(controls.run, action) ? " on" : ""}`}
                disabled={controls.run._tag === "Running"}
                onClick={() => controls.act(action, here.range, here.items)}
                {...previewing(setPreview, here.range)}
              >
                <Arrow />
                {runs(controls.run, action) ? "Digesting…" : hereLabel(here.items)}
              </button>
            )}
          </span>
        )}
        {watch !== undefined && <End seq={item.seq} watch={watch} />}
      </div>
      {failed !== undefined && controls !== null && (
        <Failure failed={failed} controls={controls} className="bl-e" />
      )}
    </>
  );
}

function Group({
  group,
  mark,
  watch,
  controls = null,
}: {
  group: Bubbles;
  mark: Mark;
  watch?: Watch;
  controls?: Controls | null;
}) {
  const name = group.me ? "Me" : group.from.name.trim() || group.from.address;
  const at = DateTime.makeUnsafe(group.at);
  const avatar = (
    <span className="g-av">
      <Avatar address={group.from.address} mark={group.me ? "Me" : monogram(group.from)} />
    </span>
  );
  const column = (
    <div className="g-col">
      <div className="g-head">
        <b title={group.from.address}>{name}</b>
        <time dateTime={group.at} title={dayAndTime(at)}>
          {clockTime(at)}
        </time>
      </div>
      {group.items.map((item, index) => (
        <Bubble
          key={item.seq}
          item={item}
          here={group.heres?.[index]}
          controls={controls}
          watch={watch}
          mark={mark}
        />
      ))}
    </div>
  );
  return (
    <section className={`sg${group.me ? " me" : ""}`} aria-label={`${name}, ${dayAndTime(at)}`}>
      {group.me ? column : avatar}
      {group.me ? avatar : column}
    </section>
  );
}

function Pin({ id, unfold, view }: { id: ConversationId; unfold: () => void; view: TopicView }) {
  const at = useAtomValue(pins(id)).get(view.key) ?? 1;
  return (
    <span className="pin-r">
      <span className="pin-n" aria-live="off">
        {Math.min(at, view.items.length)} of {view.items.length}
      </span>
      <button type="button" className="pin-x" onClick={unfold} aria-label="Fold the originals back">
        Fold
        <Chevron up />
      </button>
    </span>
  );
}

function Topic({
  id,
  view,
  solo,
  mark,
}: {
  id: ConversationId;
  view: TopicView;
  solo: boolean;
  mark: Mark;
}) {
  const [, setUi] = useAtom(readerUi(id));
  const toggle = () =>
    setUi((ui) => {
      const originals = new Set(ui.originals);
      if (view.open) originals.delete(view.key);
      else originals.add(view.key);
      return { ...ui, originals };
    });
  const who = [...new Map(view.items.map((item) => [item.from_me || item.from.address, item]))];
  return (
    <section className={`tp${view.open ? " open" : ""}${solo ? " solo" : ""}`}>
      {!solo && (
        <header className={`tp-h${view.open ? " pin" : ""}`} data-key={view.key}>
          <i className={`tsm tsm-${view.topic.state}`}>{stateNames[view.topic.state]}</i>
          <h4 className="tp-t">{view.topic.title}</h4>
          {view.open && <Pin id={id} unfold={toggle} view={view} />}
        </header>
      )}
      <p className="tp-b">{view.topic.body}</p>
      <button
        type="button"
        className={`tp-o${view.open ? " on" : ""}`}
        aria-expanded={view.open}
        onClick={toggle}
      >
        <span className="tp-av" aria-hidden="true">
          {who.slice(0, 3).map(([key, item]) => (
            <Avatar
              key={String(key)}
              address={item.from.address}
              mark={item.from_me ? "Me" : monogram(item.from)}
            />
          ))}
        </span>
        {plural(view.items.length, "original")}
        <Chevron />
      </button>
      {view.open && (
        <div className="unf">
          {view.groups.map((group) => (
            <Group key={group.items[0]?.seq} group={group} mark={mark} />
          ))}
        </div>
      )}
    </section>
  );
}

const meta = (digest: Digest, items: ReadonlyArray<ItemSummary>) => [
  timeSpan(items),
  plural(items.length, "message"),
  ...(digest.trigger === "manual" ? ["Manual"] : []),
];

function DigestCard({
  id,
  block,
  watch,
  mark,
  controls,
}: {
  id: ConversationId;
  block: Extract<Block, { _tag: "DigestCard" }>;
  watch: Watch;
  mark: Mark;
  controls: Controls | null;
}) {
  const [, setUi] = useAtom(readerUi(id));
  const { digest, items, topics } = block;
  const solo = topics.length === 1;
  const only = topics[0];
  const pinned = solo && only?.open === true;
  const collapse = () =>
    setUi((ui) => ({ ...ui, shapes: new Map(ui.shapes).set(digest.id, "row") }));
  const unfoldOnly = () =>
    setUi((ui) => {
      const originals = new Set(ui.originals);
      if (only !== undefined) originals.delete(only.key);
      return { ...ui, originals };
    });
  const action: Action = { _tag: "Redo", id: digest.id };
  const run = controls?.run;
  const redoing =
    run?._tag === "Running" && run.range.from === digest.from_seq && run.range.to === digest.to_seq;
  const failed = run === undefined ? undefined : failedAt(run, action);
  return (
    <section
      className={`dc${solo ? " solo" : ""}${redoing ? " redoing" : ""}`}
      aria-label={digest.headline}
      aria-busy={redoing || undefined}
    >
      <header className={`dc-h${pinned ? " pin" : ""}`} data-key={only?.key}>
        {digest.from_seq !== digest.to_seq && (
          <p className="dc-m">
            {meta(digest, items).map((bit) => (
              <span key={bit}>{bit}</span>
            ))}
          </p>
        )}
        <div className="dc-hl">
          <h3 className="dc-t">{digest.headline}</h3>
          {solo && only?.open && <Pin id={id} unfold={unfoldOnly} view={only} />}
          <button type="button" className="dc-x" onClick={collapse}>
            Collapse
          </button>
          {controls !== null && (
            <button
              type="button"
              className="dc-redo"
              title="Digest this range again with the current prompt and model"
              disabled={controls.run._tag === "Running"}
              onClick={() =>
                controls.act(action, { from: digest.from_seq, to: digest.to_seq }, items.length)
              }
            >
              {runs(controls.run, action)
                ? "Redoing…"
                : failed !== undefined
                  ? "Try again"
                  : "Redo"}
            </button>
          )}
        </div>
        {failed !== undefined && (
          <p className="dc-err" role="alert">
            Couldn't redo. {reason(failed.cause)} <LogPath failed={failed} />
          </p>
        )}
      </header>
      <div className="tps">
        {topics.map((view) => (
          <Topic key={view.key} id={id} view={view} solo={solo} mark={mark} />
        ))}
      </div>
      <End seq={digest.to_seq} watch={watch} />
    </section>
  );
}

function BlockView({
  id,
  block,
  watch,
  mark,
  controls,
}: {
  id: ConversationId;
  block: Block;
  watch: Watch;
  mark: Mark;
  controls: Controls | null;
}) {
  const [, setUi] = useAtom(readerUi(id));
  const setPreview = useAtomSet(preview);
  switch (block._tag) {
    case "Marker":
      return (
        <div className="lr" role="separator">
          <span>
            <b>{block.kind === "all-new" ? "All new from here" : "Last read"}</b>
            {block.newCount} new
          </span>
        </div>
      );
    case "EarlierFold":
      return (
        <button
          type="button"
          className="older"
          onClick={() => setUi((ui) => ({ ...ui, earlier: true }))}
        >
          <span className="o-n">{plural(block.digests.length, "earlier digest")}</span>
          <span className="o-span">
            {timeSpan(block.items)} · {plural(block.items.length, "message")}
          </span>
          <span className="o-go">Show</span>
        </button>
      );
    case "DigestRow":
      return (
        <div className="rr-w">
          <button
            type="button"
            className="rr"
            aria-expanded={false}
            onClick={() =>
              setUi((ui) => ({ ...ui, shapes: new Map(ui.shapes).set(block.digest.id, "card") }))
            }
          >
            <span className="rr-m">{meta(block.digest, block.items).join(" · ")}</span>
            <span className="rr-t">{block.digest.headline}</span>
          </button>
          <End seq={block.digest.to_seq} watch={watch} />
        </div>
      );
    case "DigestCard":
      return <DigestCard id={id} block={block} watch={watch} mark={mark} controls={controls} />;
    case "GapBar": {
      const { gap } = block;
      const action: Action = { _tag: "UpTo", seq: block.up_to };
      const failed = controls === null ? undefined : failedAt(controls.run, action);
      if (failed !== undefined && controls !== null) {
        return <Failure failed={failed} controls={controls} className="ge" gap={block.first} />;
      }
      return (
        <div className="tl-h ge" data-gap={block.first}>
          <span className="tl-k">Not digested</span>
          <span className="tl-n">{plural(block.run_items, "message")} above</span>
          {controls !== null && gap !== null && (
            <button
              type="button"
              className={`gp-go${runs(controls.run, action) ? " on" : ""}`}
              disabled={controls.run._tag === "Running"}
              onClick={(event) =>
                controls.act(
                  action,
                  { from: gap.from_seq, to: gap.to_seq },
                  gap.items,
                  event.currentTarget.closest("[data-gap]"),
                )
              }
              {...previewing(setPreview, { from: gap.from_seq, to: gap.to_seq })}
            >
              <Arrow up />
              {runs(controls.run, action) ? "Digesting…" : earlierLabel(gap)}
            </button>
          )}
        </div>
      );
    }
    case "Tail": {
      const { now, backlog } = block;
      const action: Action = { _tag: "Now" };
      const failed = controls === null ? undefined : failedAt(controls.run, action);
      if (failed !== undefined && controls !== null) {
        return <Failure failed={failed} controls={controls} className="tl" />;
      }
      return (
        <div className="tl-h tl">
          <span className="tl-k">Not digested</span>
          {backlog !== null && (
            <>
              <span className="tl-n">
                {backlog.chars.toLocaleString("en")} of {backlog.threshold.toLocaleString("en")}
              </span>
              <span
                className="tl-m"
                role="meter"
                aria-label="Characters toward the next digest"
                aria-valuemin={0}
                aria-valuemax={backlog.threshold}
                aria-valuenow={Math.min(backlog.chars, backlog.threshold)}
                style={{ "--p": Math.min(1, backlog.chars / backlog.threshold) } as CSSProperties}
              >
                <i />
              </span>
            </>
          )}
          {controls !== null && now !== null && (
            <button
              type="button"
              className="tl-go"
              disabled={controls.run._tag === "Running"}
              onClick={() =>
                controls.act(action, { from: now.from_seq, to: now.to_seq }, now.items)
              }
              {...previewing(setPreview, { from: now.from_seq, to: now.to_seq })}
            >
              Digest now
            </button>
          )}
        </div>
      );
    }
    case "Skeleton":
      return <Skeleton items={block.items} />;
    case "Bubbles":
      return <Group group={block} watch={watch} mark={mark} controls={controls} />;
  }
}

const blockKey = (block: Block) => {
  switch (block._tag) {
    case "Marker":
    case "Tail":
    case "Skeleton":
      return block._tag;
    case "EarlierFold":
      return `earlier-${block.digests[0]?.id}`;
    case "DigestRow":
    case "DigestCard":
      return `d-${block.digest.id}`;
    case "GapBar":
      return `gap-${block.first}`;
    case "Bubbles":
      return `g-${block.items[0]?.seq}`;
  }
};

const land = (root: HTMLElement | null) => {
  const scroller = root?.closest(".r-scroll");
  if (root === null || scroller == null) return;
  const marker = root.querySelector(".lr");
  scroller.scrollTop =
    marker === null
      ? scroller.scrollHeight
      : scroller.scrollTop +
        marker.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        24;
};

const hold = (anchor: Element | null | undefined) => {
  const scroller = anchor?.closest(".r-scroll");
  if (!(anchor instanceof HTMLElement) || scroller == null) return () => {};
  const top = anchor.getBoundingClientRect().top;
  const view = scroller.getBoundingClientRect();
  if (top < view.top || top > view.bottom) return () => {};
  return () => {
    const moved = scroller.querySelector(`[data-gap="${anchor.dataset.gap}"]`);
    if (moved !== null) scroller.scrollTop += moved.getBoundingClientRect().top - top;
  };
};

function Conversation({
  id,
  detail,
  frozen,
  watch,
  mark,
}: {
  id: ConversationId;
  detail: Detail;
  frozen: number;
  watch: Watch;
  mark: Mark;
}) {
  const [ui, setUi] = useAtom(readerUi(id));
  const { view } = useAtomValue(route);
  const hue = tagHue(useAtomValue(tagOrder), view, detail);
  const run = useAtomValue(digestRun(id));
  const start = useAtomSet(runDigest);
  const setPreview = useAtomSet(preview);
  const controls: Controls | null =
    detail.digest.earlier === null
      ? null
      : {
          run,
          act: (action, range, items, anchor) => {
            setPreview(null);
            start({
              id,
              action,
              range,
              items,
              land: (digests) => {
                setUi((current) => ({
                  ...current,
                  shapes: new Map([
                    ...current.shapes,
                    ...digests.map((digest) => [digest, "card"] as const),
                  ]),
                }));
                return hold(anchor);
              },
            });
          },
        };
  const newCount = detail.items.filter(({ seq }) => seq > frozen).length;
  const home = homeTag(view, detail.tags);
  const tags = detail.tags.filter((tag) => tag !== home);
  return (
    <article
      className="conv"
      ref={land}
      aria-label={detail.title}
      style={hue === undefined ? undefined : ({ "--bh": hue } as CSSProperties)}
    >
      <header className="r-head">
        <p className="r-crumb">
          {home !== undefined && <b>{home}</b>}
          {tags.map((tag) => (
            <span key={tag} className="tg">
              {tag}
            </span>
          ))}
          <span>{detail.source}</span>
          <span>{newCount > 0 ? `${newCount} new this time` : "Read"}</span>
          <span>
            {plural(detail.items.length, "message")} ·{" "}
            {plural(participants(detail), "person", "people")}
          </span>
          <span>
            {day(detail.first_at)} – {day(detail.last_at)}
          </span>
        </p>
        <h2 className="r-title">{detail.title}</h2>
      </header>
      {reader(detail, frozen, revealing(ui, run), run._tag === "Running" ? run.range : null).map(
        (block) => (
          <BlockView
            key={blockKey(block)}
            id={id}
            block={block}
            watch={watch}
            mark={mark}
            controls={controls}
          />
        ),
      )}
    </article>
  );
}

const dockLabels: Record<DockAction, string> = {
  Done: "Done",
  Restore: "Restore",
  MarkUnread: "Mark unread",
  Mute: "Mute",
};

function Dock({ id }: { id: ConversationId }) {
  const shown = useAtomValue(dock(id));
  const [current, navigate] = useAtom(route);
  const { unread } = useAtomValue(reading(id));
  const run = useAtomSet(dismiss);
  if (Option.isNone(shown)) return null;
  const { actions, target } = shown.value;
  return (
    <div className="r-dock" role="group" aria-label="Conversation actions">
      <button
        type="button"
        className="back"
        aria-label="Back"
        onClick={() => navigate({ _tag: "Go", to: { ...current, conversation: Option.none() } })}
      >
        <svg className="bk-i" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M10 3.5L5.5 8l4.5 4.5" />
        </svg>
      </button>
      {actions.map((action) => (
        <button
          key={action}
          type="button"
          className={action === "Done" || action === "Restore" ? "primary" : undefined}
          aria-keyshortcuts={action === "Done" ? "e" : undefined}
          onClick={() => (action === "MarkUnread" ? unread(null) : run({ act: action, target }))}
        >
          {dockLabels[action]}
          {action === "Done" && <kbd aria-hidden="true">e</kbd>}
        </button>
      ))}
    </div>
  );
}

export function Reader({ id }: { id: ConversationId }) {
  const result = useAtomValue(conversation(id));
  const { frozen, seen, dispatch, watch, unread } = useAtomValue(reading(id));
  const [, setPins] = useAtom(pins(id));
  const arm = () => dispatch({ _tag: "Input" });
  const track = (event: UIEvent<HTMLElement>) => {
    const next = new Map<TopicKey, number>();
    for (const head of event.currentTarget.querySelectorAll<HTMLElement>(".pin")) {
      const bottom = head.getBoundingClientRect().bottom;
      const originals = [...(head.closest(".tp, .dc")?.querySelectorAll(".unf .bl") ?? [])];
      const at = originals.findIndex((bl) => bl.getBoundingClientRect().bottom > bottom + 8);
      next.set(head.dataset.key as TopicKey, at < 0 ? originals.length : at + 1);
    }
    setPins((previous) =>
      next.size === previous.size && [...next].every(([key, at]) => previous.get(key) === at)
        ? previous
        : next,
    );
  };
  return (
    <>
      <div
        className="r-scroll"
        onWheel={arm}
        onTouchMove={arm}
        onPointerDown={arm}
        onKeyDown={(event: KeyboardEvent) => {
          if (scrollKeys[event.key]) arm();
        }}
        onScroll={track}
      >
        {AsyncResult.isFailure(result) && !AsyncResult.isSuccess(result) ? (
          <div className="calm es warn">
            <p className="es-alert">Can't load this conversation.</p>
          </div>
        ) : (
          AsyncResult.isSuccess(result) &&
          Option.isSome(frozen) && (
            <Conversation
              key={id}
              id={id}
              detail={result.value}
              frozen={frozen.value}
              watch={watch}
              mark={{ seen, unread }}
            />
          )
        )}
      </div>
      <Dock id={id} />
    </>
  );
}
