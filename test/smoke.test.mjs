import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';

import { decodeSessionBytes } from '../lib/zstd.mjs';
import { buildConversation, renderTranscript } from '../lib/extract.mjs';
import { extractClaims, cleanText } from '../lib/claims.mjs';
import { titleSimilarity, formatGbt7714, normalizeTitle } from '../lib/refs.mjs';
import { buildSkeleton, buildEvidenceTable, buildBibliography } from '../lib/build.mjs';

/* ---------------------------------------------------------------- decoder */

test('decodes concatenated zstd frames (DSH session log layout)', () => {
  const line1 = JSON.stringify({ type: 'session', version: 4, cwd: 'C:\\work' }) + '\n';
  const line2 = JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }] } }) + '\n';
  const buf = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(line1)),
    zlib.zstdCompressSync(Buffer.from(line2)),
  ]);
  const out = decodeSessionBytes(buf);
  assert.match(out, /"type":"session"/);
  assert.match(out, /"text":"hi"/);
});

test('tolerates a torn tail from a live session file', () => {
  const frame = zlib.zstdCompressSync(Buffer.from('{"a":1}\n'));
  const torn = Buffer.concat([frame, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00])]);
  const out = decodeSessionBytes(torn);
  assert.match(out, /"a":1/);
});

/* -------------------------------------------------------------- transcript */

const events = [
  { type: 'session', version: 4, id: 'session-test', cwd: 'C:\\work', createdAt: 1700000000000 },
  { type: 'session/title', data: { title: '测试会话' } },
  { type: 'turn/start', time: 1700000001000, data: { turn: 1 } },
  { type: 'user/message', time: 1700000001100, data: { content: [{ type: 'text', text: '用户真正说的话，想要一个能自动整理的工具' }], source: { kind: 'user' } } },
  { type: 'user/message', time: 1700000001200, data: { content: [{ type: 'text', text: '运行时注入内容' }], source: { kind: 'runtime-context' } } },
  { type: 'assistant/message', time: 1700000002000, data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '因此结论是，引用必须可核验。' }] } } },
  { type: 'turn/end', time: 1700000003000, data: { turn: 1, reason: { kind: 'completed' } } },
];

test('separates speakers and drops harness injections', () => {
  const conv = buildConversation(events);
  assert.equal(conv.stats.userMessages, 1);
  assert.equal(conv.stats.injectedMessages, 1);
  assert.equal(conv.turns[0].assistant[0].text, '因此结论是，引用必须可核验。');
  const md = renderTranscript(conv);
  assert.match(md, /### 用户/);
  assert.match(md, /### AI 回答/);
  assert.doesNotMatch(md, /运行时注入内容/);
});

/* ----------------------------------------------------------------- claims */

test('cleanText strips markdown noise', () => {
  const s = cleanText('**结论是**：见 [链接](http://x) `code`');
  assert.equal(s, '结论是：见 链接 code');
});

test('extractClaims keeps the user statement and scores conclusions', () => {
  const conv = buildConversation(events);
  const claims = extractClaims(conv);
  const statement = claims.find((c) => c.kind === 'statement');
  assert.ok(statement, '用户原话应作为问题陈述保留');
  assert.equal(statement.section, '1 引言');
  const reasoning = claims.find((c) => c.role === 'assistant');
  assert.ok(reasoning, '应抽出含结论词的回答句');
  assert.match(reasoning.text, /引用必须可核验/);
});

/* ------------------------------------------------------------- references */

test('normalizeTitle and similarity behave for English and Chinese', () => {
  assert.equal(normalizeTitle('Attention Is All You Need!'), 'attention is all you need');
  assert.ok(titleSimilarity('Attention Is All You Need', 'attention is all you need') > 0.9);
  assert.ok(titleSimilarity('注意力机制综述', '注意力机制综述') > 0.9);
  assert.ok(titleSimilarity('Attention Is All You Need', 'Speech Separation') < 0.3);
});

test('formatGbt7714 renders journal and preprint styles', () => {
  const journal = formatGbt7714({
    title: 'Nanometre-scale thermometry in a living cell',
    authors: [
      { family: 'Kucsko', given: 'G' },
      { family: 'Maurer', given: 'P C' },
      { family: 'Yao', given: 'N Y' },
      { family: 'Kubica', given: 'M' },
    ],
    year: 2013,
    venue: 'Nature',
    volume: '500',
    issue: '7460',
    pages: '54-58',
    doi: '10.1038/nature12373',
    type: 'journal-article',
  });
  assert.match(journal, /^Kucsko G, Maurer PC, Yao NY, 等\. /);
  assert.match(journal, /\[J\]\. Nature, 2013, 500\(7460\): 54-58\./);
  assert.match(journal, /DOI: 10\.1038\/nature12373\.$/);

  const preprint = formatGbt7714({
    title: 'Attention Is All You Need',
    authors: [{ family: 'Vaswani', given: 'A' }],
    year: 2017,
    venue: 'arXiv',
    type: 'posted-content',
    doi: '10.48550/arXiv.1706.03762',
  });
  assert.match(preprint, /\[EB\/OL\]\. \(2017\)\./);
  assert.match(preprint, /DOI: 10\.48550\/arXiv\.1706\.03762\./);
});

/* ------------------------------------------------------------------ build */

test('skeleton separates kept claims and only cites verified refs', () => {
  const conv = buildConversation(events);
  const claims = [
    { id: 'C001', role: 'user', turn: 1, text: '问题陈述', section: '1 引言', status: 'keep' },
    { id: 'C002', role: 'assistant', turn: 1, text: '被丢弃的句子', section: '4 论证与证据', status: 'drop' },
  ];
  const refs = [
    { id: 'R1', verdict: 'verified', record: { doi: '10.1/x', title: 'T' }, gbt7714: '[1] A. T[J]. V, 2020. DOI: 10.1/x.' },
    { id: 'R2', verdict: 'rejected', input: { title: '编造的文献' }, reason: '查无实据' },
  ];
  const md = buildSkeleton({ conversation: conv, claims, refs, title: '测试标题' });
  assert.match(md, /# 测试标题/);
  assert.match(md, /\[C001\]/);
  assert.doesNotMatch(md, /被丢弃的句子/);
  assert.match(md, /A\. T\[J\]/);
  assert.doesNotMatch(md, /编造的文献/);

  const evidence = buildEvidenceTable({ conversation: conv, claims, refs });
  assert.match(evidence, /\| C001 \| 用户 \|/);

  const bib = buildBibliography(refs);
  assert.match(bib, /已核实 1 条 \/ 待核对 0 条 \/ 已拒绝 1 条/);
  assert.match(bib, /编造的文献/);
});
