import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Fragment, type MouseEvent } from "react";
import { Avatars } from "./Avatar.tsx";
import { plural } from "./Health.ts";
import { Link } from "./Link.tsx";
import {
  type Clause,
  chips,
  clearedWidget,
  enumerate,
  sentence,
  type Widget,
  widgetDescription,
} from "./Notch.ts";
import { chipText, type Field, fieldOf, queryOf, queryText, typed } from "./Query.ts";
import { groups, type ResultGroup } from "./Results.ts";
import { type Route, route, statusOpen, type View } from "./Route.ts";
import { CloseIcon, StatusIcon } from "./Status.tsx";
import {
  counts,
  found,
  pickedGroup,
  searchGroup,
  searching,
  searchOpen,
  searchQuery,
  searchResult,
  tagOrder,
} from "./Weir.ts";

const measureCap = (cap: HTMLDivElement) => {
  const observer = new ResizeObserver(() =>
    document.documentElement.style.setProperty("--cap-h", `${cap.offsetHeight}px`),
  );
  observer.observe(cap);
  return () => observer.disconnect();
};

const fadeStrip = (strip: HTMLElement) => {
  const fade = () => {
    strip.classList.toggle("fl", strip.scrollLeft > 1);
    strip.classList.toggle("fr", strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  };
  const resized = new ResizeObserver(fade);
  const observeChips = () => {
    for (const chip of strip.children) resized.observe(chip);
  };
  const mutated = new MutationObserver(() => {
    observeChips();
    fade();
  });
  resized.observe(strip);
  observeChips();
  mutated.observe(strip, { childList: true });
  strip.addEventListener("scroll", fade, { passive: true });
  return () => {
    resized.disconnect();
    mutated.disconnect();
    strip.removeEventListener("scroll", fade);
  };
};

const scrollStrip = (arrow: HTMLElement, direction: 1 | -1) => {
  const strip = arrow.parentElement?.querySelector(".cws");
  if (!(strip instanceof HTMLElement)) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  strip.scrollBy({
    left: (strip.clientWidth - 64) * direction,
    behavior: reduce ? "auto" : "smooth",
  });
};

function StripArrow(props: { readonly direction: 1 | -1 }) {
  const prev = props.direction === -1;
  return (
    <button
      type="button"
      className={prev ? "cws-a prev" : "cws-a next"}
      tabIndex={-1}
      aria-label={prev ? "Scroll tags left" : "Scroll tags right"}
      onClick={({ currentTarget }) => scrollStrip(currentTarget, props.direction)}
    >
      <svg className="ch-i" viewBox="0 0 16 16" aria-hidden="true">
        <path d={prev ? "M10 3.5L5.5 8l4.5 4.5" : "M6 3.5L10.5 8 6 12.5"} />
      </svg>
    </button>
  );
}

const viewRoute = (view: View): Route => ({ view, query: "", conversation: Option.none() });

function SearchIcon() {
  return (
    <svg className="q-i" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.4 10.4l3.4 3.4" />
    </svg>
  );
}

function StatusButton({ className, alert }: { className: string; alert: boolean }) {
  const [open, setOpen] = useAtom(statusOpen);
  return (
    <button
      type="button"
      className={`${className}${alert ? " alert" : ""}${open ? " on" : ""}`}
      aria-label="Status"
      title="Status"
      aria-pressed={open}
      aria-description={alert ? "Needs attention" : undefined}
      onClick={() => setOpen(!open)}
    >
      <StatusIcon />
      <i className="st-dot" aria-hidden="true" />
    </button>
  );
}

export function SentenceWidget({ widget, active }: { widget: Widget; active: View | null }) {
  return (
    <Link
      to={viewRoute(widget.view)}
      current={active === widget.view}
      className={`w w-${widget.kind}`}
      description={widgetDescription(widget)}
    >
      {widget.kind === "cleared" ? (
        <>
          <span className="w-u">{widget.name}</span> <span className="w-n">{widget.count}</span>
        </>
      ) : (
        <>
          <Avatars senders={widget.senders} />
          {widget.kind !== "clear" && <span className="w-n">{widget.count}</span>}
          {widget.kind !== "clear" && " "}
          <span className="w-name">{widget.name}</span>
        </>
      )}
    </Link>
  );
}

function SentenceClause({ clause, active }: { clause: Clause; active: View | null }) {
  return clause.map(({ lead, widget, end }, at) => (
    <Fragment key={widget.view}>
      {at > 0 && " "}
      <span className="grp">
        {lead !== "" && <span className="glue">{lead}</span>}
        <SentenceWidget widget={widget} active={active} />
        {end !== "" && <span className="glue end">{end}</span>}
      </span>
    </Fragment>
  ));
}

export function Chip({ widget, active }: { widget: Widget; active: View | null }) {
  return (
    <Link
      to={viewRoute(widget.view)}
      current={active === widget.view}
      className={`cw cw-${widget.kind}`}
      description={widgetDescription(widget)}
    >
      {widget.kind === "cleared" ? (
        <>
          <span className="cw-name">{widget.name}</span> <span className="w-n">{widget.count}</span>
        </>
      ) : (
        <>
          <Avatars senders={widget.senders} />
          {widget.kind !== "clear" && <span className="w-n">{widget.count}</span>}
          {widget.kind !== "clear" && " "}
          <span className="cw-name">{widget.name}</span>
        </>
      )}
    </Link>
  );
}

// Safari does not focus links or buttons on click, so the input's blur would carry no relatedTarget.
const keepFocus = (event: MouseEvent) => {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
};

function QueryField() {
  const [current, navigate] = useAtom(route);
  const tags = useAtomValue(tagOrder);
  const opened = useAtomValue(searchOpen);
  const setGroup = useAtomSet(searchGroup);
  const field = fieldOf(current.query, tags);
  const write = (next: Field) => {
    const query = queryOf(next);
    if (query === "") setGroup(Option.none());
    navigate({ _tag: "Type", query });
  };
  return (
    <span className="q-field">
      {field.chips.map((chip, at) => (
        <span key={chip.key} className="q-chip">
          <span className="qc-k">{chip.key}:</span>
          <span className="qc-v">{chip.value}</span>
          <button
            type="button"
            className="qc-x"
            aria-label={`Remove ${chipText(chip)}`}
            title="Remove"
            onClick={() =>
              write({ ...field, chips: field.chips.filter((_, index) => index !== at) })
            }
          >
            <CloseIcon />
          </button>
        </span>
      ))}
      <input
        className="cap-in"
        type="search"
        aria-label="Search"
        placeholder="Search"
        autoFocus={opened}
        value={field.rest}
        onChange={({ target: { value } }) => write(typed(field, value, tags, false))}
        onBlur={() => {
          const next = typed(field, field.rest, tags, true);
          if (next.chips !== field.chips) write(next);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Backspace" || field.rest !== "" || field.chips.length === 0) return;
          event.preventDefault();
          write({ ...field, chips: field.chips.slice(0, -1) });
        }}
      />
    </span>
  );
}

function GroupWidget({ group, on }: { group: ResultGroup; on: boolean }) {
  const setGroup = useAtomSet(searchGroup);
  return (
    <button
      type="button"
      className={`w w-group${on ? " on" : ""}`}
      aria-pressed={on}
      aria-description={on ? "Show all results" : "Show only these"}
      onClick={() => setGroup(on ? Option.none() : Option.some(group.view))}
    >
      <Avatars senders={group.senders} />
      <span className="w-n">{group.count}</span> <span className="w-name">{group.name}</span>
    </button>
  );
}

function SearchSentence() {
  const active = useAtomValue(searching);
  const query = useAtomValue(searchQuery);
  const result = useAtomValue(searchResult);
  const results = useAtomValue(found);
  const tags = useAtomValue(tagOrder);
  const picked = useAtomValue(pickedGroup);
  if (!active) {
    return (
      <p className="s-tail q-hint">
        Searches titles, digests, originals, senders and sources, done and muted included. Every
        word must appear. Narrow with <code>from:</code> <code>in:</code> <code>source:</code>
      </p>
    );
  }
  const quoted = `“${queryText(query)}”`;
  return Option.match(results, {
    onNone: () =>
      AsyncResult.isFailure(result) ? (
        <p className="s-main">
          <span className="allclear">Can't search right now.</span>
        </p>
      ) : (
        <p className="s-main">
          <span className="glue">Searching for {quoted}…</span>
        </p>
      ),
    onSome: (list) =>
      list.length === 0 ? (
        <>
          <p className="s-main">
            <span className="allclear">Nothing matches {quoted}.</span>
          </p>
          <p className="s-tail">Try fewer words, or drop a filter.</p>
        </>
      ) : (
        <>
          <p className="s-main">
            {enumerate(
              groups(list, tags),
              `${quoted} ${query.text === "" ? "matches" : "appears in"} `,
              ".",
            ).map(({ lead, widget, end }, at) => (
              <Fragment key={widget.view}>
                {at > 0 && " "}
                <span className="grp">
                  {lead !== "" && <span className="glue">{lead}</span>}
                  <GroupWidget group={widget} on={Option.contains(picked, widget.view)} />
                  {end !== "" && <span className="glue end">{end}</span>}
                </span>
              </Fragment>
            ))}
          </p>
          <p className="s-tail">
            {plural(list.length, "conversation")}.{" "}
            {Option.isSome(picked)
              ? "Click the lit group again to see all."
              : "Click a group to see only it."}
          </p>
        </>
      ),
  });
}

export type CapForm = "full" | "compact" | "search";

export function Cap({ form, alert }: { form: CapForm; alert: boolean }) {
  const [current, navigate] = useAtom(route);
  const setSearching = useAtomSet(searchOpen);
  const setGroup = useAtomSet(searchGroup);
  const loaded = AsyncResult.getOrElse(AsyncResult.map(useAtomValue(counts), Option.some), () =>
    Option.none(),
  );
  const active = current.query === "" ? current.view : null;
  return (
    <div
      className={`cap${form === "full" ? "" : ` ${form}`}`}
      role="region"
      aria-label="weir"
      ref={measureCap}
      onBlur={({ currentTarget, relatedTarget }) => {
        if (current.query === "" && !currentTarget.contains(relatedTarget)) setSearching(false);
      }}
    >
      {form !== "full" ? (
        <div
          className={form === "search" ? "cap-q" : "cap-nav"}
          role={form === "search" ? "search" : undefined}
          onMouseDown={keepFocus}
        >
          {form === "search" && <SearchIcon />}
          <QueryField />
          {form === "search" ? (
            <button
              type="button"
              className="q-x"
              aria-label="Close search"
              title="Close search"
              onClick={() => {
                setSearching(false);
                setGroup(Option.none());
                navigate({ _tag: "Type", query: "" });
              }}
            >
              <CloseIcon />
            </button>
          ) : (
            <>
              <span className="cap-div" />
              <span className="cws-w">
                <nav className="cws" aria-label="Views" ref={fadeStrip}>
                  {Option.match(loaded, {
                    onNone: () => null,
                    onSome: (value) =>
                      chips(value).map((widget) => (
                        <Chip key={widget.view} widget={widget} active={active} />
                      )),
                  })}
                </nav>
                <StripArrow direction={-1} />
                <StripArrow direction={1} />
              </span>
              <span className="cap-div" />
              {Option.isSome(loaded) && (
                <Chip widget={clearedWidget(loaded.value)} active={active} />
              )}
              <StatusButton className="cw cw-st" alert={alert} />
            </>
          )}
        </div>
      ) : (
        <div className="cap-nav">
          {Option.match(loaded, {
            onNone: () => null,
            onSome: (value) => {
              const { main, tail } = sentence(value);
              return (
                <nav aria-label="Views">
                  <p className="s-main">
                    {main._tag === "CaughtUp" ? (
                      <span className="allclear">All caught up.</span>
                    ) : (
                      <SentenceClause clause={main.clause} active={active} />
                    )}
                  </p>
                  <p className="s-tail">
                    {tail.map((clause) => (
                      <span key={clause[0]?.widget.kind} className="cl">
                        <SentenceClause clause={clause} active={active} />
                      </span>
                    ))}
                  </p>
                </nav>
              );
            },
          })}
          <span className="cap-tools">
            <button
              type="button"
              className="q-go"
              aria-label="Search"
              title="Search"
              onClick={() => setSearching(true)}
            >
              <SearchIcon />
            </button>
            <StatusButton className="st-go" alert={alert} />
          </span>
        </div>
      )}
      {form === "search" && (
        <div className="cap-nav" aria-live="polite" onMouseDown={keepFocus}>
          <SearchSentence />
        </div>
      )}
    </div>
  );
}
