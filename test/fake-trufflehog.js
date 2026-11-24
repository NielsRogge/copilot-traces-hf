#!/usr/bin/env node
// Stand-in for the trufflehog CLI used in tests: mimics `trufflehog filesystem <dir> --json`
// output (one JSON object per finding, plus log lines), detecting a fake "ghp_" token.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('trufflehog 3.99.0-fake'); process.exit(0); }
if (args[0] !== 'filesystem') { console.error('unsupported'); process.exit(2); }
fs.writeFileSync(process.env.FAKE_TH_ARGS || '/dev/null', JSON.stringify(args));
const dir = args[1];
console.log(JSON.stringify({ level: 'info-0', msg: 'running source', source_manager_worker_id: 'x' }));
for (const name of fs.readdirSync(dir)) {
  const file = path.join(dir, name);
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/ghp_[A-Za-z0-9]{6,}|BASE64SECRET/g)) {
      const raw = m[0] === 'BASE64SECRET' ? 'decoded-value-not-in-file' : m[0];
      console.log(JSON.stringify({
        SourceMetadata: { Data: { Filesystem: { file, line: i + 1 } } },
        SourceName: 'trufflehog - filesystem', DetectorType: 8, DetectorName: 'Github',
        DecoderName: m[0] === 'BASE64SECRET' ? 'BASE64' : 'PLAIN', Verified: false, Raw: raw, ExtraData: null,
      }));
    }
  });
}
