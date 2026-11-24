/**
 * Locates and reads VS Code chat (GitHub Copilot) sessions from disk.
 *
 * VS Code persists chat sessions per workspace in
 *   <User>/workspaceStorage/<workspaceHash>/chatSessions/<sessionId>.(json|jsonl)
 * and sessions from windows without a folder in
 *   <User>/globalStorage/emptyWindowChatSessions/<sessionId>.(json|jsonl)
 *
 * `.json` files hold the full serialized session (legacy format).
 * `.jsonl` files are an append-only mutation log (VS Code >= 1.10x):
 *   {"kind":0,"v":<initial state>}
 *   {"kind":1,"k":[path...],"v":<value>}           set
 *   {"kind":2,"k":[path...],"v":[items],"i":<idx>}  push / splice
 *   {"kind":3,"k":[path...]}                        delete
 *
 * This module has no dependency on the `vscode` API so it can be unit-tested.
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

export interface SessionFileInfo {
	sessionId: string;
	file: string;
	format: 'json' | 'jsonl';
	mtimeMs: number;
	size: number;
	/** Workspace storage hash, or undefined for empty-window sessions. */
	workspaceId?: string;
	/** Folder / workspace file path the session belongs to (if known). */
	workspacePath?: string;
	/** Human-readable workspace name. */
	workspaceName: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChatSessionData = any;

/** Replays a VS Code chat session operation log (.jsonl) into the final session object. */
export function replayOperationLog(text: string): ChatSessionData {
	let state: ChatSessionData = undefined;
	const lines = text.split('\n');
	for (let lineNo = 0; lineNo < lines.length; lineNo++) {
		const line = lines[lineNo].trim();
		if (!line) {
			continue;
		}
		let entry: { kind: number; k?: (string | number)[]; v?: unknown; i?: number };
		try {
			entry = JSON.parse(line);
		} catch {
			// A torn final line (e.g. VS Code was writing while we read) is tolerated.
			if (lineNo >= lines.length - 2) {
				break;
			}
			throw new Error(`Invalid JSON on line ${lineNo + 1}`);
		}
		switch (entry.kind) {
			case 0:
				state = entry.v;
				break;
			case 1:
				state = applySet(state, entry.k ?? [], entry.v);
				break;
			case 2:
				applyPush(state, entry.k ?? [], entry.v as unknown[] | undefined, entry.i);
				break;
			case 3:
				state = applySet(state, entry.k ?? [], undefined);
				break;
			default:
				// Unknown entry kinds are ignored for forward compatibility.
				break;
		}
	}
	return state;
}

function walk(state: ChatSessionData, keyPath: (string | number)[]): ChatSessionData {
	let current = state;
	for (let i = 0; i < keyPath.length - 1; i++) {
		if (current[keyPath[i]] === undefined || current[keyPath[i]] === null) {
			current[keyPath[i]] = typeof keyPath[i + 1] === 'number' ? [] : {};
		}
		current = current[keyPath[i]];
	}
	return current;
}

function applySet(state: ChatSessionData, keyPath: (string | number)[], value: unknown): ChatSessionData {
	if (keyPath.length === 0) {
		return value;
	}
	const parent = walk(state, keyPath);
	const last = keyPath[keyPath.length - 1];
	if (value === undefined) {
		delete parent[last];
	} else {
		parent[last] = value;
	}
	return state;
}

function applyPush(state: ChatSessionData, keyPath: (string | number)[], values: unknown[] | undefined, startIndex: number | undefined): void {
	const parent = walk(state, keyPath);
	const last = keyPath[keyPath.length - 1];
	const arr: unknown[] = Array.isArray(parent[last]) ? parent[last] : [];
	if (startIndex !== undefined) {
		arr.length = startIndex;
	}
	if (values && values.length) {
		arr.push(...values);
	}
	parent[last] = arr;
}

export function readSessionFile(file: string): ChatSessionData {
	const text = fs.readFileSync(file, 'utf8');
	if (file.endsWith('.jsonl')) {
		return replayOperationLog(text);
	}
	return JSON.parse(text);
}

/**
 * Given the VS Code `User` data directory (e.g. ~/.config/Code/User), returns the
 * directories that may contain chat sessions.
 */
export function chatSessionDirs(userDir: string): { dir: string; workspaceId?: string; workspacePath?: string; workspaceName: string }[] {
	const result: { dir: string; workspaceId?: string; workspacePath?: string; workspaceName: string }[] = [];
	const wsRoot = path.join(userDir, 'workspaceStorage');
	let entries: string[] = [];
	try {
		entries = fs.readdirSync(wsRoot);
	} catch {
		entries = [];
	}
	for (const id of entries) {
		const dir = path.join(wsRoot, id, 'chatSessions');
		if (!isDir(dir)) {
			continue;
		}
		const { workspacePath, workspaceName } = readWorkspaceInfo(path.join(wsRoot, id), id);
		result.push({ dir, workspaceId: id, workspacePath, workspaceName });
	}
	const empty = path.join(userDir, 'globalStorage', 'emptyWindowChatSessions');
	if (isDir(empty)) {
		result.push({ dir: empty, workspaceName: '(no folder)' });
	}
	return result;
}

function isDir(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function readWorkspaceInfo(storageDir: string, id: string): { workspacePath?: string; workspaceName: string } {
	try {
		const ws = JSON.parse(fs.readFileSync(path.join(storageDir, 'workspace.json'), 'utf8'));
		const uri: string | undefined = ws.folder ?? ws.workspace;
		if (uri) {
			let p = uri;
			try {
				p = uri.startsWith('file:') ? fileURLToPath(uri) : decodeURIComponent(uri);
			} catch {
				/* keep raw uri */
			}
			const base = path.basename(p).replace(/\.code-workspace$/, '');
			return { workspacePath: p, workspaceName: base || p };
		}
	} catch {
		/* no workspace.json */
	}
	return { workspaceName: id.slice(0, 8) };
}

/** Lists all chat session files under the given VS Code User directory. */
export function listSessionFiles(userDir: string): SessionFileInfo[] {
	const byId = new Map<string, SessionFileInfo>();
	for (const loc of chatSessionDirs(userDir)) {
		let names: string[];
		try {
			names = fs.readdirSync(loc.dir);
		} catch {
			continue;
		}
		for (const name of names) {
			const m = /^(.+)\.(jsonl|json)$/.exec(name);
			if (!m) {
				continue;
			}
			const file = path.join(loc.dir, name);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(file);
			} catch {
				continue;
			}
			if (!stat.isFile() || stat.size === 0) {
				continue;
			}
			const info: SessionFileInfo = {
				sessionId: m[1],
				file,
				format: m[2] as 'json' | 'jsonl',
				mtimeMs: stat.mtimeMs,
				size: stat.size,
				workspaceId: loc.workspaceId,
				workspacePath: loc.workspacePath,
				workspaceName: loc.workspaceName,
			};
			const key = `${loc.dir}::${m[1]}`;
			const prev = byId.get(key);
			// Prefer the .jsonl log (newer format) over a stale .json snapshot.
			if (!prev || (info.format === 'jsonl' && prev.format === 'json') || (info.format === prev.format && info.mtimeMs > prev.mtimeMs)) {
				byId.set(key, info);
			}
		}
	}
	return [...byId.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Walks up from a path until a directory named `User` is found (VS Code's user data dir). */
export function findUserDir(fromPath: string): string | undefined {
	let current = fromPath;
	for (let i = 0; i < 8; i++) {
		if (path.basename(current) === 'User') {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break;
		}
		current = parent;
	}
	return undefined;
}
