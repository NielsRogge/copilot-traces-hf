/**
 * Converts a VS Code chat (GitHub Copilot) session into the Hugging Face
 * "Session Trace Simple Format" (STS-Format), which the Hub's trace viewer renders.
 *
 * See https://huggingface.co/docs/hub/en/session-traces-format
 *
 *   {"type":"session","harness":"...","id":"...","name":"..."}
 *   {"type":"message","message":{"role":"user","content":"..."}}
 *   {"type":"message","message":{"role":"assistant","content":"","toolCalls":[{"id":"t1","function":{"name":"x","arguments":"{}"}}]}}
 *   {"type":"message","message":{"role":"tool","toolCallId":"t1","content":"..."}}
 */
import type { ChatSessionData } from './sessionStore';

export interface StsToolCall {
	id: string;
	type?: 'function';
	function: { name: string; arguments: string };
}

export interface StsMessage {
	role: 'user' | 'assistant' | 'system' | 'tool';
	content: string;
	reasoningContent?: string;
	toolCalls?: StsToolCall[];
	toolCallId?: string;
	name?: string;
	timestamp?: number;
	model?: string;
}

export interface StsHeader {
	type: 'session';
	harness: string;
	id: string;
	name?: string;
	[extra: string]: unknown;
}

export type StsLine = StsHeader | { type: 'message'; message: StsMessage };

export interface ConvertOptions {
	harness: string;
	/** Extra metadata merged into the session header. */
	headerExtras?: Record<string, unknown>;
	/** Max characters kept for a single tool result (0 = unlimited). */
	maxToolResultChars?: number;
}

