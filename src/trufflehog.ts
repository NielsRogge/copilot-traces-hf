/**
 * Optional secret scanning with TruffleHog (https://github.com/trufflesecurity/trufflehog),
 * the same scanner pi-share-hf uses. Traces are written to a temporary directory, scanned with
 * `trufflehog filesystem --json`, and every matched secret is either replaced with a placeholder
 * or the whole session is held back from sharing.
 *
 * No dependency on the `vscode` API so it can be unit-tested.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type FindingStatus = 'verified' | 'unverified' | 'unknown';

export interface TruffleHogFinding {
	detector: string;
	status: FindingStatus;
	line?: number;
	/** Masked form of the secret, safe to show in logs and UI. */
	masked: string;
	/** The matched secret text (never logged or uploaded). */
	raw?: string;
}

export interface ScanOptions {
	/** Path to the trufflehog binary (default: `trufflehog` on PATH). */
	binary: string;
	/** Let TruffleHog check candidate secrets against the issuing service (sends them to that service). */
	verify: boolean;
	timeoutMs?: number;
}

export interface ScanResult {
	/** id → findings for that trace (traces without findings map to []). */
	findings: Map<string, TruffleHogFinding[]>;
}

export class TruffleHogNotFoundError extends Error {
	constructor(binary: string) {
		super(`TruffleHog was not found ("${binary}"). Install it from https://github.com/trufflesecurity/trufflehog (e.g. "brew install trufflehog") or set copilotTraces.trufflehog.path.`);
	}
}

function run(binary: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(binary, args, { maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, windowsHide: true }, (err, stdout, stderr) => {
			if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
				reject(new TruffleHogNotFoundError(binary));
				return;
			}
			const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
			resolve({ code, stdout: String(stdout), stderr: String(stderr) });
		});
	});
}

export async function truffleHogVersion(binary: string): Promise<string | undefined> {
	try {
		const r = await run(binary, ['--version'], 15_000);
		return (r.stdout || r.stderr).trim().split('\n')[0] || 'unknown version';
	} catch {
		return undefined;
	}
}

/** Scans trace texts (id → JSONL) with TruffleHog. */
export async function scanTraces(traces: Map<string, string>, opts: ScanOptions): Promise<ScanResult> {
	const findings = new Map<string, TruffleHogFinding[]>();
	if (traces.size === 0) {
		return { findings };
	}
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-traces-scan-'));
	const fileToId = new Map<string, string>();
	try {
		let i = 0;
		for (const [id, text] of traces) {
			const file = path.join(dir, `trace-${i++}.jsonl`);
			fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
			fileToId.set(path.resolve(file), id);
			findings.set(id, []);
		}
		const args = ['filesystem', dir, '--json', '--no-update', '--no-color', '--results=verified,unknown,unverified'];
		if (!opts.verify) {
			args.push('--no-verification');
		}
		const r = await run(opts.binary, args, opts.timeoutMs ?? 10 * 60_000);
		// trufflehog exits 0 on success (183 only with --fail and findings).
		if (r.code !== 0 && r.code !== 183) {
			throw new Error(`trufflehog exited with code ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
		}
		const seen = new Set<string>();
		for (const line of r.stdout.split('\n')) {
			const parsed = parseLine(line);
			if (!parsed) {
				continue;
			}
			const id = fileToId.get(path.resolve(parsed.file));
			if (id === undefined) {
				continue;
			}
			const key = JSON.stringify([id, parsed.finding.detector, parsed.finding.line ?? -1, parsed.finding.raw ?? '']);
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			findings.get(id)!.push(parsed.finding);
		}
		return { findings };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export function parseLine(line: string): { file: string; finding: TruffleHogFinding } | undefined {
	const trimmed = line.trim();
	if (!trimmed.startsWith('{')) {
		return undefined;
	}
	let v: Any;
	try {
		v = JSON.parse(trimmed);
	} catch {
		return undefined;
	}
	if (typeof v?.DetectorName !== 'string') {
		return undefined; // log lines, not findings
	}
	const fsMeta = v.SourceMetadata?.Data?.Filesystem;
	if (typeof fsMeta?.file !== 'string') {
		return undefined;
	}
	const raw = typeof v.Raw === 'string' && v.Raw ? v.Raw : undefined;
	const extra = v.ExtraData ?? {};
	const status: FindingStatus = v.Verified === true
		? 'verified'
		: (v.VerificationError || extra.verification_error || extra.verificationError) ? 'unknown' : 'unverified';
	return {
		file: fsMeta.file,
		finding: {
			detector: v.DetectorName,
			status,
			line: typeof fsMeta.line === 'number' ? fsMeta.line : undefined,
			masked: raw ? mask(raw) : '[REDACTED]',
			raw,
		},
	};
}

export function mask(secret: string): string {
	if (secret.length <= 8) {
		return '*'.repeat(secret.length);
	}
	return `${secret.slice(0, 4)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/**
 * Replaces each finding's secret in the JSONL trace with `[REDACTED_TRUFFLEHOG_<DETECTOR>]`.
 * Returns undefined if a secret could not be removed safely (e.g. it was only found in a
 * decoded/base64 form, or the replacement would break a JSON line); such traces should be held back.
 */
export function redactFindings(jsonl: string, findings: TruffleHogFinding[]): { text: string; count: number } | undefined {
	let text = jsonl;
	let count = 0;
	// Longest first so overlapping secrets are fully removed.
	if (findings.some(f => !f.raw || f.raw.length < 6)) {
		return undefined;
	}
	const raws = [...new Set(findings.map(f => f.raw as string))].sort((a, b) => b.length - a.length);
	for (const raw of raws) {
		const finding = findings.find(f => f.raw === raw)!;
		const label = `[REDACTED_TRUFFLEHOG_${finding.detector.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}]`;
		const variants = [raw, JSON.stringify(raw).slice(1, -1)];
		let hit = false;
		for (const variant of variants) {
			if (variant && text.includes(variant)) {
				const parts = text.split(variant);
				count += parts.length - 1;
				text = parts.join(label);
				hit = true;
			}
		}
		if (!hit) {
			return undefined;
		}
	}
	for (const line of text.split('\n')) {
		if (line.trim()) {
			try {
				JSON.parse(line);
			} catch {
				return undefined;
			}
		}
	}
	return { text, count };
}
