#!/usr/bin/env node
/**
 * Tests for vibe-history-markdown-builder.cjs
 * Run: node --test $HOME/.claude/hooks/lib/__tests__/vibe-history-markdown-builder.test.cjs
 *
 * Covers filtering rules (user + assistant), multi-line assistant turn grouping,
 * subagent delegation inlining (including graceful degrade when the subagent
 * file is missing), and malformed-JSON-line resilience.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseSessionTranscript,
  parseDigest,
  renderDigest,
  buildMarkdownDigest,
  buildSubagentLookup,
  buildFrontmatter,
  readExistingFrontmatter,
  renderChangedFiles,
  collectChangedFiles,
  filterUserMessageText,
  renderTurns
} = require('../vibe-history-markdown-builder.cjs');

// -- Test helpers ------------------------------------------------------------

/** Create a fresh temp dir for one test's fixtures. */
function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-history-builder-test-'));
}

/** Write an array of entry objects as a JSONL file, returns the file path. */
function writeJsonl(filePath, entries) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = entries.map(e => (typeof e === 'string' ? e : JSON.stringify(e)));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
  return filePath;
}

function userEntry(content, extra = {}) {
  return { type: 'user', timestamp: '2026-07-04T10:00:00.000Z', message: { content }, ...extra };
}

function assistantBlockEntry(messageId, block, extra = {}) {
  return {
    type: 'assistant',
    timestamp: '2026-07-04T10:01:00.000Z',
    requestId: `req_${messageId}`,
    message: { id: messageId, content: [block] },
    ...extra
  };
}

// -- filterUserMessageText ----------------------------------------------------

describe('filterUserMessageText', () => {
  it('keeps plain text as-is', () => {
    assert.strictEqual(filterUserMessageText('hello world'), 'hello world');
  });

  it('strips system-reminder tags while keeping real text', () => {
    const raw = '<system-reminder>internal noise\nmultiple lines</system-reminder>real user text';
    assert.strictEqual(filterUserMessageText(raw), 'real user text');
  });

  it('strips local-command-caveat and task-notification tags', () => {
    const raw = '<local-command-caveat>caveat</local-command-caveat><task-notification>notif</task-notification>kept';
    assert.strictEqual(filterUserMessageText(raw), 'kept');
  });

  it('collapses a command-name/args wrapper to one line', () => {
    const raw = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>sonnet</command-args>';
    assert.strictEqual(filterUserMessageText(raw), '*Ran command `/model` sonnet*');
  });

  it('collapses command wrapper with empty args (no trailing space)', () => {
    const raw = '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>';
    assert.strictEqual(filterUserMessageText(raw), '*Ran command `/clear`*');
  });

  it('returns null for non-string content (tool_result arrays handled upstream)', () => {
    assert.strictEqual(filterUserMessageText([{ type: 'tool_result' }]), null);
  });

  it('returns null when nothing meaningful remains after stripping', () => {
    assert.strictEqual(filterUserMessageText('<system-reminder>only noise</system-reminder>   '), null);
  });
});

// -- parseSessionTranscript: user message rules -------------------------------

describe('parseSessionTranscript — user message rules', () => {
  it('keeps plain user text turns', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [userEntry('plain question')]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[0].text, 'plain question');
  });

  it('drops isMeta:true messages entirely', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [userEntry('meta text', { isMeta: true })]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 0);
  });

  it('drops messages whose content is an array of ONLY tool_result blocks', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry([{ type: 'tool_result', tool_use_id: 'x', content: 'result' }])
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 0);
  });

  it('drops messages whose content is an empty array', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [userEntry([])]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 0);
  });

  it('keeps a real text block mixed into array content alongside a tool_result block', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry([
        { type: 'tool_result', tool_use_id: 'x', content: 'result' },
        { type: 'text', text: 'actual human follow-up question' }
      ])
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1, 'array content with a real text block must not be dropped entirely');
    assert.strictEqual(turns[0].role, 'user');
    assert.strictEqual(turns[0].text, 'actual human follow-up question');
  });

  it('renders a placeholder for an image block in array content without crashing', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
      ])
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].text, '*[image attached]*');
    assert.ok(!turns[0].text.includes('aGVsbG8='), 'base64 image data must never be inlined into markdown');
  });

  it('keeps text + renders image placeholder when both are mixed with a tool_result block', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry([
        { type: 'tool_result', tool_use_id: 'x', content: 'result' },
        { type: 'text', text: 'look at this screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'zzz' } }
      ])
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].text, 'look at this screenshot\n\n*[image attached]*');
  });

  it('collapses slash-command wrapper messages to a one-liner', async () => {
    const dir = createTempDir();
    const raw = '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>focus on tests</command-args>';
    const file = writeJsonl(path.join(dir, 's.jsonl'), [userEntry(raw)]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].text, '*Ran command `/compact` focus on tests*');
  });

  it('drops noise top-level types (mode, system, attachment, etc.)', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      { type: 'mode', data: 'x' },
      { type: 'system', data: 'y' },
      { type: 'attachment', data: 'z' },
      userEntry('real message')
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].text, 'real message');
  });
});

