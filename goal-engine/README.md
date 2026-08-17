# goal-engine — Autonomous Multi-Turn Goal Execution for OpenCode

Session-scoped, file-persisted (`~/.opencode/goal-engine/<sessionID>.goal.json`) loop with governor, compaction awareness, and Pi Web UI widgets.

## Install

```bash
npm install file:goal-engine         # local dev (repo is source of truth)
opencode plugin add ./goal-engine    # alternative global registration
# check loader for your version: `opencode plugin --help` / `opencode --help`
opencode plugins list                 # verify discovery
```
Deployed via host plugin registry/config; state lives at `~/.opencode/goal-engine/`.

## Peer dep

`@opencode-ai/plugin >= 1.14` (see `package.json:peerDependencies`).

## Files

```
goal-engine/
├── package.json
├── index.js                      # server plugin — goal_engine tool + system-transform + events
├── tui-commands.js               # command-palette autocomplete (/goal …)
├── index.test.js                 # unit tests (parse helpers, cooldown guards)
└── scripts/live-validate-goal-commands.js   # Pi Web UI live validation
```

## Commands (`/goal`)

Intercepted in `chat.message` — rewrites to `goal_engine` tool or formats read-only output. `/goal help` routes to `status`:
- `/goal <objective> [--verify CMD] [--max-turns N]` — start
- `/goal status [show|hide]` — toggle widget; `report` — detailed; `list` — most recent persisted goal
- `/goal pause` / `pause-now` — graceful vs immediate; `resume` / `resume_last`; `clear` — abandon
Autocomplete from `tui-commands.js` (`api.command.register`); TUI module must stay pure (no server default export).

## Tool `goal_engine`

`start` (`objective`, `max_turns`, `verify_command`) · `pause`/`pause_now`/`resume`/`resume_last`/`clear` (`confirmed:true`) · `status` (`status_mode`) / `report` / `set_limit`. Completion = strict `Status: GOAL_ACHIEVED` line (`index.js:COMPLETION_PATTERNS`) + optional `verify_command` shell check; governor paces continuations (suspicion/budget).

## live:validate

Needs Pi Web UI socket+token (not opencode-native):

```bash
cd goal-engine
npm run live:validate -- --socket ~/.pi-web-ui/internal-api.sock --token-path ~/.pi-web-ui/internal-api-token
```
Validates: start→persisted goal, `pause-now`, `status hide|show`, `report`, `list`, `set_limit`, `resume`, `pause`, `clear`.

## Related

Pi sibling: `pi-enhancement/goal-engine/` (separate runtime/API). See also `tui-commands.js` header comment.
