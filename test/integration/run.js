// Launches a real VS Code with a seeded user-data dir and checks the extension end to end.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { runTests } = require('@vscode/test-electron');

async function main() {
	const root = path.resolve(__dirname, '../..');
	const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-vscode-'));
	const sessions = path.join(userDataDir, 'User', 'globalStorage', 'emptyWindowChatSessions');
	fs.mkdirSync(sessions, { recursive: true });
	const { operationLog } = require(path.join(root, 'out/test/fixtures.js'));
	fs.writeFileSync(path.join(sessions, 'sess-int.jsonl'), operationLog());
	await runTests({
		extensionDevelopmentPath: root,
		extensionTestsPath: path.join(__dirname, 'suite.js'),
		launchArgs: ['--user-data-dir', userDataDir, '--disable-extensions', '--disable-gpu', '--no-sandbox'],
	});
}
main().catch(e => { console.error(e); process.exit(1); });
