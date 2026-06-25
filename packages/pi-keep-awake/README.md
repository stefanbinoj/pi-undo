# pi-keep-awake

Pi extension that prevents your computer from sleeping while a Pi agent turn is running.

## Install

```bash
pi install npm:pi-keep-awake
```

Or from a local checkout:

```bash
pi install /Users/stefanbinoj/Developer/fun/pi-undo/packages/pi-keep-awake
```

## What it does

`pi-keep-awake` listens to Pi lifecycle events:

- `agent_start` starts the keep-awake guard.
- A heartbeat refreshes the guard every two minutes.
- `agent_end` and `session_shutdown` stop the guard.

It uses native OS primitives where possible:

- macOS: `caffeinate -dimsu`
- Windows: `SetThreadExecutionState`
- Linux: `systemd-inhibit` with `xdg-screensaver reset` as a heartbeat

This avoids brittle mouse automation while solving the same problem: the machine stays awake only while the agent is actively running.

## Configuration

The heartbeat defaults to two minutes. Override it with:

```bash
PI_KEEP_AWAKE_HEARTBEAT_MS=120000
```

Values below 10 seconds are ignored.

## Development

From the monorepo root:

```bash
npm run typecheck
```

The extension entry point is [`extension/pi-keep-awake/index.ts`](extension/pi-keep-awake/index.ts).