// -- parseSessionTranscript: assistant message rules --------------------------

describe('parseSessionTranscript — assistant message rules', () => {
  it('keeps assistant text blocks', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      assistantBlockEntry('m1', { type: 'text', text: 'here is my answer' })
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1);
    assert.strictEqual(turns[0].role, 'assistant');
    assert.deepStrictEqual(turns[0].blocks, [{ kind: 'text', text: 'here is my answer' }]);
  });

  it('skips empty thinking blocks (no <details> emitted)', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      assistantBlockEntry('m1', { type: 'thinking', thinking: '', signature: 'abc123' })
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 0, 'assistant turn with only empty thinking should vanish entirely');
  });

  it('keeps non-empty thinking blocks, wrapped in <details> when rendered', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      assistantBlockEntry('m1', { type: 'thinking', thinking: 'reasoning about the fix' })
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns[0].blocks[0].kind, 'thinking');
    const md = renderTurns(turns);
    assert.match(md, /<details><summary>🧠 thinking<\/summary>/);
    assert.match(md, /reasoning about the fix/);
  });

  it('drops non-delegation tool_use blocks without a trace', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      assistantBlockEntry('m1', { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } })
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 0);
  });

  it('groups a multi-block turn (thinking+text+tool_use, 3 JSONL lines, same message.id) into ONE ordered turn', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      { type: 'assistant', timestamp: 't1', message: { id: 'msg_A', content: [{ type: 'thinking', thinking: 'thinking first' }] } },
      { type: 'assistant', timestamp: 't1', message: { id: 'msg_A', content: [{ type: 'text', text: 'then i say this' }] } },
      { type: 'assistant', timestamp: 't1', message: { id: 'msg_A', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }] } }
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 1, 'all 3 lines must collapse into a single grouped turn');
    assert.deepStrictEqual(turns[0].blocks.map(b => b.kind), ['thinking', 'text']);
    assert.strictEqual(turns[0].blocks[0].text, 'thinking first');
    assert.strictEqual(turns[0].blocks[1].text, 'then i say this');
  });

  it('starts a new turn when message.id changes even without an intervening user message', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      assistantBlockEntry('m1', { type: 'text', text: 'first turn' }),
      assistantBlockEntry('m2', { type: 'text', text: 'second turn' })
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].blocks[0].text, 'first turn');
    assert.strictEqual(turns[1].blocks[0].text, 'second turn');
  });
});

// -- Malformed input resilience -----------------------------------------------

describe('parseSessionTranscript — malformed input resilience', () => {
  it('skips malformed JSON lines without crashing, keeps parsing the rest', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      '{not valid json,,,',
      userEntry('before'),
      '{"type": "user", "message": {', // truncated/malformed
      userEntry('after')
    ]);
    const turns = await parseSessionTranscript(file);
    assert.strictEqual(turns.length, 2);
    assert.strictEqual(turns[0].text, 'before');
    assert.strictEqual(turns[1].text, 'after');
  });

  it('returns an empty array for a missing transcript file (no throw)', async () => {
    const turns = await parseSessionTranscript('/nonexistent/path/does-not-exist.jsonl');
    assert.deepStrictEqual(turns, []);
  });
});

// -- Subagent delegation inlining ----------------------------------------------

