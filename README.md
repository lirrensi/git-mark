# git-mark

`git-mark` is a CLI-first bookmark manager for git-backed resources, built for coding-agent workflows. ✨

It exists to give an agent a portable, searchable list of resources that may be useful right now, without forcing all of them into active context at once. Prompts, skills, docs, templates, scripts, reference repos, asset collections, and repo subpaths can all live in one local index. The agent sees what is pinned by default, can search the broader catalog when needed, and can materialize any matching resource into a filesystem path on demand.

The bookmark catalog matters because it is the control layer for agent resource visibility. The point is not just "save links for later." The point is "keep a broad resource universe available to an agent, while only surfacing the right subset by default."

Why that matters: most agents are great at using resources once they can see them, but bad at carrying a huge universe of possible resources in active context all the time. `git-mark` gives you a calmer model: keep the universe large, keep the default surfaced set small, and load the rest only when it is actually relevant. 🧠

## Why this exists

- I want to have 1000 various skills, tools and resources available
- I want my context to NOT nope out
- Current harness implementations load them all in context with bad discovery - it scales bad over 10 of anything
- SKILL.md itself is limited to mostly text only, does not feel like true universal "everything just a folder"
- Bit git already is. While we dont have a good solution to expose a folder over http in a clean way, git allows closest to a package-like entity 
- Your agent can already browse a folder and treat anything inside as a resource.
- **Idea**: treat ANY .git as a resource you can bookmark and load on demand + discover.
- **Solution**: take misAnthropics [Tool search tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) and apply this idea to skills and resources 


## Why this works
- Many useful agent resources already live in git, but most agent hosts only have a flat always-on context model.
- A bookmark is the right abstraction for that: "this repo or subpath exists, here is what it is for, and here is how visible it should be."
- Coding agents and local tools work best when they can get a filesystem path, not just a URL.
- Resources are not permanent - you can use it once a month and NOT pollute your file system and sneaking in every session.

In short: browser bookmarks made sense for humans on the web; `git-mark` does the same kind of job for agents working with git-backed resources. 🔖

`git-mark` is not a package manager, registry, or dependency solver. It is a local resource catalog plus a reliable way to expose git-backed materials to agents and tools as usable local paths.

## Core idea

- Canonical package truth lives in `~/.gitmarks.toml`.
- Runtime policy lives in `~/.gitmark/config.toml`.
- Clones, temp directories, logs, and runtime state are derived and rebuildable.
- The CLI is the primary interface.
- MCP support is a thin wrapper over the same CLI surface.

That means the important thing to back up or sync is your resource index, not the tool-managed clones.

## Principles

- Local-first: discovery uses local metadata, not a hosted search service.
- Agent-oriented: the catalog controls what is visible by default versus only discoverable on demand.
- Git-native: resources can be full repos or repo subpaths.
- Text-first truth: bookmarks live in plain TOML you can inspect and edit.
- Rebuildable runtime: materialized clones are cache-like working state.
- Thin integrations: wrappers should delegate to the CLI instead of re-implementing behavior.

## Install

Requirements:

- Node.js 24+
- `git` on your `PATH`

Git-based installs now run the TypeScript entrypoints through bundled `tsx` at runtime, so git installs do not need an install-time build step.

### npm

Install globally from GitHub:

```bash
npm install -g github:lirrensi/git-mark
gmk help
git-mark help
```

### pnpm

```bash
pnpm add -g github:lirrensi/git-mark
gmk help
git-mark help
```

After a global install, the MCP server binary is still `git-mark-mcp`.

Run it once with `npx` without a global install:

```bash
npx --package github:lirrensi/git-mark gmk help
```

Run the MCP server once with `npx` without a global install:

```bash
npx --package github:lirrensi/git-mark git-mark-mcp
```

From this repository:

```bash
npm install
node bin/gmk.cjs help
node --import tsx src/mcp.ts
```

