#!/usr/bin/env node
/**
 * convo-paper — 把一段 DSH 对话变成论文的脚手架。
 *
 *   convo-paper extract [--session latest|<id>] [--cwd <dir>] [--out <dir>] [--tools]
 *   convo-paper claims  [--session ...] [--out <dir>] [--per-turn 4]
 *   convo-paper refs search --query "..." [--limit 5]
 *   convo-paper refs verify --in <refs-input.json> [--out <dir>]
 *   convo-paper build   [--out <dir>] [--title "..."]
 *   convo-paper run     [--session ...] [--out <dir>] [--tools]
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveSession, listSessions, sessionsRoot } from '../lib/sessions.mjs';
import { loadConversation, renderTranscript } from '../lib/extract.mjs';
import { extractClaims, renderClaimsMarkdown } from '../lib/claims.mjs';
import { verifyAll, searchCrossref, searchOpenAlex, searchArxiv, formatGbt7714, titleSimilarity } from '../lib/refs.mjs';
import { buildSkeleton, buildEvidenceTable, buildBibliography, SECTIONS } from '../lib/build.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) args[key] = true;
      else {
        args[key] = next;
        i++;
      }
    } else args._.push(a);
  }
  return args;
}

const ensureDir = (d) => fs.mkdirSync(d, { recursive: true });
const write = (dir, name, content) => {
  ensureDir(dir);
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
};

function requireSession(args) {
  const s = resolveSession({ session: args.session, cwd: args.cwd || process.cwd() });
  return s;
}

function cmdExtract(args) {
  const out = args.out || 'paper-work';
  ensureDir(out);
  const session = requireSession(args);
  const conv = loadConversation(session.file);
  const transcript = renderTranscript(conv, { includeTools: Boolean(args.tools), title: conv.meta.title || '对话记录' });
  const files = [
    write(out, 'transcript.md', transcript),
    write(out, 'conversation.json', JSON.stringify({ session, conversation: conv }, null, 2)),
  ];
  console.log(`会话：${session.sessionId}`);
  console.log(`轮次 ${conv.stats.turns}｜用户 ${conv.stats.userMessages} 条｜AI ${conv.stats.assistantMessages} 条｜工具 ${conv.stats.toolCalls} 次`);
  for (const f of files) console.log('写入', f);
}

function cmdClaims(args) {
  const out = args.out || 'paper-work';
  ensureDir(out);
  const convPath = path.join(out, 'conversation.json');
  let conv;
  if (fs.existsSync(convPath)) conv = JSON.parse(fs.readFileSync(convPath, 'utf8')).conversation;
  else {
    const session = requireSession(args);
    conv = loadConversation(session.file);
    write(out, 'conversation.json', JSON.stringify({ session, conversation: conv }, null, 2));
  }
  const claims = extractClaims(conv, { perTurn: Number(args['per-turn'] || 4) });
  const files = [
    write(out, 'claims.json', JSON.stringify(claims, null, 2)),
    write(out, 'claims.md', renderClaimsMarkdown(claims, conv)),
  ];
  console.log(`候选观点 ${claims.length} 条`);
  for (const f of files) console.log('写入', f);
}

async function cmdRefs(args) {
  const sub = args._[1];
  if (sub === 'search') {
    const q = args.query;
    if (!q) throw new Error('refs search 需要 --query');
    const limit = Number(args.limit || 5);
    const rows = [];
    for (const [name, fn] of [['crossref', searchCrossref], ['openalex', searchOpenAlex], ['arxiv', searchArxiv]]) {
      try {
        const list = await fn(q, limit);
        for (const rec of list) rows.push({ ...rec, via: name, sim: Number(titleSimilarity(q, rec.title).toFixed(3)) });
      } catch (e) {
        console.error(`[${name}] ${e.message}`);
      }
    }
    // 跨数据源去重：同一篇论文在 Crossref / OpenAlex / arXiv 各有一条记录
    const seen = new Set();
    const deduped = [];
    rows.sort((a, b) => b.sim - a.sim);
    for (const r of rows) {
      const key = (r.doi || r.arxivId || r.title).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
      if (key && seen.has(key)) continue;
      const titleKey = r.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
      if (titleKey && seen.has(titleKey)) continue;
      if (key) seen.add(key);
      if (titleKey) seen.add(titleKey);
      deduped.push(r);
    }
    rows.length = 0;
    rows.push(...deduped);
    if (args.json) {
      console.log(JSON.stringify(rows.slice(0, limit), null, 2));
      return;
    }
    for (const r of rows.slice(0, limit)) {
      console.log(`- [${r.sim}] ${r.title}`);
      console.log(`    ${r.authors.map((a) => a.family).join(', ')} · ${r.venue || '—'} · ${r.year || '—'}`);
      if (r.doi) console.log(`    doi:${r.doi}`);
      if (r.arxivId) console.log(`    arXiv:${r.arxivId}`);
      console.log(`    ${formatGbt7714(r)}`);
    }
    return;
  }

  if (sub === 'verify') {
    const inFile = args.in;
    if (!inFile) throw new Error('refs verify 需要 --in <refs-input.json>');
    const inputs = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const list = Array.isArray(inputs) ? inputs : inputs.references || [];
    if (!list.length) throw new Error('输入里没有参考文献条目');
    console.log(`核对 ${list.length} 条…`);
    const results = await verifyAll(list, {
      onProgress: (i, n, r) => console.log(`  ${i}/${n} ${r.verdict.padEnd(9)} ${String(r.input.title).slice(0, 60)}`),
    });
    const out = args.out || path.dirname(path.resolve(inFile));
    const f = write(out, 'refs.json', JSON.stringify(results, null, 2));
    write(out, 'bibliography.md', buildBibliography(results));
    const count = (v) => results.filter((r) => r.verdict === v).length;
    console.log(`verified ${count('verified')}｜possible ${count('possible')}｜rejected ${count('rejected')}`);
    console.log('写入', f);
    return;
  }

  throw new Error('用法：convo-paper refs search|verify ...');
}

function readJsonIf(dir, name, fallback) {
  const p = path.join(dir, name);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback;
}

function cmdBuild(args) {
  const out = args.out || 'paper-work';
  const data = readJsonIf(out, 'conversation.json', null);
  if (!data) throw new Error(`${out} 下没有 conversation.json，先跑 convo-paper extract`);
  const claims = readJsonIf(out, 'claims.json', []);
  const refs = readJsonIf(out, 'refs.json', []);
  const skeleton = buildSkeleton({ conversation: data.conversation, claims, refs, title: args.title });
  const evidence = buildEvidenceTable({ conversation: data.conversation, claims, refs });
  const files = [
    write(out, 'paper-skeleton.md', skeleton),
    write(out, 'evidence.md', evidence),
    write(out, 'refs-input.example.json', JSON.stringify(exampleRefs(claims), null, 2)),
  ];
  for (const f of files) console.log('写入', f);
}

function exampleRefs(claims) {
  const kept = claims.filter((c) => c.status !== 'drop').slice(0, 3);
  return kept.map((c, i) => ({
    id: `R${i + 1}`,
    claimId: c.id,
    title: '（把这里换成你要引用的真实论文标题）',
    doi: '',
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'extract':
      return cmdExtract(args);
    case 'claims':
      return cmdClaims(args);
    case 'refs':
      return cmdRefs(args);
    case 'build':
      return cmdBuild(args);
    case 'run': {
      cmdExtract(args);
      cmdClaims(args);
      return cmdBuild(args);
    }
    case 'sessions': {
      for (const s of listSessions({ cwd: args.cwd || process.cwd() }).slice(0, Number(args.limit || 10))) {
        console.log(`${s.sessionId}  ${new Date(s.mtimeMs).toISOString()}  ${(s.size / 1024).toFixed(1)}KB  ${s.project}`);
      }
      return;
    }
    default:
      console.log(`convo-paper — 对话转论文脚手架

  convo-paper extract  [--session latest|<id>] [--cwd <dir>] [--out <dir>] [--tools]
  convo-paper claims   [--out <dir>] [--per-turn 4]
  convo-paper refs search --query "标题或关键词" [--limit 5] [--json]
  convo-paper refs verify --in refs-input.json [--out <dir>]
  convo-paper build    [--out <dir>] [--title "论文标题"]
  convo-paper run      [--out <dir>]            # extract + claims + build
  convo-paper sessions                          # 列出本机会话

会话目录：${sessionsRoot()}
论文章节：${SECTIONS.map((s) => s.key + ' ' + s.title).join(' / ')}`);
  }
}

main().catch((e) => {
  console.error('错误：' + e.message);
  process.exitCode = 1;
});
