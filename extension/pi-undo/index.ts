// pi-undo — /undo reverts the last agent run.
//   1. Rolls back workspace files via a per-session shadow git.
//   2. Rewinds the session tree so the LLM forgets the undone run.
//
// Per-session gitDir (not shared-with-branches): a bare repo has one HEAD.
// Two sessions sharing a gitDir would race on HEAD. Per-session gitDirs
// make that impossible.

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { C0_MARKER, NOTES_REF } from "./helper/constants";
import {
	acquireLock,
	buildIgnorePatterns,
	extractUserText,
	findRunStartUserEntry,
	previewFor,
} from "./helper/helper";

async function exec(
	cmd: string,
	args: string[],
	options: { input?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			cmd,
			args,
			{ encoding: "utf-8", ...options },
			(err, stdout, stderr) => {
				if (err) reject(err);
				else resolve({ stdout, stderr });
			},
		);
		if (options.input !== undefined && child.stdin) {
			child.stdin.write(options.input);
			child.stdin.end();
		}
	});
}

class ShadowGit {
	readonly gitDir: string;
	readonly workTree: string;

	constructor(workTree: string, sessionId: string, cacheBase: string) {
		this.workTree = workTree;
		const hash = createHash("sha256")
			.update(workTree)
			.digest("hex")
			.slice(0, 16);
		this.gitDir = join(
			cacheBase,
			"pi-undo",
			hash,
			"sessions",
			sessionId,
			"shadow.git",
		);
	}

	async init(): Promise<void> {
		await mkdir(this.gitDir, { recursive: true });
		if (!existsSync(join(this.gitDir, "HEAD"))) {
			await exec("git", ["init", "--bare", this.gitDir]);
		}
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"config",
			"user.email",
			"pi-undo@local",
		]);
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"config",
			"user.name",
			"pi-undo",
		]);
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"config",
			"commit.gpgsign",
			"false",
		]);
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"config",
			"core.fsmonitor",
			"false",
		]);

		const patterns = await buildIgnorePatterns(this.workTree);
		await writeFile(
			join(this.gitDir, "info", "exclude"),
			patterns.join("\n") + "\n",
		);
	}

	async ensureC0(): Promise<void> {
		await this.init();
		try {
			await exec("git", ["--git-dir", this.gitDir, "rev-parse", "HEAD"]);
			return; // chain already established
		} catch {
			// no commits yet
		}
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"--work-tree",
			this.workTree,
			"add",
			"-A",
		]);
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"--work-tree",
			this.workTree,
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			C0_MARKER,
		]);
	}

	async commitRun(commitMessage: string, promptText: string): Promise<void> {
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"--work-tree",
			this.workTree,
			"add",
			"-A",
		]);
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"--work-tree",
			this.workTree,
			"commit",
			"--allow-empty",
			"--no-gpg-sign",
			"-m",
			commitMessage,
		]);
		// Stdin for the note — handles multi-line / large prompts safely.
		await exec(
			"git",
			[
				"--git-dir",
				this.gitDir,
				"notes",
				"--ref",
				NOTES_REF,
				"add",
				"-F",
				"-",
			],
			{ input: promptText },
		);
	}

	async readNote(commit = "HEAD"): Promise<string | null> {
		try {
			const { stdout } = await exec("git", [
				"--git-dir",
				this.gitDir,
				"notes",
				"--ref",
				NOTES_REF,
				"show",
				commit,
			]);
			return stdout;
		} catch {
			return null;
		}
	}

	async readCommitMessage(commit = "HEAD"): Promise<string | null> {
		try {
			const { stdout } = await exec("git", [
				"--git-dir",
				this.gitDir,
				"log",
				"-1",
				"--format=%s",
				commit,
			]);
			return stdout.trim();
		} catch {
			return null;
		}
	}

	async resetHard(target = "HEAD~1"): Promise<void> {
		await exec("git", [
			"--git-dir",
			this.gitDir,
			"--work-tree",
			this.workTree,
			"reset",
			"--hard",
			target,
		]);
	}
}

