import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FALLBACK_EXCLUDES } from "./constants.js";

interface SessionReader {
	getEntry(id: string): SessionEntry | undefined;
}

// Per-session lock — serializes git ops on the same shadow git so a /undo
// racing an agent_end commit can't interleave.
const sessionLocks = new Map<string, Promise<unknown>>();
export async function acquireLock<T>(
	key: string,
	fn: () => Promise<T>,
): Promise<T> {
	const prev = sessionLocks.get(key) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	sessionLocks.set(key, next);
	try {
		return await next;
	} finally {
		if (sessionLocks.get(key) === next) sessionLocks.delete(key);
	}
}

export async function buildIgnorePatterns(cwd: string): Promise<string[]> {
	const patterns = [...FALLBACK_EXCLUDES];
	const giPath = join(cwd, ".gitignore");
	if (existsSync(giPath)) {
		for (const raw of (await readFile(giPath, "utf-8")).split("\n")) {
			const line = raw.trim();
			if (line && !line.startsWith("#")) patterns.push(line);
		}
	}
	return patterns;
}

export function findRunStartUserEntry(
	start: SessionEntry | undefined,
	sm: SessionReader,
): SessionEntry | null {
	let current = start;
	while (current && current.type === "message" && current.message.role !== "user") {
		if (!current.parentId) return null;
		current = sm.getEntry(current.parentId);
	}
	return current && current.type === "message" ? current : null;
}

export function extractUserText(entry: SessionEntry): string {
	if (entry.type !== "message") return "";
	if (entry.message.role !== "user") return "";
	const c = entry.message.content;
	if (typeof c === "string") return c;
	return c
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("\n");
}

export function previewFor(text: string, max = 60): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? flat.slice(0, max) + "…" : flat;
}
