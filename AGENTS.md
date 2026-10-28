# weir

## Stage

Pre-dogfood: no daemon has run against a real `~/.weir/weir.db` yet. Until one does, change the
schema by editing the first migration (`0001`) in place. After that the schema is frozen: anything
persisted changes only through a new migration that converts existing data, and a migration is
never edited once it has run against a real database. APIs and in-memory types change in place:
migrate every caller and delete the old path in the same change, with no compatibility shims.

## Layout

- Workspaces live under three roots: `packages/`, `plugins/`, and `apps/`.
- A package under `plugins/` has runtime dependencies on workspace packages: only
  `packages/contract`. Dev and test dependencies on other workspace packages are allowed.
- Nothing under `packages/`, `plugins/`, or `apps/` imports from `design/`.

## Reference

- `design/index.html` is the design doc.
- `design/prototype/ui/final/app.js` and `design/prototype/ui/final/style.css` are the UI reference.
  Run the prototype with `cd design/prototype && bun ux/serve.ts` (`PORT` env, default 9347).
- The prototype is throwaway: never import it.

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
- UI images and videos come only from `bun run demo` (synthetic data), never from a real mailbox.
- Use squash merge and delete the source branch.