export default function (pi: ExtensionAPI) {
	const cacheBase =
		process.env.PI_CACHE_DIR ?? join(homedir(), ".pi", "agent", "cache");

	// Record one agent run in the shadow git. Walks the session tree to find
	// the user message (multi-turn runs need the walk — see findRunStartUserEntry).
	async function commitRun(
		ctx: ExtensionContext,
		commitMessage: string,
	): Promise<void> {
		const userMsgEntry = findRunStartUserEntry(
			ctx.sessionManager.getEntry(commitMessage),
			ctx.sessionManager,
		);
		if (!userMsgEntry) {
			ctx.ui.notify(
				"Could not find user message for this run; not recorded",
				"warning",
			);
			return;
		}
		const promptText = extractUserText(userMsgEntry);
		if (!promptText) {
			ctx.ui.notify("User message had no text; run not recorded", "warning");
			return;
		}
		const shadow = new ShadowGit(
			ctx.cwd,
			ctx.sessionManager.getSessionId(),
			cacheBase,
		);
		try {
			await acquireLock(shadow.gitDir, () =>
				shadow.commitRun(commitMessage, promptText),
			);
		} catch (e) {
			console.error("[pi-undo] commitRun failed:", e);
			ctx.ui.notify(
				"Failed to record this run; it cannot be undone",
				"warning",
			);
		}
	}

	pi.on("session_start", async (event, ctx) => {
		if (event.reason !== "fork") return;
		const shadow = new ShadowGit(
			ctx.cwd,
			ctx.sessionManager.getSessionId(),
			cacheBase,
		);
		await acquireLock(shadow.gitDir, () => shadow.ensureC0());
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		const shadow = new ShadowGit(
			ctx.cwd,
			ctx.sessionManager.getSessionId(),
			cacheBase,
		);
		await acquireLock(shadow.gitDir, () => shadow.ensureC0());
	});

	pi.on("agent_end", async (event, ctx) => {
		const hasAssistant = event.messages.some((m) => m.role === "assistant");
		if (!hasAssistant) return;
		// AgentMessage doesn't carry its own id; the active session leaf is
		// the last assistant message after agent_end.
		const commitMessage = ctx.sessionManager.getLeafId();
		if (!commitMessage) return;
		await commitRun(ctx, commitMessage);
	});

	pi.registerCommand("undo", {
		description:
			"Restore workspace and editor to the state before the previous agent run, and remove the undone run from context",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!ctx.isIdle()) {
				ctx.ui.notify("Cancel the agent first, then /undo", "warning");
				return;
			}

			const shadow = new ShadowGit(
				ctx.cwd,
				ctx.sessionManager.getSessionId(),
				cacheBase,
			);

			await acquireLock(shadow.gitDir, async () => {
				const currentMsg = await shadow.readCommitMessage("HEAD");
				if (currentMsg === C0_MARKER) {
					ctx.ui.notify("Nothing to undo", "info");
					return;
				}

				const promptText = (await shadow.readNote("HEAD")) ?? "";

				try {
					await shadow.resetHard("HEAD~1");
				} catch (e) {
					console.error("[pi-undo] resetHard failed:", e);
					ctx.ui.notify(
						"Undo failed — could not restore workspace",
						"error",
					);
					return;
				}

				const newMsg = await shadow.readCommitMessage("HEAD");
				const newUserEntry = newMsg
					? findRunStartUserEntry(
							ctx.sessionManager.getEntry(newMsg),
							ctx.sessionManager,
						)
					: null;
				const navigationTarget = newUserEntry?.parentId ?? null;

				if (navigationTarget) {
					try {
						// summarize:false is critical — without it Pi generates a
						// branch_summary entry that gets sent to the LLM, defeating /undo.
						await ctx.navigateTree(navigationTarget, {
							summarize: false,
						});
					} catch (e) {
						console.error("[pi-undo] navigateTree failed:", e);
						ctx.ui.notify(
							"Workspace restored but context cleanup failed",
							"warning",
						);
					}
				}

				ctx.ui.setEditorText(promptText);
				ctx.ui.notify(`Undone: ${previewFor(promptText)}`, "info");
			});
		},
	});
}