describe('subagent delegation inlining', () => {
  it('links a tool_use(name=Task) block to its subagent file via toolUseId and inlines the full conversation, including isSidechain:true entries', async () => {
    const dir = createTempDir();
    const sessionId = 'sess-abc';
    const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
      userEntry('please delegate this'),
      assistantBlockEntry('m1', {
        type: 'tool_use',
        id: 'toolu_XYZ',
        name: 'Task',
        input: { subagent_type: 'researcher', description: 'Research topic X' }
      })
    ]);
    writeJsonl(path.join(dir, sessionId, 'subagents', 'agent-a1.jsonl'), [
      { type: 'user', isSidechain: true, timestamp: 't', message: { content: 'sub-question' } },
      { type: 'assistant', isSidechain: true, timestamp: 't', message: { id: 'sub_m1', content: [{ type: 'text', text: 'sub-answer' }] } }
    ]);
    fs.writeFileSync(
      path.join(dir, sessionId, 'subagents', 'agent-a1.meta.json'),
      JSON.stringify({ agentType: 'researcher', description: 'Research topic X', toolUseId: 'toolu_XYZ', spawnDepth: 1 })
    );

    const turns = await parseSessionTranscript(mainFile, { skipSidechain: true, subagentLookup: buildSubagentLookup(mainFile) });
    const delegationTurn = turns.find(t => t.role === 'assistant');
    const delegationBlock = delegationTurn.blocks.find(b => b.kind === 'delegation');

    assert.ok(delegationBlock, 'expected a delegation block');
    assert.strictEqual(delegationBlock.resolved, true);
    assert.strictEqual(delegationBlock.agentType, 'researcher');
    assert.strictEqual(delegationBlock.description, 'Research topic X');
    assert.strictEqual(delegationBlock.turns.length, 2, 'isSidechain:true entries must be inlined, not skipped');
    assert.strictEqual(delegationBlock.turns[0].text, 'sub-question');
    assert.strictEqual(delegationBlock.turns[1].blocks[0].text, 'sub-answer');

    const md = renderTurns(turns);
    assert.match(md, /\*Delegated to `researcher` agent — Research topic X\*/);
    assert.match(md, /<summary>📋 Subagent: researcher — Research topic X<\/summary>/);
    assert.match(md, /sub-answer/);
  });

  it('also recognizes tool_use name=Agent (real-world tool name observed in this install)', async () => {
    const dir = createTempDir();
    const sessionId = 'sess-agent-name';
    const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
      assistantBlockEntry('m1', {
        type: 'tool_use',
        id: 'toolu_AGENT1',
        name: 'Agent',
        input: { subagent_type: 'planner', description: 'Plan the feature' }
      })
    ]);
    writeJsonl(path.join(dir, sessionId, 'subagents', 'agent-a2.jsonl'), [
      { type: 'assistant', isSidechain: true, timestamp: 't', message: { id: 'sub_m1', content: [{ type: 'text', text: 'plan text' }] } }
    ]);
    fs.writeFileSync(
      path.join(dir, sessionId, 'subagents', 'agent-a2.meta.json'),
      JSON.stringify({ agentType: 'planner', description: 'Plan the feature', toolUseId: 'toolu_AGENT1', spawnDepth: 1 })
    );

    const digest = await buildMarkdownDigest(mainFile, {
      sessionId, hookEvent: 'SessionEnd', reasonOrTrigger: 'clear',
      projectName: 'proj', cwd: '/tmp/proj', generatedAt: '2026-07-04T00:00:00.000Z'
    });
    assert.match(digest, /\*Delegated to `planner` agent — Plan the feature\*/);
    assert.match(digest, /plan text/);
  });

  it('degrades gracefully (marker only, no crash) when the subagent file is missing', async () => {
    const dir = createTempDir();
    const sessionId = 'sess-missing';
    const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
      assistantBlockEntry('m1', {
        type: 'tool_use',
        id: 'toolu_GONE',
        name: 'Task',
        input: { subagent_type: 'debugger', description: 'Debug flaky test' }
      })
    ]);
    // No subagents/ dir created at all — agent still running or cleaned up.
    const turns = await parseSessionTranscript(mainFile, { subagentLookup: buildSubagentLookup(mainFile) });
    const delegationBlock = turns[0].blocks.find(b => b.kind === 'delegation');
    assert.strictEqual(delegationBlock.resolved, false);
    assert.strictEqual(delegationBlock.turns, null);

    const md = renderTurns(turns);
    assert.match(md, /\*Delegated to `debugger` agent — Debug flaky test\*/);
    assert.ok(!md.includes('📋 Subagent'), 'no nested <details> block should render when subagent file is absent');
  });

  it('buildSubagentLookup returns an empty map (no throw) when subagents dir is absent', () => {
    const dir = createTempDir();
    const mainFile = writeJsonl(path.join(dir, 'lonely.jsonl'), [userEntry('hi')]);
    const lookup = buildSubagentLookup(mainFile);
    assert.strictEqual(lookup.size, 0);
  });

  it('buildSubagentLookup skips malformed meta.json files without throwing', () => {
    const dir = createTempDir();
    const sessionId = 'sess-bad-meta';
    const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [userEntry('hi')]);
    fs.mkdirSync(path.join(dir, sessionId, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, sessionId, 'subagents', 'agent-bad.meta.json'), '{not valid json');
    const lookup = buildSubagentLookup(mainFile);
    assert.strictEqual(lookup.size, 0);
  });

  it('escapes </summary>-breaking characters in agentType/description in the rendered <summary> tag', async () => {
    const dir = createTempDir();
    const sessionId = 'sess-html-escape';
    const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
      assistantBlockEntry('m1', {
        type: 'tool_use',
        id: 'toolu_HTML1',
        name: 'Task',
        input: { subagent_type: 'researcher', description: 'break </summary><script>alert(1)</script> here' }
      })
    ]);
    writeJsonl(path.join(dir, sessionId, 'subagents', 'agent-h1.jsonl'), [
      { type: 'assistant', isSidechain: true, timestamp: 't', message: { id: 'sub_m1', content: [{ type: 'text', text: 'ok' }] } }
    ]);
    fs.writeFileSync(
      path.join(dir, sessionId, 'subagents', 'agent-h1.meta.json'),
      JSON.stringify({ agentType: 'researcher', description: 'break </summary><script>alert(1)</script> here', toolUseId: 'toolu_HTML1' })
    );

    const digest = await buildMarkdownDigest(mainFile, {
      sessionId, hookEvent: 'SessionEnd', reasonOrTrigger: 'clear',
      projectName: 'proj', cwd: '/tmp/proj', generatedAt: '2026-07-04T00:00:00.000Z'
    });
    assert.ok(!digest.includes('<script>alert(1)</script> here</summary>'), 'raw </summary>-breaking markup must not appear unescaped inside the summary tag');
    assert.match(digest, /<summary>📋 Subagent: researcher — break &lt;\/summary&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt; here<\/summary>/);
  });

  describe('nested/grandchild subagent delegation (Fix 1)', () => {
    it('inlines a grandchild subagent (main -> subagent A -> subagent A\'s own subagents/ dir -> subagent B)', async () => {
      const dir = createTempDir();
      const sessionId = 'sess-nested';
      const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
        assistantBlockEntry('m1', {
          type: 'tool_use',
          id: 'toolu_A',
          name: 'Task',
          input: { subagent_type: 'planner', description: 'Plan the feature' }
        })
      ]);

      // Subagent A's own transcript + meta, living in the MAIN session's subagents/ dir.
      const subagentsDir = path.join(dir, sessionId, 'subagents');
      const agentAJsonlPath = path.join(subagentsDir, 'agent-A.jsonl');
      writeJsonl(agentAJsonlPath, [
        { type: 'assistant', isSidechain: true, timestamp: 't1', message: { id: 'a_m1', content: [{ type: 'text', text: 'planning...' }] } },
        {
          type: 'assistant', isSidechain: true, timestamp: 't2',
          message: { id: 'a_m2', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Agent', input: { subagent_type: 'researcher', description: 'Research subtopic' } }] }
        }
      ]);
      fs.writeFileSync(
        path.join(subagentsDir, 'agent-A.meta.json'),
        JSON.stringify({ agentType: 'planner', description: 'Plan the feature', toolUseId: 'toolu_A' })
      );

      // Subagent B (grandchild) lives in Subagent A's OWN sibling `subagents/` dir,
      // NOT in the main session's subagents/ dir — this is the layout the original
      // (buggy) code could never resolve, because it only ever looked up ids
      // against the top-level lookup built once from the main session's dir.
      const agentAOwnSubagentsDir = path.join(subagentsDir, 'agent-A', 'subagents');
      writeJsonl(path.join(agentAOwnSubagentsDir, 'agent-B.jsonl'), [
        { type: 'assistant', isSidechain: true, timestamp: 't3', message: { id: 'b_m1', content: [{ type: 'text', text: 'grandchild research result' }] } }
      ]);
      fs.writeFileSync(
        path.join(agentAOwnSubagentsDir, 'agent-B.meta.json'),
        JSON.stringify({ agentType: 'researcher', description: 'Research subtopic', toolUseId: 'toolu_B' })
      );

      const digest = await buildMarkdownDigest(mainFile, {
        sessionId, hookEvent: 'SessionEnd', reasonOrTrigger: 'clear',
        projectName: 'proj', cwd: '/tmp/proj', generatedAt: '2026-07-04T00:00:00.000Z'
      });

      assert.match(digest, /\*Delegated to `planner` agent — Plan the feature\*/);
      assert.match(digest, /planning\.\.\./);
      assert.match(digest, /\*Delegated to `researcher` agent — Research subtopic\*/, 'grandchild delegation marker must render');
      assert.match(digest, /<summary>📋 Subagent: researcher — Research subtopic<\/summary>/, 'grandchild delegation must actually resolve into a nested <details> block, not degrade to marker-only');
      assert.match(digest, /grandchild research result/, 'grandchild subagent B content must actually be inlined, not just a marker');
    });

    it('never hangs and degrades gracefully once MAX_DELEGATION_DEPTH is exceeded (malformed/cyclic-shaped chain)', async () => {
      const dir = createTempDir();
      const sessionId = 'sess-deep-chain';
      const subagentsDir = path.join(dir, sessionId, 'subagents');

      // Build a linear delegation chain 7 levels deep (exceeds MAX_DELEGATION_DEPTH=5),
      // each level nested inside the previous one's own subagents/ dir.
      const DEPTH = 7;
      let currentDir = subagentsDir;
      const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
        assistantBlockEntry('m1', { type: 'tool_use', id: 'toolu_L0', name: 'Task', input: { subagent_type: 'agent-0', description: 'level 0' } })
      ]);

      for (let level = 1; level <= DEPTH; level++) {
        const agentFile = path.join(currentDir, `agent-L${level}.jsonl`);
        const nextToolUseId = level < DEPTH ? `toolu_L${level}` : null;
        const content = nextToolUseId
          ? [{ type: 'tool_use', id: nextToolUseId, name: 'Agent', input: { subagent_type: `agent-${level}`, description: `level ${level}` } }]
          : [{ type: 'text', text: `bottom of chain at level ${level}` }];
        writeJsonl(agentFile, [
          { type: 'assistant', isSidechain: true, timestamp: `t${level}`, message: { id: `m_L${level}`, content } }
        ]);
        fs.writeFileSync(
          path.join(currentDir, `agent-L${level}.meta.json`),
          JSON.stringify({ agentType: `agent-${level - 1}`, description: `level ${level - 1}`, toolUseId: `toolu_L${level - 1}` })
        );
        currentDir = path.join(currentDir, `agent-L${level}`, 'subagents');
      }

      const digestPromise = buildMarkdownDigest(mainFile, {
        sessionId, hookEvent: 'SessionEnd', reasonOrTrigger: 'clear',
        projectName: 'proj', cwd: '/tmp/proj', generatedAt: '2026-07-04T00:00:00.000Z'
      });
      // Guard the test itself against a real hang if the depth guard regresses.
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('buildMarkdownDigest hung — depth guard regressed')), 5000));
      const digest = await Promise.race([digestPromise, timeoutPromise]);

      assert.match(digest, /\*Delegated to `agent-0` agent — level 0\*/);
      // Beyond MAX_DELEGATION_DEPTH the chain must stop resolving further and
      // degrade to marker-only rather than recursing indefinitely.
      assert.ok(!digest.includes(`bottom of chain at level ${DEPTH}`), 'recursion must stop before reaching the bottom of a chain deeper than MAX_DELEGATION_DEPTH');
    });
  });
});

