import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRepo, repoExists, uploadFiles, whoAmI } from '@huggingface/hub';
import type { RepoDesignation } from '@huggingface/hub';

export type TargetType = 'dataset' | 'bucket';

export interface Target {
	type: TargetType;
	/** `namespace/name` */
	name: string;
}

/** Parses "user/name", "datasets/user/name", "buckets/user/name" or "hf://buckets/user/name". */
export function parseTarget(input: string, defaultType: TargetType = 'dataset'): Target | undefined {
	let s = input.trim().replace(/^hf:\/\//, '').replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/+$/, '');
	let type: TargetType = defaultType;
	const m = /^(datasets|buckets)\/(.+)$/.exec(s);
	if (m) {
		type = m[1] === 'buckets' ? 'bucket' : 'dataset';
		s = m[2];
	}
	if (!/^[\w.-]+\/[\w.-]+$/.test(s)) {
		return undefined;
	}
	return { type, name: s };
}

export function targetToString(t: Target): string {
	return `${t.type === 'bucket' ? 'buckets' : 'datasets'}/${t.name}`;
}

export function targetUrl(t: Target, hubUrl = 'https://huggingface.co'): string {
	return `${hubUrl}/${targetToString(t)}`;
}

function repo(t: Target): RepoDesignation {
	return { type: t.type, name: t.name };
}

/** Reads a token cached by the `hf` CLI / huggingface_hub, if any. */
export function readCachedToken(): string | undefined {
	if (process.env.HF_TOKEN) {
		return process.env.HF_TOKEN.trim();
	}
	if (process.env.HUGGING_FACE_HUB_TOKEN) {
		return process.env.HUGGING_FACE_HUB_TOKEN.trim();
	}
	const candidates = [
		process.env.HF_TOKEN_PATH,
		process.env.HF_HOME ? path.join(process.env.HF_HOME, 'token') : undefined,
		path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'), 'huggingface', 'token'),
	].filter((p): p is string => !!p);
	for (const p of candidates) {
		try {
			const t = fs.readFileSync(p, 'utf8').trim();
			if (t) {
				return t;
			}
		} catch {
			/* not found */
		}
	}
	return undefined;
}

export async function getUsername(accessToken: string, hubUrl?: string): Promise<string> {
	const info = await whoAmI({ accessToken, hubUrl });
	return info.name;
}

export async function ensureTarget(t: Target, accessToken: string, visibility: 'private' | 'public', hubUrl?: string): Promise<{ created: boolean }> {
	if (await repoExists({ repo: repo(t), accessToken, hubUrl })) {
		return { created: false };
	}
	await createRepo({ repo: repo(t), accessToken, hubUrl, visibility });
	return { created: true };
}

export interface UploadFile {
	path: string;
	content: string;
}

export async function uploadTraceFiles(t: Target, files: UploadFile[], accessToken: string, commitTitle: string, hubUrl?: string): Promise<void> {
	await uploadFiles({
		repo: repo(t),
		accessToken,
		hubUrl,
		commitTitle,
		files: files.map(f => ({ path: f.path, content: new Blob([f.content], { type: 'application/jsonl' }) })),
	});
}
