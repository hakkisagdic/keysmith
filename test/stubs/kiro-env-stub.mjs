#!/usr/bin/env node
/**
 * A stand-in `kiro-cli` for test/kiro-api-env.test.js. It checks its own KIRO_API_KEY against the
 * value held in the file named by STUB_EXPECT_FILE and prints only OK or BAD, never the value
 * (except in STUB_LEAK mode, which writes it to stderr to prove the gateway redacts it).
 * `/usage` runs print a plan reading; chat runs print a kiro stream-json answer.
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('2.27.1\n');
  process.exit(0);
}
// `node --test` also runs this file on its own: with no test plumbing there is nothing to do.
if (!process.env.STUB_EXPECT_FILE) process.exit(0);
const expected = fs.readFileSync(process.env.STUB_EXPECT_FILE, 'utf8');
const got = process.env.KIRO_API_KEY;
const verdict = got === expected ? 'ENV_OK' : 'ENV_BAD';
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ usage: argv.at(-1) === '/usage', verdict }) + '\n');
if (process.env.STUB_LEAK) {
  process.stderr.write(`boom: ${got}\n`);
  process.exit(1);
}
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');
if (argv.at(-1) === '/usage') {
  process.stdout.write(`Estimated Usage | resets on 2026-12-01 | KIRO POWER\nCredits (${verdict === 'ENV_OK' ? 100 : 9999} of 10000 covered in plan), 1.0%\n`);
  process.exit(0);
}
const sessionId = 'ks-stub';
line({ type: 'runStarted', data: { payloadSchema: 'acp', acpProtocolVersion: 1, engine: 'v2' } });
line({ type: 'metadata', data: { sessionId, contextUsagePercentage: 0.7 } });
line({ type: 'sessionUpdate', data: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: verdict } } } });
line({ type: 'runFinished', data: { finalText: verdict, finalTextTruncated: false } });
