# pi-undo

`/undo` command for [pi](https://github.com/earendil-works/pi-coding-agent) — restores the workspace and reverts the session tree to the state before the last agent run.

## What it does

One command, two effects:

1. **Files** — reverts every file change the previous agent run made in the working directory.
2. **Context** — rewinds the session tree to the user message that started that run, so the LLM no longer sees the undone assistant turn and tool calls. The original prompt is placed back in the editor, ready to edit and resend.

## Install

```bash
pi install npm:pi-undo
```

Or from a local checkout:

```bash
pi install /Users/stefanbinoj/Developer/fun/pi-undo
```

## Usage

In a pi session:

```
/undo
```

The agent must be idle. If it's still running, cancel it first (`Esc`), then `/undo`.

After `/undo`, the editor is pre-filled with the prompt that started the undone run, so you can edit and resend.

## How it works

`pi-undo` maintains a **per-session shadow git** — a bare repo under the cache directory (defaults to `~/.pi/agent/cache/pi-undo/<worktree-hash>/sessions/<sessionId>/shadow.git`, overridable with `$PI_CACHE_DIR`).

- On the first interaction in a session, the workspace is committed as the baseline (`__init__`).
- After every agent run, the current state of the working tree is committed, with the user prompt stored as a git note under the `pi-undo` refs namespace.
- `/undo` runs `git reset --hard HEAD~1` against that shadow repo to restore files, then uses `pi`'s `navigateTree` to drop the undone run from session history.

Each session gets its own bare repo, so concurrent sessions can't race on a shared `HEAD`. A per-session lock serializes git operations against racing `agent_end` commits.

### Ignored paths

Files excluded from tracking (in addition to the project `.gitignore`):

```
node_modules/  .git/  dist/  build/  .next/  .cache/
target/  .DS_Store  coverage/  .nyc_output/
```

The fallback list lives in [`extension/pi-undo/helper/constants.ts`](extension/pi-undo/helper/constants.ts).

### Cache layout

```
$PI_CACHE_DIR/pi-undo/<sha256(worktree)[:16]>/sessions/<sessionId>/shadow.git/
```

To wipe history for a session, delete that directory.

## Limitations

- Only tracks files inside the current working directory (`ctx.cwd`). Symlinks and files outside the worktree are not tracked.
- `/undo` reverts exactly one run — the most recent one. There is no multi-level undo.
- If the agent was cancelled mid-run, the run may not have been recorded, so `/undo` will report "Nothing to undo".
- Does not undo side effects outside the repo (network calls, databases, etc.).

## Development

Type-check:

```bash
npm run typecheck
```

The extension entry point is [`extension/pi-undo/index.ts`](extension/pi-undo/index.ts).

## License

MIT — see [LICENSE](LICENSE).