// -- buildMarkdownDigest end-to-end --------------------------------------------

describe('buildMarkdownDigest', () => {
  it('renders header + user/assistant turns in order', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('what is 2+2?'),
      assistantBlockEntry('m1', { type: 'text', text: 'it is 4' })
    ]);
    const digest = await buildMarkdownDigest(file, {
      sessionId: 'sess-1', hookEvent: 'PreCompact', reasonOrTrigger: 'manual',
      projectName: 'my-proj', cwd: '/Users/x/my-proj', generatedAt: '2026-07-04T12:00:00.000Z'
    });
    // frontmatter now precedes the legacy header (no longer at byte 0)
    assert.match(digest, /^---\n/, 'digest must open with a YAML frontmatter block');
    assert.match(digest, /\n# Session sess-1 — PreCompact \(manual\)/);
    assert.match(digest, /_project: my-proj · cwd: \/Users\/x\/my-proj · generated: 2026-07-04T12:00:00\.000Z_/);
    assert.match(digest, /### User — 2026-07-04T10:00:00\.000Z\nwhat is 2\+2\?/);
    assert.match(digest, /### Assistant — 2026-07-04T10:01:00\.000Z\nit is 4/);
  });

  it('produces frontmatter + header (no crash) for an empty/missing transcript', async () => {
    const digest = await buildMarkdownDigest('/nonexistent/file.jsonl', {
      sessionId: 'sess-2', hookEvent: 'SessionEnd', reasonOrTrigger: 'other',
      projectName: 'p', cwd: '/tmp/p', generatedAt: '2026-07-04T12:00:00.000Z'
    });
    assert.match(digest, /^---\n/);
    assert.match(digest, /\n# Session sess-2 — SessionEnd \(other\)/);
    // empty transcript → messages:0, enriched:false
    assert.match(digest, /\nmessages: 0\n/);
    assert.match(digest, /\nenriched: false\n/);
  });
});

// -- Phase 1: parse metadata extraction ---------------------------------------

describe('parseDigest — metadata extraction', () => {
  it('captures git_branch, cwd, message count, first/last timestamps, title', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('please refactor the auth module for me', {
        timestamp: '2026-07-10T01:00:00.000Z', cwd: '/repo/app', gitBranch: 'feature/auth'
      }),
      assistantBlockEntry('m1', { type: 'text', text: 'done' }, { timestamp: '2026-07-10T01:05:00.000Z' }),
      userEntry('thanks', { timestamp: '2026-07-10T01:10:00.000Z' })
    ]);
    const { extracted } = await parseDigest(file);
    assert.strictEqual(extracted.gitBranch, 'feature/auth');
    assert.strictEqual(extracted.cwd, '/repo/app');
    assert.strictEqual(extracted.userMessageCount, 2);
    assert.strictEqual(extracted.firstTs, '2026-07-10T01:00:00.000Z');
    assert.strictEqual(extracted.lastTs, '2026-07-10T01:10:00.000Z');
    assert.strictEqual(extracted.firstMeaningfulUserText, 'please refactor the auth module for me');
  });

  it('collects changed files edited BY a subagent (threads meta through recursion)', async () => {
    const dir = createTempDir();
    const sessionId = 'sess-sub-edit';
    const mainFile = writeJsonl(path.join(dir, `${sessionId}.jsonl`), [
      userEntry('delegate the implementation please'),
      assistantBlockEntry('m1', {
        type: 'tool_use', id: 'toolu_SUB', name: 'Task',
        input: { subagent_type: 'fullstack-developer', description: 'Implement feature X' }
      })
    ]);
    writeJsonl(path.join(dir, sessionId, 'subagents', 'agent-s1.jsonl'), [
      { type: 'user', isSidechain: true, timestamp: 't', message: { content: 'do it' } },
      { type: 'assistant', isSidechain: true, timestamp: 't', message: { id: 'sm1', content: [
        { type: 'tool_use', name: 'Write', input: { file_path: '/repo/src/feature-x.js' } },
        { type: 'text', text: 'implemented' }
      ] } }
    ]);
    fs.writeFileSync(
      path.join(dir, sessionId, 'subagents', 'agent-s1.meta.json'),
      JSON.stringify({ agentType: 'fullstack-developer', description: 'Implement feature X', toolUseId: 'toolu_SUB', spawnDepth: 1 })
    );

    const { extracted } = await parseDigest(mainFile);
    assert.deepStrictEqual([...extracted.changedFiles], ['/repo/src/feature-x.js'],
      'subagent-authored edits must appear in changed_files');
    // but the subagent user turn must NOT inflate the main message count
    assert.strictEqual(extracted.userMessageCount, 1, 'subagent turns must not count toward the main session');
  });

  it('collects changed files from Edit/Write/MultiEdit tool_use blocks', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('do it'),
      {
        type: 'assistant', timestamp: '2026-07-10T01:05:00.000Z', requestId: 'r1',
        message: { id: 'm1', content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/repo/a.js' } },
          { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/b.js' } },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
          { type: 'text', text: 'edited two files' }
        ] }
      }
    ]);
    const { extracted } = await parseDigest(file);
    assert.deepStrictEqual([...extracted.changedFiles].sort(), ['/repo/a.js', '/repo/b.js']);
  });

  it('prefers a custom-title record over the first user message for the title', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      { type: 'custom-title', customTitle: 'My Named Session' },
      userEntry('some long enough first request here')
    ]);
    const { extracted } = await parseDigest(file);
    assert.strictEqual(extracted.customTitle, 'My Named Session');
  });

  it('ignores slash-command echoes as title candidates', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('<command-name>/clear</command-name>'),
      userEntry('this is the real meaningful request text')
    ]);
    const { extracted } = await parseDigest(file);
    assert.strictEqual(extracted.firstMeaningfulUserText, 'this is the real meaningful request text');
  });
});

