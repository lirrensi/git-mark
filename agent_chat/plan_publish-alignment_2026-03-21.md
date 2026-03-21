# Plan: Publish-alignment pass for config, hooks, limits, and spec
_Bring the current CLI behavior and `docs/spec_initial.md` into a tighter, publishable shape without expanding scope into a large test or feature wave._

---

# Checklist
- [x] Step 1: Refactor bootstrap paths and effective runtime paths
- [x] Step 2: Replace shell hooks with TypeScript module hooks
- [x] Step 3: Add bounded CLI output for list-all, search, and peek
- [x] Step 4: Add atomic writes and disposable-state recovery
- [x] Step 5: Add targeted tests for the changed behavior
- [x] Step 6: Rewrite `docs/spec_initial.md` to match the implemented contract
- [x] Step 7: Run verification commands and mark the checklist complete

---

## Context
The repository root is `C:\Users\rx\001_Code\101_DevArea\GitMark`.

Relevant implementation files:
- `src/env.ts`
- `src/config.ts`
- `src/types.ts`
- `src/cli.ts`
- `src/index.ts`
- `src/toml.ts`
- `src/help.ts`
- `src/log.ts`
- `src/fs.ts`
- `src/mcp.ts`
- `src/search.ts`

Relevant tests:
- `test/help.test.ts`
- `test/search.test.ts`
- `test/toml.test.ts`
- `test/pin.test.ts`
- `test/add.test.ts`

Relevant documentation:
- `docs/spec_initial.md`

The user clarified the intended product behavior:
1. `update` is intentionally destructive with respect to local changes inside tool-managed clones. The tool treats local clones as disposable mirrors of remote resources, not as user worktrees.
2. Hook execution must not use `sh -lc`. Hooks are intended to be a TypeScript file path configured in `config.toml`, with exported hook functions that the tool loads directly.
3. `list` should print all pinned packages, because pinned packages are the favorites surfaced into agent context.
4. `list-all` should be paginated by default so large bookmark sets do not flood the shell. Use a default page size of `15`.
5. `search` should default to `10` results.
6. `peek` output should remain bounded.
7. The main documentation to sync right now is `docs/spec_initial.md`. Do not spend time on `README.md` in this pass.
8. Keep the multi-remote model simple. Keep `remotes` as an array in stored records. Do not add a new remote-management command in this pass.
9. Make writes safer so automated operations do not leave broken JSON or TOML files behind. Full multi-process locking is out of scope for this pass.

---

## Prerequisites
- `npm` is available.
- The repository dependencies are already installed.
- Do not create commits.
- Do not edit `README.md`.
- Do not add a broad new test suite. Add only targeted tests needed for the changed behavior in this plan.

## Scope Boundaries
- Do not add a new command for remote management.
- Do not add background daemons, watchers, or automatic syncing.
- Do not redesign search ranking beyond limit and paging behavior.
- Do not add full inter-process locking in this pass.
- Do not change the intended destructive semantics of `update`.

---

## Steps

### Step 1: Refactor bootstrap paths and effective runtime paths
Open `src/env.ts`, `src/types.ts`, `src/config.ts`, `src/cli.ts`, and `src/mcp.ts`.

Change the path model so `~/.gitmarks.toml` remains the fixed global index path and `~/.gitmark/config.toml` remains the fixed config path, but the runtime paths used for state, logs, repos, and temp storage are derived after loading config.

Implement a bootstrap-path concept for the fixed files and an effective runtime-path concept for the loaded config. The effective runtime paths must use:
- `config.storage.root` for the runtime storage root
- `config.storage.temp_root` for temp storage
- a repos root derived from `config.storage.root`
- a log path derived from `config.storage.root`
- a state path derived from `config.storage.root`

Update `runCli()` in `src/cli.ts` so the logger is created after config has been loaded and effective paths have been resolved. Update `runMcp()` in `src/mcp.ts` so bootstrap loading and effective runtime paths stay aligned with CLI behavior.

✅ Success: `src/cli.ts` no longer creates runtime-dependent paths before config is loaded, and all runtime storage paths are derived from loaded config.
❌ If failed: stop. Revert partial path-model edits in the affected files and report exactly which file caused the mismatch.

### Step 2: Replace shell hooks with TypeScript module hooks
Open `src/types.ts`, `src/config.ts`, `src/toml.ts`, `src/index.ts`, and `docs/spec_initial.md`.

Replace the current per-hook shell-command config model with a TypeScript hook module path.

Implement the following hook config shape in code:
- `hooks.module` as a string path, defaulting to an empty string

Implement direct hook loading in `src/index.ts` by dynamically importing the configured module path when present. Use the expanded absolute path converted to a file URL before importing.

Support these optional named exports from the module:
- `preLoad`
- `preExpose`
- `postLoad`
- `preUpdate`
- `postUpdate`

Each exported hook function must receive one plain object containing the relevant context: package id, repo path, visible path, selected remote, subpath, resolved commit, default branch, and hook name.

If `hooks.module` is empty, skip hooks silently. If the module file does not exist or the import fails, throw a `GitMarkError` with a clear hook-loading message. If a hook function throws, wrap the failure in a `GitMarkError`.

Delete the `sh -lc` execution path entirely from `src/index.ts`.

✅ Success: there is no shell-based hook execution left in the codebase, `config.toml` parsing/stringifying supports `hooks.module`, and runtime hook execution loads named exports from a TypeScript module.
❌ If failed: stop. Restore the old hook config fields only if the TypeScript-module hook path cannot be made to parse and load cleanly.

