---
name: convo-paper
description: 把一段 DSH 对话（或任意 AI 对话记录）整理成一篇可直接修改的论文。会按说话人分离上下文、把有创意的观点与结论抽成带出处的候选论点、生成论文章节骨架，并用 Crossref / OpenAlex / arXiv 逐条核实参考文献（DOI 反查 + 标题相似度），只有核实通过的文献才允许进入正文。当用户说"把我们的对话整理成论文/综述/白皮书/课程论文"、"总结这段讨论并写成文章"、"帮我补参考文献"时使用。
---

# convo-paper：对话 → 论文

把"聊天记录"变成"论文"的关键不是排版，而是三件事：**谁的哪句话成了论点**、**哪条论点有证据**、**哪条引用是真的**。这个技能把这三件事做成可检查的流水线，成文由你（模型）负责。

## 铁律（先读）

1. **不得编造参考文献。** 只有 `verdict: "verified"` 的条目能写进正文和文末列表。`possible` 只能出现在"待人工核对"里，`rejected` 必须丢弃并告知用户。
2. **不得写成对话纪要。** 正文里不许出现"用户问……AI 答……""本次对话中"这类元叙述。读者只应该看到一篇独立成立的论文。
3. **每个论断都能回溯。** 正文里每条判断后面挂 `[Cn]` 锚点（写作时保留在草稿，终稿可删），保证审稿时能查回原话。
4. **观点归属要诚实。** 用户提出的想法 ≠ 模型提出的想法，`claims.json` 里的 `role` 字段必须如实反映，改写时不得据为己有。
5. **拿不准的写"待核实"，不要写"研究表明"。** 没有出处的经验性论断，用"本文观察""在本次实践中"限定。

## 路径约定

下文用 `$CP` 指代脚本本体。安装后：

```bash
CP="$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs"
```

在工作区的开发副本里则是 `dsh-convo-paper/bin/convo-paper.mjs`。PowerShell 下把 `$HOME/.dsh` 换成 `C:\Users\<你>\.dsh`。

## 工作流

### 第 0 步：确认会话与产出目标

```bash
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" sessions            # 列出本机会话（最新在最前）
```

问清（一次问完，不要来回）：
- 论文类型：课程论文 / 期刊投稿 / 会议论文 / 技术报告 / 白皮书
- 篇幅：字数或页数
- 语言与格式：中文（GB/T 7714）/ 英文（APA、IEEE、ACM）
- 是否有模板（.docx/LaTeX）或导师要求

默认假设（用户没答时）：中文学术论文、6000–8000 字、GB/T 7714、输出 `.docx`。

### 第 1 步：抽取上下文（用户说了什么 / AI 答了什么）

```bash
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" run --session latest --out paper-work --tools
```

产出：

| 文件 | 内容 |
| --- | --- |
| `transcript.md` | 按轮次、按说话人（### 用户 / ### AI 回答）的完整记录；系统注入的运行时上下文已自动剔除 |
| `conversation.json` | 结构化轮次数据（角色、时间、工具调用） |
| `claims.md` / `claims.json` | 候选论点，带 id、轮次、说话人、线索词 |
| `paper-skeleton.md` | 论文章节骨架 + 论点占位 + 引用位 |
| `evidence.md` | 证据对照表（论点 → 出处 → 支撑文献） |

先读 `transcript.md`，再读 `claims.md`。**不要跳过这一步直接写**——漏读会导致把次要闲聊当主线。

### 第 2 步：判定论点（这一步决定论文成败）

逐条处理 `claims.json`，把 `status` 改成 `keep` / `merge` / `drop`，必要时合并同类项：

- **keep**：有判断、有反直觉之处、有可推广的结构（框架/类比/分层/边界条件）。
- **merge**：与另一条重复或互补 → 合并成一条，保留信息量大的表述，`mergedInto` 指向新 id。
- **drop**：操作说明、"好的我来做"、工具调用叙述、重复确认、纯事实罗列。

只留 5–12 条。论点太多说明主线没抓住；太少说明对话本身还没形成观点，应直接告诉用户"这段对话还不够支撑一篇论文，建议补充 X 方向的讨论"，而不是硬凑。

然后给每条保留的论点补两个字段：
- `title`：一句话小标题（≤20 字，名词短语）
- `needsEvidence`：`true` 表示这条需要一个外部文献支撑（新颖性主张、与他人工作的比较、公认事实）

### 第 3 步：立论（把散点变成一条论证线）

在 `paper-skeleton.md` 基础上写 `outline.md`：

1. **问题**：用户最初的困扰是什么（来自 `C001` 之类的 statement 型论点）
2. **既有做法的不足**：别人怎么解决、缺什么（需要外部文献）
3. **本文观点**：2–4 条核心主张，彼此递进而不是并列
4. **论证**：每条主张的证据（对话中的推理/案例/反例 + 文献）
5. **边界**：什么情况下不成立
6. **结论**：可检验的结论 + 下一步

