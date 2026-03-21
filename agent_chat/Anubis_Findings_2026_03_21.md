### CRITICAL — Update commands destroy local changes in materialized repos
**Location**: `src/index.ts:507`, `src/index.ts:508`, `src/git.ts:96`, `src/git.ts:101`, `src/git.ts:105`
**Problem**: `gmk update` and `gmk updateall` always force-checkout and hard-reset materialized clones to the remote branch. Any uncommitted edits inside a kept or temp clone are discarded without detection or warning.
**Impact**: Early users or agents can lose work irreversibly by running a normal refresh command against a repo they were actively editing.
**Fix**: Refuse to update dirty worktrees by default, surface a clear error, and require an explicit destructive override if reset behavior is ever allowed.

### HIGH — Configured storage roots are decorative and do not affect runtime paths
**Location**: `src/env.ts:20`, `src/env.ts:25`, `src/env.ts:29`, `src/config.ts:14`, `src/config.ts:18`, `src/cli.ts:166`, `src/cli.ts:181`, `src/cli.ts:182`
**Problem**: Runtime paths are fixed from `getToolPaths()` before config is loaded, and those paths are always rooted at `~/.gitmark` and `~/.gitmarks.toml`. Parsed `storage.root` and `storage.temp_root` never rewrite the actual paths used for logs, state, repos, or temp clones.
**Impact**: The published config file promises relocatable storage, but users cannot actually move data or temp materialization. This is direct spec drift that will look like corruption or ignored config.
**Fix**: Derive all runtime paths from config after loading it, or remove the unsupported settings from the public contract until they are real.

### HIGH — Git timeout policy is parsed but never enforced
**Location**: `src/config.ts:23`, `src/config.ts:26`, `src/git.ts:26`, `src/index.ts:236`, `src/index.ts:507`
**Problem**: `network.git_timeout_sec` is accepted from config, but `runGit()` has no timeout handling and no caller passes one. Clone/fetch/update operations can hang indefinitely on bad networks or broken remotes.
**Impact**: CLI and MCP calls can stall forever during publish-era failure cases, which makes the tool look wedged and is especially bad for agent integrations.
**Fix**: Thread timeout settings through all git execution paths and fail with a clear timeout-specific error.

### HIGH — Hook execution is hard-wired to `sh`, which breaks on stock Windows
**Location**: `src/index.ts:702`, `src/index.ts:704`
**Problem**: Every hook is launched with `spawn('sh', ['-lc', command])`. The repository is being reviewed on Windows, and a normal Windows install does not provide `sh`.
**Impact**: Any configured hook fails before the command starts on a supported Node platform. That makes documented hook support non-portable at first release.
**Fix**: Use platform-appropriate shell resolution or an explicit configurable shell, and test the hook path on Windows.

### HIGH — A malformed `state.json` bricks the CLI before the command runs
**Location**: `src/index.ts:119`, `src/index.ts:124`, `src/cli.ts:184`, `src/cli.ts:185`
**Problem**: `loadState()` calls `JSON.parse()` without recovery. Every CLI command runs temp cleanup first, so one corrupted state file aborts the entire tool before the requested command executes.
**Impact**: A truncated write, manual edit, or partial crash turns the whole install unusable until the user manually repairs internal state.
**Fix**: Treat state load as recoverable: detect parse failure, back up the bad file, rebuild empty state, and emit a clear warning.

### MEDIUM — Output-budget requirements from the spec are not implemented
**Location**: `docs/spec_initial.md:277`, `docs/spec_initial.md:378`, `docs/spec_initial.md:616`, `src/cli.ts:98`, `src/cli.ts:121`, `src/cli.ts:134`, `src/mcp.ts:152`
**Problem**: The spec requires `list`, `list-all`, `search`, and `peek` to stay near a 2 KB default budget and require paging or follow-up for larger output. The implementation prints full result sets directly in CLI and MCP with no truncation, cursoring, or paging.
**Impact**: Larger indexes will flood terminals and MCP context windows, which is exactly the failure mode the product spec says it exists to avoid.
**Fix**: Add bounded default rendering plus an explicit continuation mechanism before advertising the spec behavior.

### MEDIUM — Hook context does not include the resolved live commit promised by the spec
**Location**: `docs/spec_initial.md:175`, `src/index.ts:689`, `src/index.ts:695`
**Problem**: Hooks receive `GMK_COMMIT` from `record.commit`, which is usually empty unless the package is frozen. The resolved commit of a live clone is not passed even though hook semantics are documented around the selected remote and resolved commit.
**Impact**: Validation and audit hooks cannot reliably report or gate the exact revision that was loaded, which makes the hook contract misleading.
**Fix**: Pass the actual checked-out commit to hooks, not only the stored frozen commit field.

### MEDIUM — Invalid runtime config silently falls back to defaults
**Location**: `src/config.ts:8`, `src/config.ts:48`
**Problem**: `loadRuntimeConfig()` catches all errors and quietly returns defaults. A malformed config file does not fail clearly and does not tell the user that their settings were ignored.
**Impact**: Users will think hooks, storage, or network policy are active when the tool is actually running default behavior.
**Fix**: Distinguish missing config from invalid config and fail loudly for malformed files.

### MEDIUM — Public docs underspecify the actual surface and omit important release caveats
**Location**: `README.md:5`, `README.md:14`, `src/help.ts:1`, `package.json:19`
**Problem**: The README only shows add/list/peek/load and runtime file locations. It omits `path`, `pin`, `unpin`, `update`, `updateall`, `freeze`, `unfreeze`, the interactive add behavior, and the Node `>=24` requirement.
**Impact**: First-release users will discover commands and constraints only by failure or source reading, and the README does not warn about unstable areas like hooks or config drift.
**Fix**: Expand the README to match the real CLI surface and explicitly document current limitations that affect publish readiness.

### MEDIUM — Test coverage skips the failure paths that matter most before publish
**Location**: `test/*.test.ts`
**Problem**: The suite is mostly helper-level. There are no automated tests for dirty-repo update safety, config-root application, malformed state/config recovery, hook execution semantics, Windows shell behavior, invalid subpaths during load/peek, or timeout handling.
**Impact**: The current green test run does not cover the code paths most likely to break real users on first release.
**Fix**: Add integration tests around materialization/update/error recovery and platform-sensitive hook execution before relying on the suite as a release gate.

### Threat Model Snapshot
- **Profile**: CLI plus thin MCP wrapper for local materialization of remote git resources
- **Assets**: user filesystem, local materialized repos, bookmark index/state, agent context, hook execution on the developer machine
- **Entry points**: CLI args, MCP command strings, index/config files, remote git remotes, README content from cloned repos, hook commands
- **Trust boundaries**: local machine <-> remote git hosts, config/index files <-> runtime execution, MCP client <-> CLI process, tool <-> user shell hooks

### Coverage
- **Analyzed**: `docs/spec_initial.md`, `README.md`, `package.json`, `src/cli.ts`, `src/index.ts`, `src/git.ts`, `src/config.ts`, `src/env.ts`, `src/mcp.ts`, `src/search.ts`, `src/toml.ts`, and current `test/*.test.ts`; also verified current tests with `npm test`
- **Not analyzed**: deep dependency CVEs, npm publish packaging behavior on a clean machine, real network behavior against multiple remotes, and full cross-platform runtime validation outside source inspection
- **Confidence**: High
