---
summary: "Pattern for making a TypeScript CLI and MCP entrypoint installable from git with npm and pnpm without committing build artifacts, plus the local tarball workflow for testing global installs"
created: 2026-03-22
updated: 2026-03-22
memory_type: procedural
tags: [code, packaging, workflow, npm, pnpm, git-install, typescript, tsx, cli]
---

# How to make a TS CLI installable from git

Use this when a TypeScript CLI or MCP entrypoint must be installable directly from a git URL before proper npm packaging exists, and when local global-install testing is needed before publishing.

## Goal

Make `npm install -g github:user/repo` and `pnpm add -g github:user/repo` work without committed `dist/` artifacts and without install-time compilation.

## Procedure

1. Keep the actual application entrypoints in TypeScript under `src/`, for example `src/cli.ts` and `src/mcp.ts`.
2. Add `tsx` to `dependencies`.
3. Create tiny plain-JS or `.cjs` bin wrappers under `bin/`.
4. In each wrapper:
   - add `#!/usr/bin/env node`
   - resolve the local installed `tsx` CLI with `require.resolve('tsx/cli')`
   - compute the matching TS entry file path with `path.join(__dirname, '..', 'src', ...)`
   - run `spawnSync(process.execPath, [resolvedTsxCli, entryFile, ...process.argv.slice(2)], { stdio: 'inherit' })`
   - if `result.error` exists, print it and exit `1`
   - otherwise exit with `result.status ?? 0`
5. Point `package.json` `bin` entries at those wrapper files.
6. Include `bin` and `src` in `package.json` `files`.
7. Remove install-time rebuild triggers from `package.json`:
   - no `prepare`
   - no script literally named `build`
   - avoid `prepack`, `preinstall`, `install`, `postinstall` unless absolutely required
8. If future compilation is still needed later for packaging, keep a non-triggering script name like `compile` and a `typecheck` script.
9. If an MCP entrypoint shells into the CLI, make that delegation use the same `tsx` launch principle instead of `node --experimental-strip-types`.
10. For MCP tool schemas, keep the schema boring and compatible:
   - top-level `type: object`
   - top-level `properties`
   - `action` property with an enum
   - no top-level `oneOf`, `anyOf`, or `allOf`
11. Verify with:
   - direct local wrapper execution
   - packed tarball inspection/execution
   - real git install once pushed

## Local testing workflow before publishing

Use this when you want to test the install exactly like a package install without publishing and without relying on `pnpm add -g .`.

1. From the repo root, create a tarball:
   - `npm pack --silent`
2. Install that tarball globally with an absolute path:
   - PowerShell: `$pkg = (npm pack --silent).Trim(); pnpm add -g "$PWD\$pkg"`
   - if replacing an existing install: `pnpm remove -g git-mark` first
3. Restart the client or shell that resolves `git-mark-mcp`.
4. Test the installed MCP tool through the real client, not just by launching the server process manually.

### Important note about the "dirty gzip hack"

The tarball workflow is the reliable local-package test path.

- `pnpm add -g .` is a directory-source install and can behave like a link/local filesystem source rather than a normal named package install
- a packed `.tgz` is treated like a real package artifact and preserves the package name correctly
- with `pnpm -g`, use an absolute tarball path; relative paths may be resolved from pnpm's global directory instead of the repo root

## Recommended package.json shape

- `bin` should expose the real names and any aliases users want
- `dependencies` should include `tsx`
- `files` should include `bin`, `src`, `README.md`, `LICENSE`
- dev scripts can still use `node --import tsx src/cli.ts`
- compile scripts should use names like `compile`, not `build`
- MCP schemas should use a simple object with `action` enum instead of schema composition

## Why this works

- git installs no longer need to rebuild the package in temp directories
- package managers only need to install dependencies and link bin files
- runtime TS execution is handled by bundled `tsx`

## Known pitfalls

- Bare `--import tsx` in a global wrapper can resolve from the wrong directory
- A script named `build` can be enough to trigger git rebuild behavior
- Node built-in strip-types does not solve installed-TS-in-`node_modules` cases reliably
- Nested `npx` or `tsc` bootstrapping during git installs is fragile, especially on Windows
- `pnpm add -g .` is not a trustworthy stand-in for a real global package install
- MCP clients may reject fancy JSON Schema composition before any tool call reaches the server

## git-mark concrete example

- `git-mark` and `gmk` both point to `bin/gmk.cjs`
- `git-mark-mcp` points to `bin/git-mark-mcp.cjs`
- wrappers launch `src/cli.ts` and `src/mcp.ts` through resolved `tsx/cli`
- `src/mcp.ts` must also launch delegated `src/cli.ts` through resolved `tsx/cli`
- README install commands are plain:
  - `npm install -g github:lirrensi/git-mark`
  - `pnpm add -g github:lirrensi/git-mark`

## Fast local verification checklist

1. Run `git-mark-mcp` after global tarball install to confirm the process starts.
2. Connect the real MCP client.
3. If the client rejects the server before calling a tool, inspect the advertised input schema first.
4. Call `{"action":"list"}` through the real client.
5. If the tool call fails, confirm the returned error includes the original stderr text from the delegated CLI.
