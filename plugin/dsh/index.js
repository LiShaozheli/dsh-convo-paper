/**
 * dsh-convo-paper-plugin — host half.
 *
 * Registers five tools and a `/paper` command on the DeepSeek Harness. Plain
 * object definitions go through `ctx.tools.register` so the package depends on
 * no `@deepseek-ai/*` value import and installs into any compatible profile.
 */
import { runExtract, runClaims, runBuild, runVerifyRefs, runAll } from './pipeline.mjs';

export const name = 'convo-paper';
export const inject = ['tools'];

const LABEL = 'convo-paper';

const SESSION_PARAM = {
  type: 'string',
  description: '会话 id（`latest` 表示最近一次会话，也可传 id 片段）。留空等于 latest。',
};

const CWD_PARAM = {
  type: 'string',
  description: '会话所属工作目录；用于在多个项目之间消歧。',
};

const OUT_PARAM = {
  type: 'string',
  description: '产物目录，默认写到会话的 cwd 下的 paper-work/。',
};

function text(value) {
  return [{ type: 'text', text: String(value) }];
}

function summarize(result) {
  if (!result || result.ok === false) {
    return `失败：${result?.message || result?.code || 'unknown error'}`;
  }
  if (result.step === 'extract') {
    const s = result.stats || {};
    return `已抽取 ${result.sessionId}：${s.turns ?? 0} 轮 / 用户 ${s.userMessages ?? 0} 条 / AI ${s.assistantMessages ?? 0} 条，剔除系统注入 ${s.injectedMessages ?? 0} 条 → ${result.out}`;
  }
  if (result.step === 'claims') {
    return `候选论点 ${result.candidateCount} 条（${Object.entries(result.bySection || {})
      .map(([k, v]) => `${k}:${v}`)
      .join('，')}）→ ${result.out}`;
  }
  if (result.step === 'build') {
    return `骨架已生成：保留论点 ${result.keptClaims} 条，已核实文献 ${result.verifiedRefs} 条 → ${result.out}`;
  }
  if (result.step === 'verify-refs') {
    return `核验 ${result.verdicts.length} 条：verified ${result.verified}｜possible ${result.possible}｜rejected ${result.rejected} → ${result.out}`;
  }
  if (result.step === 'run') {
    return `${summarize(result.extracted)}\n${summarize(result.claims)}\n${summarize(result.built)}`;
  }
  return JSON.stringify(result);
}

function define(ctx, def) {
  return ctx.effect(() => ctx.tools.register(def), `${LABEL} ${def.name}`);
}

