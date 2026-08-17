# opencode-parallel-orchestrator-plugin

Stub / minimal port of `pi-enhancement/parallel-orchestrator/` for OpenCode.

## Status

Minimal `index.js`-only plugin. Provides `worktree` (`create`/`list`/`delete`/`status`), `orchestrate`, and `merge_worktree` tools backed by `git worktree` — same workflow as the Pi sibling, re-exposed as an OpenCode plugin. Server-side orchestration/UI still lives in `pi-web-ui/server/src/pi/parallel/` (not here).

## Install

```bash
npm install file:opencode-parallel-orchestrator-plugin
# or: opencode plugin add ./opencode-parallel-orchestrator-plugin
opencode plugins list   # verify
```

Peer dep `@opencode-ai/plugin >= 1.14`.
