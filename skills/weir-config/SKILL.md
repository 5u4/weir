---
name: weir-config
description: Edit weir's config.toml. Use when adding or changing a tag or rule, a group, a source or plugin config, an AI profile, or digest settings.
---

# Editing weir config

Rules address the item's rule input with JSON Pointers. Write every pointer from real `--raw` output, never from memory.

## Workflow

1. **Locate.** Run `weir-axi` with no arguments. Done when you hold the `config:` path it prints (it follows `WEIR_HOME`).
2. **Gather evidence.** `weir-axi search <query>` finds conversations, `weir-axi conv <id>` lists their items, and `weir-axi item <seq> --raw` prints the full rule input. Done when every pointer you plan to write appears in that output, and you also hold one item that should _not_ match.
3. **Edit** `config.toml`.
4. **Verify.** Run `weir-axi tag test <name>` for each changed tag and `weir-axi group test [name]` for groups. Done when both print no validation error, every sample is one you expect, the item from step 2 that should match does, and the one that should not is absent. A nonzero `moves` is the number of items `reload` will move between conversations: tell the user that number before reloading.
5. **Reload.** `weir-axi reload`, only after step 4 passes. A failed reload keeps no fallback: sync and digest stop until the config is valid.

## Pitfalls the schema does not show

- A pointer to a missing path matches nothing. It raises no error.
- `some` and `every` re-root at each element: the inner rule's `target` is relative to the element. For an array of strings, the inner target is `""`.
- Write regexes as TOML literal strings `'...'` so backslashes stay single.
- `Untagged` is reserved, in any case.
- File order is display order for tags and precedence for groups: the first group whose rule matches any item of a thread wins.
- Setting `ai = true` on a tag starts AI work from now (`ai_since`). Renaming the tag resets it.
- Tags have no `color`.
- A per-source view is a tag matching `/source`.
- Changing `port` needs a daemon restart; `reload` does not apply it.
- The plugin validates `[source.config]`. The `gws` plugin takes `command`, `backfill` and `labels`.

## Examples

```toml
[[tag]]
name = "GitHub"
match = { type = "some", target = "/raw/payload/headers", rule = { type = "and", rules = [
  { type = "regex", target = "/name", regex = '^from$', flags = "i" },
  { type = "regex", target = "/value", regex = '@github\.example>?$', flags = "i" },
] } }
```

```toml
[[group]]
name = "Northbank alerts"
match = { type = "regex", target = "/from/address", regex = '@northbank\.example$', flags = "i" }
```

A full tested config lives at `packages/fixtures/config.toml` in the weir repo.