// -- collectChangedFiles unit --------------------------------------------------

describe('collectChangedFiles', () => {
  it('adds only Edit/Write/MultiEdit/NotebookEdit file paths', () => {
    const set = new Set();
    collectChangedFiles([
      { type: 'tool_use', name: 'MultiEdit', input: { file_path: '/x' } },
      { type: 'tool_use', name: 'NotebookEdit', input: { file_path: '/y' } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/z' } },
      { type: 'text', text: 'noise' }
    ], set);
    assert.deepStrictEqual([...set].sort(), ['/x', '/y']);
  });

  it('is a no-op on non-array input', () => {
    const set = new Set();
    collectChangedFiles(null, set);
    collectChangedFiles(undefined, set);
    assert.strictEqual(set.size, 0);
  });
});

// -- Phase 2: frontmatter + changed-files rendering ----------------------------

describe('buildMarkdownDigest — frontmatter + Changed Files', () => {
  it('emits deterministic frontmatter fields and a Changed Files section', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('build the landing page please', {
        timestamp: '2026-07-10T01:00:00.000Z', gitBranch: 'main'
      }),
      {
        type: 'assistant', timestamp: '2026-07-10T01:05:00.000Z', requestId: 'r1',
        message: { id: 'm1', content: [
          { type: 'tool_use', name: 'Write', input: { file_path: '/repo/index.html' } },
          { type: 'text', text: 'built it' }
        ] }
      }
    ]);
    const digest = await buildMarkdownDigest(file, {
      sessionId: 'abcd1234-ef', hookEvent: 'SessionEnd', reasonOrTrigger: 'other',
      projectName: 'my-proj', cwd: '/repo', generatedAt: '2026-07-10T09:00:00.000Z'
    });
    assert.match(digest, /\ntitle: "build the landing page please"\n/);
    assert.match(digest, /\nproject: "my-proj"\n/);
    assert.match(digest, /\nsession_id: abcd1234-ef\n/);
    assert.match(digest, /\ngit_branch: "main"\n/);
    assert.match(digest, /\nmessages: 1\n/);
    assert.match(digest, /\nchanged_files: 1\n/);
    assert.match(digest, /\nenriched: false\n/);
    assert.match(digest, /## Changed Files\n\n- `\/repo\/index\.html`/);
  });

  it('omits git_branch and Changed Files when absent', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('just a question, no edits'),
      assistantBlockEntry('m1', { type: 'text', text: 'here is the answer' })
    ]);
    const digest = await buildMarkdownDigest(file, {
      sessionId: 's1', hookEvent: 'SessionEnd', reasonOrTrigger: 'other',
      projectName: 'p', cwd: '/p', generatedAt: '2026-07-10T09:00:00.000Z'
    });
    assert.doesNotMatch(digest, /\ngit_branch:/);
    assert.doesNotMatch(digest, /## Changed Files/);
    assert.match(digest, /\nchanged_files: 0\n/);
  });

  it('omits git_branch when the value is the literal "HEAD" (detached-HEAD cwd)', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('do a thing', {
        timestamp: '2026-07-10T01:00:00.000Z', gitBranch: 'HEAD'
      }),
      assistantBlockEntry('m1', { type: 'text', text: 'done' })
    ]);
    const digest = await buildMarkdownDigest(file, {
      sessionId: 's1', hookEvent: 'SessionEnd', reasonOrTrigger: 'other',
      projectName: 'p', cwd: '/p', generatedAt: '2026-07-10T09:00:00.000Z'
    });
    assert.doesNotMatch(digest, /\ngit_branch:/);
  });
});