Available binaries:

- `git-mark` - full command alias for the CLI entry point
- `gmk` - CLI entry point
- `git-mark-mcp` - MCP server entry point

## Quick start

Add a resource, inspect it, and load it:

```bash
gmk add github.com/you/mega-repo#skills/design
gmk list
gmk peek design
gmk load design
```

Search locally across your bookmark metadata:

```bash
gmk search design
gmk search prompt --limit 5
```

Ask for the current materialized path without reloading:

```bash
gmk path design
```

Pin, update, or freeze a bookmark:

```bash
gmk pin design
gmk update design
gmk freeze design
gmk unfreeze design
```

Maintain runtime state:

```bash
gmk doctor
gmk cleanup
gmk sync
```

## Getting started

The fastest way to make `git-mark` useful is to add the resources you reach for repeatedly. Start small, make the descriptions good, and let the catalog become smarter over time. 🌱

Start with a few favorites:

- your main prompts repo
- your skill collection repo or a specific skill subpath
- reference docs you keep cloning repeatedly
- templates, scripts, or design/reference libraries
- large "mega repos" registered by subpath instead of only at repo root

Example starter session:

```bash
gmk add github.com/you/agent-stuff#skills/design --yes
gmk add github.com/you/agent-stuff#prompts/review --yes
gmk add github.com/you/docs-playground --yes
gmk list
```

Then improve the entries that matter most:

- add a clear `summary` so pinned listings are readable
- add a stronger `description` so search is meaningful for the agent
- add `--resource` notes when you want to describe what is inside semantically
- pin the resources the agent should see by default
- keep the resources that should stay available locally

Example with explicit metadata:

```bash
gmk add github.com/you/mega-repo#design/landing-pages \
  --id landing-design \
  --summary "Landing-page design references" \
  --description "Examples, templates, and visual references for landing-page layout, hierarchy, and CTA treatment." \
  --resource "layout examples" \
  --resource "landing page templates" \
  --resource "visual references" \
  --yes
```

Once you have a handful of good entries, `gmk list`, `gmk search`, and `gmk load` become the normal discovery loop.

That is the real payoff: instead of re-explaining where things live, re-cloning the same repo, or stuffing giant inventories into prompts, the agent gets a small visible set plus a larger searchable universe. 💫

## How to think about a bookmark

Each bookmark is a package record with a stable local `id` and one or more git remotes.

You can think of it as a browser bookmark for an agent resource, with a little extra policy attached.

A record can point at:

- a whole repository
- a specific `subpath` inside a repository

Useful record flags:

- `pinned` - visible to the agent by default, shows up in the default `gmk list` view, and appears in the MCP tool description
- `kept` - keeps a stable managed clone on disk instead of relying only on temp materialization
- `discoverable` - allows the record to appear in `gmk search`
- `frozen` - pins the record to a specific commit and skips it during `gmk updateall`

Those flags are intentionally orthogonal:

- `pinned` answers "should this be surfaced by default?"
- `kept` answers "should a local copy be kept around?"

That separation is important for agent workflows. A resource may be globally visible but not kept locally, or kept locally without being part of the default surfaced set.

## Command overview

Main commands:

```text
gmk add <remote[#subpath]> [--id <id>] [--summary <text>] [--description <text>] [--resource <text>] [--yes]
gmk list
gmk list-all [--limit <n>] [--offset <n>]
gmk search <query> [--limit <n>] [--offset <n>]
gmk peek <id>
gmk load <id>
gmk path <id>
gmk pin <id>
gmk unpin <id>
gmk update <id>
gmk updateall
gmk freeze <id>
gmk unfreeze <id>
gmk remove <id>
gmk rm <id>
gmk doctor
gmk cleanup
gmk sync
gmk edit
gmk help
```

What they are for:

- `add` stores a new bookmark from a git remote or remote subpath.
- `list` shows pinned bookmarks; `list-all` pages through everything.
- `search` does local lexical search over ids and metadata.
- `peek` inspects a bookmark before you load it.
- `load` materializes the resource and returns a usable local path.
- `path` returns the current local path only if already materialized.
- `pin` and `unpin` control what surfaces by default.
- `update` and `updateall` refresh materialized bookmarks.
- `freeze` and `unfreeze` control commit pinning.
- `remove` / `rm` delete a bookmark and reconcile local derived state.
- `doctor`, `cleanup`, and `sync` keep runtime state healthy.
- `edit` opens `~/.gitmarks.toml` in your editor.

## Add and load examples

Non-interactive add with defaults:

```bash
gmk add github.com/acme/agent-library#skills/review --yes
```

Add with explicit metadata:

```bash
gmk add github.com/acme/agent-library#prompts/oncall \
  --id oncall-prompts \
  --summary "Operational prompts for on-call work" \
  --description "Reusable incident and handoff prompts stored in the agent-library repo." \
  --resource prompts \
  --resource incidents \
  --yes
```

Inspect before loading:

```bash
gmk peek oncall-prompts
```

Load and use the returned path:

```bash
RESOURCE_PATH="$(gmk load oncall-prompts)"
printf '%s\n' "$RESOURCE_PATH"
```

## Runtime files

- Index: `~/.gitmarks.toml`
- Config: `~/.gitmark/config.toml`
- Logs: `~/.gitmark/history.log`
- State: `~/.gitmark/state.json`

By default, kept repos live under the runtime storage root and temp materializations live under the temp root. Those locations are derived runtime state, not canonical data.

## Coding-agent usage

The simplest integration for coding agents is still the CLI.

The intended model is:

- the agent sees pinned resources by default
- the agent can search the wider catalog when it needs something more specific
- `load` turns a selected resource into a local filesystem path
- the agent then uses normal file tools against that path

Typical agent pattern:

1. discover with `gmk list` or `gmk search <query>`
2. inspect with `gmk peek <id>` when needed
3. materialize with `gmk load <id>`
4. read files from the returned local path with normal filesystem tools

Example:

```bash
gmk search design
gmk peek design
gmk load design
```

This works well because `git-mark` returns filesystem paths instead of inventing a custom content API.

In other words, `git-mark` is the layer that helps an agent know what exists and where to look. The actual reading still happens through ordinary filesystem access.

That is why the tool stays intentionally thin: it does not try to become a new content protocol, package format, or giant integration surface. It just makes resources visible, searchable, and loadable at the moment they are needed. 🛠️

## Integrating with coding agents

There are three practical integration levels.

### 1. MCP: the simple default

If your agent host supports MCP, use the shipped MCP server first. This is the easiest path and usually the nicest one. 🌸

Why this is the best default:

- no host-specific plugin work
- one tool surface for `list`, `search`, `peek`, `load`, and maintenance commands
- pinned resources show up in the MCP tool description automatically
- the agent can search and load resources on demand instead of carrying everything in prompt text

Typical setup shape:

- start `git-mark-mcp`
- register it in your MCP-capable host
- let the host expose the `git_mark` tool to the agent

Once connected, the host can call commands like:

```json
{ "command": "list" }
{ "command": "search design" }
{ "command": "peek landing-design" }
{ "command": "load landing-design" }
```

### 2. Skill or system-prompt integration

If your agent host supports custom skills, prompts, or reusable instructions, install the skill in `skills/git-mark/SKILL.md` or adapt its wording into your system prompt.

The goal of the skill is simple:

- remind the agent that `git-mark` exists as a resource catalog
- tell it when to check pinned resources first
- tell it when to search instead of cloning ad hoc
- tell it to use `load` before reading files

This works well even without MCP if the host can run shell commands or if you are willing to prompt the agent explicitly, for example:

