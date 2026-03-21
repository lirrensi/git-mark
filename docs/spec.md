# git-mark Behavioral Specification

## Abstract

This document specifies the observable behavior of `git-mark`, a CLI-first bookmark manager for git-backed resources. A conforming implementation stores bookmark truth in a TOML index, supports local lexical discovery, materializes bookmarked resources into managed local clones, and exposes a thin single-tool MCP wrapper over the same command surface.

## Introduction

`git-mark` manages references to repositories and repository subpaths that users want to discover and load later. It does not solve dependencies or publish artifacts. Its primary responsibility is to preserve bookmark identity and metadata, then materialize local filesystem paths on demand.

The implementation described by this repository is Node.js-based, but this specification is language-agnostic and defines behavior rather than source layout.

## Scope

In scope:

- package record identity and metadata
- index and runtime configuration files
- listing, search, inspection, materialization, update, cleanup, and health commands
- kept versus temp materialization semantics
- freezing semantics
- local hook execution points
- MCP exposure shape

Out of scope:

- registry or publish protocols
- dependency resolution
- semantic or embedding-based search
- background sync services
- write-preserving updates of tool-managed clones

## Terminology

| Term | Meaning |
|---|---|
| Package record | A single bookmark entry stored in the index |
| Package | The git-backed resource identified by one package record |
| Visible path | The repo root or selected `subpath` returned to callers |
| Kept package | A package whose clone is stored as stable managed repo state |
| Temp package | A package whose clone is materialized under temp storage on demand |
| Materialization | Creation or reuse of a local clone that satisfies `peek`, `load`, `path`, or update workflows |
| Repo key | Deterministic identity derived from the sorted remote list for kept-repo storage |
| Pinned package | A package surfaced by default in `list` and in the MCP description |
| Discoverable package | A package included in lexical search results |
| Frozen package | A package constrained to a stored commit and skipped by bulk update |

## Normative Language

The key words `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` in this document are to be interpreted as described in RFC 2119.

## System Model

### Actors

- User or agent invoking CLI commands
- Local filesystem containing index, config, runtime state, and materialized repos
- Git executable used for clone, fetch, checkout, and reset operations
- Optional local hook module
- Optional MCP host invoking the single MCP tool

### Canonical and derived state

| Layer | Location | Status |
|---|---|---|
| Package index | `~/.gitmarks.toml` | Canonical user-managed truth |
| Runtime config | `~/.gitmark/config.toml` | Canonical user-managed runtime policy |
| Runtime state | `<storage root>/state.json` | Derived, disposable tool state |
| Logs | `<storage root>/history.log` | Derived operational log |
| Kept repos | `<storage root>/repos/<repo-key>` | Derived materialization |
| Temp repos | `<temp root>/<sanitized-id>-<timestamp>` | Derived materialization |

### Package record schema

Each package record MUST support the following fields.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable local command identity |
| `remotes` | string[] | yes | One or more equivalent remotes for the same repo history |
| `subpath` | string | no | Visible folder within the repo |
| `summary` | string | no | Short discovery blurb |
| `description` | string | no | Longer human-readable description |
| `resources` | string[] | no | Semantic inventory or notes |
| `pinned` | boolean | no | Whether the package is surfaced by default |
| `kept` | boolean | no | Whether the package keeps a stable managed clone |
| `discoverable` | boolean | no | Whether the package appears in search |
| `frozen` | boolean | no | Whether the package is pinned to a commit |
| `commit` | string | no | Frozen commit value |

Default values when omitted from parsed index data:

| Field | Default |
|---|---|
| `pinned` | `false` |
| `kept` | `false` |
| `discoverable` | `true` |
| `frozen` | `false` |

### Runtime config schema

| Section | Key | Meaning | Default |
|---|---|---|---|
| `storage` | `root` | Runtime storage root | `~/.gitmark` |
| `storage` | `temp_root` | Temp materialization root | `~/.gitmark/tmp` |
| `storage` | `max_temp_size_mb` | Max aggregate temp size before pruning | `2048` |
| `network` | `git_timeout_sec` | Git command timeout | `180` |
| `network` | `allow_lfs` | Whether LFS smudge is allowed | `false` |
| `hooks` | `module` | Local hook module path | empty string |

## Conformance

A conforming implementation:

- MUST treat the package index and runtime config as the only canonical persistent truth
- MUST be able to rebuild runtime state from the index, config, and remotes
- MUST support the command surface defined in this specification
- MUST use lexical local search rather than requiring a remote or semantic search backend
- MUST expose kept and temp materialization modes
- MUST preserve the distinction between `pinned`, `kept`, `discoverable`, and `frozen`
- MUST support a thin MCP wrapper with one tool accepting a CLI-style command string
- MUST fail clearly on malformed index or config files

