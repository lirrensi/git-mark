---
summary: "Pattern for making a TypeScript CLI installable from git with npm and pnpm without committing build artifacts"
created: 2026-03-22
updated: 2026-03-22
memory_type: procedural
tags: [code, packaging, workflow, npm, pnpm, git-install, typescript, tsx, cli]
---

# How to make a TS CLI installable from git

Use this when a TypeScript CLI must be installable directly from a git URL before proper npm packaging exists.

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
9. Verify with:
   - direct local wrapper execution
   - packed tarball inspection/execution
   - real git install once pushed

## Recommended package.json shape

- `bin` should expose the real names and any aliases users want
- `dependencies` should include `tsx`
- `files` should include `bin`, `src`, `README.md`, `LICENSE`
- dev scripts can still use `node --import tsx src/cli.ts`
- compile scripts should use names like `compile`, not `build`

## Why this works

- git installs no longer need to rebuild the package in temp directories
- package managers only need to install dependencies and link bin files
- runtime TS execution is handled by bundled `tsx`

## Known pitfalls

- Bare `--import tsx` in a global wrapper can resolve from the wrong directory
- A script named `build` can be enough to trigger git rebuild behavior
- Node built-in strip-types does not solve installed-TS-in-`node_modules` cases reliably
- Nested `npx` or `tsc` bootstrapping during git installs is fragile, especially on Windows

## git-mark concrete example

- `git-mark` and `gmk` both point to `bin/gmk.cjs`
- `git-mark-mcp` points to `bin/git-mark-mcp.cjs`
- wrappers launch `src/cli.ts` and `src/mcp.ts` through resolved `tsx/cli`
- README install commands are plain:
  - `npm install -g github:lirrensi/git-mark`
  - `pnpm add -g github:lirrensi/git-mark`
