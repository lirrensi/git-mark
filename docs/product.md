# git-mark Product Canon

## Overview

`git-mark` is a bookmark manager for git-backed resources. It lets a user keep a portable personal catalog of useful repositories or repository subpaths, search that catalog locally, inspect entries before use, and materialize only the resources they need onto the local machine.

The product exists for people who regularly reuse prompts, skills, docs, templates, scripts, reference repos, or other git-hosted materials but do not want a heavyweight registry, package publishing workflow, or dependency manager. The durable truth is the bookmark index in `~/.gitmarks.toml`; the local clones, temp directories, and runtime state are rebuildable cache-like derivatives.

## Target Users

- Individual developers and agent users who curate a personal library of git-hosted resources
- People who want a dotfile-like, portable index rather than a central service
- Workflows that need direct filesystem access to fetched materials after discovery

## Core Capabilities

- Track resources as bookmark records in a TOML index, using a stable local `id`
- Point a record at either a whole repository or a specific subpath within one repository
- Distinguish surfaced favorites (`pinned`) from storage policy (`kept`)
- Search bookmarks locally with lexical ranking across ids and metadata
- Inspect a resource with compact metadata, file preview, and README excerpt before loading it
- Materialize a resource on demand and return a usable local path
- Keep stable managed clones for kept resources and disposable temp clones for temp resources
- Freeze a record to a specific commit and skip it during bulk updates
- Expose the same CLI surface through a thin single-tool MCP wrapper

## Main User Flows

### Build a bookmark catalog

The user adds a git remote, optionally with a subpath. `git-mark` inspects the source, suggests metadata, and writes a package record to `~/.gitmarks.toml`. In interactive mode it asks for summary, description, resources, default surfacing, storage mode, and search visibility.

### Browse what is already known

The user runs `gmk list` to see pinned favorites, `gmk list-all` to page through the full catalog, or `gmk search <query>` to find relevant bookmarks by local lexical search.

### Inspect before materializing

The user runs `gmk peek <id>` to see record metadata, a small visible-tree preview, and either an explicit description or a README excerpt. This supports deciding whether a resource is worth loading.

### Materialize and use a resource

The user runs `gmk load <id>`. If the record is kept, `git-mark` ensures a stable managed clone exists under its runtime storage root. If the record is temp-only, it materializes a disposable temp clone. The command returns the repo root or selected subpath so the caller can read files directly with normal filesystem tools.

### Maintain local materializations

The user can ask for the current path with `gmk path <id>`, refresh materialized resources with `gmk update <id>` or `gmk updateall`, pin or unpin surfaced entries, freeze or unfreeze records, clean temp state with `gmk cleanup`, reconcile kept materializations with `gmk sync`, inspect health with `gmk doctor`, or remove a record with `gmk remove` / `gmk rm`.

### Use from an MCP host

An MCP host can call one `git_mark` tool that accepts a single CLI-style command string. The tool description includes a compact view of the currently pinned resources so agent workflows can discover likely-useful bookmarks without a custom integration layer.

## System Shape

- Canonical bookmark truth lives in `~/.gitmarks.toml`
- Runtime behavior is configured through `~/.gitmark/config.toml`
- Managed local data lives under the runtime storage root, including kept repos, temp materializations, state, logs, and the writer lock
- The CLI is the primary interface
- A thin MCP wrapper delegates to the CLI instead of re-implementing command logic
- Git is the external transport and storage protocol for all bookmarked resources

## Design Principles

- TOML-first truth over service-managed state
- Git-backed resources without requiring author-side manifests
- Local-first discovery with no embedding service or remote search dependency
- Rebuildable runtime state: indexes and config are user truth; materializations are disposable derivatives
- Convenience entry points rather than strong isolation boundaries when a subpath is selected

## Non-Goals

- Dependency resolution, version solving, or package-manager semantics
- A package registry, publish flow, or author cooperation requirement
- Semantic search, embeddings, or external search services
- Automatic background syncing or daemon behavior
- Stable editable working copies inside tool-managed clones
- A multi-tool MCP surface with one tool per command
- A GUI in the current product
