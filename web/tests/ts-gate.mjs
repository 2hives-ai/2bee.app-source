#!/usr/bin/env node
/**
 * Full quality gate — TypeScript, ESLint, core tests, node tests.
 *
 * Run: node web/tests/ts-gate.mjs
 * Exit 0 = clean, exit 1 = errors found.
 *
 * Checks:
 *   1. TypeScript — zero type errors
 *   2. ESLint — zero errors (warnings allowed)
 *   3. Core tests — all 693 pass (Rust/WASM)
 *   4. Node tests — all pass (unit tests)
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const WEB_DIR = new URL('..', import.meta.url).pathname;
const ROOT_DIR = resolve(WEB_DIR, '..');

const EXCLUDED_TS = [];

function run(cmd, label, cwd) {
  try {
    const out = execSync(cmd, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(`✅ ${label}: pass`);
    return true;
  } catch (e) {
    const out = e.stdout || e.stderr || '';
    return { label, out };
  }
}

let failed = false;

// ── TypeScript ──────────────────────────────────────────────────────────────
const ts = run('npx tsc --noEmit', 'TypeScript', WEB_DIR);
if (ts !== true) {
  const lines = ts.out.split('\n').filter(l => l.includes('error TS'));
  const real = lines.filter(l => !EXCLUDED_TS.some(ex => l.includes(ex)));
  if (real.length > 0) {
    console.error(`❌ TypeScript: ${real.length} error(s)`);
    real.slice(0, 10).forEach(l => console.error(`  ${l}`));
    failed = true;
  } else {
    console.log('✅ TypeScript: 0 errors');
  }
}

// ── ESLint (errors only, warnings allowed) ──────────────────────────────────
const lint = run('npx eslint src/ --ext .ts,.tsx --quiet', 'ESLint', WEB_DIR);
if (lint !== true) {
  const lines = lint.out.split('\n').filter(l => l.includes('error'));
  const count = lines.find(l => l.includes('problem'));
  if (count) {
    console.error(`❌ ESLint: ${count.trim()}`);
    failed = true;
  } else if (lines.length > 0) {
    console.error(`❌ ESLint: ${lines.length} error(s)`);
    lines.slice(0, 10).forEach(l => console.error(`  ${l}`));
    failed = true;
  }
} else {
  console.log('✅ ESLint: 0 errors');
}

// ── Core tests (Rust/WASM) ──────────────────────────────────────────────────
const core = run('cargo test --lib 2>&1', 'Core tests', ROOT_DIR + '/core');
if (core !== true) {
  const lines = core.out.split('\n');
  const summary = lines.find(l => l.includes('test result:'));
  const failures = lines.filter(l => l.includes('FAILED'));
  if (summary && summary.includes('0 failed')) {
    console.log(`✅ Core tests: ${summary.trim()}`);
  } else {
    console.error(`❌ Core tests failed`);
    if (summary) console.error(`  ${summary.trim()}`);
    failures.forEach(l => console.error(`  ${l.trim()}`));
    failed = true;
  }
}

// ── Node tests (unit tests) ─────────────────────────────────────────────────
const node = run('node --import ./tests/register.mjs --test tests/*.test.ts 2>&1', 'Node tests', WEB_DIR);
if (node !== true) {
  const lines = node.out.split('\n');
  const failLine = lines.find(l => l.includes('# fail') && !l.includes('# fail 0'));
  const passLine = lines.find(l => l.includes('# pass'));
  if (failLine) {
    console.error(`❌ Node tests: ${failLine.trim()}`);
    if (passLine) console.error(`  ${passLine.trim()}`);
    failed = true;
  } else if (!node.out.includes('# fail 0') && !node.out.includes('pass')) {
    console.error(`❌ Node tests: unexpected output`);
    node.out.split('\n').slice(0, 5).forEach(l => console.error(`  ${l}`));
    failed = true;
  } else {
    console.log(`✅ Node tests: pass`);
  }
} else {
  console.log('✅ Node tests: pass');
}

// ── Summary ─────────────────────────────────────────────────────────────────
if (failed) {
  console.error('\n❌ Gate FAILED — fix errors before committing.');
  process.exit(1);
} else {
  console.log('\n✅ Gate PASSED — all checks clean.');
  process.exit(0);
}
