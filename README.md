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

Each plugin is a small ESM package with a `package.json` and `index.js` entry point.

See the plugin directories directly:
- `goal-engine/`
- `opencode-memory-plugin/`
- `opencode-parallel-orchestrator-plugin/`

## Public-release note

This repository is the cleaner OpenCode companion side of a larger private experimentation environment. It is intentionally narrower than the full private setup so it can be published safely and understood more easily by outside users.

## License

MIT
