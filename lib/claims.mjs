/**
 * Heuristic candidate extraction: which sentences carry a stance, a judgement,
 * a conclusion, or an idea worth putting into a paper.
 *
 * This is deliberately conservative and cheap. The model curates the list
 * afterwards (SKILL.md step 3) — the script's job is to make sure nothing is
 * silently dropped, and to keep a stable id + provenance for every candidate.
 */

const CLAIM_MARKERS = [
  // 判断 / 归因 / 结论
  '因此', '所以', '可见', '说明', '本质上', '关键是', '关键在于', '我认为', '我的判断',
  '结论', '核心是', '根本原因', '之所以', '这意味着', '换句话说', '值得注意', '说白了',
  '更重要的是', '问题在于', '真正的', '应该是', '不应该', '建议', '必须', '不能',
  '只能', '代价', '前提', '边界', '而不是', '反过来', '实际上', '误区', '容易', '风险',
  // 英文
  'therefore', 'thus', 'this means', 'the key', 'in my view', 'i think', 'suggests that',
  'implies', 'we should', 'the problem is', 'root cause', 'trade-off', 'rather than',
];

const NOVELTY_MARKERS = [
  // 创意 / 反直觉 / 框架 / 类比
  '反直觉', '与直觉相反', '容易被忽略', '被低估', '重新定义', '换个角度', '打个比方',
  '类比', '可以这样理解', '三个层次', '两层', '框架', '假设', '反例', '悖论', '张力',
  'insight', 'reframe', 'framework', 'counterintuitive', 'analogy', 'novel', 'hypothesis',
];

const USER_INTENT_MARKERS = ['我想要', '我希望', '我担心', '困扰', '问题是', '我觉得', '能不能', '有没有'];

const MD_LINK = /\[([^\]]*)\]\([^)]*\)/g;
const MD_EMPH = /(\*\*|__|\*|_|`|~~)/g;

/** Strip markdown scaffolding so the extracted sentence reads like prose. */
export function cleanText(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(MD_LINK, '$1')
    .replace(MD_EMPH, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function splitSentences(text) {
  const cleaned = cleanText(text);
  const chunks = cleaned.split(/(?<=[。！？!?；;])|\n+/);
  return chunks
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 14 && s.length <= 420)
    .filter((s) => !/^(js|bash|json|text)?\s*$/i.test(s));
}

function score(sentence, pool) {
  const lower = sentence.toLowerCase();
  let hits = 0;
  const matched = [];
  for (const m of pool) {
    if (lower.includes(m.toLowerCase())) {
      hits += 1;
      matched.push(m);
    }
  }
  return { hits, matched };
}

export function extractClaims(conversation, { perTurn = 6 } = {}) {
  const claims = [];
  let n = 0;
  const seen = new Set();
  const add = (claim) => {
    const key = claim.text.toLowerCase().replace(/\s+/g, '').slice(0, 120);
    if (!key || seen.has(key)) return;
    seen.add(key);
    n += 1;
    claims.push({ ...claim, id: `C${String(n).padStart(3, '0')}` });
  };

  for (const turn of conversation.turns) {
    // 用户的原话就是论文的问题陈述，整段保留，不参与线索词筛选。
    for (const u of turn.users) {
      const text = cleanText(u.text).replace(/\s+/g, ' ').slice(0, 320);
      if (text.length >= 8) {
        add({
          role: 'user',
          turn: turn.turn,
          at: u.at,
          text,
          claimScore: 0,
          noveltyScore: 0,
          markers: ['问题陈述'],
          section: '1 引言',
          kind: 'statement',
          status: 'candidate',
        });
      }
    }

    const buckets = [
      ...turn.assistant.map((a) => ({ role: 'assistant', text: a.text, at: a.at })),
      ...turn.users.map((u) => ({ role: 'user', text: u.text, at: u.at })),
    ];
    for (const bucket of buckets) {
      const scored = splitSentences(bucket.text).map((s) => {
        const c = score(s, CLAIM_MARKERS);
        const nv = score(s, NOVELTY_MARKERS);
        const intent = bucket.role === 'user' ? score(s, USER_INTENT_MARKERS) : { hits: 0, matched: [] };
        return {
          text: s,
          claimScore: c.hits,
          claimMarkers: c.matched,
          noveltyScore: nv.hits,
          noveltyMarkers: nv.matched,
          intentScore: intent.hits,
          total: c.hits * 2 + nv.hits * 2 + intent.hits + Math.min(s.length, 120) / 200,
        };
      });
      const picked = scored
        .filter((s) => s.claimScore > 0 || s.noveltyScore > 0 || s.intentScore > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, perTurn);

      for (const s of picked) {
        add({
          role: bucket.role,
          turn: turn.turn,
          at: bucket.at,
          text: s.text,
          claimScore: s.claimScore,
          noveltyScore: s.noveltyScore,
          markers: [...new Set([...s.claimMarkers, ...s.noveltyMarkers])],
          section:
            bucket.role === 'user'
              ? '1 引言'
              : s.noveltyScore > 0
                ? '3 核心观点与框架'
                : '4 论证与证据',
          kind: 'sentence',
          status: 'candidate',
        });
      }
    }
  }
  return claims;
}

export function renderClaimsMarkdown(claims, conversation) {
  const out = ['# 候选观点清单', ''];
  out.push(`来源：${conversation.meta.title || '(未命名会话)'}｜候选 ${claims.length} 条`, '');
  out.push('> 这些是脚本按线索词捞出的候选句。写论文前请逐条判定：保留 / 合并 / 删除，把结论写回 claims.json 的 status 字段。');
  out.push('');
  const bySection = new Map();
  for (const c of claims) {
    if (!bySection.has(c.section)) bySection.set(c.section, []);
    bySection.get(c.section).push(c);
  }
  for (const [section, list] of bySection) {
    out.push(`## ${section}`, '');
    for (const c of list) {
      out.push(`- **${c.id}**（第${c.turn}轮·${c.role === 'user' ? '用户' : 'AI'}，线索：${c.markers.join('/') || '—'}）`);
      out.push(`  ${c.text}`);
    }
    out.push('');
  }
  return out.join('\n');
}
