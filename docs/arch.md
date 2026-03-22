# git-mark Architecture Canon

## Overview

This repository implements `git-mark` as a small Node.js 24+ TypeScript CLI with a thin MCP adapter. The implementation is intentionally local-first: it reads a user-owned TOML index under `~/.gitmark`, maintains derived runtime state under the same storage root, shells out to the system `git` executable for remote operations, and returns filesystem paths to callers. The MCP layer is not a general command runner; it exposes a schema-validated action subset for `list`, `search`, `peek`, and `load`.

The architecture is simple enough to keep in a single file. Most behavior lives in a shared service module used by both the CLI and the MCP wrapper.

## Scope Boundary

**Owns**: CLI parsing, TOML index/config IO, search ranking, materialization state, lock coordination, hook dispatch, git command orchestration, structured MCP delegation to the CLI

**Does not own**: git server behavior, remote repository contents, editor behavior, MCP host lifecycle beyond the JSON-RPC server contract

**Boundary interfaces**: local filesystem, `git` executable, optional TypeScript hook module, stdio JSON-RPC for MCP, spawned editor process

## Components

### Entry points

| Path | Responsibility |
|---|---|
| `src/cli.ts` | CLI argument parsing, output formatting, command dispatch, writer-lock wrapping |
| `src/mcp.ts` | Single-tool MCP server that delegates to the CLI |

### Core services

| Path | Responsibility |
|---|---|
| `src/index.ts` | Primary domain logic for records, materialization, updates, cleanup, hooks, and drift reconciliation |
| `src/git.ts` | Child-process wrapper around git commands, timeouts, and LFS environment handling |
| `src/lock.ts` | Filesystem-backed single-writer lock with heartbeat and stale-lock recovery |
| `src/search.ts` | Local in-memory search over index records and cached repo artifacts, built on MiniSearch with explicit field boosting and id-priority rules |
| `src/toml.ts` | Minimal custom parser/stringifier for package index and runtime config |

### Supporting modules

| Path | Responsibility |
|---|---|
| `src/config.ts` | Runtime config loading and bootstrap file creation |
| `src/env.ts` | Home-directory expansion and derived runtime path resolution |
| `src/add.ts` | Interactive add UX helpers and summary inference |
| `src/help.ts` | CLI help text and dynamic MCP tool description generation |
| `src/fs.ts` | Filesystem helpers and atomic text writes |
| `src/log.ts` | Append-only line logger with max-line rotation |
| `src/errors.ts` | Typed application errors and CLI formatting |
| `src/types.ts` | Shared runtime and data types |

## Data Models / Storage

### Package index

- Location: `~/.gitmark/index.toml`
- Format: repeated `[[package]]` TOML records
- Ownership: user-managed canonical data

### Runtime config

- Location: `~/.gitmark/config.toml`
- Format: TOML sections `storage`, `network`, and `hooks`
- Ownership: user-managed runtime policy

### Derived runtime tree

Under the effective storage root:

| Path | Purpose |
|---|---|
| `history.log` | Operational history and command-failure logging |
| `state.json` | Derived materialization map plus cached repo artifacts such as README text, visible-tree preview, and discovered skill metadata |
| `.write.lock/` | Single-writer coordination metadata |
| `repos/` | Stable kept materializations keyed by repo hash |
| temp root | Temp materializations keyed by sanitized id plus timestamp |

### Identity model

- Package identity is the record `id`
- Kept repo storage identity is `repoKeyFor(record)`, a SHA-256 digest over the sorted remote list, truncated to 24 hex chars
- Temp storage identity is package-id based and timestamped, so temp materializations are per-package and ephemeral

### Search artifact cache

- `state.json` remains disposable derived state, but also stores the last collected metadata artifacts for materialized or inspected repos
- Cached artifacts are stored alongside kept repo and temp repo state rather than in a separate database or cache file
- README text is stored raw and truncated to 16384 characters
- Discovered skills follow the Agent Skills specification and are cached as a name-to-description map extracted from matching `SKILL.md` files

## Relationships and Flow

### CLI runtime flow

1. `src/cli.ts` resolves bootstrap paths
2. `src/config.ts` ensures `config.toml` exists and loads it
3. `src/env.ts` derives effective runtime paths
4. `src/cli.ts` creates the logger and command context
5. Writer commands enter `src/lock.ts` and run preflight reconciliation plus temp cleanup
6. `src/index.ts` executes the requested behavior
7. CLI prints human-facing output and appends log lines

### Materialization flow

1. Resolve record from the index
2. Decide kept versus temp target path
3. Run `preLoad` for `load`
4. Reuse an existing materialization when valid, otherwise clone using `src/git.ts`
5. Detect default branch and current commit
6. Apply frozen checkout if required
7. Persist derived repo or temp state in `state.json`
8. Run `preExpose` and `postLoad` hooks when applicable
9. Return the visible path, which may be the repo root or a subpath inside it

### Update flow

1. Ensure the package is materialized
2. Resolve the clone root rather than the visible subpath
3. Run `preUpdate`
4. `git fetch --prune origin`
5. `git checkout --force <default-branch>`
6. `git reset --hard origin/<default-branch>`
7. Reapply frozen commit if needed
8. Persist updated runtime state
9. Run `postUpdate`

### MCP flow

