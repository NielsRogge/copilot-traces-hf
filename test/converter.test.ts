import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { convertSession, toJsonl } from '../src/converter';
import { parseTarget } from '../src/hub';
import { redactDeep } from '../src/redact';
import { listSessionFiles, readSessionFile, replayOperationLog } from '../src/sessionStore';
import { legacySession, operationLog } from './fixtures';

const opts = { harness: 'vscode-copilot' };

test('replays the jsonl operation log', () => {
	const s = replayOperationLog(operationLog());
	assert.equal(s.customTitle, 'Fixing utils test');
	assert.equal(s.requests.length, 2);
	assert.equal(s.requests[0].response.length, 4);
	assert.ok(s.requests[0].result.metadata.toolCallRounds);
	assert.equal(s.requesterUsername, undefined);
});

test('converts agent-mode rounds into assistant/tool messages', () => {
	const r = convertSession(legacySession, 'sess-legacy', opts);
	assert.equal(r.header.type, 'session');
	assert.equal(r.header.harness, 'vscode-copilot');
	assert.equal(r.header.id, 'sess-legacy');
	assert.deepEqual(r.header.models, ['gpt-5', 'claude-sonnet-4.5']);
	const roles = r.messages.map(m => m.role);
	// agent request: user, a(tool), tool, a(tool), tool, a(final); ask request: user, a(tool), tool, a(final)
	assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
	const a1 = r.messages[1];
	assert.equal(a1.reasoningContent, 'Need to read the file.');
	assert.equal(a1.toolCalls![0].function.name, 'copilot_readFile');
	assert.equal(a1.toolCalls![0].function.arguments, '{"filePath":"/home/alice/proj/utils.ts"}');
	assert.equal(a1.model, 'gpt-5');
	assert.equal(r.messages[2].toolCallId, 'call_read');
	assert.match(r.messages[2].content, /a - b/);
	assert.equal(r.messages[4].content, '1 passing\n0 failing');
	assert.equal(r.messages[5].content, 'Fixed it.');
});

test('converts ask-mode response parts', () => {
	const r = convertSession(legacySession, 'x', opts);
	const [, a, tool, fin] = r.messages.slice(6);
	assert.equal(a.reasoningContent, 'Simple question.');
	assert.equal(a.content, 'It adds two numbers, see `utils.ts`');
	assert.equal(a.toolCalls![0].function.arguments, '{"query":"**/*.ts"}');
	assert.equal(tool.content, 'utils.ts\nindex.ts');
	assert.equal(fin.content, 'Done.');
});

test('json and jsonl produce the same trace', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-'));
	const ws = path.join(dir, 'User', 'workspaceStorage', 'abc123');
	fs.mkdirSync(path.join(ws, 'chatSessions'), { recursive: true });
	fs.writeFileSync(path.join(ws, 'workspace.json'), JSON.stringify({ folder: 'file:///home/alice/my%20proj' }));
	fs.writeFileSync(path.join(ws, 'chatSessions', 'sess-legacy.json'), JSON.stringify({ ...legacySession, customTitle: 'Fixing utils test' }));
	fs.writeFileSync(path.join(ws, 'chatSessions', 'sess-legacy.jsonl'), operationLog());
	const empty = path.join(dir, 'User', 'globalStorage', 'emptyWindowChatSessions');
	fs.mkdirSync(empty, { recursive: true });
	fs.writeFileSync(path.join(empty, 'other.json'), JSON.stringify(legacySession));

	const files = listSessionFiles(path.join(dir, 'User'));
	assert.equal(files.length, 2);
	const ws1 = files.find(f => f.workspaceId === 'abc123')!;
	assert.equal(ws1.format, 'jsonl');
	assert.equal(ws1.workspaceName, 'my proj');
	assert.equal(files.find(f => !f.workspaceId)!.workspaceName, '(no folder)');

	const fromLog = convertSession(readSessionFile(ws1.file), 'id', opts);
	const fromJson = convertSession(JSON.parse(fs.readFileSync(path.join(ws, 'chatSessions', 'sess-legacy.json'), 'utf8')), 'id', opts);
	assert.deepEqual(fromLog, fromJson);
	assert.equal(fromLog.header.name, 'Fixing utils test');
});

test('jsonl output follows the STS format', () => {
	const out = toJsonl(convertSession(legacySession, 'id', opts));
	const lines = out.trim().split('\n').map(l => JSON.parse(l));
	assert.equal(lines[0].type, 'session');
	for (const l of lines.slice(1)) {
		assert.equal(l.type, 'message');
		assert.ok(['user', 'assistant', 'tool', 'system'].includes(l.message.role));
		assert.equal(typeof l.message.content, 'string');
		for (const tc of l.message.toolCalls ?? []) {
			assert.equal(typeof tc.function.arguments, 'string');
			JSON.parse(tc.function.arguments);
		}
	}
});

test('redacts secrets and home directory', () => {
	const r = convertSession(legacySession, 'id', opts);
	const { value, count } = redactDeep(r.messages, { secrets: true, replacements: [{ find: '/home/alice', replace: '~' }] });
	const text = JSON.stringify(value);
	assert.ok(!text.includes('hf_abcdefghijklmnopqrstuvwxyz0123456789'));
	assert.ok(text.includes('[REDACTED_HF_TOKEN]'));
	assert.ok(!text.includes('/home/alice'));
	assert.ok(count >= 2);
});

test('parses upload targets', () => {
	assert.deepEqual(parseTarget('alice/traces'), { type: 'dataset', name: 'alice/traces' });
	assert.deepEqual(parseTarget('datasets/alice/traces'), { type: 'dataset', name: 'alice/traces' });
	assert.deepEqual(parseTarget('hf://buckets/alice/traces'), { type: 'bucket', name: 'alice/traces' });
	assert.deepEqual(parseTarget('https://huggingface.co/datasets/alice/traces/'), { type: 'dataset', name: 'alice/traces' });
	assert.equal(parseTarget('nope'), undefined);
});
