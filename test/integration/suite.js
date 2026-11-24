const assert = require('assert');
const vscode = require('vscode');

exports.run = async function () {
	const ext = vscode.extensions.getExtension('huggingface.copilot-traces-hf');
	assert.ok(ext, 'extension not found');
	const api = await ext.activate();
	const cmds = await vscode.commands.getCommands(true);
	for (const c of ['previewSession', 'exportSessions', 'uploadSessions', 'uploadWorkspaceSessions', 'uploadAllSessions', 'setToken', 'signOut', 'setTarget', 'openTarget']) {
		assert.ok(cmds.includes('copilotTraces.' + c), 'missing command ' + c);
	}
	const traces = await api.getTraces('all');
	assert.equal(traces.length, 1);
	assert.equal(traces[0].sessionId, 'sess-int');
	assert.equal(traces[0].title, 'Fixing utils test');
	const lines = traces[0].jsonl.trim().split('\n').map(l => JSON.parse(l));
	assert.equal(lines[0].type, 'session');
	assert.equal(lines[0].harness, 'vscode-copilot');
	assert.ok(lines.length > 5);
	assert.ok(!traces[0].jsonl.includes('hf_abcdefghijklmnopqrstuvwxyz0123456789'), 'secret not redacted');
	console.log('INTEGRATION OK:', lines.length, 'lines,', lines[0].name);
};
