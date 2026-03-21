---
name: git-mark
description: Use this skill when the user may already have reusable git-backed resources available through git-mark, or when they want to register, inspect, search, pin, load, update, or organize such resources for coding-agent workflows.
---

# git-mark

`git-mark` is the agent's resource catalog for git-backed materials. ✨

Use it to answer questions like:

- what reusable resources already exist
- which resources are pinned and should be considered first
- whether a useful repo or repo subpath is already registered
- where a selected resource lives on disk after loading
- whether a missing resource should be added to the catalog

The point is not to stuff everything into active context.
The point is to keep a broad resource universe available, surface only the right subset by default, and load the rest on demand.

Why this exists: agents are often good at using a resource once they can see it, but bad at carrying a huge universe of possible resources in active context all the time. `git-mark` gives the agent a calmer way to work: keep a small default surfaced set, keep the larger catalog searchable, and materialize the exact thing needed only when it becomes relevant. 🧠

## When to use this skill

Use `git-mark` when the task involves reusable resources that may already live in git, especially:

- prompts
- skills
- templates
- documentation repos
- reference repos
- scripts or helper tooling
- asset libraries
- specific folders inside larger repos

Reach for `git-mark` when:

- the user mentions a repo, library, prompt set, docs collection, or reusable asset set they use repeatedly
- the user wants the agent to check what resources are already available
- the user wants to add a repo or repo subpath as a reusable resource
- the agent would otherwise do an ad hoc clone of something that may belong in the shared catalog

## How to think about it

Treat `git-mark` as a layer alongside:

- built-in tools
- MCP tools
- installed skills
- workspace files

Those other systems tell you what actions you can take.
`git-mark` tells you what reusable external materials already exist and how to reach them.

Think of it like bookmarks for an agent, not bookmarks for browsing. The value is not just saving links. The value is making a large resource universe available without turning every session into a cluttered mess. 🔖

## Default workflow

When `git-mark` is relevant, follow this order:

1. check surfaced resources with `gmk list`
2. if the exact resource is unknown, search with `gmk search <query>`
3. inspect likely matches with `gmk peek <id>`
4. materialize the chosen one with `gmk load <id>`
5. use normal file tools against the returned path

If the needed resource does not exist yet:

1. add it with `gmk add <remote[#subpath]>`
2. include good metadata if known
3. pin it only if it should be surfaced by default

## Operating rules

- prefer `git-mark` before one-off cloning when the resource is something reusable
- prefer pinned entries as the default surfaced set
- use search when the exact id is not known
- use `peek` before `load` when several matches are plausible
- use `load` when you need actual files
- after loading, switch back to ordinary filesystem tools
- write clear summaries and descriptions when adding resources so future searches work well

## What the flags mean

- `pinned`: surfaced by default to the agent
- `kept`: local copy is kept around
- `discoverable`: included in search results
- `frozen`: locked to a commit until unfrozen

Important: `pinned` and `kept` are different.

- `pinned` answers visibility
- `kept` answers storage

A resource may be visible by default without being kept locally, or kept locally without being part of the default surfaced set.

## Recommended agent behavior

Good times to use `git-mark`:

- before cloning a repo just to inspect docs or examples
- when the user says "I have a repo for that" or "I keep this in git"
- when the user wants a persistent catalog of reusable resources
- when a project depends on prompts, templates, or references stored outside the current workspace

Do not overuse it:

- do not search the catalog for every tiny workspace-local task
- do not add random one-off repos unless the user wants them kept as reusable resources
- do not treat tool-managed clones as durable editing worktrees

Keep it friendly and practical: if `git-mark` can save the user from re-explaining where something lives or save you from recloning the same repo again, it is probably the right tool. 🌼

## Useful commands

```bash
gmk list
gmk list-all
gmk search design
gmk search prompts --limit 5
gmk peek landing-design
gmk load landing-design
gmk path landing-design
gmk add github.com/acme/agent-library#skills/review --yes
gmk pin landing-design
gmk update landing-design
gmk freeze landing-design
```

## Suggested instruction to pair with this skill

```text
Use git-mark whenever reusable git-backed resources may already exist. Check pinned resources first, search the wider catalog when needed, inspect likely matches, then load the selected resource and read files from the returned path.
```

## One-line summary

Use `git-mark` as the agent's catalog of reusable git-backed resources: see what is surfaced by default, search the wider index when needed, load the chosen resource to a filesystem path, and add missing resources so they become reusable later.
