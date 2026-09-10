'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI = path.join(__dirname, '..', 'vibe-history-qmd-cli.cjs');
const { extractCount, COLLECTION } = require('../vibe-history-qmd-cli.cjs');

// --- pure helper: -n extraction -------------------------------------------
describe('extractCount', () => {
  test('pulls -n N out and keeps the rest in order', () => {
    assert.deepStrictEqual(extractCount(['hello', '-n', '5']), { n: '5', rest: ['hello'] });
    assert.deepStrictEqual(extractCount(['-n', '3', 'a', 'b']), { n: '3', rest: ['a', 'b'] });
  });
  test('no -n → n null, args untouched', () => {
    assert.deepStrictEqual(extractCount(['a', 'b']), { n: null, rest: ['a', 'b'] });
  });
  test('trailing -n with no value is treated as a normal token', () => {
    assert.deepStrictEqual(extractCount(['q', '-n']), { n: null, rest: ['q', '-n'] });
  });
});

test('COLLECTION name is vibe-history', () => {
  assert.strictEqual(COLLECTION, 'vibe-history');
});

// --- integration: stub `qmd` on PATH, assert dispatch + env ---------------
// A fake qmd records argv + QMD_RUNTIME to a file, so we can verify the CLI
// forwards the right subcommand/args and forces the node runtime, without a
// real qmd install.
function withStubQmd(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qmdstub-'));
  const rec = path.join(dir, 'rec.txt');
  const stub = path.join(dir, 'qmd');
  fs.writeFileSync(stub,
    `#!/bin/sh\nprintf '%s\\n' "RUNTIME=$QMD_RUNTIME" "ARGS=$*" >> "${rec}"\nexit 0\n`);
  fs.chmodSync(stub, 0o755);
  try {
    return fn({ dir, rec, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function run(env, args) {
  return execFileSync('node', [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('CLI dispatch (stubbed qmd)', () => {
  test('search forwards subcommand + query + -n, forcing QMD_RUNTIME=node', () => {
    withStubQmd(({ rec, env }) => {
      run(env, ['search', 'sapo theme', '-n', '3']);
      const out = fs.readFileSync(rec, 'utf8');
      assert.match(out, /RUNTIME=node/);
      assert.match(out, /ARGS=search sapo theme -n 3/);
    });
  });

  test('index calls `collection add <root> --name vibe-history`', () => {
    withStubQmd(({ rec, env }) => {
      run(env, ['index']);
      const out = fs.readFileSync(rec, 'utf8');
      assert.match(out, /ARGS=collection add \S+ --name vibe-history/);
    });
  });

  test('vsearch + query forward their own subcommand', () => {
    withStubQmd(({ rec, env }) => {
      run(env, ['vsearch', 'fix login race']);
      run(env, ['query', 'how does auth work']);
      const out = fs.readFileSync(rec, 'utf8');
      assert.match(out, /ARGS=vsearch fix login race/);
      assert.match(out, /ARGS=query how does auth work/);
    });
  });

  test('status runs qmd status then collection show', () => {
    withStubQmd(({ rec, env }) => {
      run(env, ['status']);
      const out = fs.readFileSync(rec, 'utf8');
      assert.match(out, /ARGS=status/);
      assert.match(out, /ARGS=collection show vibe-history/);
    });
  });
});

describe('CLI error handling', () => {
  test('unknown command exits 2', () => {
    withStubQmd(({ env }) => {
      assert.throws(() => run(env, ['bogus']), (e) => e.status === 2);
    });
  });

  test('search with no query exits 2', () => {
    withStubQmd(({ env }) => {
      assert.throws(() => run(env, ['search']), (e) => e.status === 2);
    });
  });
});
