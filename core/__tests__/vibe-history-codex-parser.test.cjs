'use strict';

/**
 * Tests for vibe-history-codex-parser.cjs against BOTH Codex rollout schemas:
 *   A) interactive TUI / pre-0.147: event_msg → item_completed → payload.item
 *   B) exec 0.147.x: flat event_msg user_message/agent_message + patch_apply_end
 */

const A_ITEM = (item, ts) => ({ type: 'event_msg', timestamp: ts, payload: { type: 'item_completed', item } });

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseCodexRollout } = require('../vibe-history-codex-parser.cjs');

/** Write JSONL entries to a temp rollout file and return its path. */
function writeRollout(entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  const file = path.join(dir, 'rollout-test.jsonl');
  fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  return file;
}

const SESSION_META = {
  type: 'session_meta',
  timestamp: '2026-08-23T10:11:52.404Z',
  payload: {
    session_id: '01a02e1a-eee4-71c0-8ccd-49818d1f8446',
    id: '01a02e1a-eee4-71c0-8ccd-49818d1f8446',
    timestamp: '2026-08-23T10:11:52.210Z',
    cwd: '/tmp/does-not-exist-project'
  }
};

test('parses user + agent turns from flat event_msg payloads (0.147.0)', async () => {
  const file = writeRollout([
    SESSION_META,
    { type: 'event_msg', timestamp: '2026-08-23T10:11:55.297Z', payload: { type: 'user_message', message: 'Do the thing' } },
    { type: 'event_msg', timestamp: '2026-08-23T10:11:59.398Z', payload: { type: 'agent_message', message: 'Doing the thing now.' } },
    { type: 'event_msg', timestamp: '2026-08-23T10:14:48.441Z', payload: { type: 'token_count', info: {} } }
  ]);

  const { turns, extracted, sessionId } = await parseCodexRollout(file);

  assert.strictEqual(sessionId, '01a02e1a-eee4-71c0-8ccd-49818d1f8446');
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].role, 'user');
  assert.strictEqual(turns[0].text, 'Do the thing');
  assert.strictEqual(turns[1].role, 'assistant');
  assert.deepStrictEqual(turns[1].blocks, [{ kind: 'text', text: 'Doing the thing now.' }]);
  assert.strictEqual(extracted.userMessageCount, 1);
  assert.strictEqual(extracted.cwd, '/tmp/does-not-exist-project');
  assert.strictEqual(extracted.firstTs, '2026-08-23T10:11:55.297Z');
  assert.strictEqual(extracted.lastTs, '2026-08-23T10:14:48.441Z');
  assert.strictEqual(extracted.firstMeaningfulUserText, 'Do the thing');
});

