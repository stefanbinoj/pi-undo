# pi-packages

Monorepo for Pi extension packages.


## Packages

| Package | Role | Install |
| --- | --- | --- |
| `pi-undo` | `/undo` command that restores workspace files and rewinds session context to before the last agent run. | `pi install npm:pi-undo` |
| `pi-keep-awake` | Prevents your computer from sleeping while a Pi agent turn is running. | `pi install npm:pi-keep-awake` |

### ScreenShots

Install dependencies at the root:

```bash
npm install
```

Type-check every package:

```bash
npm run typecheck
```

Dry-run all publishable packages:

```bash
npm run publish:dry
```

Publish all packages:

```bash
npm run publish
```

## Structure

```text
packages/
  pi-undo/
  pi-keep-awake/
```

Each package has its own `package.json`, `README.md`, `LICENSE`, and `pi.extensions` entry.

## License

MIT
