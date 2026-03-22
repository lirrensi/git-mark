---
summary: "git-mark installs from git by shipping TS source plus JS bin wrappers that run through bundled tsx at runtime, and MCP tool calls must delegate through the same tsx path"
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
- The MCP server uses the official MCP SDK
- MCP tool calls must delegate to `src/cli.ts` through the same `tsx` launch strategy as `bin/gmk.cjs`
- The MCP input schema must stay a plain top-level object with `action` as a property enum, not a top-level `oneOf` / `anyOf` / `allOf`

## Why this was necessary

- Node 24+ would not strip TypeScript under installed `node_modules`
- Git-hosted installs triggered temp-directory rebuild behavior whenever `build`/`prepare` style scripts were present
- Nested bootstrap attempts with `tsc` or `npx typescript` inside git-install temp directories were unreliable on Windows with `pnpm` + `npm`
- Running TS directly through bundled `tsx` at runtime avoided all install-time build problems
- The MCP server originally worked as a process but failed real client handshakes until it was migrated off a hand-rolled protocol implementation and onto the official SDK
- The MCP server originally advertised a top-level `oneOf` input schema, which some clients rejected before they would even call the tool
- After SDK migration, MCP tool execution still failed under global installs until delegated CLI execution switched from `--experimental-strip-types` to the same `tsx` runtime path used by the installed bins

## Installed command shape

- `git-mark` -> `./bin/gmk.cjs`
- `gmk` -> `./bin/gmk.cjs`
- `git-mark-mcp` -> `./bin/git-mark-mcp.cjs`

## Important implementation detail

Do not use `node --import tsx ...` in the installed wrapper with a bare `tsx` specifier. In global installs, Node may try to resolve `tsx` from the caller's current directory instead of the installed package location. The reliable pattern is resolving `tsx/cli` inside the wrapper with `require.resolve(...)` and spawning Node with that absolute path.

## MCP-specific truth

- The exposed MCP tool name is `git_mark`
- The supported action payloads are `list`, `search`, `peek`, and `load`
- The advertised schema should be compatible with strict clients:
  - top-level `type: "object"`
  - top-level `properties`
  - `action` property with `enum: ["list", "search", "peek", "load"]`
  - no top-level `oneOf`, `anyOf`, or `allOf`
- Conditional validation stays server-side:
  - `search` requires `query`
  - `peek` and `load` require `id`
- Tool errors should preserve real stderr/stdout text so client-side failures are understandable