1. `src/mcp.ts` boots the same bootstrap files as the CLI
2. `tools/list` builds one tool description from currently pinned records via `src/help.ts`
3. `tools/call` accepts a structured action payload and validates it before execution
4. The server spawns `node --experimental-strip-types src/cli.ts ...args`
5. The MCP surface exposes read-only discovery plus `load`; mutating commands are not surfaced
6. Stdout and stderr are merged into a text result and flagged as error when exit status is non-zero
7. Arbitrary shell execution is intentionally out of scope for MCP; if a deployment needs that capability, it should be exposed separately through a permissioned shell tool rather than by widening the MCP schema

### Search flow

1. Load canonical records from `~/.gitmark/index.toml`
2. Load derived artifacts from `state.json`
3. Build an in-memory MiniSearch index from record metadata plus cached artifacts
4. Apply explicit boosts so exact and prefix `id` matches outrank broader text matches
5. Return ranked package hits without network or git operations

### Artifact collection flow

1. During `add` inspection, extract README text, visible-path preview, and discovered skill metadata from Agent Skills-standard skill directories
2. Persist those artifacts into `state.json`
3. On `update`, `updateall`, and `sync`, refresh artifacts after repo content changes
4. On `load`, reuse existing artifacts when present; only collect artifacts when materialization is new or artifacts are missing

## Dependencies

### Runtime dependencies

- Node.js 24+
- System `git` executable on `PATH`
- Optional local editor from `VISUAL` or `EDITOR`
- Optional hook module loaded through native module import
- `@inquirer/prompts` for interactive add flows

### Internal dependency shape

- `src/cli.ts` depends on almost every other internal module and is the orchestration root
- `src/mcp.ts` depends on bootstrap helpers, index loading, and help-text generation, but delegates command execution back to the CLI
- `src/index.ts` is the main domain layer and depends on filesystem, git, TOML, env, lock inspection helpers, and artifact extraction helpers
- `src/search.ts` depends on MiniSearch and builds a transient in-memory index from canonical records plus cached runtime artifacts

## Contracts / Invariants

| Invariant | Description |
|---|---|
| Index is canonical | `~/.gitmark/index.toml` is the durable package truth |
| Config is canonical | `config.toml` controls runtime paths and policies |
| Runtime state is rebuildable | `state.json`, logs, repos, and temp dirs are derived and may be reconstructed |
| One writer at a time | Mutating commands run under the filesystem lock |
| Search is local | Search uses only canonical index data and cached runtime artifacts, not remote or embedding services |
| Kept repos may be shared | Multiple kept records with the same remote set reuse one repo directory |
| Visible path may be nested | Returned paths are convenience entry points inside a full clone |
| Tool-managed updates are destructive | Update resets managed clones to remote branch state |

## Configuration / Operations

### Bootstrapping

- Missing `config.toml` is auto-created with defaults
- Missing index file is treated as an empty catalog
- Missing runtime directories are created on startup

### Locking

- Writer lock directory: `<storage root>/.write.lock`
- Metadata: `owner.json` and `heartbeat`
- Default acquisition timeout: 60 seconds
- Default stale heartbeat threshold: 20 seconds

### Cleanup and reconciliation

- Writer preflight always reconciles orphan runtime state and temp drift before the main command
- Temp cleanup also prunes entries older than roughly one day or beyond size budget
- `cleanup` clears tracked temp materializations completely
- `sync` restores kept materializations after reconciliation

### Observability

- Commands append structured JSON metadata to `history.log`
- Log rotation is line-count-based, trimmed to the most recent 1000 lines by default
- `doctor` is the explicit health-reporting surface for drift and lock state

### Failure domains

- Invalid index or config data stops the command
- Invalid `state.json` is quarantined and recovered from
- Hook load or hook execution failure stops the invoking command
- Git timeouts or failures surface as application errors

## Design Decisions

### Single shared core module

Confidence: High

The repository concentrates most domain behavior in `src/index.ts`. This keeps CLI and future wrappers aligned, at the cost of a relatively large central module.

### Full-clone storage model

Confidence: High

Even when a package points at a subpath, the implementation clones the full repo and returns a nested visible path. This preserves normal git semantics and simplifies update behavior.

### Thin MCP adapter

Confidence: High

The MCP server does not duplicate command logic. It shells out to the CLI and exposes one tool to minimize schema surface and keep behavior aligned.

### Custom lightweight TOML parser

Confidence: Medium

The repository uses a small in-repo TOML parser and writer rather than an external TOML library. This keeps dependencies small but intentionally supports only the subset of TOML needed by the product.

### Derived runtime state instead of canonical database

Confidence: High

`state.json` is treated as disposable cache-like state. The architecture favors a text-first index and local recomputation over a more complex persistent state store.

## Testing Strategy

- Unit tests cover TOML parsing, search ranking, add UX helpers, help text, pinning, and git wrappers
- Runtime tests cover hook loading, state recovery, reconciliation, cleanup, and sync behavior
- Lock tests cover contention timeouts and stale-lock recovery
- Optional e2e coverage exists for a real remote clone when explicitly enabled by environment variable

## Implementation Pointers

- CLI entry: `src/cli.ts`
- MCP entry: `src/mcp.ts`
- Core behavior: `src/index.ts`
- Runtime lock: `src/lock.ts`
- Search engine: `src/search.ts`
- Tests: `test/*.test.ts`
