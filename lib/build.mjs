/**
 * Assemble the paper scaffold: sections, claim slots, citation slots, and the
 * evidence table that traces every claim back to a turn and a speaker.
 *
 * It intentionally stops at the skeleton. Prose is written by the model under
 * SKILL.md, because a template-filled document is not a paper.
 */

export const SECTIONS = [
  { key: '1', title: '引言', hint: '问题从哪里来：用户提出的是什么困扰，为什么值得写成文章' },
  { key: '2', title: '相关工作', hint: '外部文献对照；每条引用必须来自 refs.verified' },
  { key: '3', title: '核心观点与框架', hint: '对话中真正有创意的判断、类比、框架' },
  { key: '4', title: '论证与证据', hint: '支撑上述观点的推理链、案例、反例、数据' },
  { key: '5', title: '讨论与局限', hint: '边界条件、反方意见、尚未验证的假设' },
  { key: '6', title: '结论与展望', hint: '收敛成可检验的结论与下一步工作' },
];

function pickSection(c) {
  const m = String(c.section || '').match(/^\s*(\d)/);
  if (m && SECTIONS.some((s) => s.key === m[1])) return m[1];
  return c.role === 'user' ? '1' : '3';
}

export function buildSkeleton({ conversation, claims, refs = [], title }) {
  const kept = claims.filter((c) => c.status !== 'drop');
  const groups = new Map(SECTIONS.map((s) => [s.key, []]));
  for (const c of kept) groups.get(pickSection(c)).push(c);

  const verified = refs.filter((r) => r.verdict === 'verified');
  const possible = refs.filter((r) => r.verdict === 'possible');
  const citeIndex = new Map();
  verified.forEach((r, i) => citeIndex.set(r.id || r.record.doi || r.record.title, i + 1));

  const docTitle = title || conversation.meta.title || '未命名论文';
  const out = [];
  out.push(`# ${docTitle}`);
  out.push('');
  out.push('> 骨架由 convo-paper 生成：括号内是写作指令，`[Cn]` 是可引用的观点锚点，`[n]` 是对应参考文献。');
  out.push('');
  out.push('## 摘要');
  out.push('');
  out.push('（用 200–300 字写：问题、方法、核心观点、结论。不要出现“本文借助 AI 对话”这类元叙述。）');
  out.push('');
  out.push('**关键词**：（3–5 个）');
  out.push('');

  for (const s of SECTIONS) {
    out.push(`## ${s.key} ${s.title}`);
    out.push('');
    out.push(`<!-- 写作提示：${s.hint} -->`);
    out.push('');
    const list = groups.get(s.key) || [];
    if (!list.length) {
      out.push('（本节暂无对话素材：需要补充外部文献或由作者补写。）');
      out.push('');
      continue;
    }
    list.forEach((c, i) => {
      const cite = c.citeId && citeIndex.has(c.citeId) ? ` [${citeIndex.get(c.citeId)}]` : '';
      out.push(`${i + 1}. **[${c.id}]**（第${c.turn}轮·${c.role === 'user' ? '用户' : 'AI'}）${c.text}${cite}`);
    });
    out.push('');
  }

  out.push('## 参考文献');
  out.push('');
  if (!verified.length) {
    out.push('（尚无已核实文献。先跑 `convo-paper refs verify`，只有 verdict=verified 的记录才能写进来。）');
  } else {
    verified.forEach((r, i) => out.push(r.gbt7714.replace(/^\[\d+\]\s*/, `[${i + 1}] `)));
  }
  if (possible.length) {
    out.push('');
    out.push('<!-- 待人工核对（匹配度不足，暂不列入正式参考文献）：');
    for (const r of possible) out.push(`  - ${r.record.title}（相似度 ${r.similarity}）${r.record.doi || ''}`);
    out.push('-->');
  }
  out.push('');
  return out.join('\n');
}

export function buildEvidenceTable({ conversation, claims, refs = [] }) {
  const out = [];
  out.push('# 证据对照表');
  out.push('');
  out.push('每一条进入正文的判断，都必须能在这张表里找到出处。审稿人问“这个结论哪来的”，答案在这里。');
  out.push('');
  out.push('| 观点 | 说话人 | 轮次 | 原文摘要 | 支撑文献 | 状态 |');
  out.push('| --- | --- | --- | --- | --- | --- |');
  for (const c of claims) {
    const short = c.text.replace(/\|/g, '\\|').slice(0, 60);
    const refsForClaim = refs.filter((r) => r.claimId === c.id && r.verdict === 'verified');
    const refText = refsForClaim.length
      ? refsForClaim.map((r) => (r.record.doi ? `doi:${r.record.doi}` : r.record.title.slice(0, 30))).join('；')
      : '—';
    out.push(`| ${c.id} | ${c.role === 'user' ? '用户' : 'AI'} | ${c.turn} | ${short} | ${refText} | ${c.status || 'candidate'} |`);
  }
  out.push('');
  out.push('## 未被引用的对话结论');
  out.push('');
  const unused = claims.filter((c) => !refs.some((r) => r.claimId === c.id));
  if (!unused.length) out.push('（无）');
  else for (const c of unused) out.push(`- ${c.id} ${c.text.slice(0, 80)}`);
  out.push('');
  return out.join('\n');
}

export function buildBibliography(refs) {
  const verified = refs.filter((r) => r.verdict === 'verified');
  const possible = refs.filter((r) => r.verdict === 'possible');
  const rejected = refs.filter((r) => r.verdict === 'rejected');
  const out = [];
  out.push('# 参考文献（GB/T 7714）');
  out.push('');
  out.push(`已核实 ${verified.length} 条 / 待核对 ${possible.length} 条 / 已拒绝 ${rejected.length} 条。`);
  out.push('');
  verified.forEach((r, i) => out.push(r.gbt7714.replace(/^\[\d+\]\s*/, `[${i + 1}] `)));
  if (possible.length) {
    out.push('');
    out.push('## 待人工核对（不得直接引用）');
    out.push('');
    for (const r of possible) {
      out.push(`- 输入：${r.input.title}`);
      out.push(`  候选：${r.record.title}（${r.record.venue || '—'}, ${r.record.year || '—'}）相似度 ${r.similarity}`);
      if (r.record.doi) out.push(`  DOI：${r.record.doi}`);
    }
  }
  if (rejected.length) {
    out.push('');
    out.push('## 已拒绝（查无此文，模型可能编造）');
    out.push('');
    for (const r of rejected) out.push(`- ${r.input.title || '(空)'} —— ${r.reason}`);
  }
  out.push('');
  return out.join('\n');
}
