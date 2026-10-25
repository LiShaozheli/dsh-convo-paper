# dsh-convo-paper

把一段对话整理成一篇论文——但**参考文献必须真的存在**。

[![tests](https://img.shields.io/badge/tests-8%20passed-brightgreen)](#开发与测试)
[![node](https://img.shields.io/badge/node-%E2%89%A522.15-blue)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）技能包：读会话日志 → 按说话人还原上下文 → 抽出有创意的观点与结论 → 生成论文章节骨架 → 逐条核实参考文献 → 交给模型写成稿。

**它不替代写作，它保证写作不被编造拖垮。**

## 它解决什么

把聊天记录丢给模型说"写成论文"，通常得到两种东西：带对话口吻的纪要，或者引用格式完美、但查无此文的文本。已有实证研究指出，模型给出的参考文献在格式上无懈可击，却常与真实文献不符[^1]；在专业领域测评中，回答准确率与引用可靠性并不同步[^2]。

| 常见失败 | 本技能的处理 |
| --- | --- |
| 产出"对话纪要"而不是论文 | 先分离说话人再抽论点，正文禁止出现"用户/AI"元叙述 |
| 一本正经编造参考文献 | Crossref / DataCite / OpenAlex / arXiv 四源核验，通过才放行 |
| 把用户的洞见写成"本文提出" | 每条论点记录 `role` + `turn`，证据表可逐条回溯 |
| 篇幅膨胀、主线丢失 | 论点强制收敛到 5–12 条，超了直接提示"素材不足" |

## 效果示例

```
$ convo-paper refs verify --in refs.json
核对 3 条…
  1/3 verified  Citation Accuracy Challenges Posed by Large Language Models
  2/3 verified  High Accuracy, Questionable References: LLMs' Performance…
  3/3 rejected  A Fully Automated Conversation-to-Paper Pipeline with Guaranteed…
verified 2｜possible 0｜rejected 1
```

第 3 条是刻意构造的伪造条目——标题像模像样、DOI 不存在。它在三个数据源都查无相近记录，被拒绝并单独告警。**在本测试样本上，伪造引用的放行数量为零。**

## 工作流

```
DSH 会话日志 (session.v4.jsonl.zstd)
        │  逐帧解 zstd、按 source.kind 剔掉系统注入
        ▼
   transcript.md      用户说了什么 / AI 答了什么，按轮次分开
        │  线索词 + 新颖性标记 + 长度打分
        ▼
   claims.json        候选论点：id / 说话人 / 轮次 / 时间戳 / 建议章节
        │  人工或模型判定 keep / merge / drop
        ▼
   paper-skeleton.md  章节骨架 + 论点占位 + 引用位
        │  检索 → DOI 反查 → 标题相似度
        ▼
   refs.json          verified / possible / rejected
        │
        ▼
   paper.md → paper.docx（宋体小四 / 1.5 倍行距 / GB/T 7714）
```

## 安装

作为 DSH 技能安装（需要一个已初始化的 DSH）：

```bash
git clone https://github.com/LiShaozheli/dsh-convo-paper.git
cp -r dsh-convo-paper "$HOME/.dsh/skills/convo-paper"
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" sessions   # 验证
```

要求 Node ≥ 22.15（用到内置 `zlib.zstdDecompressSync`）。无第三方依赖。

装好后技能会出现在 DSH 的技能列表里，说一句"把上面这段对话整理成论文"即可触发。

## 快速开始

```bash
CP="$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs"

node "$CP" sessions                        # 列出本机会话（最新在前）
node "$CP" run --out paper-work            # 抽取 + 论点 + 骨架
node "$CP" refs search --query "关键词" --limit 5
node "$CP" refs verify --in refs.json --out paper-work
python ~/.dsh/skills/convo-paper/bin/md2docx.py paper-work/paper.md paper-work/paper.docx
```

| 命令 | 作用 |
| --- | --- |
| `sessions` | 列出本机所有会话日志 |
| `extract` | 抽取上下文 → `transcript.md` / `conversation.json` |
| `claims` | 候选论点 → `claims.md` / `claims.json` |
| `build` | 章节骨架 → `paper-skeleton.md` / `evidence.md` |
| `refs search` | 检索文献，返回 DOI 与 GB/T 7714 著录 |
| `refs verify` | 逐条核验，输出 `refs.json` / `bibliography.md` |
| `run` | `extract` + `claims` + `build` |

`--session` 支持 `latest`、完整 id（`session-xxxx`）或 id 片段；`--cwd` 指定会话所属工作目录。

## 引用核验规则

| verdict | 条件 | 允许的用法 |
| --- | --- | --- |
| `verified` | DOI 可解析 且 标题相似度 ≥ 0.85 | 可进正文与参考文献 |
| `possible` | 相似度 0.62–0.85 | 仅"待人工核对"，需人工确认 |
| `rejected` | < 0.62 或查无记录 | 丢弃并告警 |

DOI 路由：`10.48550/arXiv.*`、Zenodo、OSF 等 DataCite 注册的 DOI 走 DataCite（走 Crossref 会返回错误的重印记录）；其余先 Crossref，再 DataCite，再 OpenAlex。中文文献没有 DOI 时必须标 `[待核实]`。

## 与生态插件协作

如果本机装有文献类插件，技能会优先使用它们检索，再交给脚本独立复核：

- `paper_search` / [dsh-paper-search](https://www.npmjs.com/package/dsh-paper-search)（20+ 学术源）
- [dsh-zotero](https://www.npmjs.com/package/dsh-zotero)（用户自己的 Zotero 文库，最可信）
- [@copylee/dsh-academic](https://www.npmjs.com/package/@copylee/dsh-academic)（综述、精读、模拟审稿技能）

**检索可以依赖插件，判定必须双源。** 插件给出的 DOI 也会被 `refs verify` 再解析一次，防止插件侧元数据错误被直接继承。

## 实测记录

在一个真实 DSH 会话上跑通（2 个用户轮次 / 2 条模型回答 / 90 次工具调用）：

- 日志里有 4 条被记录为"用户消息"的系统注入（运行时上下文、技能目录、时间戳等），按 `source.kind` 正确剔除——不剔除它们会被当成超长用户发言，直接污染问题陈述。
- 5 条候选论点，人工判定保留 3 条。被丢弃的两条是操作说明与工具配置提示：句式完整、含结论词，但对论文没有贡献——这说明线索词方法保证不漏，但必须有第二道判定。
- 3 条候选引用 → 2 条 `verified`、1 条 `rejected`。其中一条只给标题、没给 DOI，靠 Crossref 检索匹配成功。

## 开发与测试

```bash
node test/smoke.test.mjs     # 8 个用例：解码、说话人分离、论点抽取、著录格式、骨架生成
```

无第三方依赖、无构建步骤。核心模块：

| 文件 | 职责 |
| --- | --- |
| `lib/zstd.mjs` | 多帧 zstd 解码（Node 的 sync API 只解第一帧，stream API 遇到写入中的尾部会报错） |
| `lib/sessions.mjs` | 定位会话日志、解析事件 |
| `lib/extract.mjs` | 事件 → 按轮次/说话人的对话结构 |
| `lib/claims.mjs` | 候选论点抽取与打分 |
| `lib/refs.mjs` | 四源检索、DOI 路由、相似度判定、GB/T 7714 著录 |
| `lib/build.mjs` | 章节骨架与证据表 |
| `bin/md2docx.py` | Markdown → DOCX（python-docx，中文学术排版） |

## 路线图

- [ ] 跨会话聚合：同一主题的多轮讨论合并成一篇
- [ ] 中文文献通道：可核验的中文元数据来源
- [ ] 独立评审模型：对论证链做对抗性检查
- [ ] 更多著录格式：APA / IEEE / ACM / Chicago

## 已知边界

- **保证"引用存在"，不保证"引用恰当"**——哪条文献支撑哪个论点，仍需作者判断。
- 知网/万方/维普没有开放 API，中文文献只能人工确认。
- 论点抽取是启发式的；以操作指令为主的对话（装插件、改配置）抽出的内容质量很低，技能会提示素材不足而不是硬写。
- 面向"思想型"对话设计；依赖实验数据的研究里，对话只是构思副产品，此时它应退化为提纲工具。

## English

**dsh-convo-paper** turns a DeepSeek Harness conversation into a paper draft without fabricated references. It decodes the session log frame by frame, separates the human's turns from the model's (dropping harness injections), extracts candidate claims with speaker/turn provenance, builds a section skeleton, and gates every citation through Crossref / DataCite / OpenAlex / arXiv — only records whose DOI resolves and whose title matches may enter the manuscript.

```bash
git clone https://github.com/LiShaozheli/dsh-convo-paper.git
cp -r dsh-convo-paper "$HOME/.dsh/skills/convo-paper"
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" run --out paper-work
```

Requires Node ≥ 22.15. No dependencies.

## License

MIT. See [LICENSE](LICENSE).

[^1]: Zhang M, Zhao T. Citation Accuracy Challenges Posed by Large Language Models[J]. JMIR Medical Education, 2025, 11: e72998. DOI: 10.2196/72998.
[^2]: Nieves-Lopez B, Fabregas A, Del Rio Montesinos GF, 等. High Accuracy, Questionable References: Large Language Models' Performance and Citation Reliability in Foot and Ankle Surgery Examinations[J]. Foot & Ankle Orthopaedics, 2026, 11(3). DOI: 10.1177/24730114261484163.
