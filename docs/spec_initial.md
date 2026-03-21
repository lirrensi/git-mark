# git-mark - Specification v0.2

> A bookmark manager for git-backed resources, with lightweight surfacing, local materialization, and optional caching.

---

## Naming

- **Tool name:** `git-mark`
- **Short alias:** `gmk`
- **Why not "package manager":** it does not solve dependencies, resolve versions, or manage installs in the traditional sense. It behaves more like bookmarks over git resources.

---

## Core Philosophy

- **Everything under git is a resource.** Skills, instructions, templates, binaries, images, raw files, docs, or whole repos.
- **Bookmarks first.** The tool tracks what exists, what should be surfaced, and what should be cached locally.
- **No author cooperation required.** A valid package can be any git repo or any subpath within one.
- **Thin contract.** The tool manages records, caches, and local views. Agents and users read files directly.
- **Visibility is not presence.** A package can be known, searchable, and loadable without being surfaced by default.

---

## Core Concepts

Each package record has two independent flags:

### Flag 1: `pinned` - surfaced by default

| Value | Meaning |
|-------|---------|
| `true` | Included in `gmk list` |
| `false` | Hidden from default list output, but still searchable and loadable |

`pinned` does **not** promise agent integration. It only controls what the tool surfaces by default.

`pinned` and `kept` are fully independent. A package may be pinned but temp-only (`pinned = true`, `kept = false`). In that case it is surfaced by default, but it is still materialized only on demand.

### Flag 2: `kept` - stable local materialization

| Value | Meaning |
|-------|---------|
| `true` | Package has a stable local view managed by the tool |
| `false` | Package is materialized into temp storage on demand |

---

## The Index

The global index lives at `~/.gitmarks.toml`.

It is a plain text file, meant to be backed up, versioned, copied to a fresh machine, or shared like dotfiles.

### Record Schema

```toml
[[package]]
id = "design"                  # required, unique local handle
remotes = ["github.com/you/mega-repo"]
subpath = "skills/design"      # optional

summary = "Design references, templates, and style guidance"  # optional, <= 300 chars
description = ""               # optional, longer user-authored description
resources = [                   # optional, semantic inventory, not a file tree
  "10 design reference videos",
  "4 landing page templates",
  "Typography guidelines"
]

pinned = true                   # optional, default false
kept = true                     # optional, default false
discoverable = true             # optional, default true

frozen = false                  # optional, default false
commit = ""                    # resolved commit when frozen
```

### Field Rules

- `id` is the local CLI identity used by commands such as `gmk load design`.
- `remotes` contains one or more equivalent mirrors of the **same physical repo history**. The tool tries them in order.
- A package must not point to multiple unrelated repos.
- `subpath` narrows the visible package view to one folder inside the repo.
- `summary` is the short search and discovery anchor. It should be concise and capped at 300 characters.
- `description` is the richer explanation. It may be user-authored, imported, or left empty.
- `resources` is a semantic list of useful things inside, written for humans and agents, not filenames.
- `commit` is meaningful only when `frozen = true`.

### Identity and Inference

- `id` is explicit in the stored record.
- When adding a package, the tool may infer `id` from the repo name.
- If `subpath` is present, the default inferred id may include a subpath-derived suffix, for example `mega-repo/design`.
- If the inferred id collides with an existing record, the tool should suggest or auto-generate a disambiguated id.

---

## Tool Configuration

The package index is not the only state the tool needs.

`git-mark` should also have a separate runtime configuration file for storage policy, network policy, and local automation hooks.

### Config location

- global index: `~/.gitmarks.toml`
- global runtime config: `~/.gitmark/config.toml`

If the config file does not exist, sensible defaults are used.

### Example config

```toml
[storage]
root = "~/.gitmark"
temp_root = "~/.gitmark/tmp"
max_temp_size_mb = 2048

[network]
git_timeout_sec = 120
allow_lfs = false

[hooks]
pre_load = ""
pre_expose = ""
post_load = ""
pre_update = ""
post_update = ""
```

### What belongs in config

Config is for tool behavior, not for package identity.

Examples:

- storage roots
- temp cleanup thresholds
- max allowed temp storage size
- git/network timeout values
- whether Git LFS fetches are allowed
- local automation hooks

Package records remain focused on package metadata and source identity.

### LFS policy

Git LFS should be explicitly controllable.

