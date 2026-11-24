import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { convertSession, sessionTitle, toJsonl } from './converter';
import { ensureTarget, getUsername, parseTarget, readCachedToken, Target, targetToString, targetUrl, uploadTraceFiles } from './hub';
import { redactDeep, RedactOptions } from './redact';
import { findUserDir, listSessionFiles, readSessionFile, SessionFileInfo } from './sessionStore';

const TOKEN_KEY = 'copilotTraces.hfToken';
const UPLOADED_KEY = 'copilotTraces.uploaded'; // sessionId -> mtimeMs uploaded
const EXTENSION_VERSION = '0.1.0';

let output: vscode.LogOutputChannel;
let ctx: vscode.ExtensionContext;
let autoTimer: NodeJS.Timeout | undefined;
let busy = false;

interface LoadedSession {
	info: SessionFileInfo;
	title: string;
	requestCount: number;
	lastDate: number;
	jsonl: string;
	redactions: number;
}

function cfg() {
	return vscode.workspace.getConfiguration('copilotTraces');
}

export interface CopilotTracesApi {
	/** Converts the Copilot sessions in scope to STS-Format JSONL (redaction applied). */
	getTraces(scope: 'workspace' | 'all'): Promise<{ sessionId: string; title: string; workspace: string; jsonl: string }[]>;
}

export function activate(context: vscode.ExtensionContext): CopilotTracesApi {
	ctx = context;
	output = vscode.window.createOutputChannel('Copilot Traces', { log: true });
	context.subscriptions.push(
		output,
		vscode.commands.registerCommand('copilotTraces.previewSession', previewSession),
		vscode.commands.registerCommand('copilotTraces.exportSessions', exportSessions),
		vscode.commands.registerCommand('copilotTraces.uploadSessions', () => uploadPicked()),
		vscode.commands.registerCommand('copilotTraces.uploadWorkspaceSessions', () => uploadScope('workspace')),
		vscode.commands.registerCommand('copilotTraces.uploadAllSessions', () => uploadScope('all')),
		vscode.commands.registerCommand('copilotTraces.setToken', setToken),
		vscode.commands.registerCommand('copilotTraces.signOut', signOut),
		vscode.commands.registerCommand('copilotTraces.setTarget', () => pickTarget(true)),
		vscode.commands.registerCommand('copilotTraces.openTarget', openTarget),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('copilotTraces.autoUpload')) {
				scheduleAutoUpload();
			}
		}),
		{ dispose: () => autoTimer && clearInterval(autoTimer) },
	);
	scheduleAutoUpload();
	return {
		getTraces: async scope =>
			(await loadSessions(discover(scope))).map(s => ({ sessionId: s.info.sessionId, title: s.title, workspace: s.info.workspaceName, jsonl: s.jsonl })),
	};
}

export function deactivate(): void {
	if (autoTimer) {
		clearInterval(autoTimer);
	}
}

// ---------------------------------------------------------------------------
// Session discovery

function userDirs(): string[] {
	const dirs = new Set<string>();
	const configured = cfg().get<string[]>('additionalUserDataDirs', []) ?? [];
	for (const d of configured) {
		if (d) {
			dirs.add(d.replace(/^~(?=$|[\\/])/, os.homedir()));
		}
	}
	const fromGlobal = findUserDir(ctx.globalStorageUri.fsPath);
	if (fromGlobal) {
		dirs.add(fromGlobal);
	}
	if (ctx.storageUri) {
		const fromWs = findUserDir(ctx.storageUri.fsPath);
		if (fromWs) {
			dirs.add(fromWs);
		}
	}
	return [...dirs];
}

function currentWorkspaceId(): string | undefined {
	// storageUri = <User>/workspaceStorage/<workspaceId>/<extensionId>
	return ctx.storageUri ? path.basename(path.dirname(ctx.storageUri.fsPath)) : undefined;
}