### Step 3: Add bounded CLI output for list-all, search, and peek
Open `src/cli.ts`, `src/index.ts`, `src/search.ts`, and `src/help.ts`.

Keep `list` behavior as unbounded output of all pinned packages.

Add CLI paging and limit behavior with these defaults:
- `list-all`: default `--limit 15`, default `--offset 0`
- `search`: default `--limit 10`, default `--offset 0`
- `peek`: keep output compact by reducing the preview item cap and README excerpt cap

Implement option parsing for `list-all` and `search` using the existing `parseOptions()` helper. Add a small helper for parsing positive integer options with sensible fallbacks.

Implement `list-all` so the CLI prints only the selected page of records and prints a short continuation hint when more records exist.

Implement `search` so `searchRecords()` accepts limit and offset, the CLI prints only the selected page, and the CLI prints a short continuation hint when more matches exist.

Implement `peek` so file preview length and README excerpt length are lower than the current values and remain compact by default.

Update CLI help text in `src/help.ts` to mention `--limit` and `--offset` for the bounded commands.

✅ Success: `list` still prints all pinned packages, while `list-all`, `search`, and `peek` are bounded by default and the help text documents the relevant flags.
❌ If failed: stop. Remove partially added flags from help text if the commands do not honor them.

### Step 4: Add atomic writes and disposable-state recovery
Open `src/fs.ts`, `src/index.ts`, `src/config.ts`, and `src/log.ts`.

Implement an atomic text write helper in `src/fs.ts` that writes to a temp file in the same directory and then renames the temp file over the destination.

Change structured-file writers to use atomic writes where practical:
- `saveIndexFile()` in `src/index.ts`
- `saveState()` in `src/index.ts`
- `ensureConfigFile()` in `src/config.ts`

Do not redesign log rotation in this pass.

Add defensive recovery for malformed `state.json` only. If parsing `state.json` fails, rename the broken file to a sibling file that preserves the original content with a timestamped `state.broken-*.json` name, then continue with an empty state object.

Do not auto-repair malformed `~/.gitmarks.toml` or malformed `config.toml`. Those files should still fail loudly because they are user-managed truth.

✅ Success: structured state and config writes use atomic replacement, malformed `state.json` is preserved and replaced with an empty in-memory state, and malformed index/config files still fail loudly.
❌ If failed: stop. Keep malformed-state recovery code only if the original broken file is preserved before continuing.

### Step 5: Add targeted tests for the changed behavior
Open or add tests under `test/`.

Add targeted automated tests for these behaviors only:
1. Effective runtime paths honor loaded config storage roots.
2. Runtime config TOML round-trips with `hooks.module`.
3. A TypeScript hook module can be loaded and its exported hook function is called.
4. Malformed `state.json` is preserved and recovered as empty state.
5. `searchPackages()` or higher-level search paging honors limit and offset.
6. CLI help text mentions the new bounded-command flags.

Prefer unit or narrow integration tests that avoid live network access.

✅ Success: new tests cover the newly added behavior without expanding into a broad suite.
❌ If failed: stop. Remove any flaky network-dependent test and replace it with a local filesystem test.

### Step 6: Rewrite `docs/spec_initial.md` to match the implemented contract
Open `docs/spec_initial.md`.

Edit the specification so it matches the intended and implemented behavior after Steps 1 through 5.

Make these content changes explicitly:
- Clarify that tool-managed clones are disposable mirrors of remote resources and `update` intentionally refreshes them even if local edits are lost.
- Clarify that `pinned` means favorites surfaced into default `list` output and agent context.
- Clarify that `list` prints pinned favorites, while `list-all` is the broader bookmark listing with bounded paging.
- Clarify the default page sizes for `list-all` and `search`.
- Clarify that hooks are configured as a TypeScript module file path with exported hook functions, not shell commands.
- Clarify that `state.json` is disposable tool-owned state and may be rebuilt if malformed, while the index and config remain user-managed truth.
- Keep the plural `remotes` model, but do not add any new command surface beyond the current implementation.

Keep the rest of the document intact unless a sentence directly conflicts with the behavior above.

✅ Success: `docs/spec_initial.md` no longer claims shell hooks or the old output-budget wording that conflicts with the implemented command behavior.
❌ If failed: stop. Do not invent new features in the spec to patch over implementation gaps.

### Step 7: Run verification commands and mark the checklist complete
Run these commands from the repository root:
- `npm test`
- `npm run typecheck`

If both commands pass, update the checklist at the top of this plan file so every completed step is marked `[x]`.

✅ Success: both commands pass and the checklist mirrors the finished work.
❌ If failed: stop on the first failing command, fix only the code directly related to the failure, rerun the failed command, then rerun the full verification set.

---

## Verification
The plan is complete only when all of the following are true:
- `npm test` passes.
- `npm run typecheck` passes.
- `src/index.ts` no longer contains `sh -lc` shell hook execution.
- `src/help.ts` documents bounded flags for the relevant commands.
- `docs/spec_initial.md` reflects TypeScript hooks, pinned favorites semantics, bounded `list-all`/`search`, and disposable-update wording.

## Rollback
If a critical refactor fails and cannot be repaired, restore the repository to the pre-plan working tree by checking the current git diff, then manually revert only the files changed by this plan using the saved diff context. Do not use destructive git commands.