// -- buildFrontmatter: schema + semantic preservation --------------------------

describe('buildFrontmatter — schema + semantic preservation', () => {
  const extracted = {
    firstTs: '2026-07-10T01:00:00.000Z', lastTs: '2026-07-10T02:00:00.000Z',
    userMessageCount: 3, gitBranch: null, changedFiles: new Set(), customTitle: 'T', firstMeaningfulUserText: null
  };
  const digestMeta = { sessionId: 's', hookEvent: 'SessionEnd', projectName: 'p', cwd: '/p', generatedAt: '2026-07-10T09:00:00.000Z' };

  it('emits the full schema empty + enriched:false on fresh capture (topics merged into keywords)', () => {
    const fm = buildFrontmatter(extracted, digestMeta, {});
    assert.match(fm, /\nenriched: false\n/);
    assert.match(fm, /\ntitle: "T"\n/);
    assert.match(fm, /\nsummary: ""\n/);
    assert.match(fm, /\ntype: ""\n/);
    assert.match(fm, /\noutcome: ""\n/);
    assert.match(fm, /\nkeywords: \[\]\n/);
    assert.match(fm, /\ndecisions: \[\]\n/);
    assert.match(fm, /\nlessons: \[\]\n/);
    assert.match(fm, /\ninsights: \[\]\n/);
    assert.doesNotMatch(fm, /\ntopics:/);
  });

  it('emits raw preserved semantic values verbatim (incl. block lists) with enriched:true', () => {
    const preserved = {
      title: 'title: "Better LLM title"',
      summary: 'summary: "Precise summary."',
      type: 'type: "feature"',
      keywords: 'keywords: [cro, landing-page]',
      decisions: 'decisions:\n  - "Chose OR-query over regex"',
      enriched: true
    };
    const fm = buildFrontmatter(extracted, digestMeta, preserved);
    assert.match(fm, /\ntitle: "Better LLM title"\n/);
    assert.match(fm, /\nkeywords: \[cro, landing-page\]\n/);
    assert.match(fm, /\ndecisions:\n  - "Chose OR-query over regex"\n/);
    assert.match(fm, /\nenriched: true\n/);
  });
});