function discover(scope: 'workspace' | 'all'): SessionFileInfo[] {
	const wsId = currentWorkspaceId();
	const seen = new Set<string>();
	const all: SessionFileInfo[] = [];
	for (const dir of userDirs()) {
		for (const s of listSessionFiles(dir)) {
			if (seen.has(s.file)) {
				continue;
			}
			seen.add(s.file);
			if (scope === 'workspace' && s.workspaceId !== wsId) {
				continue;
			}
			all.push(s);
		}
	}
	return all.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function redactOptions(): RedactOptions {
	const c = cfg();
	const replacements: { find: string; replace: string }[] = [];
	if (c.get<boolean>('redact.homeDirectory', true)) {
		const home = os.homedir();
		replacements.push({ find: home, replace: '~' });
		replacements.push({ find: home.replace(/\\/g, '\\\\'), replace: '~' });
		replacements.push({ find: home.replace(/\\/g, '/'), replace: '~' });
		try {
			const user = os.userInfo().username;
			if (user && user.length >= 3) {
				replacements.push({ find: user, replace: '<user>' });
			}
		} catch {
			/* ignore */
		}
	}
	return {
		secrets: c.get<boolean>('redact.secrets', true),
		customPatterns: c.get<string[]>('redact.customPatterns', []),
		replacements,
	};
}

function loadSession(info: SessionFileInfo): LoadedSession | undefined {
	let data;
	try {
		data = readSessionFile(info.file);
	} catch (e) {
		output.warn(`Could not read ${info.file}: ${String(e)}`);
		return undefined;
	}
	if (!data || !Array.isArray(data.requests) || data.requests.length === 0) {
		return undefined;
	}
	const c = cfg();
	const headerExtras: Record<string, unknown> = {
		exporter: `vscode-copilot-traces@${EXTENSION_VERSION}`,
		vscodeVersion: vscode.version,
	};
	if (c.get<boolean>('includeWorkspaceName', true)) {
		headerExtras.workspace = info.workspaceName;
	}
	const converted = convertSession(data, info.sessionId, {
		harness: c.get<string>('harness', 'vscode-copilot') || 'vscode-copilot',
		headerExtras,
		maxToolResultChars: c.get<number>('maxToolResultChars', 50000),
	});
	if (converted.messages.length === 0) {
		return undefined;
	}
	const redacted = redactDeep({ header: converted.header, messages: converted.messages }, redactOptions());
	const jsonl = toJsonl({ ...converted, header: redacted.value.header, messages: redacted.value.messages });
	const last = data.requests[data.requests.length - 1];
	return {
		info,
		title: sessionTitle(data),
		requestCount: converted.requestCount,
		lastDate: data.lastMessageDate ?? last?.responseTimestamp ?? last?.timestamp ?? info.mtimeMs,
		jsonl,
		redactions: redacted.count,
	};
}

async function loadSessions(infos: SessionFileInfo[]): Promise<LoadedSession[]> {
	const out: LoadedSession[] = [];
	for (const info of infos) {
		const s = loadSession(info);
		if (s) {
			out.push(s);
		}
		// Yield to keep the extension host responsive on large histories.
		await new Promise(r => setImmediate(r));
	}
	return out;
}

async function pickSessions(canPickMany: boolean, title: string): Promise<LoadedSession[] | undefined> {
	const scopeChoice = currentWorkspaceId()
		? await vscode.window.showQuickPick(
			[
				{ label: 'Current workspace', scope: 'workspace' as const },
				{ label: 'All workspaces', scope: 'all' as const },
			],
			{ title, placeHolder: 'Which Copilot chat sessions?' },
		)
		: { scope: 'all' as const };
	if (!scopeChoice) {
		return undefined;
	}
	const sessions = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Reading Copilot chat sessions…' },
		() => loadSessions(discover(scopeChoice.scope)),
	);
	if (sessions.length === 0) {
		vscode.window.showInformationMessage('No Copilot chat sessions found.');
		return undefined;
	}
	const uploaded = ctx.globalState.get<Record<string, number>>(UPLOADED_KEY, {});
	const items = sessions.map(s => ({
		label: s.title,
		description: `${s.info.workspaceName} · ${s.requestCount} request${s.requestCount === 1 ? '' : 's'}`,
		detail: `${new Date(s.lastDate).toLocaleString()}${uploaded[s.info.sessionId] ? (uploaded[s.info.sessionId] >= s.info.mtimeMs ? ' · uploaded' : ' · changed since upload') : ''}`,
		session: s,
	}));
	if (canPickMany) {
		const picked = await vscode.window.showQuickPick(items, { title, canPickMany: true, matchOnDescription: true, matchOnDetail: true });
		return picked?.map(p => p.session);
	}
	const picked = await vscode.window.showQuickPick(items, { title, matchOnDescription: true, matchOnDetail: true });
	return picked ? [picked.session] : undefined;
}

// ---------------------------------------------------------------------------
// Commands

async function previewSession(): Promise<void> {
	const picked = await pickSessions(false, 'Preview Copilot session as trace');
	if (!picked?.length) {
		return;
	}
	const doc = await vscode.workspace.openTextDocument({ content: picked[0].jsonl, language: 'jsonl' });
	await vscode.window.showTextDocument(doc, { preview: false });
}

