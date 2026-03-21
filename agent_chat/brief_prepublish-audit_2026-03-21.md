# Brief: Pre-publish audit for git-mark
_Review the greenfield CLI/MCP tool for spec drift, missing essentials, weak error handling, and edge cases that matter before an initial public release._

---

## Target Agent
Anubis

## Context
`git-mark` is a small Node/TypeScript CLI plus thin MCP wrapper for bookmarking git-backed resources. The repo has a spec in `docs/spec_initial.md`, a very short `README.md`, working implementation in `src/`, and a light test suite in `test/`.

The implementation intentionally differs from the spec already. The goal here is not to force full spec compliance yet, but to identify the most important publish blockers, design inconsistencies, error-handling gaps, and edge cases worth addressing soon.

Relevant files:
- `docs/spec_initial.md` - current intended behavior
- `README.md` - current public-facing framing
- `src/cli.ts` - CLI surface and command wiring
- `src/index.ts` - core add/list/search/peek/load/path/update/freeze logic
- `src/git.ts` - git process execution and repo operations
- `src/config.ts` - runtime config loading
- `src/env.ts` - runtime path resolution
- `src/mcp.ts` - MCP wrapper
- `src/search.ts` - search behavior
- `src/toml.ts` - index/config parsing
- `test/*.test.ts` - current automated coverage

Observed upfront:
- Tests and typecheck pass.
- Only `docs/spec_initial.md` exists; there is no `docs/product.md`, `docs/spec.md`, or architecture canon yet.
- Config includes storage/network/hook fields, but some of those may not actually influence runtime behavior.

---

## Focus Areas

- `src/env.ts` and `src/config.ts` - check whether configured storage roots actually affect runtime paths or if the code is effectively hard-coded to `~/.gitmark`.
- `src/index.ts` - inspect materialization, temp cleanup, hook execution, update, freeze, and path resolution for correctness and user-facing failure modes.
- `src/git.ts` - inspect cross-platform behavior, timeouts, authentication failure clarity, destructive operations, and remote handling.
- `src/mcp.ts` - inspect whether MCP behavior stays aligned with CLI behavior and whether tool output/error semantics are safe enough for publish.
- `src/search.ts` versus `docs/spec_initial.md` - assess search quality and notable spec drift.
- `README.md` versus actual command surface - check whether published docs would undersell, overpromise, or omit important caveats.
- `test/` coverage - identify important missing tests, especially around error cases and platform-sensitive behavior.

## Hypotheses

1. Runtime config is partially decorative today: some configured paths and network settings are parsed but never enforced.
2. Hook execution and shell assumptions may break on Windows or mixed-shell environments.
3. Some spec promises around output discipline, remote mirrors, LFS policy, and search behavior are not implemented yet and may confuse early users.
4. The core happy path works, but edge cases around invalid subpaths, frozen/temp state transitions, and failed clone/update flows may need stronger tests and clearer messages.

---

## Deliverable

- [ ] Ranked list of the highest-value pre-publish issues, grouped by severity
- [ ] Concrete spec-vs-implementation mismatches that matter now, with file references
- [ ] Error-handling and edge-case gaps with file references
- [ ] Recommended next essentials for a first public release: what to fix before publish, what can wait until after

## Out of Scope
- Do not implement fixes
- Do not rewrite the spec or docs
- Do not spend time on style-only nits unless they affect usability or publish readiness