```text
Use git-mark whenever reusable resources may already exist. Check pinned resources first, search when needed, then load the selected resource and read files from the returned path.
```

This is the lightest-weight non-MCP integration and works surprisingly well.

Why use this path: sometimes you do not need deep tooling integration yet. You just need the agent to remember that a reusable catalog exists and to check it before wandering off to rediscover everything from scratch. 🧭

### 3. Native plugin or direct adoption

If you are building your own agent host, the long-term integration is to treat `git-mark` as a native resource layer alongside your skill system.

That usually means one of:

- call the CLI directly from your host code
- wrap the same behavior in your own plugin layer
- reuse the MCP tool contract and adapt it into your host's internal tool system

The important part is not the transport. The important part is the model:

- pinned resources are the default surfaced set
- the wider catalog is searchable but not always injected
- `load` resolves a resource into a filesystem path
- normal file tooling handles the actual reading afterward

That model is what keeps the resource universe broad without making agent context noisy.

Why build this deeper version: if you control the host, `git-mark` can become a first-class resource layer sitting right beside skills, tools, and workspace files instead of being "just another command." 🧩

## MCP integration

`git-mark` also ships a single-tool MCP server for hosts that prefer MCP.

The integration story is intentionally minimal:

- one MCP tool: `git_mark`
- one input payload field: `command`
- that field contains the same CLI-style string you would type after `gmk`

So MCP is not a parallel command model. It is a transport wrapper around the CLI.

That is the key design choice: one tool, one string payload, one shared behavior surface.

The MCP layer exists so an agent host can treat `git-mark` as another resource source, alongside its built-in skills or tools, without needing a custom resource protocol.

### Why a single-tool MCP wrapper

- It keeps the MCP schema small.
- It avoids duplicating command logic in a second interface.
- It lets CLI improvements carry through to MCP automatically.
- The `command` field acts as both instruction and payload transport.

### MCP examples

Start the server:

```bash
git-mark-mcp
```

If you are running from the repo for local development instead of an installed binary:

```bash
node bin/git-mark-mcp.cjs
```

The advertised tool is `git_mark` with an input shape like:

```json
{ "command": "search design" }
```

More examples:

```json
{ "command": "list" }
{ "command": "peek design" }
{ "command": "load design" }
{ "command": "path design" }
```

What comes back is text output from the CLI, with MCP marking the call as an error if the underlying CLI command exits non-zero.

The tool description also includes a compact view of currently pinned bookmarks so agents can see likely-useful resources before making a call.

## Suggested agent rollout

If you are adopting `git-mark` for yourself or a team, a simple rollout looks like this:

1. add 5-15 resources you already reuse often
2. clean up descriptions so search works well
3. pin only the small set the agent should see by default
4. connect MCP where supported
5. install or adapt the skill for hosts that do not support MCP cleanly
6. only build native integrations if you need deeper host-specific behavior

Nice and gradual. No giant migration ceremony required. 🐾

## Operational notes

- `gmk add` is interactive in a TTY unless you pass `--yes`.
- `gmk list` shows pinned records; use `gmk list-all` for the full catalog.
- `gmk search` excludes records with `discoverable = false`.
- `gmk path <id>` does not clone or fetch; it only reports an existing materialized path.
- Tool-managed updates are destructive inside managed clones; do not treat those directories as durable editing worktrees.
- A returned subpath is a convenience entry point inside a full clone, not an isolation boundary.

## What `git-mark` is not

- not a package registry
- not a dependency manager
- not a publish workflow
- not semantic search or embeddings
- not a multi-tool MCP API with one tool per command
- not a system for stuffing every known resource into active agent context at once

## Development

Useful local commands from this repo:

```bash
npm install
npm test
npm run typecheck
npm run mcp
```

The implementation is a Node.js + TypeScript codebase with a shared CLI core and a thin MCP adapter. See `docs/product.md`, `docs/spec.md`, and `docs/arch.md` for the fuller canon.
