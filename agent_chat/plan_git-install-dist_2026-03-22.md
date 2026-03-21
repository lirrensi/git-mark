# Plan: Ship built JavaScript for git installs
_Done looks like `git-mark` installs from git with `npm` and `pnpm` without executing TypeScript from `node_modules`, and the README documents the install commands including the `pnpm` build-approval note._

---

# Checklist
- [x] Step 1: Emit distributable JavaScript into `dist`
- [x] Step 2: Point package entry points at built files
- [x] Step 3: Document git install commands for `npm` and `pnpm`
- [x] Step 4: Verify pack output and local execution

---

## Context
- Repository root: `C:\Users\rx\001_Code\101_DevArea\GitMark`
- The current executable entry points are `bin/gmk.js` and `bin/git-mark-mcp.js`.
- The current bin files import `../src/cli.ts` and `../src/mcp.ts` directly.
- `package.json` currently publishes `src/` and does not publish built JavaScript.
- `tsconfig.json` currently has `"noEmit": true`, so `pnpm build` cannot create runtime files.
- The install failure happens because Node 24+ refuses TypeScript stripping for files inside installed `node_modules` paths.
- The README install section lives in `README.md`.

## Prerequisites
- Run all commands from `C:\Users\rx\001_Code\101_DevArea\GitMark`.
- Node.js and `pnpm` must already be installed.
- Do not delete user changes outside the files named in this plan.
- If `agent_chat/` does not exist, create `agent_chat/` before saving any additional artifacts.

## Scope Boundaries
- Do not edit files under `docs/` for this task.
- Do not edit files under `src/` unless a TypeScript compiler setting requires a minimal entry-point adjustment.
- Do not change application behavior of CLI commands.
- Do not add new runtime dependencies such as `tsx`.

---

## Steps

### Step 1: Emit distributable JavaScript into `dist`
Open `tsconfig.json`. Replace the current compiler options so TypeScript emits JavaScript files into `dist/` while keeping Node ESM behavior. Keep `target`, `module`, `moduleResolution`, `strict`, `allowImportingTsExtensions`, `verbatimModuleSyntax`, and `skipLibCheck` only if they remain valid with emitting enabled. Remove `"noEmit": true`. Add compiler options required for emit output, including `"outDir": "dist"`, `"rootDir": "src"`, and any option needed so `.ts` extension imports in source are rewritten correctly for Node ESM output. Keep the `include` array limited to `src/**/*.ts` and `test/**/*.ts` unless the compiler rejects that shape. If the compiler rejects including tests while `rootDir` is `src`, change `include` to only `src/**/*.ts` and leave tests to the existing `node --experimental-strip-types --test` script.

✅ Success: Running `pnpm build` creates `dist/cli.js`, `dist/mcp.js`, and JavaScript output for the rest of the runtime modules without TypeScript compiler errors.
❌ If failed: Read the compiler error text. Make the smallest possible `tsconfig.json` adjustment to satisfy the compiler without changing runtime behavior. Re-run `pnpm build`. If `pnpm build` still fails after `tsconfig.json` changes, stop and report the exact compiler error.

### Step 2: Point package entry points at built files
Open `package.json`. Change the `bin` entries so `gmk` points to `./dist/cli.js` and `git-mark-mcp` points to `./dist/mcp.js`. Change the `build` script to use `tsc -p tsconfig.json` without a hard-coded `node_modules/typescript/bin/tsc` path. Add a `prepare` script that runs the build command so git-based installs build automatically. Keep `typecheck` as a no-emit compiler run. Keep `dev`, `start`, `mcp`, and `test` on the current TypeScript-based local-development flow unless a package-script reference must change. Change the `files` array so published or packed output includes `dist`, `README.md`, and `LICENSE`, and no longer includes `src` or `bin`. Leave `package.json` `type` as `module`. After editing `package.json`, delete `bin/gmk.js` and `bin/git-mark-mcp.js` because the package will no longer use those wrappers. Open `src/mcp.ts` and change the CLI child-process target so the development entry path remains `src/cli.ts` when `src/mcp.ts` is executed directly, but the built entry path becomes `dist/cli.js` when `dist/mcp.js` is executed from a packed or installed package.

