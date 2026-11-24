import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { mask, parseLine, redactFindings, scanTraces, TruffleHogNotFoundError, truffleHogVersion } from '../src/trufflehog';

const fake = path.join(__dirname, 'fake-trufflehog.js');
const line = (content: string) => JSON.stringify({ type: 'message', message: { role: 'tool', content } });
// Short ghp_ token that the regex redaction does NOT catch (it requires 36+ chars), so only TruffleHog finds it.
const secret = 'ghp_shortButStillSecret123';

test('parses TruffleHog JSON findings and ignores log lines', () => {
	assert.equal(parseLine('{"level":"info-0","msg":"running"}'), undefined);
	assert.equal(parseLine('not json'), undefined);
	const p = parseLine(JSON.stringify({ SourceMetadata: { Data: { Filesystem: { file: '/x/a.jsonl', line: 3 } } }, DetectorName: 'AWS', Verified: true, Raw: 'AKIAXXXXXXXXXXXXXXXX' }));
	assert.equal(p!.file, '/x/a.jsonl');
	assert.equal(p!.finding.status, 'verified');
	assert.equal(p!.finding.line, 3);
	assert.ok(!p!.finding.masked.includes('XXXXXXXXXXXX'));
	assert.equal(parseLine(JSON.stringify({ SourceMetadata: { Data: { Filesystem: { file: 'f' } } }, DetectorName: 'X', VerificationError: 'timeout', Raw: 'abc' }))!.finding.status, 'unknown');
});

test('masks secrets', () => {
	assert.equal(mask('short'), '*****');
	assert.equal(mask('ghp_abcdefghijkl'), 'ghp_…kl (16 chars)');
});

test('scans traces with the trufflehog binary and maps findings back', async () => {
	const argsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'th-')), 'args.json');
	process.env.FAKE_TH_ARGS = argsFile;
	const traces = new Map([
		['a', [line('clean'), line('nothing here')].join('\n')],
		['b', [line('ok'), line(`export TOKEN=${secret}`)].join('\n')],
	]);
	const r = await scanTraces(traces, { binary: fake, verify: false });
	assert.deepEqual(r.findings.get('a'), []);
	const fb = r.findings.get('b')!;
	assert.equal(fb.length, 1);
	assert.equal(fb[0].detector, 'Github');
	assert.equal(fb[0].line, 2);
	const args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
	assert.ok(args.includes('--json') && args.includes('--no-update') && args.includes('--no-verification'));
	const r2 = await scanTraces(new Map([['a', 'x']]), { binary: fake, verify: true });
	assert.ok(!JSON.parse(fs.readFileSync(argsFile, 'utf8')).includes('--no-verification'));
	assert.deepEqual(r2.findings.get('a'), []);
});

test('redacts findings and keeps every line valid JSON', async () => {
	const text = [line('a'), line(`TOKEN=${secret} and again ${secret}`)].join('\n') + '\n';
	const r = await scanTraces(new Map([['t', text]]), { binary: fake, verify: false });
	const red = redactFindings(text, r.findings.get('t')!);
	assert.ok(red);
	assert.equal(red!.count, 2);
	assert.ok(!red!.text.includes(secret));
	assert.ok(red!.text.includes('[REDACTED_TRUFFLEHOG_GITHUB]'));
	red!.text.trim().split('\n').forEach(l => JSON.parse(l));
});

test('holds back traces whose secret cannot be located (decoded findings)', async () => {
	const text = line('blob BASE64SECRET') + '\n';
	const r = await scanTraces(new Map([['t', text]]), { binary: fake, verify: false });
	assert.equal(r.findings.get('t')!.length, 1);
	assert.equal(redactFindings(text, r.findings.get('t')!), undefined);
});

test('reports a missing binary', async () => {
	await assert.rejects(scanTraces(new Map([['a', 'x']]), { binary: '/nonexistent/trufflehog', verify: false }), TruffleHogNotFoundError);
	assert.equal(await truffleHogVersion('/nonexistent/trufflehog'), undefined);
	assert.equal(await truffleHogVersion(fake), 'trufflehog 3.99.0-fake');
});
