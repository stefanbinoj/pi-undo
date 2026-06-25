# pi-undo v2 — Handoff (v1.2)

## 1. Project intent

A Pi extension that provides a `/undo` command which reverts the most recent agent turn in two ways simultaneously:

1. **Restore the workspace** — file changes from the most recent turn are reverted.
2. **Clean the LLM context** — the undone user message and the assistant's reply to it are removed from future LLM context (via session-tree navigation).

Constraint: `/undo` works only after the agent ends or is stopped. The user wants a single, reliable command that does both.

The code lives in `/Users/stefanbinoj/Developer/fun/pi-undo`. The current `extension/pi-undo/index.ts` is structurally on the right track but is **broken** — it references `WorkspaceState`, `getState`, `acquireLock`, `freshRun` (and an `UndoneRecord` type) that are never defined. The file won't typecheck. There is no `tsc` / build script in `package.json`. This handoff describes the v2 design that replaces the current implementation.

## 2. Locked v1 design

### Storage
- `~/.pi/agent/cache/pi-undo/<workspace-hash>/shadow.git/` — bare shadow git, one per workspace. Workspace hash = `sha256(cwd).slice(0,16)`. Honors `PI_CACHE_DIR` env override.
- `refs/heads/session-<sessionId>` — one branch per session.
- `refs/notes/pi-undo` — git notes namespace for per-commit metadata.
- **Excludes**: read the user's project `.gitignore` if it exists (via the `ignore` npm package). Fall back to this static list if `.gitignore` is missing: `node_modules`, `.git`, `dist`, `build`, `.next`, `.cache`, `target`, `.DS_Store`, `.coverage`, `.nyc_output`. The combined pattern set is written to the shadow git's `info/exclude` and used as `:(exclude)<pattern>` pathpecs in `git add`.
  - `ignore` is a small, well-known npm package (no native deps). Add to `package.json` `dependencies`.
  - Pseudocode for the helper:
    ```ts
    import ignore from "ignore";
    async function buildExcludePatterns(cwd: string): Promise<string[]> {
      const fallback = ["node_modules/", ".git/", "dist/", "build/", ".next/", ".cache/", "target/", ".DS_Store", "coverage/", ".nyc_output/"];
      try {
        const gi = await readFile(path.join(cwd, ".gitignore"), "utf-8");
        const matcher = ignore().add(fallback).add(gi);
        return [...matcher.patterns()]; // see ignore docs for the exact accessor
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
        throw e;
      }
    }
    ```

### Per-turn commit
- On `turn_end` (assistant message): `git commit --allow-empty -m "<event.message.id>"` + `git notes --ref=pi-undo add -m "$promptText" HEAD`.
- On `agent_end` (no `turn_end` fired): if `event.messages.some(m => m.role === "assistant")`, commit with `turnId` = the last assistant message's id, same note. Otherwise skip.
- Note content: plain text prompt (no JSON). `userMessageEntryId` is derived from `turnId`: `sessionManager.getEntry(turnId).parentId`.
- `turnId === "__init__"` is the C0 marker; no note attached.
- **All turns are recorded, including `source: "extension"` and slash-command-triggered agent runs.** The user can `/undo` any turn; the prompt text in the editor pre-fill and the notify message give them context to decide whether to actually re-run.

### C0 (initial commit)
- On first `before_agent_start` (any reason): `git commit --allow-empty -m "__init__"` (turnId `__init__`, no note).
- For `session_start` reason `fork`: create C0 immediately at `session_start`, capturing workspace state at fork time.
- For `session_start` reason `resume`: branch should already exist, no C0 needed.
- For `session_start` reason `new` / `startup`: wait for first `before_agent_start` to create C0.