async function exportSessions(): Promise<void> {
	const picked = await pickSessions(true, 'Export Copilot sessions as trace files');
	if (!picked?.length) {
		return;
	}
	const folder = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Export here' });
	if (!folder?.length) {
		return;
	}
	for (const s of picked) {
		fs.writeFileSync(path.join(folder[0].fsPath, fileName(s)), s.jsonl, 'utf8');
	}
	const redactions = picked.reduce((n, s) => n + s.redactions, 0);
	const choice = await vscode.window.showInformationMessage(
		`Exported ${picked.length} session${picked.length === 1 ? '' : 's'} to ${folder[0].fsPath}${redactions ? ` (${redactions} redactions)` : ''}.`,
		'Reveal',
	);
	if (choice === 'Reveal') {
		vscode.commands.executeCommand('revealFileInOS', folder[0]);
	}
}

async function uploadPicked(): Promise<void> {
	const picked = await pickSessions(true, 'Upload Copilot sessions to Hugging Face');
	if (picked?.length) {
		await upload(picked, true);
	}
}

async function uploadScope(scope: 'workspace' | 'all'): Promise<void> {
	if (scope === 'workspace' && !currentWorkspaceId()) {
		vscode.window.showWarningMessage('No workspace is open.');
		return;
	}
	const sessions = await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Reading Copilot chat sessions…' },
		() => loadSessions(discover(scope)),
	);
	if (!sessions.length) {
		vscode.window.showInformationMessage('No Copilot chat sessions found.');
		return;
	}
	await upload(sessions, true);
}

function fileName(s: LoadedSession): string {
	const date = new Date(s.lastDate).toISOString().slice(0, 10);
	return `${date}_${s.info.sessionId}.jsonl`.replace(/[^\w.-]/g, '_');
}

function remotePath(s: LoadedSession): string {
	const prefix = (cfg().get<string>('pathInRepo', 'copilot') ?? '').replace(/^\/+|\/+$/g, '');
	const name = `${s.info.sessionId}.jsonl`.replace(/[^\w.-]/g, '_');
	return prefix ? `${prefix}/${name}` : name;
}

async function getToken(interactive: boolean): Promise<string | undefined> {
	const stored = await ctx.secrets.get(TOKEN_KEY);
	if (stored) {
		return stored;
	}
	const cached = readCachedToken();
	if (cached) {
		return cached;
	}
	if (!interactive) {
		return undefined;
	}
	return setToken();
}

async function setToken(): Promise<string | undefined> {
	const token = await vscode.window.showInputBox({
		title: 'Hugging Face access token',
		prompt: 'Create a token with write access at https://huggingface.co/settings/tokens',
		password: true,
		ignoreFocusOut: true,
		validateInput: v => (v.trim().startsWith('hf_') ? undefined : 'Tokens start with "hf_"'),
	});
	if (!token) {
		return undefined;
	}
	try {
		const name = await getUsername(token.trim(), hubUrl());
		await ctx.secrets.store(TOKEN_KEY, token.trim());
		vscode.window.showInformationMessage(`Signed in to Hugging Face as ${name}.`);
		return token.trim();
	} catch (e) {
		vscode.window.showErrorMessage(`Invalid Hugging Face token: ${errorMessage(e)}`);
		return undefined;
	}
}

async function signOut(): Promise<void> {
	await ctx.secrets.delete(TOKEN_KEY);
	vscode.window.showInformationMessage('Removed the stored Hugging Face token.');
}

function hubUrl(): string | undefined {
	const u = cfg().get<string>('hubUrl', '');
	return u ? u.replace(/\/+$/, '') : undefined;
}

async function pickTarget(force: boolean, token?: string): Promise<Target | undefined> {
	const current = cfg().get<string>('target', '');
	const parsed = current ? parseTarget(current) : undefined;
	if (parsed && !force) {
		return parsed;
	}
	let suggestion = current;
	if (!suggestion) {
		const t = token ?? (await getToken(false));
		if (t) {
			try {
				suggestion = `datasets/${await getUsername(t, hubUrl())}/copilot-traces`;
			} catch {
				/* ignore */
			}
		}
	}
	const value = await vscode.window.showInputBox({
		title: 'Where should traces be uploaded?',
		prompt: 'A dataset ("datasets/<user>/<name>") or a storage bucket ("buckets/<user>/<name>"). It is created (private by default) if it does not exist.',
		value: suggestion || 'datasets/<user>/copilot-traces',
		ignoreFocusOut: true,
		validateInput: v => (parseTarget(v) ? undefined : 'Expected datasets/<user>/<name> or buckets/<user>/<name>'),
	});
	const t = value ? parseTarget(value) : undefined;
	if (t) {
		await cfg().update('target', targetToString(t), vscode.ConfigurationTarget.Global);
	}
	return t;
}

async function openTarget(): Promise<void> {
	const t = parseTarget(cfg().get<string>('target', '') ?? '');
	if (!t) {
		vscode.window.showInformationMessage('No upload target configured yet. Run "Copilot Traces: Upload Sessions to Hugging Face" first.');
		return;
	}
	vscode.env.openExternal(vscode.Uri.parse(targetUrl(t, hubUrl())));
}

