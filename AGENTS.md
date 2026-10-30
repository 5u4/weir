# weir

## Stage

Single user: the operator is the only one running weir, so no database needs to survive a schema
change. Change the schema by editing the first migration (`0001`) in place; the operator deletes
`~/.weir` when a change needs it. APIs and in-memory types change in place too: migrate every caller
and delete the old path in the same change, with no compatibility shims.

## Layout

- Workspaces live under three roots: `packages/`, `plugins/`, and `apps/`.
- A package under `plugins/` has runtime dependencies on workspace packages: only
  `packages/contract`. Dev and test dependencies on other workspace packages are allowed.
- Nothing under `packages/`, `plugins/`, or `apps/` imports from `design/`.

## Reference

- `design/index.html` is the design doc.
- Web UI styles use the tokens in `apps/web/src/theme.css`. A value with no step gets a new token
  there, never a literal, an `[arbitrary]` class or a `(--var)` shorthand. `bun run lint` enforces
  this on class strings and, through `lint/css-tokens.grit`, on literals in CSS other than
  `theme.css` (type, radius, duration and spacing properties, colors, z-index and custom
  properties).
  Tailwind inlines `--shadow-*` values into `shadow-*` classes, so only the color vars inside them
  follow the theme; a shadow whose geometry changes per theme is an `--elevation-*` token, used as
  `elevation-*`.
- A class string outside a `className` attribute lives in a camelCase variable or arrow function
  named `…Class` (see `apps/web/src/ListClasses.ts`); beyond `class`/`className` attributes, the
  lint checks only variables named `className(s)`, `classes`, `style(s)` or `…Class`. Styles
  utilities cannot express (sibling selectors, masks) go in `apps/web/src/styles/*.css` under
  `@layer components`, imported from `theme.css`; element resets live in `styles/base.css` under
  `@layer base`.
- `design/prototype/ui/final/` is historical reference only, never imported. Run it with
  `cd design/prototype && bun ux/serve.ts` (`PORT` env, default 9347).

## Effect

Run `bun run vendor:effect` (idempotent), then read `repos/effect/LLMS.md` before writing Effect
code. Treat `repos/` as read-only reference: never import from it or make the build depend on it.
The vendored v4 source outranks Effect v3 documentation and model memory. Import one namespace per
module (`effect/Effect`, `effect/sql/SqlClient`); avoid the `effect` barrel and area barrels such as
`effect/sql`. Confirm area APIs such as `effect/sql` and `effect/reactivity` in the vendored source.

## Comments

- Default to none. Names, types, and tests carry the meaning.
- Before writing a comment, try to encode the fact instead: a type, an assertion, a test, or a lint
  rule. If one of those can hold it, write no comment.
- A comment survives only for a fact about something we cannot change, such as a third-party type
  that lies or a runtime quirk. State it concretely in one line.
- No doc comments on exports. Find callers with LSP references, not prose.
- Every `TODO` names the condition that makes it actionable.

## Pull requests

- Never open one unless the developer explicitly asks.
- Use conventional commit titles in plain language: `fix(web): new chats no longer spike CPU`.
- State the problem in a sentence or two, then how it was fixed.
- Rebase onto the latest main before opening.
- UI changes need before/after images; motion or timing needs a short video.
- The daemon serves the Web UI only after `bun run build:web`; `bun run demo` runs it first.
- UI images and videos come only from `bun run demo --serve` (synthetic data), never from a real
  mailbox.
- Use squash merge and delete the source branch.
