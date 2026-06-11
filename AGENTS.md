# Agent Instructions for OpenCode Plugins

## Mission

Improve this repository as a **public, live plugin repo**. Keep changes small, understandable, and safe for outside users.

## What this repo contains

This repo contains companion OpenCode plugins for workflow-oriented agent sessions, currently including:
- `goal-engine/`
- `opencode-memory-plugin/`
- `opencode-parallel-orchestrator-plugin/`

## Required workflow

1. Prefer minimal diffs over broad rewrites.
2. If you change behaviour, update docs in the same pull/commit when appropriate.
3. Before commit/push, inspect:
   - `git status --short`
   - `git diff --stat`
   - `git diff --cached --stat`
4. Leave the working tree clean before finishing.

## Secret-safety / public repo hygiene

Treat this repo as permanently public.

### Never commit
- `.env` files or local config files containing real credentials
- API keys, bearer tokens, OAuth refresh tokens, cookies, or copied auth headers
- local test output, debug dumps, or transcripts containing private user/project data
- machine-specific notes, shell histories, or private scratch files

### Always use placeholders in examples
- Use obvious fake example values in docs and tests
- Never replace placeholders with working credentials “temporarily”
- If an example requires a token-shaped string, make it clearly fake

### Respect `.gitignore`
- If you create a new sensitive local artifact, add it to `.gitignore`
- Do not use `git add -f` on ignored secret-bearing files

## Plugin-specific guidance

- Keep plugin READMEs aligned with actual package contents.
- Prefer portable paths and generic installation guidance over references to a single personal machine.
- If a plugin has useful coupling with Pi Web UI, describe that clearly, but do not assume Pi Web UI is required unless it truly is.

## Final rule

If a file, example, or generated output looks even slightly like live credential material or private runtime state, stop and inspect it before committing.