- if `allow_lfs = false`, the tool should avoid pulling LFS content
- if a package requires LFS content and policy forbids it, the command should fail clearly
- this protects users from accidental large downloads and unexpected binary materialization

### Hooks

Hooks are local machine commands configured by the user.

They are not package metadata, and they are not fetched from the package source.

The core hook points should include:

- `pre_load`
- `pre_expose`
- `post_load`
- `pre_update`
- `post_update`

### Hook semantics

- `pre_load` runs before a load operation starts
- `pre_expose` runs after clone or fetch work is complete, but before a path is returned to the caller
- `post_load` runs after a successful load
- `pre_update` and `post_update` wrap update operations
- hooks receive relevant context such as package id, local repo path, returned subpath, selected remote, and resolved commit

### Hook failure behavior

- if a blocking hook such as `pre_expose` exits non-zero, the command should fail and no path should be returned
- this is the intended place for security scanning, policy checks, or other local validation
- post hooks may also fail loudly, but should not retroactively pretend the underlying operation never happened unless the implementation explicitly supports rollback

The classic example is a security scan immediately after clone or fetch, before the package path is exposed to an agent.

---

## Source Model

### One package, one repo

A package always maps to exactly one physical repo, plus an optional subpath.

Valid:

```toml
[[package]]
id = "rust-memory"
remotes = ["github.com/you/mega-repo"]
subpath = "skills/rust-memory"

[[package]]
id = "design"
remotes = ["github.com/you/mega-repo"]
subpath = "skills/design"
```

Invalid as a core primitive:

- one package id pointing to multiple unrelated repos
- one package id acting as a human bundle of many different packages

That higher-level bundling belongs to a future group abstraction, not to the package primitive.

### Mirrors

`remotes` supports fallback mirrors for the same repo.

Example:

```toml
[[package]]
id = "design"
remotes = [
  "github.com/you/mega-repo",
  "git.example.com/you/mega-repo"
]
subpath = "skills/design"
```

The tool tries remotes in order until one succeeds. Once fetched, the resolved commit is the truth for that materialization.

---

## Storage and Materialization

The tool uses full local clones as its working storage model.

If a package points at a subpath, the returned local path is that folder inside the local clone. This is a convenience-first design: the caller is guided to the relevant folder, but the rest of the repo may still be reachable through normal filesystem navigation.

### Visible behavior

- If `kept = true`, the package has a stable exposed local path.
- If `kept = false`, the package is materialized to temp storage on demand.
- If `subpath` is set, the returned path points to that selected folder inside the local clone.
- Returned paths are convenience entry points, not isolation boundaries.

### Internal behavior

Implementation is flexible:

- the tool clones the full repo because that is where git history actually exists
- multiple package ids may reuse local clones when they refer to the same repo history
- the returned path from `gmk load` may be the repo root or a subpath inside that local clone

This keeps update behavior simple and preserves normal repo behavior such as symlink traversal and git metadata in the underlying clone.

### Temp cleanup

Temp cleanup is synchronous and tool-managed.

- cleanup runs at the start of each CLI invocation
- stale temp materializations are removed first
- the tool updates its own temp-state tracking so removed temp paths are no longer treated as live
- after cleanup, the requested command runs normally
- `gmk load <id>` is the repair operation that re-materializes a temp package if cleanup just removed it

---

## Discovery Model

The tool supports three levels of discovery:

1. **Surfaced set** via `gmk list`
2. **Full bookmark set** via `gmk list-all`
3. **Full-text lookup** via `gmk search`

### Output budget

Discovery output should be intentionally small.

- Default command output should not exceed about `2 KB`.
- If the result set is larger, the tool should require paging, cursors, or an explicit follow-up.
- The goal is to avoid flooding agent context or terminal output when indexes get large.

### Search behavior

- `gmk search <query>` searches across all discoverable packages.
- Search should use `summary`, `description`, and `resources`.
- Packages with `discoverable = false` are omitted from search results but remain directly addressable by `id`.

### Search method

Search in v0.2 is lexical, not semantic.

- the recommended default is a BM25-style full-text ranking method or an equivalent keyword-ranking algorithm
- search indexes text from `summary`, `description`, and `resources`
- `summary` should receive the highest weight because it is the strongest short intent signal
- `description` should receive medium weight
- `resources` should receive lower but still meaningful weight
- exact or near-exact `id` matches should rank very highly

This is intended to be accurate enough for large personal indexes without requiring embeddings, external services, or heavier semantic infrastructure.

### Search normalization

