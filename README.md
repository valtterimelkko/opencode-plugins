# OpenCode Plugins

A small companion collection of OpenCode plugins for longer-running, workflow-oriented agent sessions.

These plugins were built to make OpenCode feel less like a bare runtime connection and more like a configurable agent workspace with memory, orchestration, and autonomous goal execution.

## Why this exists

I wanted OpenCode to participate in the same broader workflow philosophy as my Pi-based setup: persistent goals, better memory, and safer parallel execution. This repository packages the OpenCode side of that work.

It is also designed to pair well with **[Pi Web UI](https://github.com/valtterimelkko/pi-web-ui)**, where some plugin-generated state can be surfaced in the browser as status widgets or normalized session events.

## Plugins in this repository

### `goal-engine`
Autonomous multi-turn goal execution for OpenCode.

Features:
- define a goal and keep working toward it across turns
- pause, resume, clear, inspect, and resume the most recent persisted goal
- session-scoped disk persistence
- verification-oriented completion model with optional shell verification
- companion status rendering in Pi Web UI when used together, including compaction progress

Quick live validation, when Pi Web UI's Internal API is available:

```bash
cd goal-engine
npm run live:validate -- --socket ~/.pi-web-ui/internal-api.sock --token-path ~/.pi-web-ui/internal-api-token
```

### `opencode-memory-plugin`
Persistent memory helper for OpenCode.

Features:
- session memory
- auto-memory style persistence patterns
- explicit memory tool usage for durable context

### `opencode-parallel-orchestrator-plugin`
Git worktree-based parallel orchestration plugin.

Features:
- create isolated worktrees for parallel tasks
- parse plan files into task sets
- track worktree status
- merge completed work back with different strategies

## Relationship to Pi Web UI

These plugins can be useful on their own, but they are especially relevant if you also use:
- **[Pi Web UI](https://github.com/valtterimelkko/pi-web-ui)** as a browser interface around OpenCode
- companion Pi extensions in a separate Pi-focused repository

Pi Web UI can operate without these plugins, but some workflow niceties become richer when they are installed.

## Installation shape

`goal-engine` has `index.js` + `tui-commands.js` + `scripts/` + `index.test.js`; the other two plugins are `index.js` only (minimal stubs). Each is a small ESM package with `package.json`.

See the plugin directories directly:
- `goal-engine/` (`index.js` + `tui-commands.js` + `scripts/live-validate-*.js` + `index.test.js`)
- `opencode-memory-plugin/` (`index.js` only)
- `opencode-parallel-orchestrator-plugin/` (`index.js` only)

## Deploy / verify (OpenCode plugin discovery)

```bash
# install from a local checkout
npm install file:goal-engine              # or: opencode plugin add ./goal-engine
npm install file:opencode-memory-plugin
npm install file:opencode-parallel-orchestrator-plugin
# verify they are visible to the host
opencode plugins list        # (or `opencode plugin list` per your version)
```

Deployed plugins are resolved via the host's plugin registry/config; goal-engine state lives at `~/.opencode/goal-engine/<sessionID>.goal.json` (not `~/.pi/...`).

## Pi ↔ OpenCode parity (public scope)

| Pi (`pi-enhancement`) | OpenCode (`opencode-plugins`) | State |
|-----------------------|-------------------------------|-------|
| `memory/` | `opencode-memory-plugin/` | Stub — tool + memory files ported, heuristic extraction minimal |
| `goal-engine/` | `goal-engine/` | Active — multi-turn `/goal`, governor, compaction-aware, live:validate |
| `parallel-orchestrator/` | `opencode-parallel-orchestrator-plugin/` | Stub — `git worktree` tool wrappers |

This repo is the public OpenCode companion side — intentionally narrower than the private Pi+Web UI setup. Pi Web UI's `server/src/pi/parallel/` orchestration remains part of the larger private environment, not here.

## Public-release note

This repository is the cleaner OpenCode companion side of a larger private experimentation environment. It is intentionally narrower than the full private setup so it can be published safely and understood more easily by outside users.

## License

MIT
