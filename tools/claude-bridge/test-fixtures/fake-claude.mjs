#!/usr/bin/env node
// Stand-in for the `claude` executable in tests (CLAUDE_BIN). Records what it
// was given to $FAKE_RECORD and behaves per $FAKE_MODE: ok | slow | sleep | error | tools | noinit.
// With `--input-format stream-json` it answers in stream-json lines (init + result),
// as the real CLI does; FAKE_MODE=tools makes its init event report a tool, and
// FAKE_MODE=noinit leaves the init event out.
import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--system-prompt-file');
  const rec = {
    argv,
    cwd: process.cwd(),
    cwdEntries: readdirSync(process.cwd()),
    stdin: Buffer.concat(chunks).toString('utf8'),
    system: i >= 0 ? readFileSync(argv[i + 1], 'utf8') : null,
    pid: process.pid,
  };
  if (process.env.FAKE_RECORD) writeFileSync(process.env.FAKE_RECORD, JSON.stringify(rec));
  const mode = process.env.FAKE_MODE || 'ok';
  const a = argv.indexOf('--input-format');
  const stream = a >= 0 && argv[a + 1] === 'stream-json';
  const init = { type: 'system', subtype: 'init', tools: mode === 'tools' ? ['Bash'] : [], mcp_servers: [] };
  const head = stream && mode !== 'noinit' ? JSON.stringify(init) + '\n' : '';
  if (mode === 'sleep') {
    setTimeout(() => {}, 600000);
    return;
  }
  if (mode === 'slow') {
    const start = Date.now();
    setTimeout(() => {
      appendFileSync(process.env.FAKE_LOG, JSON.stringify({ start, end: Date.now() }) + '\n');
      process.stdout.write(head + JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'slow reply', usage: {} }));
    }, 400);
    return;
  }
  if (mode === 'error') {
    process.stdout.write(head + JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }));
    process.exit(1);
  }
  const result = {
    type: 'result', subtype: 'success', is_error: false, result: 'canned reply',
    usage: { input_tokens: 3, output_tokens: 2 },
  };
  if (stream) {
    const ev = JSON.parse(rec.stdin);
    const images = ev.message.content.filter((c) => c.type === 'image');
    if (images.length) result.result = `canned reply (${images.length} image${images.length === 1 ? '' : 's'})`;
    process.stdout.write(head + JSON.stringify({ type: 'assistant' }) + '\n' + JSON.stringify(result) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(result));
});