The search implementation should do lightweight normalization.

- case-insensitive matching
- punctuation-insensitive tokenization where practical
- reasonable token splitting on paths, dashes, and underscores
- support for multi-word queries

The goal is not perfect information retrieval, only strong enough keyword search for hundreds or thousands of saved entries.

### Non-goal for v0.2

- no semantic vector search
- no embedding index
- no external search service requirement
- no promise of typo tolerance beyond simple normalization unless explicitly added later

---

## Description and README Handling

The spec distinguishes two levels of package explanation:

### `summary`

- short heuristic for deciding whether to inspect a package at all
- intended for `list`, `list-all`, and `search`
- capped at 300 characters

### `description`

- richer explanation of what the package is and when to use it
- may be user-authored
- may be imported or derived from a package README
- may be empty

### README fallback

If no explicit `description` is present, the tool may use package README content as the descriptive fallback for inspection commands.

Rules:

- README use is primarily for `gmk peek`, not for bloating the index
- the tool may cache a bounded README excerpt and README path metadata for non-kept packages
- imported README content should be truncated aggressively
- long README text should require paging or an explicit request

---

## `peek` - inspect before load

`gmk peek <id>` is the inspection command used before materializing a package for active work.

`peek` is inspection-only. It does not create or guarantee a working local path.

Its job is to answer two questions:

- what is this package?
- what is inside the visible package view?

### `peek` should show

- `id`
- remote source or chosen mirror
- `subpath`, if any
- `summary`
- `description`, or README excerpt if no description exists
- `resources`
- pinned / kept / frozen state
- compact file or subtree preview for the visible package view only

### `peek` constraints

- default output should stay within about `2 KB`
- if more content exists, the tool should require paging or an explicit follow-up
- for non-kept packages, lightweight metadata such as README excerpts may be cached separately from full package materialization

`peek` is intentionally lighter than `load`. It exists to save unnecessary materialization and unnecessary directory browsing.

---

## `load` - materialize and return path

`gmk load <id>` ensures the package exists locally, then prints the resolved local path.

### Behavior

- before doing anything else, `load` performs normal synchronous temp cleanup
- if `kept = true` and a valid local view already exists, return that path
- if `kept = true` and local view is missing, fetch and materialize it, then return the path
- if `kept = false`, materialize into temp storage and return the temp path
- if `subpath` is set, return the local path to that folder inside the clone

The returned path is meant to be read directly by an agent or human using normal filesystem tools.

---

## `path` - return an existing local path

`gmk path <id>` is a convenience lookup.

### Behavior

- it returns the current local usable path only if the package is already materialized
- it never fetches, clones, or re-materializes anything
- if the package is not currently materialized, it should fail clearly and tell the caller to use `gmk load <id>`
- if `subpath` is set, the returned path is that folder inside the local clone

This command exists for callers that already expect a package to be present and only need to recover the local path.

---

## Updating

Updates are manual.

There is no background sync and no automatic update policy in the core tool.

### Rules

- updates operate on the local full clones, not on the returned subpath entry points
- `gmk updateall` refreshes all non-frozen packages from their remotes
- frozen packages are skipped by default
- `gmk update <id>` may update one specific package explicitly
- if a package is frozen, normal update commands do not change its commit unless the user explicitly unfreezes or force-updates it
- if a package has `subpath`, updating still happens at the repo level because git history lives at the full clone

This keeps package changes deliberate and easy to reason about.

---

## Freezing

Freezing pins a package to a resolved commit.

### Behavior

- when frozen, the package stores the commit it should materialize
- `gmk load <id>` resolves to that exact commit
- `gmk updateall` skips it
- changing the stored commit requires an explicit per-package action

This is a lightweight safety mechanism against unexpected upstream changes.

---

## CLI Sketch

```bash
# Add a package, inferring id from repo name when possible
git-mark add github.com/you/mega-repo#skills/design
gmk add github.com/you/mega-repo#skills/design

# List surfaced packages only
gmk list

# List the full bookmark set
gmk list-all

# Search across all discoverable packages
gmk search "design templates"

# Inspect before loading
gmk peek design

# Materialize and print local path
gmk load design

# Print current local path if materialized
gmk path design

# Update all non-frozen packages
gmk updateall

# Update one package explicitly
gmk update design

# Freeze a package at its current resolved commit
gmk freeze design

# Unfreeze a package
gmk unfreeze design
```

---

## Addendum: MCP Integration for Current Agents

