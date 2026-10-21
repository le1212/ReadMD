# 决策：本地 Markdown 阅读/编辑器选型

- 日期：2026-10-20
- 状态：已采纳（v0.1 实施中）

## 背景

目标是在 Windows 上提供一个**打开本地文件夹、阅读和编辑 Markdown**的桌面程序。使用者不要求技术背景，因此需要：

- 双击即可用，界面接近 Typora / MarkText 的所见即所得体验；
- 不改动原有 Markdown 文件结构，不把笔记锁进数据库；
- 低成本、可回退，后续能持续升级；
- 不重复实现成熟的 Markdown 解析与富文本编辑内核。

## 对标与调研

### 市场头部产品

| 产品 | 形态与优势 | 授权/价格 | 对本项目的启示 |
| --- | --- | --- | --- |
| Typora | 即时渲染（Live Preview）的开创者，界面极简，本地文件，Windows/macOS/Linux | 闭源、付费（官网当前网络无法访问，价格以官网为准） | 交互目标：写作时看不到源码标记，光标所在行才显示语法 |
| Obsidian | 本地 Markdown 文件 + 双向链接/图谱/插件，个人使用免费 | 闭源 | 文件必须留在本地、格式开放；但知识库/双链不是本期范围 |
| MarkText | 开源全功能 Markdown 编辑器，WYSIWYG，Windows 安装包现成 | MIT，62,879 stars，v0.22.0（2026-10-18），仍在高频更新 | 最接近“直接可用”的成品；也是本项目功能对照基准 |
| VS Code | 内置 Markdown 编辑与预览，扩展生态强 | MIT（核心） | 证明“编辑器 + 预览”是成熟路径，但 IDE 对普通用户过重 |
| Zettlr | 面向学术写作的 Markdown 工作台 | GPL-3.0，13,790 stars | 功能强，但 GPL 传染性不适合作为闭源二开底座 |
| 思源笔记 | 本地优先的知识库，块级编辑 | AGPL-3.0，46,849 stars | 数据模型是数据库而非纯文件，不符合“直接改 .md”的目标 |

> 说明：Typora 官网、维基百科在当前网络环境均连接超时，未能逐页核对；上表只采用其长期公开的产品定位，不引用具体价格与版本号。Obsidian（obsidian.md）、MarkText、Zettlr、思源的信息均来自官网或 GitHub API 的实时数据。

### GitHub 候选项目评估

检索关键词至少覆盖：`markdown editor`、`topic:markdown-editor stars:>1000`、`typora alternative`、`awesome markdown`。

| 项目 | 许可证 | 规模/活跃度 | 结论 |
| --- | --- | --- | --- |
| [marktext/marktext](https://github.com/marktext/marktext) | MIT | 62,879 stars；2026-10-20 仍有提交；v0.22.0 提供 Windows x64 安装包 | **不 Fork**。它是完整成品，直接安装即可满足“全功能”需求；Fork 整个 monorepo（Electron + Vue + TS + pnpm）会带来长期同步成本，超出本期“轻量本地阅读/编辑”的范围。保留为备选与功能对照。 |
| [Vanessa219/vditor](https://github.com/Vanessa219/vditor) | MIT | 11,383 stars；v4.0.1（2026-10-18）；npm 包内含 highlight.js / KaTeX / Mermaid 等全部离线资源 | **直接依赖**。作为编辑器内核，支持所见即所得、即时渲染（Typora 式）、分屏三种模式，中文文档完善。 |
| [Milkdown/milkdown](https://github.com/Milkdown/milkdown) | MIT | 11,996 stars；2026-10-18 仍有提交 | 备选内核。基于 ProseMirror，定制能力强，但文件树、上传、中文工具栏等需要更多自研；本期不选。 |
| [nhn/tui.editor](https://github.com/nhn/tui.editor) | MIT | 17,993 stars，但仓库已归档（最后提交 2024-08） | 淘汰：不再维护。 |
| [pandao/editor.md](https://github.com/pandao/editor.md) | MIT | 14,305 stars，最后提交 2024-04 | 淘汰：停更、老式 jQuery 架构。 |
| [benweet/stackedit](https://github.com/benweet/stackedit) | Apache-2.0 | 23,092 stars，最后提交 2023-07 | 淘汰：浏览器在线编辑器，非桌面本地文件场景。 |
| [Zettlr/Zettlr](https://github.com/Zettlr/Zettlr) | GPL-3.0 | 13,790 stars，活跃 | 淘汰：GPL 传染性，不适合作为可闭源分发的底座。 |
| [siyuan-note/siyuan](https://github.com/siyuan-note/siyuan) | AGPL-3.0 | 46,849 stars，活跃 | 淘汰：AGPL + 数据库式知识库，不是纯文件编辑器。 |
| [BND-1/horseMD](https://github.com/BND-1/horseMD) | MIT | 506 stars，2026-06 创建 | 仅参考。定位同样是“Typora 替代 + 标签页 + 文件树”，但项目新、规模小，暂不作为依赖。 |

## 决策

**自研一个轻量外壳，编辑器内核直接依赖 Vditor。**

- 运行时：Electron 42.1.0（与 MarkText 同大版本，Windows 10 1809 可运行；无需 Rust 工具链）。
- 编辑器：Vditor 4.0.1，`mode: 'ir'`（即时渲染），所有懒加载资源指向本地 `renderer/vendor/vditor`，完全离线。
- 自研部分：欢迎页、文件夹树、标签页、自动保存、主题切换、图片粘贴落盘、查找、HTML/PDF 导出、最近打开、窗口状态记忆。
- 许可证：本项目代码 MIT；Vditor 的 MIT 许可证随构建产物一起保留。

## 为什么不直接 Fork MarkText

1. MarkText 已经是成熟成品，直接安装即可获得更完整的功能；Fork 的收益主要是品牌/界面定制，而不是能力。
2. 它是 pnpm monorepo（Electron + Vue + TypeScript），Fork 后每次上游更新都需要处理大量冲突。
3. 本期目标是“轻量、可维护、按需定制”，用 Vditor + 薄外壳更符合成本与可逆性要求。

## 影响与风险

- **格式会被规范化**：Vditor 的即时渲染在保存时可能调整空行、列表符号、表格对齐等（与 Typora 类似）。原始内容在首次保存前不变；介意 diff 的用户应先用 Git 或备份。
- **安装包体积**：Electron 版本约 150–250 MB。若未来强需求“小体积”，可迁移到 Tauri，但需要安装 Rust 工具链，成本更高。
- **上游 API 变化**：锁定 Vditor 4.0.1；升级前需跑冒烟测试与截图回归。
- **安全**：Markdown 默认开启 XSS 过滤；渲染进程禁用 Node、启用上下文隔离与沙箱；文件写入限制在用户打开的文件夹/文件范围内；外部链接交给系统浏览器。
- **可逆性**：所有文档仍是普通 `.md` 文件，不产生私有数据库；卸载程序不影响文件。

## 备选方案（按推荐顺序）

1. **直接安装 MarkText**：最快获得完整功能，适合“现在就要用”；缺点是界面与功能不可按需裁剪。
2. **Fork MarkText**：适合要做深度品牌化/功能改造的团队；维护成本最高。
3. **Milkdown 自研内核**：适合需要块级编辑、协同、AI 深度集成的长期项目；本期工作量最大。