### `/undo` flow
1. Refuse with notify if agent is running: `ctx.isIdle()` check, NOT `waitForIdle()`. Message: "Cancel the agent first, then /undo".
2. If the current HEAD's commit subject is `"__init__"`, notify "Nothing to undo" and return.
3. Read the git note on current HEAD → get `promptText` (raw text, no parsing).
4. `git reset --hard HEAD~1` (in shadow git with `--work-tree=<cwd>`).
5. Derive `userMessageEntryId = ctx.sessionManager.getEntry(newHeadTurnId).parentId`, where `newHeadTurnId` is the new HEAD's commit subject.
6. `ctx.navigateTree(userMessageEntryId, { summarize: false })`.
7. `ctx.ui.setEditorText(promptText)`.
8. `ctx.ui.notify("Undone: <preview>…", "info")`.

### Multi-step
Works because the branch is linear (`__init__ → turn-1 → turn-2 → ...`); each `/undo` is one `HEAD~1`. No in-memory undo stack; the shadow git IS the stack.

### Concurrency / locking
Per-branch lock around all shadow git operations (`acquireLock(branchName, fn)` — chain promises in a `Map<string, Promise<unknown>>` keyed by `session-<id>`). Per-branch is more concurrent than per-repo and is the v1 default.

### Error handling
- If `commitTurn` fails (permission, disk full, etc.): `console.error` the error, `ctx.ui.notify("Failed to record this turn; it cannot be undone", "warning")`, do not block the turn.
- If `/undo` fails partway (e.g., `git reset` succeeds but `navigateTree` throws): workspace is already restored, so just notify "Workspace restored but context cleanup failed" and continue. The next `/undo` will retry the navigation.

## 3. Q&A trail (every decision and why)

**Q1 (originally from the first design review): "Move onto that user message leafId" — wrong, it doesn't exclude the user message from context.**

The user's original plan was to navigate to the user message's leafId after `/undo`. But the user message leaf is the leaf AFTER the user message was appended. Navigating to it leaves the user message on the active root-to-leaf path, so the LLM still sees it. To actually exclude the user message and the assistant reply, navigate to the **parent of the user message** (the leaf active just before the message was appended) with `summarize: false`. Then `setEditorText(extractUserText(userMessage))` puts the prompt back in the editor.

In v1.2 we don't need `baseLeafId` at all — `userMessageEntryId = sessionManager.getEntry(turnId).parentId` derives it from the assistant message's id at `/undo` time.

**Q2 (SHA stored per turn): Three options (after-only, before-only, both).**

After-only is enough. Store the after-commit SHA (HEAD of the session branch) only. No "before" commit. On `/undo`, `git reset --hard HEAD~1` steps back one commit. We don't need the before-commit because (a) git's parent links give us the chain for free, and (b) we're not doing `/redo`, so the "after" of the undone turn is irrelevant.

**Q3 (multi-step `/undo` math): `HEAD~1` from an "after" commit lands on the previous "after" commit because there are no interleaved "before" commits — the chain is just `C0 → C1 → C2 → ...`.**

Multi-step `/undo` works correctly. Each `/undo` is one `HEAD~1`. Linear arithmetic, no exceptions.

**Q4 (manual edits between turns): Current code preserves them via per-turn "before" commits; the new design with after-only commits would lose them.**

**Option A: accept the loss.** `/undo` is aggressive. Document that manual edits between turns are not preserved. Treat a future `/checkpoint` command as a v2 follow-up. The user explicitly chose this.

**Q5 (when does C0 happen?): Four options (eager on `session_start`, lazy on `input`, lazy on `before_agent_start`, no C0).**

**Option C: lazy on `before_agent_start`**, with this session_start matrix:
- `startup` / `new`: wait for first `before_agent_start` to create C0
- `fork`: create C0 immediately at `session_start` capturing workspace state at fork time
- `resume`: use existing branch; if branch missing, treat as `new` (warn the user)
- `/reload`: use existing branch; if branch missing, warn and skip rehydration

`turnId` for C0 is the literal string `__init__`, no git note attached.

