import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import type { Status } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { type CSSProperties, type KeyboardEvent, useCallback } from "react";
import {
  ago,
  clockTime,
  configState,
  dayAndTime,
  type Health,
  now,
  plural,
  type SourceHealth,
  type SourceState,
  type StreamHealth,
} from "./Health.ts";
import { type SettingsFocus, settingsOpen } from "./Route.ts";
import { digestRows } from "./SettingsRows.ts";
import { ThemePreference, themePreference } from "./Theme.ts";
import { reload } from "./Weir.ts";

function GearIcon() {
  return (
    <svg
      className="size-4.5 fill-none stroke-current stroke-1.7 linecap-round linejoin-round"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

export function SettingsButton() {
  const [focus, setFocus] = useAtom(settingsOpen);
  const open = Option.isSome(focus);
  return (
    <footer
      className="fixed bottom-0 left-stage z-raised flex h-14 w-list items-center bg-head px-1.5 shadow-rule-line backdrop-blur-md max-wide:right-0 max-wide:left-0 max-wide:w-auto max-wide:px-3"
      aria-label="Settings"
    >
      <button
        type="button"
        className={`grid size-9 place-items-center rounded-circle transition-tint ${open ? "bg-ink text-island" : "text-ink-3 hover:bg-hover hover:text-ink"}`}
        aria-label="Settings"
        title="Settings (,)"
        aria-pressed={open}
        onClick={() => setFocus(open ? Option.none() : Option.some({ section: "appearance" }))}
      >
        <GearIcon />
      </button>
    </footer>
  );
}

export function CloseIcon({ small = false }: { small?: boolean }) {
  return (
    <svg
      className={`fill-none stroke-current stroke-1.6 linecap-round ${small ? "size-2.5" : "size-3.5"}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

type Led = "ok" | "held" | "bad";

const ledOf = (bad: boolean, held: boolean): Led => (bad ? "bad" : held ? "held" : "ok");

const ledClass: Record<Led, string> = { ok: "bg-ok", held: "bg-ink-4", bad: "bg-warn" };
const glowClass: Record<Led, string> = {
  ok: "shadow-glow-ok",
  held: "shadow-none",
  bad: "shadow-glow-warn",
};

const stateLine = (state: SourceState, stopped: boolean, current: DateTime.Utc) => {
  switch (state._tag) {
    case "Failed":
      return "Sync failed";
    case "Starting":
      return stopped ? "Stopped" : "Starting";
    case "NotSynced":
      return stopped ? "Stopped" : "Not synced yet";
    case "Synced":
      return stopped ? "Stopped" : `Synced ${ago(state.at, current)}`;
  }
};

const streamMeta = ({ state, items, backfilling }: StreamHealth, current: DateTime.Utc) =>
  [
    state._tag === "Failed" && state.tried !== null ? `Tried ${ago(state.tried, current)}` : null,
    plural(items, "item"),
    backfilling ? "backfill running" : null,
  ].filter((part) => part !== null);

const codeClass = "font-mono text-sm leading-normal font-medium normal-nums";
const errorClass = "mx-0 mt-2.5 mb-0.5 rounded-xl bg-warn-wash px-3.5 py-2.5 wrap-anywhere";
const errorCodeClass = `${codeClass} text-ink`;
const listClass = "m-0 grid list-none gap-1 p-0";
const sectionClass = "scroll-mt-3 border-t border-t-line-2 pt-5 pb-5.5";
const headingClass =
  "mx-0 mt-0 mb-3 font-sans text-xs leading-none font-bold tracking-wide text-ink-3 uppercase";
const fieldsClass = "m-0 grid gap-0.5";
const fieldClass = "grid grid-cols-field items-baseline gap-x-4 py-1.5 max-wide:grid-cols-stack";
const termClass = "text-sm text-ink-3";
const valueClass =
  "m-0 flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-md text-ink tabular-nums";
const tagClass = "flex flex-wrap items-baseline gap-x-2 gap-y-0";
const scopeKindClass = "text-xs font-bold tracking-wide text-ink-3 uppercase";
const errsFileClass = `${codeClass} text-warn`;
const errsClass = "mx-0 mt-3 mb-0 grid list-none gap-2 rounded-2xl bg-warn-wash px-3.5 py-3";
const errsItemClass =
  "flex flex-wrap items-baseline gap-x-3.5 gap-y-0.5 text-md wrap-anywhere text-ink";
const noteCodeClass = "font-mono text-xs leading-normal font-medium normal-nums text-ink-2";

function SourceRow({ source, stopped }: { source: SourceHealth; stopped: boolean }) {
  const current = useAtomValue(now);
  const { state, streams } = source;
  const [only] = streams;
  const perStream = streams.length > 1;
  const meta = [
    plural(streams.length, "stream"),
    ...(only !== undefined && !perStream ? streamMeta(only, current) : []),
  ];
  const ownError =
    state._tag === "Failed" &&
    !(perStream && streams.some((s) => s.state._tag === "Failed" && s.state.error === state.error));
  const bad = state._tag === "Failed";
  const led = ledOf(bad, stopped);
  return (
    <li
      className="-mx-3 grid grid-cols-source items-baseline gap-x-3 rounded-xl px-3 py-2"
      data-source={source.id}
      onAnimationEnd={({ animationName, currentTarget }) => {
        if (animationName === "flash") currentTarget.removeAttribute("data-flash");
      }}
    >
      <span
        className={`col-start-1 row-start-1 size-2 self-center rounded-circle ${ledClass[led]} ${glowClass[led]}`}
        aria-hidden="true"
      />
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2 whitespace-nowrap">
        <b className="overflow-hidden text-base font-semibold text-ellipsis text-ink">
          {source.id}
        </b>
        <span className="text-sm text-ink-3">{source.plugin}</span>
      </span>
      <span
        className={`col-start-3 row-start-1 text-md font-semibold whitespace-nowrap tabular-nums ${bad ? "text-warn" : "text-ink-2"}`}
      >
        {stateLine(state, stopped, current)}
      </span>
      <span className="col-start-2 col-end-4 row-start-2 mt-0.5 text-sm text-ink-3 tabular-nums">
        {meta.join(" · ")}
      </span>
      {ownError && (
        <p className={`${errorClass} col-start-2 col-end-4 row-start-3`}>
          <code className={errorCodeClass}>{state.error}</code>
        </p>
      )}
      {perStream && (
        <ul
          className="col-start-2 col-end-4 mx-0 mt-2 mb-0 grid list-none gap-1.5 p-0"
          aria-label={`${source.id} streams`}
        >
          {streams.map((stream) => {
            const failed = stream.state._tag === "Failed";
            return (
              <li key={stream.name} className="grid grid-cols-stream items-baseline gap-x-3">
                <b className="col-start-1 row-start-1 truncate text-md font-semibold text-ink-2">
                  {stream.name}
                </b>
                <span
                  className={`col-start-2 row-start-1 text-sm font-semibold whitespace-nowrap tabular-nums ${failed ? "text-warn" : "text-ink-2"}`}
                >
                  {stateLine(stream.state, stopped, current)}
                </span>
                <span className="col-start-1 col-end-3 row-start-2 text-sm text-ink-3 tabular-nums">
                  {streamMeta(stream, current).join(" · ")}
                </span>
                {stream.state._tag === "Failed" && (
                  <p className={`${errorClass} col-start-1 col-end-3 row-start-3`}>
                    <code className={errorCodeClass}>{stream.state.error}</code>
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function ConfigSection({ config }: { config: Status["config"] }) {
  const state = configState(useAtomValue(reload), config);
  const runReload = useAtomSet(reload);
  const reloading = state._tag === "Reloading";
  return (
    <section className={sectionClass} aria-labelledby="sv-h-cfg" data-section="config">
      <h3 className={headingClass} id="sv-h-cfg">
        Config
      </h3>
      <dl className={fieldsClass}>
        <div className={fieldClass}>
          <dt className={termClass}>File</dt>
          <dd className={valueClass}>
            <code className={`${codeClass} wrap-anywhere text-ink-2`}>{config.path}</code>
          </dd>
        </div>
        <div className={fieldClass}>
          <dt className={termClass}>State</dt>
          <dd className={valueClass}>
            <span className="inline-flex items-baseline gap-2.5" role="status" aria-live="polite">
              {state._tag === "Reloading" ? (
                <span className="font-semibold text-ink-2">Reloading…</span>
              ) : state._tag === "Invalid" ? (
                <span className="font-semibold text-warn">Reload failed</span>
              ) : state._tag === "RequestFailed" ? (
                <span className="font-semibold text-warn">Reload request failed</span>
              ) : (
                <>
                  <span className="font-semibold text-ok">Config loaded</span>
                  <time className="text-ink-3" dateTime={DateTime.formatIso(state.at)}>
                    {clockTime(state.at)}
                  </time>
                </>
              )}
            </span>
          </dd>
        </div>
      </dl>
      {state._tag === "Invalid" && (
        <ul className={errsClass} aria-label="Config errors">
          {state.problem.issues.length === 0 ? (
            <li className={errsItemClass}>
              <code className={errsFileClass}>{state.problem.file}</code>
              <span>{state.problem.message}</span>
            </li>
          ) : (
            state.problem.issues.map((issue) => (
              <li key={`${issue.path}\n${issue.message}`} className={errsItemClass}>
                <code className={errsFileClass}>{state.problem.file}</code>
                <span>
                  {issue.path !== "" && (
                    <>
                      <code className={codeClass}>{issue.path}</code>:{" "}
                    </>
                  )}
                  {issue.message}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      {state._tag === "RequestFailed" && (
        <ul className={errsClass} aria-label="Reload error">
          <li className={errsItemClass}>
            <code className={errsFileClass}>POST /reload</code>
            <span>{state.reason}</span>
          </li>
        </ul>
      )}
      <div className="mt-4 flex items-center gap-4 max-wide:flex-col max-wide:items-start">
        <button
          type="button"
          className="inline-flex h-10 flex-none items-center gap-2.5 rounded-full bg-capbg px-5.5 text-md font-bold text-cap-1 elevation-notch transition-press-bg hover:bg-primary-hover active:scale-press aria-disabled:cursor-progress"
          aria-disabled={reloading}
          onClick={() => {
            if (!reloading) runReload();
          }}
        >
          {reloading ? (
            <>
              <span
                className="size-3.25 animate-spin rounded-circle border-thick border-cap-faint border-t-cap-1 motion-reduce:animate-none"
                aria-hidden="true"
              />
              Reloading…
            </>
          ) : (
            "Reload"
          )}
        </button>
        <p className="m-0 text-sm leading-normal text-ink-3">
          Reads <code className={noteCodeClass}>config.toml</code> and{" "}
          <code className={noteCodeClass}>prompts/</code> again, after running sync and AI calls
          finish.
        </p>
      </div>
    </section>
  );
}

const themes = ThemePreference.literals;
const themeLabel = (preference: ThemePreference) =>
  `${preference[0]?.toUpperCase()}${preference.slice(1)}`;

function Appearance() {
  const [preference, setPreference] = useAtom(themePreference);
  const at = themes.indexOf(preference);
  const step = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const next = themes[(at + delta + themes.length) % themes.length] ?? preference;
    setPreference(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-pick="${next}"]`)?.focus();
  };
  return (
    <section className={sectionClass} aria-labelledby="sv-h-ap" data-section="appearance">
      <h3 className={headingClass} id="sv-h-ap">
        Appearance
      </h3>
      <div
        className="relative inline-grid grid-cols-segments rounded-full bg-hover p-1 max-wide:w-full max-wide:grid-cols-segments-fill"
        role="radiogroup"
        aria-labelledby="sv-h-ap"
        style={{ "--i": at } as CSSProperties}
        onKeyDown={step}
      >
        <span
          className="absolute top-1 bottom-1 left-1 w-24 translate-x-segment rounded-full bg-ink transition-transform duration-spring ease-spring motion-reduce:transition-none max-wide:w-segment-fill"
          aria-hidden="true"
        />
        {themes.map((option) => (
          <button
            key={option}
            type="button"
            className="relative h-8.5 rounded-full text-sm font-semibold text-ink-2 transition-ink duration-base not-aria-checked:hover:text-ink aria-checked:text-island focus-visible:outline-offset-tight"
            role="radio"
            data-pick={option}
            aria-checked={option === preference}
            tabIndex={option === preference ? 0 : -1}
            onClick={() => setPreference(option)}
          >
            {themeLabel(option)}
          </button>
        ))}
      </div>
    </section>
  );
}

export function SettingsView({
  status: value,
  health,
  focus,
}: {
  status: Status;
  health: Health;
  focus: SettingsFocus;
}) {
  const land = useCallback(
    (view: HTMLDivElement | null) => {
      const scroller = view?.closest<HTMLElement>(".r-scroll");
      const section = view?.querySelector<HTMLElement>(`[data-section="${focus.section}"]`);
      if (view == null || scroller == null || section == null) return;
      scroller.scrollTop =
        focus.section === "appearance"
          ? 0
          : scroller.scrollTop +
            section.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            Number.parseFloat(getComputedStyle(section).scrollMarginTop);
      const row = [...view.querySelectorAll<HTMLElement>("[data-source]")].find(
        ({ dataset }) => dataset.source === focus.source,
      );
      if (row === undefined) return;
      row.removeAttribute("data-flash");
      void row.offsetWidth;
      row.setAttribute("data-flash", "");
    },
    [focus],
  );
  return (
    <div className="max-w-status px-reader pt-5.5 pb-24 max-wide:pt-3.5" ref={land}>
      <h2 className="m-0 pb-5.5 font-display text-3xl leading-tight font-extrabold tracking-tighter">
        Settings
      </h2>
      <Appearance />
      <section className={sectionClass} aria-labelledby="sv-h-src" data-section="sources">
        <h3 className={headingClass} id="sv-h-src">
          Sources
        </h3>
        <ul className={listClass}>
          {health.sources.map((source) => (
            <SourceRow key={source.id} source={source} stopped={health.stopped} />
          ))}
        </ul>
      </section>
      <section className={sectionClass} aria-labelledby="sv-h-en" data-section="digests">
        <h3 className={headingClass} id="sv-h-en">
          Digests
        </h3>
        <dl className={fieldsClass}>
          <div className={fieldClass}>
            <dt className={termClass}>AI on</dt>
            <dd className={valueClass}>
              {value.ai.length === 0 ? (
                <span>
                  No tag or group has <code className={codeClass}>ai = true</code>
                </span>
              ) : (
                <ul className={listClass}>
                  {value.ai.map((scope) => (
                    <li key={`${scope.kind}:${scope.name}`} className={tagClass}>
                      <b>{scope.name}</b>
                      {scope.kind === "group" && <span className={scopeKindClass}>group</span>}
                      <span className="text-ink-3">
                        {scope.ai_since === null
                          ? plural(scope.conversations, "conversation")
                          : `since ${dayAndTime(DateTime.makeUnsafe(scope.ai_since))} · ${plural(scope.conversations, "conversation")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
          {digestRows(value.digest).map((row) => (
            <div key={row.label} className={fieldClass}>
              <dt className={termClass}>{row.label}</dt>
              <dd className={valueClass}>
                {row.label === "Queue" ? (
                  row.jobs.length === 0 ? (
                    "Empty"
                  ) : (
                    <ul className={listClass}>
                      {row.jobs.map((job) => (
                        <li key={job.key} className={tagClass}>
                          <b>{job.title}</b>
                          <span className="text-ink-3">{job.state}</span>
                        </li>
                      ))}
                    </ul>
                  )
                ) : row.label === "Last run" ? (
                  <>
                    <time dateTime={DateTime.formatIso(row.at)}>{dayAndTime(row.at)}</time>
                    <span className="text-ink-3">{row.detail}</span>
                  </>
                ) : row.label === "Threshold" ? (
                  row.text
                ) : (
                  <code className={codeClass}>{row.profile}</code>
                )}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <ConfigSection config={value.config} />
    </div>
  );
}