// -- readExistingFrontmatter ---------------------------------------------------

describe('readExistingFrontmatter', () => {
  it('preserves scalar + block-list semantic fields verbatim through a round-trip', () => {
    const dir = createTempDir();
    const p = path.join(dir, 'f.md');
    const enriched = [
      '---',
      'title: "Fix Sapo search"',
      'summary: "Did the thing"',
      'type: "feature"',
      'outcome: "completed"',
      'keywords: [sapo-theme, search]',
      'decisions:',
      '  - "Chose OR-query over regex"',
      '  - "Kept structured filter intact"',
      'lessons:',
      '  - "Sapo OR must be uppercase"',
      'insights: []',
      'project: "p"',
      'date: 2026-07-10',
      'session_id: s',
      'enriched: true',
      '---',
      '',
      '# Session s',
      'body'
    ].join('\n');
    fs.writeFileSync(p, enriched, 'utf8');
    const got = readExistingFrontmatter(p);
    assert.strictEqual(got.enriched, true);
    assert.strictEqual(got.title, 'title: "Fix Sapo search"');
    assert.strictEqual(got.keywords, 'keywords: [sapo-theme, search]');
    assert.strictEqual(got.decisions, 'decisions:\n  - "Chose OR-query over regex"\n  - "Kept structured filter intact"');
    assert.strictEqual(got.lessons, 'lessons:\n  - "Sapo OR must be uppercase"');

    // re-emit keeps the block list intact
    const extracted = { firstTs: null, lastTs: null, userMessageCount: 0, gitBranch: null, changedFiles: new Set(), customTitle: 'X', firstMeaningfulUserText: null };
    const fm = buildFrontmatter(extracted, { sessionId: 's', hookEvent: 'SessionEnd', projectName: 'p', cwd: '/p', generatedAt: '2026-07-10T09:00:00.000Z' }, got);
    assert.match(fm, /\ndecisions:\n  - "Chose OR-query over regex"\n  - "Kept structured filter intact"\n/);
    assert.match(fm, /\nenriched: true\n/);
  });

  it('infers enriched:true for a legacy file lacking the flag but carrying semantic content', () => {
    const dir = createTempDir();
    const p = path.join(dir, 'legacy.md');
    fs.writeFileSync(p, '---\ntitle: "X"\nsummary: "real summary"\ntype: "debug"\n---\n\n# Session s\nbody', 'utf8');
    const got = readExistingFrontmatter(p);
    assert.strictEqual(got.enriched, true);
    assert.strictEqual(got.summary, 'summary: "real summary"');
  });

  it('treats an all-empty file as enriched:false (no flag, no content)', () => {
    const dir = createTempDir();
    const p = path.join(dir, 'empty.md');
    fs.writeFileSync(p, '---\ntitle: "X"\nsummary: ""\ntype: ""\nkeywords: []\ndecisions: []\n---\n\nbody', 'utf8');
    assert.strictEqual(readExistingFrontmatter(p).enriched, false);
  });

  it('returns {} for a missing file or a file without frontmatter', () => {
    assert.deepStrictEqual(readExistingFrontmatter('/nonexistent.md'), {});
    const dir = createTempDir();
    const p = path.join(dir, 'plain.md');
    fs.writeFileSync(p, '# no frontmatter here\n', 'utf8');
    assert.deepStrictEqual(readExistingFrontmatter(p), {});
  });

  it('round-trips through a re-capture: preserved semantic fields survive', async () => {
    const dir = createTempDir();
    const file = writeJsonl(path.join(dir, 's.jsonl'), [
      userEntry('some meaningful request text here'),
      assistantBlockEntry('m1', { type: 'text', text: 'ok' })
    ]);
    const destPath = path.join(dir, 'out.md');
    const digestMeta = { sessionId: 's', hookEvent: 'SessionEnd', reasonOrTrigger: 'other', projectName: 'p', cwd: '/p', generatedAt: '2026-07-10T09:00:00.000Z' };
    const { turns, extracted } = await parseDigest(file);
    const md = renderDigest(turns, extracted, digestMeta, {
      type: 'type: "feature"', summary: 'summary: "S"', keywords: 'keywords: [x]', enriched: true
    });
    fs.writeFileSync(destPath, md, 'utf8');
    const preserved = readExistingFrontmatter(destPath);
    const md2 = renderDigest(turns, extracted, digestMeta, preserved);
    assert.match(md2, /\ntype: "feature"\n/);
    assert.match(md2, /\nkeywords: \[x\]\n/);
    assert.match(md2, /\nenriched: true\n/);
  });
});

// -- renderChangedFiles --------------------------------------------------------

describe('renderChangedFiles', () => {
  it('renders a sorted list', () => {
    const out = renderChangedFiles(new Set(['/b', '/a', '/c']));
    assert.strictEqual(out, '## Changed Files\n\n- `/a`\n- `/b`\n- `/c`');
  });
  it('returns empty string for an empty/undefined set', () => {
    assert.strictEqual(renderChangedFiles(new Set()), '');
    assert.strictEqual(renderChangedFiles(undefined), '');
  });
});
