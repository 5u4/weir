import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import { commit } from "./Morph.ts";

export const View = Schema.Union([
  Schema.Literals(["untagged", "cleared"]),
  Schema.TemplateLiteral(["tag:", Schema.NonEmptyString]),
]);
export type View = typeof View.Type;

export const viewLabel = (view: View) =>
  view === "untagged" ? "Untagged" : view === "cleared" ? "Cleared" : view.slice("tag:".length);

export const ConversationId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("ConversationId"),
);
export type ConversationId = typeof ConversationId.Type;

const param = <S extends Schema.Top>(
  type: S,
  fromParam: (raw: string) => Option.Option<S["Type"]>,
  toParam: (value: S["Type"]) => string,
  fallback: S["Type"],
) =>
  Schema.optionalKey(Schema.String).pipe(
    Schema.decodeTo(Schema.toType(type), {
      decode: SchemaGetter.transformOptional((raw: Option.Option<string>) =>
        Option.some(Option.getOrElse(Option.flatMap(raw, fromParam), () => fallback)),
      ),
      encode: SchemaGetter.transformOptional((value: Option.Option<S["Type"]>) =>
        Option.filter(Option.map(value, toParam), (raw) => raw !== toParam(fallback)),
      ),
    }),
  );

const decodeView = Schema.decodeUnknownOption(View);
const decodeConversation = Schema.decodeUnknownOption(
  Schema.NumberFromString.pipe(Schema.decodeTo(ConversationId)),
);

export const Route = Schema.Struct({
  view: param(View, decodeView, String, "untagged"),
  query: param(Schema.String, Option.some, String, ""),
  conversation: param(
    Schema.Option(ConversationId),
    (raw) => Option.map(decodeConversation(raw), Option.some),
    Option.match({ onNone: () => "", onSome: String }),
    Option.none(),
  ),
}).pipe(Schema.encodeKeys({ view: "v", query: "q", conversation: "c" }));
export type Route = typeof Route.Type;

const decodeRoute = Schema.decodeSync(Route);
const encodeRoute = Schema.encodeSync(Route);

export const parse = (search: string): Route =>
  decodeRoute(Object.fromEntries(new URLSearchParams(search)));

export const href = (route: Route) => {
  const search = new URLSearchParams(encodeRoute(route)).toString();
  return search === "" ? "/" : `/?${search}`;
};

export type Navigation =
  | { readonly _tag: "Go"; readonly to: Route }
  | { readonly _tag: "Replace"; readonly to: Route }
  | { readonly _tag: "Type"; readonly query: string };

export const destination = (previous: Route, navigation: Navigation): Route =>
  navigation._tag === "Type"
    ? {
        ...previous,
        query: navigation.query,
        conversation: navigation.query === "" ? previous.conversation : Option.none(),
      }
    : navigation.to;

export type Write = "push" | "replace" | "leave" | "none";

export const writeKind = (previous: Route, navigation: Navigation): Write => {
  const next = destination(previous, navigation);
  if (href(previous) === href(next)) return "none";
  if (navigation._tag === "Replace") return "replace";
  if (navigation._tag === "Go" || previous.query === "") return "push";
  return next.query === "" ? "leave" : "replace";
};

const SearchEntry = Schema.Struct({
  preSearch: Schema.String,
  depth: Schema.Int.check(Schema.isGreaterThan(0)),
});
type SearchEntry = typeof SearchEntry.Type;
const searchEntry = Schema.decodeUnknownOption(SearchEntry);

const pushedEntry = (previous: Route, next: Route): SearchEntry | null => {
  if (next.query === "") return null;
  if (previous.query === "") return { preSearch: href(previous), depth: 1 };
  return Option.match(searchEntry(history.state), {
    onNone: () => null,
    onSome: ({ preSearch, depth }) => ({ preSearch, depth: depth + 1 }),
  });
};

const statusShown = Atom.make(false);

export const statusOpen = Atom.writable(
  (get) => get(statusShown),
  (ctx, open: boolean) =>
    commit(() => {
      const { conversation } = ctx.get(route);
      return {
        before: { status: ctx.get(statusShown), conversation },
        after: { status: open, conversation },
        apply: () => ctx.set(statusShown, open),
        animate: true,
      };
    }),
);

export const listTops = Atom.make<ReadonlyMap<string, number>>(new Map()).pipe(Atom.keepAlive);

const historyWrite = (
  previous: Route,
  navigation: Navigation,
): { readonly target: Route; readonly write: Option.Option<() => void> } => {
  const next = destination(previous, navigation);
  switch (writeKind(previous, navigation)) {
    case "none":
      return { target: previous, write: Option.none() };
    case "push":
      return {
        target: next,
        write: Option.some(() => history.pushState(pushedEntry(previous, next), "", href(next))),
      };
    case "replace":
      return {
        target: next,
        write: Option.some(() => history.replaceState(history.state, "", href(next))),
      };
    case "leave":
      return Option.match(searchEntry(history.state), {
        onNone: () => {
          const target = { ...next, conversation: Option.none() };
          return {
            target,
            write: Option.some(() => history.replaceState(null, "", href(target))),
          };
        },
        onSome: ({ preSearch, depth }) => ({
          target: parse(new URL(preSearch, location.href).search),
          write: Option.some(() => history.go(-depth)),
        }),
      });
  }
};

export const route: Atom.Writable<Route, Navigation> = Atom.writable(
  (get) => {
    const sync = (event: PopStateEvent) => {
      const next = parse(location.search);
      commit(() => {
        const status = get.registry.get(statusShown);
        return {
          before: { status, conversation: get.registry.get(route).conversation },
          after: { status, conversation: next.conversation },
          apply: () => get.setSelf(next),
          animate: !event.hasUAVisualTransition,
        };
      });
    };
    addEventListener("popstate", sync);
    get.addFinalizer(() => removeEventListener("popstate", sync));
    return parse(location.search);
  },
  (ctx, navigation: Navigation) =>
    commit(() => {
      const previous = ctx.get(route);
      const { target, write } = historyWrite(previous, navigation);
      const from = location.href;
      return {
        before: { status: ctx.get(statusShown), conversation: previous.conversation },
        after: { status: false, conversation: target.conversation },
        apply: () => {
          ctx.set(statusShown, false);
          if (Option.isNone(write) || location.href !== from) return;
          write.value();
          ctx.setSelf(target);
        },
        animate: navigation._tag !== "Type",
      };
    }),
);