The core tool is a CLI, but it can be integrated into coding agents today through a thin MCP wrapper.

This addendum is intentionally pragmatic: it is not a native plugin architecture, and it does not require agent vendors to adopt anything new.

### Goal

Expose `git-mark` to current agents with minimal MCP overhead while still surfacing the pinned package set for the active session.

### Recommended shape: one MCP tool

Use a **single MCP tool** that wraps the existing CLI.

Example conceptual shape:

- **tool name:** `git_mark`
- **description:** generated from `gmk list`, plus short usage help
- **input:** one command string, CLI-style
- **behavior:** run `gmk <command>` and return stdout

Example input:

```json
{
  "command": "search design templates"
}
```

The MCP server is therefore a thin adapter:

```text
receive command string -> run gmk <command> -> return stdout
```

This keeps CLI and MCP behavior aligned and avoids duplicating command logic in two places.

### Why one tool

Each additional MCP tool has prompt and schema overhead.

A single-tool, subcommand-style interface keeps integration small:

- one tool registration
- one description block
- one input shape
- no explosion of tiny wrappers like `list`, `search`, `load`, `peek`, `path`, `update`

The command surface stays in the CLI where it belongs.

### Tool description strategy

The MCP tool description should include:

- a one-line explanation of what `git-mark` is
- the currently pinned package set from `gmk list`
- a short reminder of common commands such as `list`, `list-all`, `search`, `peek`, `load`, and `path`

It should **not** include resolved local paths for pinned packages.

Conceptual example:

```text
git-mark bookmark manager for git-backed resources.

Pinned resources available this session:
- [rust-memory] Modern Rust memory principles
- [design] Brand guidelines and templates

Use commands like:
- list
- list-all
- search <query>
- peek <id>
- load <id>
- path <id>
```

This effectively injects a lightweight skills-style index into agents that already support MCP tools.

### Rationale for omitting paths in pinned descriptions

1. A pinned package may not be materialized yet, so no usable local path exists.
2. Temp packages do not have a stable path until `gmk peek` or `gmk load` resolves one.
3. `pinned` and `kept` are separate axes: a package can be important enough to surface by default without being kept on disk at all times.

### Dynamic description

The MCP wrapper may generate the tool description dynamically:

- at server startup
- when the active project changes
- when the pinned set changes, if the MCP host supports refresh or reconnect behavior

This allows pinned resources to be surfaced without requiring a dedicated plugin system.

### Important limitation

The dynamic description is a compatibility hack for current tooling.

- it helps agents discover currently pinned resources
- it does not replace a future first-class integration
- if the MCP host does not refresh tool descriptions during a session, the surfaced pinned list may become stale until reconnect

### Recommended command subset for agent workflows

For current agents, the most useful commands are:

- `list`
- `list-all`
- `search <query>`
- `peek <id>`
- `load <id>`
- `path <id>`

These are enough for the common flow:

1. discover surfaced packages
2. search broader bookmarks if needed
3. inspect with `peek`
4. materialize with `load`
5. read files directly from the returned path

### Output discipline still applies

Even through MCP, normal output limits should still hold.

- `list`, `list-all`, `search`, and `peek` should still aim for about `2 KB` by default
- larger responses should require paging or explicit follow-up

This keeps the single-tool wrapper useful without flooding the model context.

### Non-goal of this addendum

This MCP wrapper does not redefine the core architecture.

It is only a bridge for using `git-mark` in current coding agents before any future native integrations, plugins, or richer agent-specific protocols exist.

---

## Bootstrapping a Fresh Machine

The index is just a text file.

```bash
# Restore your bookmark universe
cp ~/.gitmarks.toml /path/to/new/machine/

# Then materialize kept packages as needed or via future restore command
gmk list
gmk load design
```

The simplest backup strategy is the same as for dotfiles.

---

## What This Is Not

- Not a dependency manager
- Not a lockfile solver
- Not a package registry
- Not an access layer over git
- Not requiring any author-side manifest
- Not exposing whole repos when only a subpath package was requested

---

## Deferred / Out of Scope for v0.2

- Project-level override files
- Group abstraction for loading many package ids at once
- GUI
- Daemon or background sync
- Agent-specific integration layers
- Author-defined package manifests as a requirement
- One package id mapping to many unrelated repos

---

## One-Sentence Definition

> `git-mark` is a bookmark manager for git-backed resources: it tracks what exists, what is surfaced, and how to materialize only the package view you actually want.
