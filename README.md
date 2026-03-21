# git-mark

`git-mark` is a bookmark manager for git-backed resources.

## Quick start

```bash
npx git-mark add github.com/you/mega-repo#skills/design
gmk list
gmk peek design
gmk load design
```

## Runtime files

- Index: `~/.gitmarks.toml`
- Config: `~/.gitmark/config.toml`
- Logs: `~/.gitmark/history.log`
- State: `~/.gitmark/state.json`