✅ Success: `package.json` references only built executables in `dist/`, `prepare` exists, the obsolete wrapper files are removed, and `dist/mcp.js` invokes `dist/cli.js` instead of `cli.ts`.
❌ If failed: If deleting `bin/` files causes another file in the repository to reference those paths, restore only the needed wrapper file and change its contents to import from `../dist/...js`. Then continue. If `package.json` becomes invalid JSON, correct the syntax and re-open the file before continuing. If `dist/mcp.js` still points at `cli.ts` after a rebuild, re-open `src/mcp.ts`, change the computed CLI filename logic, rebuild, and do not continue until the emitted file points at `cli.js`.

### Step 3: Document git install commands for `npm` and `pnpm`
Open `README.md`. In the install section, replace the existing global-install guidance so it explains that git installs now build during install. Keep the `npm` example for global install from GitHub. Add a separate `pnpm` subsection with the exact command sequence needed for a git-based global install when `pnpm` requires approval for build scripts. Document the standard install command first. Immediately after that, add the follow-up approval command a user may need if `pnpm` blocks the `prepare` build script. Use the actual global approval flag from `pnpm help approve-builds`, then show the reinstall command after approval so the sequence is complete. Use concise wording and keep the rest of the README structure intact. Also update any repo-run examples that still tell users to run `node --experimental-strip-types src/mcp.ts` directly if an installed binary is now the preferred path, but do not remove valid local-development instructions.

✅ Success: `README.md` shows separate install commands for `npm` and `pnpm`, and the `pnpm` section includes `pnpm approve-builds -g` plus the follow-up reinstall command.
❌ If failed: If the exact `pnpm` approval command is unclear from repo context, run `pnpm help approve-builds` and use the supported flags shown there. Do not invent any unpublished package-registry command.

### Step 4: Verify pack output and local execution
Run `pnpm build`. Run `pnpm pack`. Confirm the tarball contents include `dist/` and do not include `src/cli.ts` or `src/mcp.ts`. Run `node dist/cli.js help` and confirm the help text prints. Run a packed-package execution command that exercises the built `gmk` bin entry point. Run a second verification that exercises the built `git-mark-mcp` path enough to prove the packed package no longer depends on `cli.ts`; an acceptable check is inspecting the packed `dist/mcp.js` file contents after `pnpm pack`, or executing `node dist/mcp.js` with a minimal MCP handshake if practical. If a global install is undesirable in the workspace environment, use packed-tarball execution commands instead of global install commands.

✅ Success: The built CLI runs from `dist/`, the packed artifact contains built JavaScript instead of TypeScript entry points, and the packed MCP executable path no longer depends on `cli.ts`.
❌ If failed: If `pnpm pack` still includes `src/`, re-open `package.json` and correct the `files` array, then re-run `pnpm pack`. If `node dist/cli.js help` fails, inspect the emitted import paths in `dist/cli.js` and return to Step 1 to correct `tsconfig.json` emit settings. If the packed MCP path still depends on `cli.ts`, return to Step 2 and correct `src/mcp.ts` before re-running this verification step.

---

## Verification
- `pnpm build` exits successfully.
- `pnpm pack` outputs a tarball whose file list includes `dist/cli.js` and `dist/mcp.js`.
- `pnpm pack` output does not list `src/cli.ts` or `src/mcp.ts`.
- `node dist/cli.js help` prints the `git-mark / gmk` usage text.
- `README.md` contains a separate `pnpm` install block and mentions `pnpm approve-builds -g` plus the follow-up reinstall command for cases where `pnpm` blocks build scripts.
- `dist/mcp.js` points at `cli.js` rather than `cli.ts`.

## Rollback
- If a change breaks the build and cannot be corrected quickly, restore `package.json`, `tsconfig.json`, and `README.md` from git with `git checkout -- package.json tsconfig.json README.md`.
- If wrapper-file deletion must be reverted, restore `bin/gmk.js` and `bin/git-mark-mcp.js` with `git checkout -- bin/gmk.js bin/git-mark-mcp.js`.
- After rollback, delete any generated `dist/` output and generated tarballs manually before stopping.
