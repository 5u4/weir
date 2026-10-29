import { useAtom, useAtomValue } from "@effect/atom-react/Hooks";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { Fragment } from "react";
import { Avatars } from "./Avatar.tsx";
import { Link } from "./Link.tsx";
import { type Clause, chips, clearedWidget, sentence, type Widget, widgetLabel } from "./Notch.ts";
import { type Route, route, statusOpen, type View } from "./Route.ts";
import { StatusIcon } from "./Status.tsx";
import { counts, searchOpen } from "./Weir.ts";

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
      label={widgetLabel(widget)}
    >
      {widget.kind === "cleared" ? (
        <>
          <span className="w-u">{widget.name}</span> <span className="w-n">{widget.count}</span>
        </>
      ) : (
        <>
          <Avatars senders={widget.senders} />
          {widget.kind !== "clear" && <span className="w-n">{widget.count}</span>}{" "}
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
      label={widgetLabel(widget)}
    >
      {widget.kind === "cleared" ? (
        <>
          <span className="cw-name">{widget.name}</span>
          <span className="w-n">{widget.count}</span>
        </>
      ) : (
        <>
          <Avatars senders={widget.senders} />
          {widget.kind !== "clear" && <span className="w-n">{widget.count}</span>}
          <span className="cw-name">{widget.name}</span>
        </>
      )}
    </Link>
  );
}

export function Cap({ compact, alert }: { compact: boolean; alert: boolean }) {
  const [current, navigate] = useAtom(route);
  const [searching, setSearching] = useAtom(searchOpen);
  const loaded = AsyncResult.getOrElse(AsyncResult.map(useAtomValue(counts), Option.some), () =>
    Option.none(),
  );
  const active = current.query === "" ? current.view : null;
  return (
    <div
      className={`cap${compact ? " compact" : ""}`}
      role="region"
      aria-label="weir"
      ref={measureCap}
      onBlur={({ currentTarget, relatedTarget }) => {
        if (current.query === "" && !currentTarget.contains(relatedTarget)) setSearching(false);
      }}
    >
      {compact ? (
        <div
          className="cap-nav"
          onMouseDown={(event) => {
            // Safari does not focus links or buttons on click, so the input's blur would carry no relatedTarget.
            if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
          }}
        >
          <input
            className="cap-in"
            type="search"
            aria-label="Search"
            placeholder="Search"
            autoFocus={searching}
            value={current.query}
            onChange={({ target: { value } }) => navigate({ _tag: "Type", query: value })}
          />
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
          {Option.isSome(loaded) && <Chip widget={clearedWidget(loaded.value)} active={active} />}
          <StatusButton className="cw cw-st" alert={alert} />
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
    </div>
  );
}
