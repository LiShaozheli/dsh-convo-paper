/**
 * High-level pipeline used by the plugin's tools.
 *
 * Each step is a plain async function returning a small, JSON-serializable
 * result. The tools are thin wrappers so the same logic stays testable without
 * a running harness.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveSession } from './lib/sessions.mjs';
import { loadConversation, renderTranscript } from './lib/extract.mjs';
import { extractClaims, renderClaimsMarkdown } from './lib/claims.mjs';
import { verifyAll } from './lib/refs.mjs';
import { buildSkeleton, buildEvidenceTable, buildBibliography } from './lib/build.mjs';

const ensure = (dir) => fs.mkdirSync(dir, { recursive: true });

function write(dir, name, content) {
  ensure(dir);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

/** Where artifacts go: explicit `out`, else <session cwd>/paper-work. */
function resolveOut(explicit, cwd) {
  if (explicit) return path.resolve(explicit);
  const base = cwd || process.cwd();
  return path.join(base, 'paper-work');
}

export async function runExtract({ session, cwd, out, includeTools = false } = {}) {
  const s = resolveSession({ session, cwd });
  const conversation = loadConversation(s.file);
  const dir = resolveOut(out, conversation.meta.cwd || cwd);
  const transcript = renderTranscript(conversation, {
    includeTools,
    title: conversation.meta.title || '对话记录',
  });
  const files = [
    write(dir, 'transcript.md', transcript),
    write(dir, 'conversation.json', JSON.stringify({ session: s, conversation }, null, 2)),
  ];
  return {
    ok: true,
    step: 'extract',
    sessionId: s.sessionId,
    title: conversation.meta.title,
    out: dir,
    files,
    stats: conversation.stats,
  };
}

export async function runClaims({ session, cwd, out, perTurn = 6 } = {}) {
  const dir = resolveOut(out, cwd);
  const convFile = path.join(dir, 'conversation.json');
  let conversation;
  let sessionId = null;
  if (fs.existsSync(convFile)) {
    const saved = JSON.parse(fs.readFileSync(convFile, 'utf8'));
    conversation = saved.conversation;
    sessionId = saved.session?.sessionId ?? null;
  } else {
    const s = resolveSession({ session, cwd });
    sessionId = s.sessionId;
    conversation = loadConversation(s.file);
    write(dir, 'conversation.json', JSON.stringify({ session: s, conversation }, null, 2));
    write(
      dir,
      'transcript.md',
      renderTranscript(conversation, { title: conversation.meta.title || '对话记录' }),
    );
  }
  const claims = extractClaims(conversation, { perTurn });
  const files = [
    write(dir, 'claims.json', JSON.stringify(claims, null, 2)),
    write(dir, 'claims.md', renderClaimsMarkdown(claims, conversation)),
  ];
  return {
    ok: true,
    step: 'claims',
    sessionId,
    out: dir,
    files,
    candidateCount: claims.length,
    bySection: claims.reduce((acc, c) => {
      acc[c.section] = (acc[c.section] || 0) + 1;
      return acc;
    }, {}),
  };
}

export async function runBuild({ out, cwd, title } = {}) {
  const dir = resolveOut(out, cwd);
  const convFile = path.join(dir, 'conversation.json');
  if (!fs.existsSync(convFile)) {
    return { ok: false, code: 'missing-conversation', message: `${dir} 下没有 conversation.json，先跑 paper_extract` };
  }
  const saved = JSON.parse(fs.readFileSync(convFile, 'utf8'));
  const claimsFile = path.join(dir, 'claims.json');
  const refsFile = path.join(dir, 'refs.json');
  const claims = fs.existsSync(claimsFile) ? JSON.parse(fs.readFileSync(claimsFile, 'utf8')) : [];
  const refs = fs.existsSync(refsFile) ? JSON.parse(fs.readFileSync(refsFile, 'utf8')) : [];

  const skeleton = buildSkeleton({ conversation: saved.conversation, claims, refs, title });
  const evidence = buildEvidenceTable({ conversation: saved.conversation, claims, refs });
  const files = [
    write(dir, 'paper-skeleton.md', skeleton),
    write(dir, 'evidence.md', evidence),
  ];
  return {
    ok: true,
    step: 'build',
    out: dir,
    files,
    keptClaims: claims.filter((c) => c.status !== 'drop').length,
    verifiedRefs: refs.filter((r) => r.verdict === 'verified').length,
  };
}

export async function runVerifyRefs({ refs, out, cwd } = {}) {
  if (!Array.isArray(refs) || refs.length === 0) {
    return { ok: false, code: 'missing-refs', message: 'refs 需要是 [{title, doi?, claimId?}] 数组' };
  }
  const dir = resolveOut(out, cwd);
  const results = await verifyAll(refs);
  const files = [
    write(dir, 'refs.json', JSON.stringify(results, null, 2)),
    write(dir, 'bibliography.md', buildBibliography(results)),
  ];
  return {
    ok: true,
    step: 'verify-refs',
    out: dir,
    files,
    verified: results.filter((r) => r.verdict === 'verified').length,
    possible: results.filter((r) => r.verdict === 'possible').length,
    rejected: results.filter((r) => r.verdict === 'rejected').length,
    verdicts: results.map((r) => ({
      id: r.id,
      title: r.input?.title,
      verdict: r.verdict,
      similarity: r.similarity,
      doi: r.record?.doi || null,
      reason: r.reason,
    })),
  };
}

export async function runAll({ session, cwd, out, includeTools = false, perTurn = 6 } = {}) {
  const extracted = await runExtract({ session, cwd, out, includeTools });
  const claims = await runClaims({ session, cwd, out: extracted.out, perTurn });
  const built = await runBuild({ out: extracted.out });
  return { ok: true, step: 'run', out: extracted.out, extracted, claims, built };
}