export function apply(ctx) {
  define(ctx, {
    name: 'paper_extract',
    description:
      '读取一段 DSH 会话日志，按说话人还原上下文（用户说了什么 / AI 答了什么），剔除运行时上下文等系统注入，输出 transcript.md 与 conversation.json。做"把对话整理成论文"的第一步。',
    parameters: {
      type: 'object',
      properties: { session: SESSION_PARAM, cwd: CWD_PARAM, out: OUT_PARAM, includeTools: { type: 'boolean', description: '是否在 transcript 中附上工具调用摘要' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(summarize(v)) },
    async execute(args = {}) {
      return runExtract(args);
    },
    presentCall: (args = {}) => ({
      card: 'generic',
      title: '抽取对话上下文',
      kind: 'read',
      rawInput: String(args.session || 'latest'),
    }),
  });

  define(ctx, {
    name: 'paper_claims',
    description:
      '从已抽取的对话中提炼带出处的候选论点（观点/结论/创意），每条含 id、说话人、轮次、时间戳、建议章节，输出 claims.json 与 claims.md，供人工判定 keep/merge/drop。',
    parameters: {
      type: 'object',
      properties: {
        out: OUT_PARAM,
        session: SESSION_PARAM,
        cwd: CWD_PARAM,
        perTurn: { type: 'number', description: '每轮最多保留多少条候选句，默认 6' },
      },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(summarize(v)) },
    async execute(args = {}) {
      return runClaims(args);
    },
    presentCall: () => ({ card: 'generic', title: '提炼候选论点', kind: 'read' }),
  });

  define(ctx, {
    name: 'paper_build',
    description:
      '把保留的论点与已核实文献组装成论文骨架：摘要、六节正文、参考文献，并生成 evidence.md 证据对照表（论点→出处→支撑文献）。',
    parameters: {
      type: 'object',
      properties: { out: OUT_PARAM, cwd: CWD_PARAM, title: { type: 'string', description: '论文标题；缺省用会话标题' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(summarize(v)) },
    async execute(args = {}) {
      return runBuild(args);
    },
    presentCall: () => ({ card: 'generic', title: '生成论文骨架', kind: 'edit' }),
  });

  define(ctx, {
    name: 'paper_verify_refs',
    description:
      '逐条核验参考文献：Crossref / DataCite / OpenAlex / arXiv 四源检索，DOI 反查 + 标题相似度判定。只有 verified 的条目允许进入正文，possible 需人工核对，rejected 必须丢弃。输入 [{id, claimId, title, doi}]。',
    parameters: {
      type: 'object',
      properties: {
        refs: {
          type: 'array',
          description: '待核验条目，title 必填，doi 强烈建议',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              claimId: { type: 'string', description: '这条文献支撑哪个论点（C001…）' },
              title: { type: 'string' },
              doi: { type: 'string' },
              year: { type: 'number' },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
        out: OUT_PARAM,
        cwd: CWD_PARAM,
      },
      required: ['refs'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(summarize(v)) },
    async execute(args = {}) {
      return runVerifyRefs(args);
    },
    presentCall: (args = {}) => ({
      card: 'generic',
      title: '核验参考文献',
      kind: 'read',
      rawInput: `${Array.isArray(args.refs) ? args.refs.length : 0} 条`,
    }),
  });

  define(ctx, {
    name: 'paper_run',
    description: '一步完成 paper_extract → paper_claims → paper_build，产出可编辑的论文骨架。需要核验文献时再单独调用 paper_verify_refs。',
    parameters: {
      type: 'object',
      properties: { session: SESSION_PARAM, cwd: CWD_PARAM, out: OUT_PARAM, includeTools: { type: 'boolean' }, perTurn: { type: 'number' } },
      additionalProperties: false,
    },
    output: { schema: { type: 'object' }, render: (_a, v) => text(summarize(v)) },
    async execute(args = {}) {
      return runAll(args);
    },
    presentCall: (args = {}) => ({ card: 'generic', title: '对话转论文', kind: 'edit', rawInput: String(args.session || 'latest') }),
  });

  // Cordis 4 refuses to read an undeclared service through `ctx.commands`
  // ("cannot get property ... without inject") and that throw would roll back
  // the whole entry — tools included. Read the service reflectively instead,
  // which needs no inject and stays undefined on hosts without commands.
  const commands = ctx.reflect && typeof ctx.reflect.get === 'function' ? ctx.reflect.get('commands', false) : undefined;
  if (commands && typeof commands.register === 'function') {
    ctx.effect(
      () =>
        commands.register({
          name: 'paper',
          description: '把当前（或指定）会话整理成论文骨架',
          input: { hint: '[latest|<会话id>] [--out <目录>]' },
          handler: async (invocation) => {
            try {
              const raw = String(invocation?.args ?? invocation?.input ?? invocation?.text ?? '').trim();
              const parts = raw.split(/\s+/).filter(Boolean);
              const session = parts[0] && parts[0] !== '--out' ? parts[0] : 'latest';
              const outIdx = parts.indexOf('--out');
              const out = outIdx >= 0 ? parts[outIdx + 1] : undefined;
              const result = await runAll({ session, out });
              const text = summarize(result);
              // The host's command registry accepts exactly two result kinds —
              // `success` (optional text) and `error` (non-empty text). Anything
              // else fails validation with "unknown result kind".
              return result && result.ok === false ? { kind: 'error', text } : { kind: 'success', text };
            } catch (error) {
              return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
            }
          },
        }),
      `${LABEL} /paper command`,
    );
  }
}