## Behavioral Specification

### Source parsing and identity

- A source descriptor MUST accept the shape `<remote>` or `<remote>#<subpath>`.
- If the remote lacks an explicit scheme and is not an SSH-style remote, it MUST be normalized to `https://...`.
- `subpath` MUST be trimmed of leading and trailing slashes.
- Default inferred ids MUST be based on the remote repo name and, when present, the last segment of `subpath`.
- Generated ids MUST be sanitized to lowercase and limited to `a-z`, `0-9`, `/`, `_`, and `-`.
- When a new id collides, the implementation MUST generate `-2`, `-3`, and so on until unique.

### `add`

- `add` MUST require a remote source.
- In an interactive TTY, `add` MUST inspect the source first, show a compact preview, and prompt for metadata and flags.
- With `--yes` or in non-interactive mode, `add` MUST skip prompts and use defaults.
- Non-interactive defaults in the current product are: `pinned=true`, `kept=true`, `discoverable=true`, empty `resources`, suggested `summary`, and README-derived `description` when available.
- If the exact same remote plus subpath already exists, non-interactive `add` MUST fail clearly.
- Interactive duplicate handling MUST offer replace, keep-both-under-another-id, or cancel.
- Successful `add` MUST write the updated index and print the resulting id.

### `list`

- `list` MUST return only records where `pinned` is not `false`.
- Records MUST be sorted by `id` ascending.
- Output SHOULD include a short human-readable snippet and technical flags.

### `list-all`

- `list-all` MUST return all records sorted by `id` ascending.
- Default pagination MUST be `--limit 15 --offset 0`.
- When more results exist, the command MUST print a continuation hint.

### `search`

- `search` MUST require a non-empty query to return results; empty queries return no matches.
- Default pagination MUST be `--limit 10 --offset 0`.
- Search MUST exclude records with `discoverable = false`.
- Search MUST index `id`, `summary`, `description`, and `resources`.
- Search MUST be case-insensitive and perform lightweight normalization over punctuation, path separators, dashes, and underscores.
- Search SHOULD support exact token matches, prefix completion, and light typo tolerance.
- Exact and prefix `id` matches MUST outrank broader descriptive matches.
- Ties MUST break by `id` ascending.

### `peek`

- `peek` MUST require an existing package id.
- `peek` MUST return record metadata, pinned/kept/discoverable/frozen flags, a compact file preview, and either `description` or a README excerpt.
- `peek` MAY clone transiently when the package is not already materialized.
- If `peek` created a transient inspection clone, it MUST delete that transient clone before returning.
- `peek` MUST preview the visible path, not the entire repo tree outside the selected subpath.

### `load`

- `load` MUST require an existing package id.
- `load` MUST ensure git is available before materialization.
- `load` MUST run `preLoad` before materialization work.
- For kept packages, `load` MUST materialize or reuse a stable repo path under the managed repos root.
- For temp packages, `load` MUST materialize or reuse a temp repo path under the temp root.
- If `subpath` is present, `load` MUST return the visible subpath rather than the repo root.
- `load` MUST run `preExpose` after materialization and before returning a path.
- `load` MUST run `postLoad` after successful exposure handling.
- If a hook fails, `load` MUST fail clearly.

### `path`

- `path` MUST return the current visible path only when the package is already materialized.
- `path` MUST NOT fetch, clone, or re-materialize anything.
- If not materialized, `path` MUST fail clearly and direct the caller to `gmk load <id>`.

### `update`

- `update` MUST require an existing package id.
- If the package is frozen and update is not forced, `update` MUST fail with a frozen-package error.
- `update` MUST ensure the package is materialized before updating.
- `update` MUST run `preUpdate` before fetching and `postUpdate` after success.
- `update` MUST fetch from `origin` and reset the local clone hard to `origin/<default-branch>`.
- Update behavior for tool-managed clones is intentionally destructive; local edits inside those clones are not preserved.
- After updating, the visible path MUST still be returned.

### `updateall`

- `updateall` MUST process every non-frozen package.
- `updateall` MUST skip frozen packages silently in normal operation.
- `updateall` MUST print the number of updated packages.

### `pin` and `unpin`

- `pin` MUST set `pinned = true` and preserve other fields.
- `unpin` MUST set `pinned = false` and preserve other fields.

### `freeze` and `unfreeze`

