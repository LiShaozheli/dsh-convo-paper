# dsh-convo-paper-plugin

DeepSeek Harness 插件版：把对话整理成论文，并用确定性检索核验每一条引用。

这是 [dsh-convo-paper](../README.md) 的宿主插件形态。核心逻辑与技能版完全一致（`dsh/lib/` 由 `lib/` 生成，`npm test` 会校验两份不漂移），区别在于它把自己注册进 DSH 的工具与命令系统：

| 能力 | 说明 |
| --- | --- |
| `paper_extract` | 读会话日志，按说话人还原上下文，剔除系统注入 → `transcript.md` / `conversation.json` |
| `paper_claims` | 提炼带出处的候选论点（id / 说话人 / 轮次 / 时间戳 / 建议章节）→ `claims.json` / `claims.md` |
| `paper_build` | 组装论文骨架与证据对照表 → `paper-skeleton.md` / `evidence.md` |
| `paper_verify_refs` | 四源核验引用（Crossref / DataCite / OpenAlex / arXiv），DOI 反查 + 标题相似度 |
| `paper_run` | 一步跑完 extract → claims → build |
| `/paper` | 斜杠命令，等价于 `paper_run` |

## 安装

插件需要装进 profile（不是拷文件夹）：

```bash
dsh plugin --profile desktop add dsh-convo-paper-plugin          # 从 npm 装（推荐）
# 或直接从仓库装：dsh plugin --profile desktop add github:LiShaozheli/dsh-convo-paper#path:/plugin
```

装完重启 DSH，`设置 → 插件` 里会出现 **convo-paper**，输入框输入 `/paper` 可用。

也可以只在某个 profile 里试用：

```bash
dsh plugin --profile web add github:LiShaozheli/dsh-convo-paper#path:/plugin
```

## 与技能版的取舍

| | 插件版 | 技能版 |
| --- | --- | --- |
| 出现在「已安装插件」 | ✅ | ❌（在技能列表/`@` 菜单里） |
| 斜杠命令 `/paper` | ✅ | ❌ |
| 原生工具，模型可直接调用 | ✅ | 读 `SKILL.md` 后手动跑 CLI |
| 安装成本 | 需要 profile 与重启 | 拷一个目录即可 |
| 依赖 | 无（不 import 任何 `@deepseek-ai/*` 值） | 无 |

## 契约

```js
export const name = 'convo-paper'
export const inject = ['tools']
export function apply(ctx) { ctx.effect(() => ctx.tools.register({...}), 'label') }
```

- 工具用 `ctx.tools.register` 的普通对象定义（参数走 JSON Schema，输出走 `output.schema` + `render`），因此不依赖 `@deepseek-ai/dsh-tools` 的 `defineTool`，装到任何兼容 profile 都能跑。
- 命令用 `ctx.commands.register`，且做了存在性判断——宿主没有 commands 服务时自动跳过，不影响工具。
- 所有注册都包在 `ctx.effect(...)` 里，插件卸载时自动注销。

## 验证

```bash
node test/plugin.test.mjs     # mock ctx：8 个用例，含真实会话日志端到端
node scripts/sync-core.mjs --check
```

测试会在临时 `DSH_HOME` 里造一份多帧 zstd 会话日志，套上 mock ctx 走完 `paper_run`，断言产物与控制台摘要。

## 已知边界

- 保证引用的**存在性**，不保证**恰当性**。
- 中文数据库（知网/万方）无开放 API，中文文献需人工确认。
- 论点抽取是启发式的；操作密集型对话会提示素材不足，而不是硬写。