**Q6 (JSONL entry fields): User pushed back on putting per-turn data in the session JSONL — wanted isolated, non-bloaty storage.**

**Use git notes, not JSONL, not commit-message body.** The shadow git is self-contained. No JSONL involvement at all. The note is plain text (the prompt). Commit subject is just the `turnId` (a session entry id — see v1.1 refinements below). Body is empty. `git log` stays clean. Reasoning chain: commit-message body would bloat every commit; JSONL would bloat the session file and pollute the user's data; git notes are a separate ref space, have no size limit (git uses blob storage), and can be read/written with `git notes --ref=<ns> show/add`. The fresh LLM can verify with `git notes --help`.

**Q7 (aborted / interrupted turns): What if `turn_end` doesn't fire (Esc, crash, unrecoverable error)?**

**Option B (refined): record on `agent_end` if there's at least one assistant message in `event.messages`.** Use that message's id as the `turnId` (same as the normal case). If there's no assistant message (fully aborted before any assistant turn), skip the commit — there's no turn state worth recording. No synthetic `aborted-<uuid>` turnId; the prefix-on-turnId trick is gone because turnId is now always a real session entry id (or `__init__`).

**Note on `/reload` midturn:** there is no in-memory state to lose; the same handlers run before and after `/reload`. No special handling needed. If the branch is missing on `session_start` reason `resume`, call `ctx.ui.notify("Undo history not available for this session — was the cache cleared?", "warning")` and proceed with an empty in-memory state.

**Q8 (deleted in v1.2 — collapsed into Q7).** Originally about `/reload` rehydration of an `inFlightTurn` state that no longer exists. Removing `inFlightTurn` makes the question moot. The `/reload` note above covers the remaining concerns (missing branch on resume).

**Q9 (forks / `/tree` in the session tree): Shadow git branch is linear, session tree can be branched.**

**Option A: linear `/undo` regardless of tree shape.** `/undo` steps back one commit in time, not in tree path. Document. Per-tree-path branches deferred to v2 (prerequisite: implement `/tree` file restore via `session_before_tree` hook, with dirty-guard and `restoreOnTree: "ask" | "always"` choice).

Considered per-tree-path branches but rejected: the shadow git's `--work-tree=<cwd>` is the user's actual workspace, and Pi's `/tree` doesn't restore files. Branching in the shadow git without workspace restoration creates a disconnect (the new branch's "fork point" wouldn't match the workspace state). Per-tree-path branches only make sense if `/tree` also restores files, which is a v2 feature.

**Q10 (extension-origin prompts, simplified in v1.2): `source: "extension"` inputs trigger agent runs.**

**Originally**: skip them — no `inFlightTurn` set, so the agent run still happens but no commit is made.

