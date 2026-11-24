/**
 * Best-effort redaction of secrets and local paths before traces leave the machine.
 * This is NOT a guarantee: always review traces before publishing them publicly.
 */

export interface RedactOptions {
	secrets: boolean;
	/** Replace occurrences of these strings (e.g. home directory, username) with a placeholder. */
	replacements?: { find: string; replace: string }[];
	/** Additional user-provided regular expressions. */
	customPatterns?: string[];
}

const SECRET_PATTERNS: [string, RegExp][] = [
	['HF_TOKEN', /\bhf_[A-Za-z0-9]{30,}\b/g],
	['GITHUB_TOKEN', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g],
	['GITHUB_PAT', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
	['OPENAI_KEY', /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g],
	['ANTHROPIC_KEY', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
	['AWS_ACCESS_KEY', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
	['GOOGLE_API_KEY', /\bAIza[0-9A-Za-z_-]{35}\b/g],
	['SLACK_TOKEN', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
	['STRIPE_KEY', /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
	['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
	['PRIVATE_KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g],
	// key=value / "key": "value" style assignments of obviously secret names
	['SECRET', /(?<=\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["']?)[^\s"',;]{8,}/gi],
];

export function redactString(input: string, opts: RedactOptions): { text: string; count: number } {
	let text = input;
	let count = 0;
	if (opts.secrets) {
		for (const [label, re] of SECRET_PATTERNS) {
			text = text.replace(re, () => {
				count++;
				return `[REDACTED_${label}]`;
			});
		}
	}
	for (const p of opts.customPatterns ?? []) {
		let re: RegExp;
		try {
			re = new RegExp(p, 'g');
		} catch {
			continue;
		}
		text = text.replace(re, () => {
			count++;
			return '[REDACTED]';
		});
	}
	for (const { find, replace } of opts.replacements ?? []) {
		if (find && find.length >= 3 && text.includes(find)) {
			const parts = text.split(find);
			count += parts.length - 1;
			text = parts.join(replace);
		}
	}
	return { text, count };
}

/** Recursively redacts every string inside a JSON-compatible value. */
export function redactDeep<T>(value: T, opts: RedactOptions): { value: T; count: number } {
	let count = 0;
	const visit = (v: unknown): unknown => {
		if (typeof v === 'string') {
			const r = redactString(v, opts);
			count += r.count;
			return r.text;
		}
		if (Array.isArray(v)) {
			return v.map(visit);
		}
		if (v && typeof v === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, val] of Object.entries(v)) {
				out[k] = visit(val);
			}
			return out;
		}
		return v;
	};
	return { value: visit(value) as T, count };
}
