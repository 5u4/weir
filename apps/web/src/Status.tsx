import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react/Hooks";
import type { Status } from "@weir/daemon/Api";
import * as DateTime from "effect/DateTime";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import type { CSSProperties, KeyboardEvent } from "react";
import {
  ago,
  clockTime,
  dayAndTime,
  type Health,
  now,
  plural,
  type SourceHealth,
  type Verdict,
} from "./Health.ts";
import { ThemePreference, themePreference } from "./Theme.ts";
import { reload, status, statusOpen } from "./Weir.ts";

export function StatusIcon() {
  return (
    <svg className="st-i" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M1.5 8.5h2.8l1.9-4.6 3.4 8.2 1.9-3.6h3" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg className="x-i" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

const sourceLine = (source: SourceHealth, stopped: boolean, current: DateTime.Utc) => {
  switch (source.state._tag) {
    case "Failed":
      return "Sync failed";
    case "Starting":
      return stopped ? "Stopped" : "Starting";
    case "NotSynced":
      return stopped ? "Stopped" : "Not synced yet";
    case "Synced":
      return stopped ? "Stopped" : `Synced ${ago(source.state.at, current)}`;
  }
};

const verdictText = (verdict: Verdict, current: DateTime.Utc) => {
  switch (verdict._tag) {
    case "Stopped":
      return {
        title: "Sync and digests stopped",
        detail:
          "The config did not load. Fix it and Reload. Everything synced so far stays readable.",
      };
    case "SourceDown":
      return {
        title: `${verdict.source} can't sync.`,
        detail: "The other sources and digests keep running.",
      };
    case "Running":
      return {
        title: "Everything is running.",
        detail:
          verdict.lastSync === null
            ? "Waiting for the first sync."
            : `Last sync ${ago(verdict.lastSync, current)}.`,
      };
  }
};

export function EmptyReader({ health }: { health: Health }) {
  const current = useAtomValue(now);
  const [, setOpen] = useAtom(statusOpen);
  return (
    <div className={`calm es${health.alert ? " warn" : ""}`}>
      {health.stopped && (
        <p className="es-alert">Sync and digests stopped. The config did not load.</p>
      )}
      <ul className="es-rows" aria-label="Sync">
        {health.sources.map((source) => {
          const bad = source.state._tag === "Failed";
          return (
            <li
              key={source.id}
              className={`es-row${bad ? " bad" : ""}${health.stopped ? " held" : ""}`}
            >
              <span className="sv-led es-led" aria-hidden="true" />
              <b>{source.id}</b>
              <span className="es-st">{sourceLine(source, health.stopped, current)}</span>
              {source.state._tag === "Failed" && (
                <code className="es-err">{source.state.error}</code>
              )}
            </li>
          );
        })}
      </ul>
      {health.alert && (
        <button type="button" className="es-open" onClick={() => setOpen(true)}>
          Open Status
        </button>
      )}
    </div>
  );
}

function SourceRow({ source, stopped }: { source: SourceHealth; stopped: boolean }) {
  const current = useAtomValue(now);
  const { state } = source;
  const meta = [
    state._tag === "Failed" && state.lastGood !== null
      ? `Last good sync ${ago(state.lastGood, current)}`
      : null,
    plural(source.streams, "stream"),
    source.backfilling ? "backfill running" : null,
  ].filter((part) => part !== null);
  return (
    <li className={`sv-src${state._tag === "Failed" ? " bad" : ""}${stopped ? " held" : ""}`}>
      <span className="sv-led" aria-hidden="true" />
      <span className="sv-src-name">
        <b>{source.id}</b>
        <span>{source.plugin}</span>
      </span>
      <span className="sv-src-state">{sourceLine(source, stopped, current)}</span>
      <span className="sv-src-meta">{meta.join(" · ")}</span>
      {state._tag === "Failed" && (
        <p className="sv-err">
          <code>{state.error}</code>
        </p>
      )}
    </li>
  );
}

function ConfigSection({ config }: { config: Status["config"] }) {
  const reloadResult = useAtomValue(reload);
  const runReload = useAtomSet(reload, { mode: "promiseExit" });
  const refreshStatus = useAtomRefresh(status);
  const reloading = AsyncResult.isWaiting(reloadResult);
  return (
    <section className="sv-sec" aria-labelledby="sv-h-cfg">
      <h3 className="sv-h" id="sv-h-cfg">
        Config
      </h3>
      <dl className="sv-dl">
        <div className="sv-row">
          <dt>File</dt>
          <dd>
            <code className="sv-path">{config.path}</code>
          </dd>
        </div>
        <div className="sv-row">
          <dt>State</dt>
          <dd>
            <span className="sv-state" role="status" aria-live="polite">
              {reloading ? (
                <span className="sv-busy">Reloading…</span>
              ) : config.error !== null ? (
                <span className="sv-bad">Reload failed</span>
              ) : (
                <>
                  <span className="sv-good">Config loaded</span>
                  <time dateTime={config.loaded_at}>
                    {clockTime(DateTime.makeUnsafe(config.loaded_at))}
                  </time>
                </>
              )}
            </span>
          </dd>
        </div>
      </dl>
      {config.error !== null && !reloading && (
        <ul className="sv-errs" aria-label="Config errors">
          {config.error.issues.length === 0 ? (
            <li>
              <code className="sv-errs-file">{config.error.file}</code>
              <span>{config.error.message}</span>
            </li>
          ) : (
            config.error.issues.map((issue) => (
              <li key={`${issue.path}\n${issue.message}`}>
                <code className="sv-errs-file">{config.error?.file}</code>
                <span>
                  {issue.path !== "" && (
                    <>
                      <code>{issue.path}</code>:{" "}
                    </>
                  )}
                  {issue.message}
                </span>
              </li>
            ))
          )}
        </ul>
      )}
      <div className="sv-reload-row">
        <button
          type="button"
          className="sv-reload"
          aria-disabled={reloading}
          onClick={async () => {
            if (reloading) return;
            await runReload({});
            refreshStatus();
          }}
        >
          {reloading ? (
            <>
              <span className="sv-spin" aria-hidden="true" />
              Reloading…
            </>
          ) : (
            "Reload"
          )}
        </button>
        <p className="sv-note">
          Reads <code>config.toml</code> and <code>prompts/</code> again, after running sync and AI
          calls finish.
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
    <section className="sv-sec" aria-labelledby="sv-h-ap">
      <h3 className="sv-h" id="sv-h-ap">
        Appearance
      </h3>
      <div
        className="sv-seg"
        role="radiogroup"
        aria-labelledby="sv-h-ap"
        style={{ "--i": at } as CSSProperties}
        onKeyDown={step}
      >
        <span className="sv-thumb" aria-hidden="true" />
        {themes.map((option) => (
          <button
            key={option}
            type="button"
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

export function StatusView({ status: value, health }: { status: Status; health: Health }) {
  const current = useAtomValue(now);
  const tone = health.alert ? "warn" : "ok";
  const { title, detail } = verdictText(health.verdict, current);
  const aiTags = value.tags.filter(({ ai }) => ai);
  return (
    <div className="sv">
      <header key={tone} className={`sv-head sv-${tone}`}>
        <h2 className="sv-title">Status</h2>
        <svg className="sv-pulse" viewBox="0 0 160 24" aria-hidden="true">
          <path
            pathLength="1"
            d={tone === "ok" ? "M0 13h56l7-10 10 19 8-14 5 5h74" : "M0 13h56l7-10 10 19 4-7h83"}
          />
        </svg>
        <p className="sv-verdict">
          <b className="sv-verdict-title">{title}</b>
          <span className="sv-verdict-detail">{detail}</span>
        </p>
      </header>
      <section className="sv-sec" aria-labelledby="sv-h-src">
        <h3 className="sv-h" id="sv-h-src">
          Sources
        </h3>
        <ul className="sv-srcs">
          {health.sources.map((source) => (
            <SourceRow key={source.id} source={source} stopped={health.stopped} />
          ))}
        </ul>
      </section>
      <section className="sv-sec" aria-labelledby="sv-h-en">
        <h3 className="sv-h" id="sv-h-en">
          Digests
        </h3>
        <dl className="sv-dl">
          <div className="sv-row">
            <dt>AI on</dt>
            <dd>
              {aiTags.length === 0 ? (
                <span>
                  No tag has <code>ai = true</code>
                </span>
              ) : (
                <ul className="sv-tags">
                  {aiTags.map((tag) => (
                    <li key={tag.name}>
                      <b>{tag.name}</b>
                      <span className="sv-dim">
                        {tag.ai_since === null
                          ? plural(tag.conversations, "conversation")
                          : `since ${dayAndTime(DateTime.makeUnsafe(tag.ai_since))} · ${plural(tag.conversations, "conversation")}`}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
      </section>
      <ConfigSection config={value.config} />
      <Appearance />
    </div>
  );
}