export interface ConvertResult {
	header: StsHeader;
	messages: StsMessage[];
	requestCount: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function sessionTitle(session: ChatSessionData): string {
	if (typeof session?.customTitle === 'string' && session.customTitle.trim()) {
		return session.customTitle.trim();
	}
	const first = (session?.requests ?? []).find((r: Any) => typeof r?.message?.text === 'string' && r.message.text.trim());
	if (first) {
		const t = String(first.message.text).replace(/\s+/g, ' ').trim();
		return t.length > 80 ? t.slice(0, 77) + '...' : t;
	}
	return 'Untitled chat';
}

export function convertSession(session: ChatSessionData, sessionId: string, opts: ConvertOptions): ConvertResult {
	const requests: Any[] = (session?.requests ?? []).filter((r: Any) => r && !r.isHidden && !r.hiddenFromTranscript);
	const messages: StsMessage[] = [];
	const models = new Set<string>();

	for (const req of requests) {
		const model = normalizeModel(req.modelId);
		if (model) {
			models.add(model);
		}
		const userText = typeof req.message?.text === 'string' ? req.message.text : '';
		if (!req.requestHiddenFromTranscript) {
			messages.push(clean({ role: 'user', content: userText, timestamp: num(req.timestamp) }));
		}

		const rounds: Any[] | undefined = req.result?.metadata?.toolCallRounds;
		if (Array.isArray(rounds) && rounds.length > 0) {
			messages.push(...convertToolCallRounds(req, rounds, model, opts));
		} else {
			messages.push(...convertResponseParts(req, model, opts));
		}

		const errorMessage = req.result?.errorDetails?.message;
		if (typeof errorMessage === 'string' && errorMessage) {
			messages.push(clean({ role: 'system', content: `Error: ${errorMessage}`, timestamp: num(req.responseTimestamp) }));
		}
	}

	const first = requests[0];
	const last = requests[requests.length - 1];
	const header: StsHeader = {
		type: 'session',
		harness: opts.harness,
		id: sessionId,
		name: sessionTitle(session),
		agent: 'GitHub Copilot',
		source: 'vscode-chat',
		createdAt: toIso(session?.creationDate ?? first?.timestamp),
		updatedAt: toIso(session?.lastMessageDate ?? last?.responseTimestamp ?? last?.timestamp),
		models: [...models],
		mode: first?.modeInfo?.modeId ?? first?.modeInfo?.kind ?? undefined,
		...opts.headerExtras,
	};
	for (const k of Object.keys(header)) {
		if (header[k] === undefined) {
			delete header[k];
		}
	}

	return { header, messages, requestCount: requests.length };
}

/** Agent-mode requests: Copilot persists the exact model/tool loop in result.metadata. */
function convertToolCallRounds(req: Any, rounds: Any[], model: string | undefined, opts: ConvertOptions): StsMessage[] {
	const out: StsMessage[] = [];
	const results: Record<string, Any> = req.result?.metadata?.toolCallResults ?? {};
	const invocations = toolInvocationsById(req.response);

	for (const round of rounds) {
		const toolCalls: StsToolCall[] = (round?.toolCalls ?? []).map((tc: Any, i: number) => ({
			id: String(tc?.id ?? `${round?.id ?? 'call'}_${i}`),
			type: 'function' as const,
			function: { name: String(tc?.name ?? 'unknown'), arguments: argString(tc?.arguments) },
		}));
		out.push(clean({
			role: 'assistant',
			content: typeof round?.response === 'string' ? round.response : '',
			reasoningContent: thinkingText(round?.thinking),
			toolCalls: toolCalls.length ? toolCalls : undefined,
			timestamp: num(round?.timestamp),
			model,
		}));
		for (const tc of toolCalls) {
			let content: string | undefined;
			if (results[tc.id] !== undefined) {
				content = extractText(results[tc.id]);
			}
			if (!content && invocations.has(tc.id)) {
				content = invocationResultText(invocations.get(tc.id));
			}
			out.push(clean({
				role: 'tool',
				toolCallId: tc.id,
				name: tc.function.name,
				content: truncate(content ?? '', opts.maxToolResultChars),
				timestamp: num(invocations.get(tc.id)?.completedAt),
			}));
		}
	}

	// Copilot sometimes renders a final answer that is not part of the last round
	// (e.g. when the request was cancelled mid-loop). Nothing to add in that case.
	return out;
}

/** Ask/edit mode or other chat participants: rebuild the turn from the rendered response parts. */
function convertResponseParts(req: Any, model: string | undefined, opts: ConvertOptions): StsMessage[] {
	const out: StsMessage[] = [];
	const parts: Any[] = Array.isArray(req.response) ? req.response : [];
	let text = '';
	let reasoning = '';
	let pendingCalls: StsToolCall[] = [];
	let pendingResults: StsMessage[] = [];
	const ts = num(req.responseTimestamp) ?? num(req.timestamp);

	const flush = () => {
		if (!text && !reasoning && !pendingCalls.length) {
			return;
		}
		out.push(clean({
			role: 'assistant',
			content: text,
			reasoningContent: reasoning || undefined,
			toolCalls: pendingCalls.length ? pendingCalls : undefined,
			timestamp: ts,
			model,
		}));
		out.push(...pendingResults);
		text = '';
		reasoning = '';
		pendingCalls = [];
		pendingResults = [];
	};

	for (const part of parts) {
		if (!part) {
			continue;
		}
		const kind = part.kind;
		if (kind === undefined || kind === 'markdownContent') {
			const value = kind === 'markdownContent' ? part.content?.value : part.value;
			if (typeof value === 'string') {
				if (pendingCalls.length) {
					flush();
				}
				text += value;
			}
		} else if (kind === 'inlineReference') {
			text += '`' + referenceName(part) + '`';
		} else if (kind === 'thinking') {
			if (pendingCalls.length) {
				flush();
			}
			reasoning += thinkingText(part) ?? '';
		} else if (kind === 'toolInvocationSerialized' || kind === 'toolInvocation') {
			const id = String(part.toolCallId ?? `call_${pendingCalls.length}`);
			const name = String(part.toolId ?? 'tool');
			pendingCalls.push({ id, type: 'function', function: { name, arguments: invocationArguments(part) } });
			pendingResults.push(clean({
				role: 'tool',
				toolCallId: id,
				name,
				content: truncate(invocationResultText(part), opts.maxToolResultChars),
				timestamp: num(part.completedAt),
			}));
		} else if (kind === 'textEditGroup') {
			const file = uriToString(part.uri);
			if (file) {
				text += `\n\n_Edited \`${file}\`_\n`;
			}
		} else if (kind === 'warning' || kind === 'info') {
			const v = part.content?.value ?? part.content;
			if (typeof v === 'string') {
				text += `\n\n> ${v}\n`;
			}
		}
	}
	flush();
	return out;
}

function toolInvocationsById(parts: Any): Map<string, Any> {
	const map = new Map<string, Any>();
	if (Array.isArray(parts)) {
		for (const p of parts) {
			if (p && (p.kind === 'toolInvocationSerialized' || p.kind === 'toolInvocation') && p.toolCallId) {
				map.set(String(p.toolCallId), p);
			}
		}
	}
	return map;
}

function invocationArguments(part: Any): string {
	const d = part.resultDetails;
	if (d && typeof d === 'object' && !Array.isArray(d) && typeof d.input === 'string') {
		return d.input;
	}
	const s = part.toolSpecificData;
	if (s?.kind === 'terminal') {
		const command = s.commandLine?.userEdited ?? s.commandLine?.toolEdited ?? s.commandLine?.original ?? s.command;
		return JSON.stringify({ command, ...(s.language ? { language: s.language } : {}) });
	}
	if (s?.kind === 'input' && s.rawInput !== undefined) {
		return argString(s.rawInput);
	}
	const msg = mdText(part.invocationMessage);
	return JSON.stringify(msg ? { description: msg } : {});
}

function invocationResultText(part: Any): string {
	if (!part) {
		return '';
	}
	const chunks: string[] = [];
	const d = part.resultDetails;
	if (Array.isArray(d)) {
		chunks.push(d.map(x => uriToString(x?.uri ?? x)).filter(Boolean).join('\n'));
	} else if (d && typeof d === 'object') {
		if (Array.isArray(d.output)) {
			for (const o of d.output) {
				if (o?.type === 'embed' && typeof o.value === 'string' && (o.isText ?? true)) {
					chunks.push(o.value);
				} else if (o?.type === 'ref') {
					chunks.push(uriToString(o.uri));
				}
			}
		}
	}
	const s = part.toolSpecificData;
	if (s?.kind === 'terminal' && s.terminalCommandOutput?.text) {
		chunks.push(String(s.terminalCommandOutput.text));
	}
	if (part.resultError) {
		chunks.push(`Error: ${typeof part.resultError === 'string' ? part.resultError : JSON.stringify(part.resultError)}`);
	}
	const joined = chunks.filter(Boolean).join('\n');
	return joined || mdText(part.pastTenseMessage) || mdText(part.invocationMessage) || '';
}

/**
 * Extracts readable text from a persisted LanguageModelToolResult. Parts are either
 * text parts ({ value: string }), data parts, or prompt-tsx trees ({ value: { node: ... } }).
 */
export function extractText(value: Any, depth = 0): string {
	if (value === null || value === undefined || depth > 64) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	if (Array.isArray(value)) {
		return value.map(v => extractText(v, depth + 1)).filter(Boolean).join('');
	}
	if (typeof value === 'object') {
		if (Array.isArray(value.content)) {
			return value.content.map((v: Any) => extractText(v, depth + 1)).filter(Boolean).join('\n');
		}
		if (typeof value.value === 'string') {
			return value.value;
		}
		// prompt-tsx text chunk
		if (typeof value.text === 'string' && !Array.isArray(value.children)) {
			return value.text;
		}
		if (value.value && typeof value.value === 'object') {
			return extractText(value.value, depth + 1);
		}
		if (value.node) {
			return extractText(value.node, depth + 1);
		}
		if (Array.isArray(value.children)) {
			return value.children.map((c: Any) => {
				const t = extractText(c, depth + 1);
				return c?.lineBreakBefore ? '\n' + t : t;
			}).join('');
		}
		if (typeof value.mimeType === 'string' && value.data !== undefined) {
			return `[${value.mimeType} data]`;
		}
	}
	return '';
}

function thinkingText(thinking: Any): string | undefined {
	if (!thinking) {
		return undefined;
	}
	const t = thinking.text ?? thinking.value;
	const s = Array.isArray(t) ? t.join('') : typeof t === 'string' ? t : '';
	return s.trim() ? s : undefined;
}

function argString(args: Any): string {
	if (typeof args === 'string') {
		return args;
	}
	try {
		return JSON.stringify(args ?? {});
	} catch {
		return '{}';
	}
}

function mdText(v: Any): string {
	if (typeof v === 'string') {
		return v;
	}
	if (v && typeof v.value === 'string') {
		return v.value;
	}
	return '';
}

function referenceName(part: Any): string {
	if (typeof part.name === 'string' && part.name) {
		return part.name;
	}
	const ref = part.inlineReference;
	const uri = ref?.uri ?? ref?.location?.uri ?? ref;
	const s = uriToString(uri);
	return s.split('/').pop() || s || 'reference';
}

function uriToString(uri: Any): string {
	if (!uri) {
		return '';
	}
	if (typeof uri === 'string') {
		return uri;
	}
	if (typeof uri.fsPath === 'string') {
		return uri.fsPath;
	}
	if (typeof uri.path === 'string') {
		return uri.scheme && uri.scheme !== 'file' ? `${uri.scheme}://${uri.authority ?? ''}${uri.path}` : uri.path;
	}
	if (typeof uri.external === 'string') {
		return uri.external;
	}
	return '';
}

function normalizeModel(modelId: unknown): string | undefined {
	if (typeof modelId !== 'string' || !modelId) {
		return undefined;
	}
	return modelId.replace(/^copilot\//, '');
}

function num(v: unknown): number | undefined {
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toIso(v: unknown): string | undefined {
	const n = num(v);
	return n !== undefined ? new Date(n).toISOString() : undefined;
}

function truncate(s: string, max: number | undefined): string {
	if (!max || s.length <= max) {
		return s;
	}
	return s.slice(0, max) + `\n…[truncated ${s.length - max} characters]`;
}

function clean(m: StsMessage): StsMessage {
	for (const k of Object.keys(m) as (keyof StsMessage)[]) {
		if (m[k] === undefined) {
			delete m[k];
		}
	}
	return m;
}

export function toJsonl(result: ConvertResult): string {
	const lines: StsLine[] = [result.header, ...result.messages.map(message => ({ type: 'message' as const, message }))];
	return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}