**v1.2 simplification**: drop the skip entirely. All turns are recorded, including extension-origin. The user can `/undo` any turn; the prompt text in the editor pre-fill (which shows the extension's prompt) gives them context to decide whether to actually re-run. ~5 fewer lines, no in-memory state at all.

**The `/undo` agent-idle check (resolved during handoff, not a numbered Q):** use `ctx.isIdle()` + refuse with notify. NOT `ctx.waitForIdle()`. Reason: waiting could let `/undo` race against a turn that's about to do something destructive; refusing forces the user to cancel the turn first, which is the safer default and matches the user's original spec.

### Refinements during handoff

- **v1.1**:
  - Commit subject is just the `turnId` (session entry id, or `__init__` for C0). No `pi-undo: ` prefix — the shadow git is exclusively used by this extension.
  - `turnId` IS the session entry id of the assistant message (`event.message.id` in `turn_end`, last assistant's id in `agent_end`). No UUID generation. Session tree is the source of truth.
  - Git note is plain text prompt, not JSON. `userMessageEntryId` derived from `turnId` via `getEntry(turnId).parentId`.
  - `.gitignore` honored if present, else static fallback. `ignore` npm package.
  - Edge case: if session is compacted, old assistant message ids may be removed from the session tree, breaking `getEntry(turnId)`. `/undo` for that turn is best-effort. Compaction is a v2 concern.

- **v1.2**:
  - **Drop `inFlightTurn` entirely** — every field it held (`turnId`, `baseLeafId`, `promptText`) is derivable from the event and the session tree. No in-memory state at all for the turn itself.
  - **Drop `pi.on("input")` handler** — there's nothing for it to do.
  - **Drop the extension-origin skip** — all turns are recorded.
  - **Q8 collapses into Q7** — no `/reload` rehydration special case.
  - The `input` and `before_agent_start` handlers simplify to: nothing for `input`, branch-ensure for `before_agent_start`.

## 4. Implementation outline (~200-250 lines, single file `extension/pi-undo/index.ts`)

1. **`ShadowGit` class** (simplify the existing one):
   - Keep: `init()`, the bare-git setup, the `info/exclude` write (now populated by `buildExcludePatterns` per the storage section), the seed commit that establishes the initial branch.
   - Drop: the `snapshot()`, `hasChangesSince()`, and `restore()` methods. They implemented the old "before/after" snapshot model and are no longer needed.
   - Add:
     - `ensureBranch(sessionId)` — checks if `refs/heads/session-<id>` exists (via `git rev-parse --verify`, exit code 0/1). If not, `git checkout -b session-<id>` (from current HEAD), then `git commit --allow-empty -m "__init__"`. The seed HEAD is whatever was there (usually the shadow git's `main` with its initial empty commit, established in `init()`).
     - `commitTurn(turnId, promptText)` — does `git commit --allow-empty -m "<turnId>"` + `git notes --ref=pi-undo add -m "<promptText>" HEAD`. The commit subject is the bare `turnId`. The note is the raw prompt text. Helper must handle multi-line prompts and shell-escape single quotes (use single-quote wrap with `'\''` substitution).
     - `readNote(commit = "HEAD")` — `git notes --ref=pi-undo show <commit>`, returns the raw note text or `null`. No JSON parsing.
     - `readTurnId(commit = "HEAD")` — `git log -1 --format=%s <commit>`, returns the commit subject (the `turnId`).
     - `resetHard(target = "HEAD~1")` — `git reset --hard <target>`.
   - All operations take `--work-tree=<cwd>` and `--git-dir=<shadow.git>`.
   - Wrap every operation in `acquireLock(branchName, fn)` for serialisation per session branch.

2. **State**: none. The shadow git and session tree are the only state. No in-memory undo stack, no `inFlightTurn`, no `WorkspaceState` map.

3. **Handlers**:

   ```ts
   // No pi.on("input") handler. There's nothing to capture.

   pi.on("session_start", async (event, ctx) => {
     if (event.reason === "fork") {
       await shadow.ensureBranch(ctx.sessionManager.getSessionId());
     }
     // For other reasons, ensureBranch is called lazily on first before_agent_start.
     // If reason === "resume" and the branch is missing, the user has lost history
     // — proceed without it. (Optionally: ctx.ui.notify a warning. We don't, in v1.2.)
   });

   pi.on("before_agent_start", async (_event, ctx) => {
     await shadow.ensureBranch(ctx.sessionManager.getSessionId());
   });

   pi.on("turn_end", async (event, ctx) => {
     if (event.message?.role !== "assistant") return;
     await commitTurn(ctx, event.message.id);
   });

   pi.on("agent_end", async (event, ctx) => {
     const lastAssistant = [...event.messages].reverse().find(m => m.role === "assistant");
     if (!lastAssistant) return; // fully aborted, nothing to record
     await commitTurn(ctx, lastAssistant.id);
   });

   pi.registerCommand("undo", {
     description: "Restore workspace and context to before the previous agent turn",
     handler: async (_args, ctx) => {
       // The flow from section 2.
       if (!ctx.isIdle()) {
         ctx.ui.notify("Cancel the agent first, then /undo", "warning");
         return;
       }
       const sessionId = ctx.sessionManager.getSessionId();
       const shadow = new ShadowGit(ctx.cwd, cacheBase);
       await acquireLock(`session-${sessionId}`, async () => {
         const turnId = await shadow.readTurnId("HEAD");
         if (turnId === "__init__") {
           ctx.ui.notify("Nothing to undo", "info");
           return;
         }
         const promptText = await shadow.readNote("HEAD") ?? "";
         await shadow.resetHard("HEAD~1");
         const newTurnId = await shadow.readTurnId("HEAD");
         const userMessageEntryId = ctx.sessionManager.getEntry(newTurnId)?.parentId ?? null;
         if (userMessageEntryId) {
           await ctx.navigateTree(userMessageEntryId, { summarize: false });
         }
         ctx.ui.setEditorText(promptText);
         const preview = promptText.length > 60 ? promptText.slice(0, 60) + "…" : promptText;
         ctx.ui.notify(`Undone: ${preview}`, "info");
       });
     },
   });

   async function commitTurn(ctx: ExtensionContext, turnId: string) {
     const userMsgEntry = ctx.sessionManager.getEntry(
       ctx.sessionManager.getEntry(turnId)?.parentId ?? ""
     );
     if (!userMsgEntry) {
       // Edge case: parent was somehow removed (compaction?). Skip.
       ctx.ui.notify("Could not find user message for this turn; turn not recorded", "warning");
       return;
     }
     const promptText = extractUserText(userMsgEntry);
     const sessionId = ctx.sessionManager.getSessionId();
     const shadow = new ShadowGit(ctx.cwd, cacheBase);
     await acquireLock(`session-${sessionId}`, () =>
       shadow.commitTurn(turnId, promptText)
     );
   }
   ```

4. **Helpers**:
   - `acquireLock(key, fn)` — chain promises in a `Map<string, Promise<unknown>>`. Returns the result of the last call. The pattern from the current code.
   - `buildExcludePatterns(cwd)` — see the storage section. Uses the `ignore` npm package.
   - `extractUserText(entry)` — walks the entry's message content (text parts) and concatenates the text. Simple string extraction. Handle both `string` content and `[{ type: "text", text: "..." }]` content shapes (Pi supports both).
   - `escapeForShell(text)` — single-quote wrap with `'\''` substitution, for safely embedding prompt text in `git commit -m "..."` and `git notes add -m "..."` invocations. Multi-line text is fine (git takes the message verbatim).

5. **File layout**:
   - Single file: `extension/pi-undo/index.ts`. No new source files.
   - `package.json`: add `ignore` to `dependencies`. Drop `typebox` from `peerDependencies` (unused). Add `scripts.typecheck: "tsc --noEmit"` (the existing `tsconfig.json` already has `noEmit: true`).

## 5. Pi API references (verified)

From `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`:

- `ExtensionAPI` has: `on(event, handler)`, `registerCommand(name, options)`, `appendEntry<T>(customType, data?)`.
- `ExtensionCommandContext` extends `ExtensionContext` and adds: `waitForIdle()`, `navigateTree(targetId, options?)`, `newSession()`, `fork()`, `switchSession()`, `reload()`, plus `getSystemPromptOptions()`.
- `ExtensionContext` has: `ui` (with `notify`, `setEditorText`, `select`, `confirm`, `input`, `custom`, `setStatus`, `setEditorComponent`, etc.), `cwd`, `sessionManager`, `isIdle()`, `hasPendingMessages()`, `abort()`, `getContextUsage()`, `modelRegistry`, etc.
- **`navigateTree(targetId, { summarize: false })`**: `summarize: false` is critical. Without it, Pi generates a `branch_summary` entry that gets appended to the session tree AND is sent to the LLM, defeating the purpose of `/undo`. Other options: `customInstructions`, `replaceInstructions`, `label`.
- Events used: `session_start`, `before_agent_start`, `turn_end`, `agent_end`. **`pi.on("input")` is NOT used in v1.2 — there's nothing to capture.**
- `SessionManager` (read-only via `sessionManager`): `getLeafId()`, `getLeafEntry()`, `getEntry(id)`, `getBranch(fromId?)`, `getEntries()`, `getChildren(parentId)`, `getSessionId()`, `getSessionFile()`, `getCwd()`. `getBranch()` returns `SessionEntry[]`.
- `TurnEndEvent`: `{ turnIndex: number, message: AgentMessage, toolResults: ToolResultMessage[] }`. `message.id` is the assistant message's session entry id.
- `AgentEndEvent`: `{ messages: AgentMessage[] }`. Filter for `role === "assistant"` to find assistant messages.

**Key gotchas**:
- `ctx.sessionManager` is `ReadonlySessionManager` in the event context (not the full mutable one). The mutable `branch()` and `resetLeaf()` methods are NOT exposed. Use `ctx.navigateTree` from a command context, or `pi.appendEntry` for custom entries.
- `event.message` in `turn_end` can be `undefined` for some edge cases — null-check.
- `ctx.isIdle()` is the right gate for `/undo`; `ctx.waitForIdle()` waits indefinitely and is wrong here.
- The session entry id (`event.message.id` in `turn_end`) is a UUID. Treat it as opaque; use `getEntry(id).parentId` to walk the tree.
- The `__init__` literal is our own convention for C0; it's NOT a session entry id. When reading the commit subject, check `=== "__init__"` to detect C0 (no navigation possible from it).
- An assistant message's parent (the user message) is the navigation target on `/undo`. `getEntry(turnId).parentId` returns the user message's id. The user message's content (the prompt text) is in `entry.message.content`.
- `SessionEntry.message.content` can be either a plain `string` or `Array<TextContent | ImageContent>` depending on the agent. `extractUserText` must handle both shapes.

## 6. v2 deferred items (do NOT implement for v1)

- **Manual edits between turns preserved via `/checkpoint` command** (Q4).
- **`/redo` command** (user explicitly out of scope).
- **Per-tree-path branches in the shadow git** (Q9). Requires implementing `/tree` file restore via `session_before_tree` hook first.
- **`/tree` file restore** with `restoreOnTree: "ask" | "always" | "never"` config (Q9 prerequisite).
- **Dirty-guard for unsaved manual changes at `/undo` time** — by design, `/undo` is aggressive (consistent with Q4).
- **Robust handling of `/undo` after session compaction** — `getEntry(turnId)` may return `undefined` for old turns whose assistant message was compacted away. v1 is best-effort.
- **3 restore modes** (code+context, context-only, code-only) — out of scope.
- **TUI checkpoint list with diff stats** — out of scope.
- **Session deletion hook integration** to clean up orphan shadow git branches — Pi doesn't expose such a hook yet.

## 7. What "done" looks like for v1

A user can:

1. Open Pi in a project.
2. Send a prompt, agent makes file changes.
3. Send another prompt, agent makes more file changes.
4. Type `/undo` — workspace reverts to before the most recent prompt, the prompt text reappears in the editor, the LLM no longer sees the undone turn in context.
5. Type `/undo` again — workspace reverts to before the turn before that, etc.
6. Edit the prompt and press Enter to retry.
7. Quit Pi, restart, resume the session, type `/undo` — same behaviour, no history lost (shadow git + notes survive in the cache directory).

All of the above must work without manual intervention, without breaking the workspace, and without polluting the user's project `.git` history.

---

**End of handoff.** The fresh LLM should be able to start implementing from section 4, using sections 2, 3, 5 as the design rationale. There are no remaining open decisions — every question raised during the design phase has a decided answer in section 3.
