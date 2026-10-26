import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { apply, name as pluginName, inject } from '../plugin/dsh/index.js';

/* ------------------------------------------------------------- fixtures */

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cp-'));
  const project = path.join(home, 'proj');
  fs.mkdirSync(project, { recursive: true });
  const dir = path.join(home, 'sessions', '--' + project.replace(/[\\/:]+/g, '-') + '--', 'session-test1');
  fs.mkdirSync(dir, { recursive: true });

  const events = [
    { type: 'session', version: 4, id: 'session-test1', cwd: project, createdAt: 1700000000000 },
    { type: 'session/title', data: { title: '对话转论文测试' } },
    { type: 'turn/start', time: 1700000001000, data: { turn: 1 } },
    { type: 'user/message', time: 1700000001100, data: { content: [{ type: 'text', text: '我想把这段讨论整理成论文，关键问题是引用不能编造' }], source: { kind: 'user' } } },
    { type: 'user/message', time: 1700000001200, data: { content: [{ type: 'text', text: '运行时上下文注入内容' }], source: { kind: 'runtime-context' } } },
    { type: 'assistant/message', time: 1700000002000, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '因此我认为，引用核验必须由确定性检索完成，而不是让生成模型自评。' }] } } },
    { type: 'tool/call', time: 1700000002100, data: { turn: 1, step: 1, callId: 'c1', name: 'web_search', arguments: '{}' } },
    { type: 'turn/end', time: 1700000003000, data: { turn: 1, reason: { kind: 'completed' } } },
  ];

  const frames = events.map((e) => zlib.zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n')));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames));
  return { home, project, sessionDir: dir };
}

/**
 * Minimal stand-in for a Cordis 4 context.
 *
 * `commands` is a throwing getter on purpose: a real Cordis context refuses to
 * read a service the plugin did not declare in `inject` ("cannot get property
 * \"commands\" without inject") and that throw rolls back the whole entry. The
 * plugin must reach the optional service through `ctx.reflect.get` instead.
 */
function mockCtx({ withCommands = true } = {}) {
  const tools = [];
  const commands = [];
  const commandsService = { register: (cmd) => { commands.push(cmd); return () => {}; } };
  const ctx = {
    tools: { register: (def) => { tools.push(def); return () => {}; } },
    get commands() {
      throw new Error('cannot get property "commands" without inject');
    },
    reflect: { get: (service) => (withCommands && service === 'commands' ? commandsService : undefined) },
    effect(fn) { return fn(); },
  };
  return { ctx, tools, commands };
}

/* ---------------------------------------------------------------- tests */

test('plugin exports the cordis contract', () => {
  assert.equal(pluginName, 'convo-paper');
  assert.deepEqual(inject, ['tools']);
  assert.equal(typeof apply, 'function');
});

test('apply registers five tools and the /paper command', () => {
  const { ctx, tools, commands } = mockCtx();
  apply(ctx);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['paper_build', 'paper_claims', 'paper_extract', 'paper_run', 'paper_verify_refs']);
  assert.equal(commands.length, 1);
  assert.equal(commands[0].name, 'paper');
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.output.render, 'function');
  }
});

test('paper_run produces transcript, claims and skeleton', async () => {
  const { home, project } = makeHome();
  process.env.DSH_HOME = home;
  const { ctx, tools } = mockCtx();
  apply(ctx);
  const run = tools.find((t) => t.name === 'paper_run');

  const result = await run.execute({ session: 'test1' });
  assert.equal(result.ok, true);
  assert.equal(result.step, 'run');

  const out = result.out;
  assert.equal(out, path.join(project, 'paper-work'));
  for (const f of ['transcript.md', 'conversation.json', 'claims.json', 'claims.md', 'paper-skeleton.md', 'evidence.md']) {
    assert.ok(fs.existsSync(path.join(out, f)), `missing ${f}`);
  }

  const transcript = fs.readFileSync(path.join(out, 'transcript.md'), 'utf8');
  assert.match(transcript, /### 用户/);
  assert.match(transcript, /### AI 回答/);
  assert.doesNotMatch(transcript, /运行时上下文注入内容/);
  assert.match(transcript, /已过滤系统注入消息：1 条/);

  const claims = JSON.parse(fs.readFileSync(path.join(out, 'claims.json'), 'utf8'));
  assert.ok(claims.length >= 2);
  assert.ok(claims.some((c) => c.kind === 'statement'));

  const skeleton = fs.readFileSync(path.join(out, 'paper-skeleton.md'), 'utf8');
  assert.match(skeleton, /## 参考文献/);
});

test('paper_extract reports stats and tolerates --out', async () => {
  const { home, project } = makeHome();
  process.env.DSH_HOME = home;
  const { ctx, tools } = mockCtx();
  apply(ctx);
  const extract = tools.find((t) => t.name === 'paper_extract');

  const out = path.join(project, 'custom-out');
  const result = await extract.execute({ session: 'test1', out });
  assert.equal(result.ok, true);
  assert.equal(result.out, out);
  assert.equal(result.stats.userMessages, 1);
  assert.equal(result.stats.injectedMessages, 1);
  assert.ok(fs.existsSync(path.join(out, 'transcript.md')));

  const rendered = extract.output.render({}, result)[0];
  assert.equal(rendered.type, 'text');
  assert.match(rendered.text, /已抽取 session-test1/);
});

test('paper_claims works from an existing conversation.json', async () => {
  const { home, project } = makeHome();
  process.env.DSH_HOME = home;
  const { ctx, tools } = mockCtx();
  apply(ctx);
  const out = path.join(project, 'paper-work');
  await tools.find((t) => t.name === 'paper_extract').execute({ session: 'test1', out });

  const result = await tools.find((t) => t.name === 'paper_claims').execute({ out, perTurn: 3 });
  assert.equal(result.ok, true);
  assert.ok(result.candidateCount > 0);
  assert.ok(fs.existsSync(path.join(out, 'claims.md')));
});

test('paper_build fails cleanly without a conversation', async () => {
  const { ctx, tools } = mockCtx();
  apply(ctx);
  const result = await tools.find((t) => t.name === 'paper_build').execute({ out: fs.mkdtempSync(path.join(os.tmpdir(), 'empty-')) });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing-conversation');
});

test('paper_verify_refs rejects an empty input instead of calling the network', async () => {
  const { ctx, tools } = mockCtx();
  apply(ctx);
  const result = await tools.find((t) => t.name === 'paper_verify_refs').execute({ refs: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'missing-refs');
});

test('/paper handler runs the pipeline for the latest session', async () => {
  const { home } = makeHome();
  process.env.DSH_HOME = home;
  const { ctx, commands } = mockCtx();
  apply(ctx);
  const result = await commands[0].handler({ args: 'test1' });
  assert.equal(result.kind, 'text');
  assert.match(result.text, /已抽取 session-test1/);
});

test('apply survives a host that provides no commands service', () => {
  const { ctx, tools, commands } = mockCtx({ withCommands: false });
  // A Cordis host without the commands plugin still gets every tool, and the
  // optional slash command is skipped instead of failing the entry.
  assert.doesNotThrow(() => apply(ctx));
  assert.deepEqual(tools.map((t) => t.name).sort(), ['paper_build', 'paper_claims', 'paper_extract', 'paper_run', 'paper_verify_refs']);
  assert.equal(commands.length, 0);
});