test('extracts changed files from patch_apply_end stdout', async () => {
  const file = writeRollout([
    SESSION_META,
    { type: 'event_msg', timestamp: '2026-08-23T10:11:55.297Z', payload: { type: 'user_message', message: 'edit files' } },
    {
      type: 'event_msg',
      timestamp: '2026-08-23T10:13:01.134Z',
      payload: {
        type: 'patch_apply_end',
        stdout: 'Success. Updated the following files:\nA /repo/a.ts\nM /repo/b.ts\nD /repo/c.ts\n'
      }
    }
  ]);

  const { extracted } = await parseCodexRollout(file);
  const files = [...extracted.changedFiles].sort();
  assert.deepStrictEqual(files, ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
});

test('response_item stream is ignored for content (dup/encrypted) in exec mode', async () => {
  const file = writeRollout([
    SESSION_META,
    { type: 'event_msg', timestamp: '2026-08-23T10:11:55.297Z', payload: { type: 'user_message', message: 'hi' } },
    // response_item reasoning is encrypted with no plaintext → never a thinking block.
    { type: 'response_item', timestamp: '2026-08-23T10:11:56.000Z', payload: { type: 'reasoning', summary: [], encrypted_content: 'xxx' } },
    // response_item message duplicates the flat agent_message → must not double-count.
    { type: 'response_item', timestamp: '2026-08-23T10:11:57.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    { type: 'event_msg', timestamp: '2026-08-23T10:11:59.398Z', payload: { type: 'agent_message', message: 'done' } }
  ]);

  const { turns } = await parseCodexRollout(file);
  assert.strictEqual(turns.length, 2);
  assert.deepStrictEqual(turns[1].blocks, [
    { kind: 'text', text: 'done' }
  ]);
});

test('multiple user turns flush assistant turns correctly; malformed lines skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-rollout-'));
  const file = path.join(dir, 'rollout-test.jsonl');
  const lines = [
    JSON.stringify(SESSION_META),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-23T10:11:55Z', payload: { type: 'user_message', message: 'first' } }),
    'this is not json',
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-23T10:11:56Z', payload: { type: 'agent_message', message: 'reply one' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-23T10:11:57Z', payload: { type: 'user_message', message: 'second' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-08-23T10:11:58Z', payload: { type: 'agent_message', message: 'reply two' } })
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

  const { turns, extracted } = await parseCodexRollout(file);
  assert.strictEqual(extracted.userMessageCount, 2);
  assert.deepStrictEqual(turns.map(t => t.role), ['user', 'assistant', 'user', 'assistant']);
});

test('empty / missing rollout returns empty result without throwing', async () => {
  const r1 = await parseCodexRollout('/no/such/file.jsonl');
  assert.strictEqual(r1.turns.length, 0);
  assert.strictEqual(r1.extracted.userMessageCount, 0);

  const empty = writeRollout([SESSION_META]);
  const r2 = await parseCodexRollout(empty);
  assert.strictEqual(r2.turns.length, 0);
  assert.strictEqual(r2.sessionId, '01a02e1a-eee4-71c0-8ccd-49818d1f8446');
  // firstTs falls back to session start when no user message exists.
  assert.strictEqual(r2.extracted.firstTs, '2026-08-23T10:11:52.210Z');
});

// --- Schema A: interactive TUI / pre-0.147 (event_msg → item_completed) ---

test('parses user + agent turns from item_completed items (TUI 0.149.x)', async () => {
  const file = writeRollout([
    SESSION_META,
    A_ITEM({ type: 'UserMessage', content: [{ type: 'text', text: 'reorganize the blog' }] }, '2026-08-24T03:39:41.520Z'),
    A_ITEM({ type: 'Reasoning', summary_text: [], raw_content: [] }, '2026-08-24T03:39:42.000Z'),
    A_ITEM({ type: 'AgentMessage', content: [{ type: 'Text', text: 'Here is a plan.' }] }, '2026-08-24T03:39:48.000Z'),
    A_ITEM({ type: 'CommandExecution', command: ['ls'] }, '2026-08-24T03:39:49.000Z')
  ]);
  const { turns, extracted } = await parseCodexRollout(file);
  assert.strictEqual(extracted.userMessageCount, 1);
  assert.deepStrictEqual(turns.map(t => t.role), ['user', 'assistant']);
  assert.strictEqual(turns[0].text, 'reorganize the blog');
  // Empty (encrypted) reasoning is dropped → assistant turn is just the text block.
  assert.deepStrictEqual(turns[1].blocks, [{ kind: 'text', text: 'Here is a plan.' }]);
  assert.strictEqual(extracted.firstMeaningfulUserText, 'reorganize the blog');
});

test('item_completed Reasoning with summary_text becomes a thinking block', async () => {
  const file = writeRollout([
    SESSION_META,
    A_ITEM({ type: 'UserMessage', content: [{ type: 'text', text: 'hi' }] }, '2026-08-24T03:39:41Z'),
    A_ITEM({ type: 'Reasoning', summary_text: ['weighing options'] }, '2026-08-24T03:39:42Z'),
    A_ITEM({ type: 'AgentMessage', content: [{ type: 'Text', text: 'done' }] }, '2026-08-24T03:39:43Z')
  ]);
  const { turns } = await parseCodexRollout(file);
  assert.deepStrictEqual(turns[1].blocks, [
    { kind: 'thinking', text: 'weighing options' },
    { kind: 'text', text: 'done' }
  ]);
});

test('item_completed FileChange collects changed files', async () => {
  const file = writeRollout([
    SESSION_META,
    A_ITEM({ type: 'UserMessage', content: [{ type: 'text', text: 'edit' }] }, '2026-08-24T03:39:41Z'),
    A_ITEM({ type: 'FileChange', changes: { '/repo/a.ts': {}, '/repo/b.ts': {} } }, '2026-08-24T03:39:42Z')
  ]);
  const { extracted } = await parseCodexRollout(file);
  assert.deepStrictEqual([...extracted.changedFiles].sort(), ['/repo/a.ts', '/repo/b.ts']);
});
