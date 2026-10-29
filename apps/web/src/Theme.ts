import * as KeyValueStore from "effect/persistence/KeyValueStore";
import * as Atom from "effect/reactivity/Atom";
import * as Schema from "effect/Schema";

export const ThemePreference = Schema.Literals(["system", "light", "dark"]);
export type ThemePreference = typeof ThemePreference.Type;
export type Theme = "light" | "dark";

export const themeKey = "weir:theme";

export const themePreference = Atom.kvs({
  runtime: Atom.runtime(KeyValueStore.layerStorage(() => localStorage)),
  key: themeKey,
  schema: ThemePreference,
  defaultValue: (): ThemePreference => "system",
});

const systemDark = Atom.make((get) => {
  const query = matchMedia("(prefers-color-scheme: dark)");
  const sync = () => get.setSelf(query.matches);
  query.addEventListener("change", sync);
  get.addFinalizer(() => query.removeEventListener("change", sync));
  return query.matches;
});

export const theme = Atom.make((get): Theme => {
  const preference = get(themePreference);
  const resolved = preference === "system" ? (get(systemDark) ? "dark" : "light") : preference;
  document.documentElement.dataset.theme = resolved;
  return resolved;
});
