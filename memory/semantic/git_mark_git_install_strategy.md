---
summary: "git-mark installs from git by shipping TS source plus JS bin wrappers that run through bundled tsx at runtime"
created: 2026-03-22
updated: 2026-03-22
memory_type: semantic
tags: [code, packaging, npm, pnpm, git-install, typescript, tsx, cli]
---

# git-mark git install strategy

`git-mark` is made installable directly from GitHub for both `npm` and `pnpm` by avoiding install-time builds entirely.

## Current truth

- `package.json` exposes three bins: `git-mark`, `gmk`, and `git-mark-mcp`
- The bins point to plain CommonJS wrapper files in `bin/`
- The wrappers do not execute built `dist/` output
- The wrappers resolve `tsx` from the installed package with `require.resolve('tsx/cli')`
- The wrappers spawn `node <resolved tsx cli> <src entry.ts> ...args`
- The package ships `bin/` and `src/` in the published/git-installed files list
- The package has no `prepare` script and no script literally named `build`
- `tsx` is a runtime dependency

## Why this was necessary

- Node 24+ would not strip TypeScript under installed `node_modules`
- Git-hosted installs triggered temp-directory rebuild behavior whenever `build`/`prepare` style scripts were present
- Nested bootstrap attempts with `tsc` or `npx typescript` inside git-install temp directories were unreliable on Windows with `pnpm` + `npm`
- Running TS directly through bundled `tsx` at runtime avoided all install-time build problems

## Installed command shape

- `git-mark` -> `./bin/gmk.cjs`
- `gmk` -> `./bin/gmk.cjs`
- `git-mark-mcp` -> `./bin/git-mark-mcp.cjs`

## Important implementation detail

Do not use `node --import tsx ...` in the installed wrapper with a bare `tsx` specifier. In global installs, Node may try to resolve `tsx` from the caller's current directory instead of the installed package location. The reliable pattern is resolving `tsx/cli` inside the wrapper with `require.resolve(...)` and spawning Node with that absolute path.
