# opencode-memory-plugin

Stub / minimal port of the Pi `memory` extension for OpenCode.

## Status

Minimal `index.js`-only plugin (sibling: `pi-enhancement/memory/`). Ships a `memory` tool (`save`/`search`/`show`/`list`/`edit`/`clear`) and system-prompt injection; persistent store is `~/.opencode/memory/<slug>/MEMORY.md` + per-session `~/.opencode/session-memory/<sessionID>.md`.

## Install

```bash
npm install file:opencode-memory-plugin
# or: opencode plugin add ./opencode-memory-plugin
opencode plugins list   # verify
```

Peer dep `@opencode-ai/plugin >= 1.14`.