async function upload(sessions: LoadedSession[], interactive: boolean): Promise<boolean> {
	if (busy) {
		if (interactive) {
			vscode.window.showInformationMessage('An upload is already in progress.');
		}
		return false;
	}
	busy = true;
	try {
		const token = await getToken(interactive);
		if (!token) {
			return false;
		}
		const target = await pickTarget(false, token);
		if (!target) {
			return false;
		}
		const visibility = cfg().get<'private' | 'public'>('visibility', 'private');

		if (interactive && cfg().get<boolean>('confirmBeforeUpload', true)) {
			const redactions = sessions.reduce((n, s) => n + s.redactions, 0);
			const msg = `Upload ${sessions.length} Copilot session${sessions.length === 1 ? '' : 's'} to ${targetToString(target)}?`;
			const detail =
				'Traces can contain prompts, code, file paths, command output and secrets. ' +
				`Automatic redaction replaced ${redactions} value${redactions === 1 ? '' : 's'}, but it is best-effort — review traces with "Copilot Traces: Preview Session" before publishing publicly. ` +
				`New repositories are created as ${visibility}.`;
			const ok = await vscode.window.showWarningMessage(msg, { modal: true, detail }, 'Upload');
			if (ok !== 'Upload') {
				return false;
			}
		}

		await vscode.window.withProgress(
			{ location: interactive ? vscode.ProgressLocation.Notification : vscode.ProgressLocation.Window, title: `Uploading traces to ${targetToString(target)}…` },
			async () => {
				const { created } = await ensureTarget(target, token, visibility, hubUrl());
				if (created) {
					output.info(`Created ${visibility} ${target.type} ${target.name}`);
				}
				// Upload in batches to keep commits reasonably sized.
				const batchSize = 100;
				for (let i = 0; i < sessions.length; i += batchSize) {
					const batch = sessions.slice(i, i + batchSize);
					await uploadTraceFiles(
						target,
						batch.map(s => ({ path: remotePath(s), content: s.jsonl })),
						token,
						`Upload ${batch.length} Copilot trace${batch.length === 1 ? '' : 's'}`,
						hubUrl(),
					);
				}
			},
		);

		const uploaded = { ...ctx.globalState.get<Record<string, number>>(UPLOADED_KEY, {}) };
		for (const s of sessions) {
			uploaded[s.info.sessionId] = s.info.mtimeMs;
		}
		await ctx.globalState.update(UPLOADED_KEY, uploaded);
		output.info(`Uploaded ${sessions.length} session(s) to ${targetToString(target)}`);

		if (interactive) {
			const choice = await vscode.window.showInformationMessage(
				`Uploaded ${sessions.length} session${sessions.length === 1 ? '' : 's'} to ${targetToString(target)}.`,
				'Open in Browser',
			);
			if (choice === 'Open in Browser') {
				vscode.env.openExternal(vscode.Uri.parse(targetUrl(target, hubUrl())));
			}
		}
		return true;
	} catch (e) {
		output.error(`Upload failed: ${errorMessage(e)}`);
		if (interactive) {
			vscode.window.showErrorMessage(`Uploading traces failed: ${errorMessage(e)}`);
		}
		return false;
	} finally {
		busy = false;
	}
}

// ---------------------------------------------------------------------------
// Auto upload

function scheduleAutoUpload(): void {
	if (autoTimer) {
		clearInterval(autoTimer);
		autoTimer = undefined;
	}
	if (!cfg().get<boolean>('autoUpload.enabled', false)) {
		return;
	}
	const minutes = Math.max(5, cfg().get<number>('autoUpload.intervalMinutes', 30));
	autoTimer = setInterval(() => void autoUpload(), minutes * 60_000);
	setTimeout(() => void autoUpload(), 30_000);
}

async function autoUpload(): Promise<void> {
	const target = parseTarget(cfg().get<string>('target', '') ?? '');
	if (!target || busy) {
		return; // auto upload only runs once a target has been chosen interactively
	}
	const scope = cfg().get<'workspace' | 'all'>('autoUpload.scope', 'workspace');
	if (scope === 'workspace' && !currentWorkspaceId()) {
		return;
	}
	const uploaded = ctx.globalState.get<Record<string, number>>(UPLOADED_KEY, {});
	const quietMs = 5 * 60_000; // skip sessions that are still being written to
	const changed = discover(scope).filter(s => (uploaded[s.sessionId] ?? 0) < s.mtimeMs && Date.now() - s.mtimeMs > quietMs);
	if (!changed.length) {
		return;
	}
	const sessions = await loadSessions(changed);
	if (sessions.length) {
		output.info(`Auto-uploading ${sessions.length} changed session(s)`);
		await upload(sessions, false);
	}
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