写完后自检：**把 6 个标题连起来读，是否就是一段完整的摘要？** 不是就回去改结构。

### 第 4 步：核实参考文献（本技能的核心保障）

**4.1 先问本机有没有更强的文献工具。** 按优先级尝试：

| 工具 | 用途 |
| --- | --- |
| `paper_search` / `dsh-paper-search` 插件 | 20+ 学术源，含 PubMed、Semantic Scholar、CNKI 类中文源 |
| `dsh-zotero` 插件 | 用户自己的 Zotero 文库（最可信：用户读过） |
| `@copylee/dsh-academic` 技能 | 文献综述、引文核验 |
| `convo-paper refs search` | Crossref / OpenAlex / arXiv 兜底（无需装任何插件） |

有插件就用插件检索，拿到 **DOI 或 arXiv ID**，再交给 4.2 做独立复核。这是"调用其他插件保证准确性"的落点：**检索可以靠插件，判定必须双源**。

**4.2 逐条核实。**

```bash
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" refs search --query "作者 年份 标题关键词" --limit 5
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" refs verify --in paper-work/refs-input.json --out paper-work
```

`refs-input.json` 格式（`title` 必填，`doi` 强烈建议）：

```json
[
  { "id": "R1", "claimId": "C003", "title": "Attention Is All You Need", "doi": "10.48550/arXiv.1706.03762" },
  { "id": "R2", "claimId": "C005", "title": "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks" }
]
```

判定规则（脚本内置）：

| verdict | 条件 | 允许的用法 |
| --- | --- | --- |
| `verified` | DOI 可解析且标题相似度 ≥ 0.85 | 写入正文与参考文献 |
| `possible` | 相似度 0.62–0.85 | 只能写进"待人工核对"，需人工确认 |
| `rejected` | < 0.62 或查无记录 | 丢弃，并向用户说明"这条引用查无实据" |

**中文文献**：Crossref 覆盖有限。有 DOI 的中国期刊走 DOI 反查；没有 DOI 的（知网、万方）必须标 `[待核实]`，或者改用同主题、可核实的英文文献并在正文里注明，**不允许凭记忆写卷期页码**。

**4.3 引用位置。** 正文里用上标 `[1]`、`[2]` 顺序编号，与 `bibliography.md` 一致；`possible` 一条都不许进正文。

### 第 5 步：成稿与导出

按 `outline.md` 写 `paper.md`：

- 摘要 200–300 字（问题、方法、主张、结论四段式，不要背景灌水）
- 关键词 3–5 个
- 正文各节：先给结论句，再展开论证；每段只说一件事
- 图表：对话里出现的数据/流程，用 markdown 表格或 mermaid 表达，不要截图
- 参考文献：直接复制 `bibliography.md` 的 verified 段

导出 `.docx`（两条路，任选）：

```bash
# A. 技能自带转换器（宋体小四 / 1.5 倍行距 / 首行缩进 2 字符 / 表格式参考文献）
python "$HOME/.dsh/skills/convo-paper/bin/md2docx.py" paper-work/paper.md paper-work/paper.docx
```

```
# B. 已安装 office-docx 技能时，用它做更细的排版控制
skill: office-docx  →  依据 paper.md 生成 .docx，套用用户模板
```

最后交付：`paper.md`、`paper.docx`、`bibliography.md`、`evidence.md` 四件，并明确告知：哪些引用已核实、哪些待人工确认、哪些论点来自用户、哪些来自模型（学术诚信要求）。

## 质量闸门（交付前逐条打勾）

- [ ] 正文没有出现"用户/AI/对话/聊天记录"字样
- [ ] 每条核心论点在 `evidence.md` 里都有出处
- [ ] 参考文献全部是 `verified`；`possible` 数量已如实告知用户
- [ ] 摘要 ≤ 300 字且包含结论
- [ ] 观点归属诚实：用户的想法没被写成"本文提出"
- [ ] 有"局限"一节，且写了具体边界而不是套话
- [ ] 页码/卷期/DOI 与 `bibliography.md` 逐字一致

## 命令速查

```bash
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" sessions                              # 列出会话
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" extract --session latest --out paper-work --tools
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" claims  --out paper-work --per-turn 6
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" build   --out paper-work --title "论文标题"
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" refs search --query "关键词" --limit 5
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" refs verify --in paper-work/refs-input.json --out paper-work
node "$HOME/.dsh/skills/convo-paper/bin/convo-paper.mjs" run --out paper-work                  # extract + claims + build
```

`--session` 可传 `latest`、完整 id（`session-xxxx`）或 id 片段；`--cwd` 用于指定会话所属工作目录。

## 已知边界

- 中文数据库（知网/万方/维普）没有开放 API：这类文献必须人工确认，脚本只能提示。
- 会话很长（>60 轮）时，`claims.md` 会明显变长，务必先按"主线"筛掉支线讨论，否则论文会失焦。
- 对话里如果主要是操作指令（装插件、改配置），抽出的"论点"质量会很低——这种情况应当直接告诉用户对话素材不足。
