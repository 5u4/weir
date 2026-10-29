import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

export const View = Schema.Union([
  Schema.Literals(["untagged", "cleared"]),
  Schema.TemplateLiteral(["tag:", Schema.NonEmptyString]),
]);
export type View = typeof View.Type;

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

export const statusOpen = Atom.writable(
  (get) => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") get.setSelf(false);
    };
    addEventListener("keydown", closeOnEscape);
    get.addFinalizer(() => removeEventListener("keydown", closeOnEscape));
    return false;
  },
  (ctx, open: boolean) => ctx.setSelf(open),
);

export const route = Atom.writable(
  (get) => {
    const sync = () => get.setSelf(parse(location.search));
    addEventListener("popstate", sync);
    get.addFinalizer(() => removeEventListener("popstate", sync));
    return parse(location.search);
  },
  (ctx, navigation: Navigation) => {
    const previous = ctx.get(route);
    ctx.set(statusOpen, false);
    const next = destination(previous, navigation);
    switch (writeKind(previous, navigation)) {
      case "none":
        return;
      case "push":
        history.pushState(pushedEntry(previous, next), "", href(next));
        ctx.setSelf(next);
        return;
      case "replace":
        history.replaceState(history.state, "", href(next));
        ctx.setSelf(next);
        return;
      case "leave":
        Option.match(searchEntry(history.state), {
          onNone: () => {
            const target = { ...next, conversation: Option.none() };
            history.replaceState(null, "", href(target));
            ctx.setSelf(target);
          },
          onSome: ({ preSearch, depth }) => {
            history.go(-depth);
            ctx.setSelf(parse(new URL(preSearch, location.href).search));
          },
        });
    }
  },
);
