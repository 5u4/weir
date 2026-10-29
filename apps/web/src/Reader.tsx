import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { KeyboardEvent, UIEvent } from "react";
import { Avatar } from "./Avatar.tsx";
import {
  type Block,
  type Bubbles,
  type Detail,
  type Digest,
  type ItemSummary,
  participants,
  reader,
  type TopicKey,
  type TopicView,
} from "./Blocks.ts";
import { clockTime, dayAndTime, plural } from "./Health.ts";
import { monogram } from "./Notch.ts";
import { pins, readerUi, reading } from "./Reading.ts";
import type { ConversationId } from "./Route.ts";
import { conversation } from "./Weir.ts";

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
  const first = items[0]?.occurred_at;
  const last = items.at(-1)?.occurred_at;
  if (first === undefined || last === undefined) return "";
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

function End({ seq, watch }: { seq: number; watch: Watch }) {
  return <span className="read-end" data-seq={seq} ref={watch} aria-hidden="true" />;
}

function Group({ group, watch }: { group: Bubbles; watch?: Watch }) {
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
      {group.items.map((item) => (
        <div className="bl" key={item.seq}>
          <div className="bb">
            {item.body_new.trim() === "" ? (
              <p className="body b-none">(no text)</p>
            ) : (
              <p className="body">{item.body_new}</p>
            )}
          </div>
          {watch !== undefined && <End seq={item.seq} watch={watch} />}
        </div>
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

function Topic({ id, view, solo }: { id: ConversationId; view: TopicView; solo: boolean }) {
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
            <Group key={group.items[0]?.seq} group={group} />
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
}: {
  id: ConversationId;
  block: Extract<Block, { _tag: "DigestCard" }>;
  watch: Watch;
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
  return (
    <section className={`dc${solo ? " solo" : ""}`} aria-label={digest.headline}>
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
        </div>
      </header>
      <div className="tps">
        {topics.map((view) => (
          <Topic key={view.key} id={id} view={view} solo={solo} />
        ))}
      </div>
      <End seq={digest.to_seq} watch={watch} />
    </section>
  );
}

function BlockView({ id, block, watch }: { id: ConversationId; block: Block; watch: Watch }) {
  const [, setUi] = useAtom(readerUi(id));
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
      return <DigestCard id={id} block={block} watch={watch} />;
    case "GapBar":
      return (
        <div className="tl-h ge">
          <span className="tl-k">Not digested</span>
          <span className="tl-n">{plural(block.run_items, "message")} above</span>
        </div>
      );
    case "Tail":
      return (
        <div className="tl-h tl">
          <span className="tl-k">Not digested</span>
        </div>
      );
    case "Bubbles":
      return <Group group={block} watch={watch} />;
  }
}

const blockKey = (block: Block) => {
  switch (block._tag) {
    case "Marker":
    case "Tail":
      return block._tag;
    case "EarlierFold":
      return `earlier-${block.digests[0]?.id}`;
    case "DigestRow":
    case "DigestCard":
      return `d-${block.digest.id}`;
    case "GapBar":
      return `gap-${block.before_digest}`;
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

function Conversation({
  id,
  detail,
  frozen,
  watch,
}: {
  id: ConversationId;
  detail: Detail;
  frozen: number;
  watch: Watch;
}) {
  const ui = useAtomValue(readerUi(id));
  const newCount = detail.items.filter(({ seq }) => seq > frozen).length;
  const [home, ...tags] = detail.tags;
  return (
    <article className="conv" ref={land} aria-label={detail.title}>
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
      {reader(detail, frozen, ui).map((block) => (
        <BlockView key={blockKey(block)} id={id} block={block} watch={watch} />
      ))}
    </article>
  );
}

export function Reader({ id }: { id: ConversationId }) {
  const result = useAtomValue(conversation(id));
  const { frozen, dispatch, watch } = useAtomValue(reading(id));
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
          />
        )
      )}
    </div>
  );
}
