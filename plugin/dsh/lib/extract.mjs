// Vendored copy of lib/extract.mjs — edit lib/ and run `node scripts/sync-core.mjs`.
/**
 * Turn a DSH event log into a readable, role-separated transcript.
 *
 * What the user said and what the assistant answered are kept in separate
 * buckets per turn, because the paper pipeline needs to attribute every idea
 * to a speaker and a turn.
 *
 * Important: DSH also records harness injections (runtime context, skill
 * catalog, time context, IM notices …) as `user/message` events. They are NOT
 * user speech and are filtered out by `source.kind === 'user'`.
 */
import { readEvents } from './sessions.mjs';

const TEXT_BLOCKS = new Set(['text']);
const REAL_USER = new Set(['user']);

function blocksToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && TEXT_BLOCKS.has(b.type))
    .map((b) => String(b.text ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function head(value, max = 160) {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max) + '…' : flat;
}

export function buildConversation(events, { includeInjected = false } = {}) {
  const meta = { title: '', cwd: '', createdAt: null, model: '', sessionId: '' };
  const turns = [];
  let current = null;
  const toolByCallId = new Map();
  const injected = [];

  const ensureTurn = (n) => {
    let t = turns.find((x) => x.turn === n);
    if (!t) {
      t = { turn: n, users: [], assistant: [], tools: [], startedAt: null, endedAt: null, endReason: null };
      turns.push(t);
      turns.sort((a, b) => a.turn - b.turn);
    }
    return t;
  };

  for (const ev of events) {
    const d = ev.data || {};
    switch (ev.type) {
      case 'session':
        // The header is a flat record, not wrapped in `data`.
        meta.cwd = ev.cwd || meta.cwd;
        meta.sessionId = ev.id || meta.sessionId;
        meta.createdAt = ev.createdAt ? new Date(ev.createdAt).toISOString() : meta.createdAt;
        break;
      case 'session/title':
        if (d.title) meta.title = d.title;
        break;
      case 'request/header':
      case 'request/context':
        if (typeof d.model === 'string' && d.model) meta.model = d.model;
        break;
      case 'turn/start': {
        const t = ensureTurn(d.turn);
        t.startedAt = new Date(ev.time).toISOString();
        current = t;
        break;
      }
      case 'turn/end': {
        const t = ensureTurn(d.turn);
        t.endedAt = new Date(ev.time).toISOString();
        t.endReason = d.reason?.kind || null;
        break;
      }
      case 'user/message': {
        const text = blocksToText(d.content);
        if (!text) break;
        const kind = d.source?.kind || 'user';
        if (!REAL_USER.has(kind) && !includeInjected) {
          injected.push({ kind, head: head(text, 80) });
          break;
        }
        const t = current || ensureTurn(current ? current.turn : turns.length + 1);
        t.users.push({ at: new Date(ev.time).toISOString(), kind, text });
        break;
      }
      case 'assistant/message': {
        const t = ensureTurn(d.turn ?? (current ? current.turn : 0));
        const msg = d.message || {};
        const text = blocksToText(msg.content);
        if (text) t.assistant.push({ at: new Date(ev.time).toISOString(), step: d.step ?? null, text });
        break;
      }
      case 'tool/call': {
        const t = ensureTurn(d.turn ?? (current ? current.turn : 0));
        const entry = {
          at: new Date(ev.time).toISOString(),
          name: d.name || 'tool',
          arguments: d.arguments ?? '',
          resultHead: '',
          ok: null,
        };
        t.tools.push(entry);
        if (d.callId) toolByCallId.set(d.callId, entry);
        break;
      }
      case 'tool/result': {
        const msg = d.message || {};
        const callId = msg.toolCallId || msg.source?.callId || d.toolCallId;
        const entry = callId ? toolByCallId.get(callId) : null;
        if (entry) {
          entry.resultHead = head(blocksToText(msg.content), 200);
          entry.ok = d.meta?.ok ?? null;
        }
        break;
      }
      default:
        break;
    }
  }

  const sum = (fn) => turns.reduce((n, t) => n + fn(t), 0);
  const stats = {
    turns: turns.length,
    userMessages: sum((t) => t.users.length),
    assistantMessages: sum((t) => t.assistant.length),
    toolCalls: sum((t) => t.tools.length),
    injectedMessages: injected.length,
    userChars: sum((t) => t.users.reduce((m, u) => m + u.text.length, 0)),
    assistantChars: sum((t) => t.assistant.reduce((m, a) => m + a.text.length, 0)),
  };

  return { meta, turns, stats, injected };
}

export function renderTranscript(conversation, { includeTools = false, title = '对话记录' } = {}) {
  const { meta, turns, stats } = conversation;
  const out = [];
  out.push(`# ${title}`);
  out.push('');
  out.push(`- 会话标题：${meta.title || '(未命名)'}`);
  out.push(`- 会话 ID：${meta.sessionId || '未知'}`);
  out.push(`- 工作目录：\`${meta.cwd || '未知'}\``);
  out.push(
    `- 轮次：${stats.turns}｜用户消息：${stats.userMessages}｜AI 消息：${stats.assistantMessages}｜工具调用：${stats.toolCalls}`,
  );
  if (stats.injectedMessages) {
    out.push(`- 已过滤系统注入消息：${stats.injectedMessages} 条（运行时上下文、技能目录等，不计入用户发言）`);
  }
  out.push('');

  for (const t of turns) {
    if (!t.users.length && !t.assistant.length) continue;
    out.push(`## 第 ${t.turn} 轮`);
    for (const u of t.users) {
      out.push('');
      out.push('### 用户');
      out.push('');
      out.push(u.text.trim());
    }
    for (const a of t.assistant) {
      out.push('');
      out.push('### AI 回答');
      out.push('');
      out.push(a.text.trim());
    }
    if (includeTools && t.tools.length) {
      out.push('');
      out.push('<details><summary>工具调用 ' + t.tools.length + ' 次</summary>');
      out.push('');
      for (const tool of t.tools) out.push(`- \`${tool.name}\` ${head(tool.arguments, 120)}`);
      out.push('');
      out.push('</details>');
    }
    out.push('');
  }
  return out.join('\n');
}

export function loadConversation(file, opts) {
  return buildConversation(readEvents(file), opts);
}