- `freeze` MUST materialize the package if needed, resolve the current commit, set `frozen = true`, and store that commit in `commit`.
- A frozen package MUST materialize at the stored commit.
- `unfreeze` MUST set `frozen = false` and clear `commit`.

### `remove` / `rm`

- `remove` and `rm` MUST be aliases.
- Removal MUST delete the index entry.
- Removal MUST delete tracked temp state and temp directories for that package.
- If the removed package was kept, removal MUST delete the shared kept repo only when no other kept record still refers to the same repo key.
- Removal MUST reconcile orphan runtime state after record deletion.

### `doctor`

- `doctor` MUST report git availability issues, stale lock state, orphan temp state, orphan repo state, missing materializations, and orphan directories.
- `doctor` MUST NOT mutate runtime state.
- `doctor` MUST exit non-zero when issues are found.

### `cleanup`

- `cleanup` MUST remove all tracked temp materializations.
- `cleanup` MUST preserve kept repo materializations.
- `cleanup` MUST also prune orphan repo and temp directories and stale state entries.

### `sync`

- `sync` MUST reconcile runtime drift and then materialize every kept package.
- `sync` MUST NOT materialize temp-only packages.

### `edit`

- `edit` MUST open the canonical package index in the configured editor selection order: `VISUAL`, then `EDITOR`, then platform fallback.
- The platform fallback MUST be `notepad.exe` on Windows and `vi` otherwise.
- After editing, the implementation MUST reconcile orphan runtime state.

### Help and version

- `help`, `--help`, `-h`, and `-help` MUST return usage text.
- `--version` and `-v` MUST return the tool version.

## Data and State Model

### Index semantics

- The package index MUST be plain-text TOML using repeated `[[package]]` entries.
- Each package MUST contain `id` and `remotes`.
- Unknown package keys MUST fail parsing.
- Parsed missing booleans MUST receive the defaults defined earlier in this document.

### Runtime state semantics

`state.json` tracks two maps:

- `repos`: keyed by repo key for kept materializations
- `temps`: keyed by package id for temp materializations

Each kept repo state MUST include path, selected remote, default branch, last commit, and update timestamp.

Each temp state MUST include path, repo key, selected remote, default branch, materialization time, and last access time.

### Temp cleanup rules

- Temp cleanup MUST run before writer commands execute their main action.
- Temp directories older than about 24 hours MUST be eligible for removal.
- Missing tracked temp paths MUST be removed from state.
- If total temp size exceeds `max_temp_size_mb`, the oldest temp entries MUST be removed first until usage is within limit.

### Writer lock

- Mutating commands MUST execute under a single filesystem-backed writer lock.
- The lock MUST contain owner metadata and a heartbeat file.
- A contending writer MUST wait up to about 60 seconds by default.
- If the heartbeat becomes stale, the next writer MUST reap the stale lock and retry.

### Hook model

Supported hook names are `preLoad`, `preExpose`, `postLoad`, `preUpdate`, and `postUpdate`.

Hook context MUST include:

- package id
- repo path
- visible path
- selected remote
- subpath
- resolved commit
- default branch
- hook name

If a configured hook module cannot be loaded, the invoking command MUST fail clearly.

## Error Handling and Edge Cases

- Malformed `~/.gitmarks.toml` MUST fail loudly with line context.
- Malformed `config.toml` MUST fail loudly with line context.
- Malformed `state.json` MUST be preserved as `state.broken-*.json` and treated as empty runtime state.
- Missing package ids MUST return a not-found error.
- Missing selected `subpath` in a materialized repo MUST fail clearly.
- Unavailable git MUST fail clearly.
- Timed-out git commands MUST fail clearly and include the timeout duration.
- If all remotes fail during clone, the command MUST fail after all candidates are attempted.
- Commands that require a package id or source MUST fail clearly on missing arguments.

## Security Considerations

- `git-mark` executes `git` against user-supplied remotes and therefore inherits the trust and risk profile of those remotes.
- The hook module is arbitrary local code and MUST be treated as trusted local execution.
- Update operations intentionally discard local modifications in tool-managed clones; those clones are not safe places for user-authored changes.
- Disabling LFS by default reduces accidental large-object downloads, but does not remove all remote-content risk.
- The returned visible path is a convenience entry point, not an isolation boundary from the rest of the cloned repository.

## References

### Normative References

- RFC 2119: Key words for use in RFCs to Indicate Requirement Levels

### Informative References

- `docs/product.md`
- `docs/spec_initial.md` (historical artifact, not canonical)
