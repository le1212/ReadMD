# 决策：Markdown 导出 Word / PDF 的排版方案

- 日期：2026-10-21
- 状态：已采纳（v0.1.2 实施）

## 背景

现有 ReadMD 只能导出 HTML 和 PDF，且 PDF 直接复用屏幕样式：字号、行距、页边距都没有针对 A4 纸张设计，导出 Word 更是完全缺失。

用户的核心要求是：

- 支持 Markdown → Word(.docx) 与 PDF；
- 导出结果要“美观”，行距、字距、段间距都要留出呼吸感；
- 排版要符合规范，而不是把网页样式直接塞进纸张；
- 用户不需要懂技术，点一下就能得到可用的文档。

约束：

- 应用是 Electron 桌面程序，面向 Windows 普通用户；
- 不希望引入几百 MB 的额外运行时（例如完整的 LaTeX）；
- 导出必须可离线使用；
- 现有 Markdown 文件不能被改写，导出是只读操作；
- 新增依赖必须许可证清晰、可商用。

## 对标与调研

### 头部产品怎么做

| 产品 | Word 导出 | PDF 导出 | 对 ReadMD 的启示 |
| --- | --- | --- | --- |
| Typora | 通过 Pandoc + `reference.docx` 控制样式；用户可以在 Word 里改好一套样式再作为模板 | 内置 Chromium 渲染，可选 A4/A5、页边距、主题、页眉页脚、分页 | Word 用“样式模板”而不是逐段硬编码；PDF 用纸张尺寸 + 页边距 + 打印 CSS |
| Pandoc | `--reference-doc` 指定参考文档，只取其中的样式和文档属性 | 默认走 LaTeX，也可换 `wkhtmltopdf`、`weasyprint`、`typst` 等 HTML/排版引擎 | 样式与内容分离是成熟做法；但 Pandoc 是 GPL，且 PDF 依赖 LaTeX，不适合直接打包进轻量桌面应用 |
| Obsidian | 原生不提供 Word 导出，通常依赖 Pandoc 插件 | Electron/Chromium 打印，支持主题和分页 | PDF 用 Chromium 是桌面端常见方案，不需要再装浏览器 |
| Microsoft Word | — | — | 中文正文常用宋体小四（12pt）、1.5 倍行距；A4 上下 2.54cm、左右 3.17cm 是常见版心 |

结论：**Word 用“原生 Word 样式 + 固定排版规范”，PDF 用“Chromium 打印 + 专用打印 CSS”**，与头部产品的做法一致，且不需要引入 LaTeX/Pandoc。

### GitHub 候选项目

检索关键词覆盖：`markdown to docx`、`docx generator javascript`、`markdown pdf electron printToPDF`、`html to docx`。

| 项目 | 许可证 | 规模/活跃度 | 评估结论 |
| --- | --- | --- | --- |
| [dolanmiu/docx](https://github.com/dolanmiu/docx) | MIT | 约 6.0k stars，v9.13.0，持续维护 | **直接依赖**。支持段落/字符样式、`eastAsia` 中文字体、行距、段前段后、字符间距、页边距、页眉页脚、表格、图片；内置 HTML → docx 转换，并能把 MathML 转成 Word 原生公式。 |
| [node-html-parser](https://github.com/taoqf/node-html-parser) | MIT | 约 1.2k stars | **直接依赖**。只做一件事：快速扫描 HTML 里的图片地址，供 docx 转换前预读图片。 |
| [jgm/pandoc](https://github.com/jgm/pandoc) | GPL-2.0+ | 46.7k stars | **不打包**。GPL 传染性 + 完整安装体积大；PDF 默认依赖 LaTeX。只参考其 `reference.docx` 的“样式与内容分离”思路。 |
| [simonhaenisch/md-to-pdf](https://github.com/simonhaenisch/md-to-pdf) | MIT | 2.0k stars | **不采用**。它自带 Puppeteer（另一份 Chromium），而 Electron 本身就是 Chromium；引入等于重复几百 MB 运行时。只参考其 `@media print`、页眉页脚、分页配置。 |
| html-docx-js 等 HTML→docx 方案 | MIT | 维护较弱 | **不采用**。只能生成较粗的 HTML 快照，无法精确控制中文字体、字符间距、1.5 倍行距和 Word 样式。 |

### 方案对比

| 方案 | Word 质量 | PDF 质量 | 体积/依赖 | 许可证风险 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 打包 Pandoc | 最高（原生 Word 样式） | 最高（LaTeX） | 150MB+，PDF 还要 LaTeX（数百 MB） | GPL | 淘汰 |
| md-to-pdf + Puppeteer | 不支持 | 好 | 额外 Chromium 约 300MB | MIT | 淘汰 |
| docx 库 + Electron `printToPDF` | 高（原生样式可编辑） | 高（A4 打印 CSS） | 约 24MB（未压缩） | MIT | **采用** |
| 自研 OOXML 生成 | 可控 | 高 | 无新增依赖 | 无 | 不采用：重复造轮子，维护成本高 |

## 决策

### 1. Word：用 `docx` 生成“可继续编辑”的原生样式文档

内容来源是 Vditor 的 `getHTML()`，再交给 `docx/html` 转换。转换时：

- 正文、标题、引用、代码块、列表、链接分别映射到 Word 样式：
  - `Normal`：正文
  - `Heading 1` ~ `Heading 6`：标题
  - `Quote`：引用
  - `Source Code`：代码块
  - `List Paragraph`：列表
  - `Hyperlink`：链接
  - `Verbatim Char`：行内代码
- 表格边框、底色、单元格内边距等无法用 Word 表格样式稳定表达的部分，用一段极简的 `@media print` CSS 控制；
- 图片在转换前由主进程读入（本地路径、`file://`、`http(s)`、data URL），再交给转换器，避免转换器联网或读盘；
- 公式在渲染进程用 KaTeX 重新渲染成“HTML + MathML”，PDF 用 HTML 显示，Word 用 MathML 转成 Word 原生公式。

### 2. PDF：Chromium `printToPDF` + 专用打印 CSS

- 纸张 A4，页边距上下 2.54cm、左右 3.17cm；
- 正文 12pt、行高 1.8、段后 0.55em、两端对齐；
- 标题黑体，正文宋体，拉丁文分别配 Arial / Times New Roman；
- 标题 `break-after: avoid`，代码块 `break-inside: avoid`，表格 `thead` 跨页重复，表格行不跨页拆分；
- 页脚“第 X 页 / 共 Y 页”，8pt 灰色；
- 不在页眉重复文档标题，避免第一页标题与页眉重复；需要时后续可增加“页眉显示文件名”的选项；
- 导出 HTML 与 PDF 共用同一套 CSS，保证网页、打印、PDF 观感一致。

### 3. 统一排版规范

| 元素 | Word | PDF / HTML |
| --- | --- | --- |
| 正文 | 宋体 12pt（小四），Times New Roman，1.5 倍行距，段后 6pt，字符间距 0.2pt | 宋体 12pt，1.8 行高，段后 0.55em，字距 0.02em |
| 一级标题 | 黑体 22pt 加粗，下边框，段前 24pt/段后 12pt | 黑体 22pt，下边框，段前 24pt/段后 16pt |
| 二级标题 | 黑体 17pt 加粗，段前 18pt/段后 9pt | 黑体 17pt，段前 24pt/段后 10pt |
| 三级标题 | 黑体 15pt 加粗，段前 15pt/段后 6pt | 黑体 15pt，段前 18pt/段后 8pt |
| 代码块 | Consolas 9.5pt，浅灰底、细边框、左右缩进 | 同左，`break-inside: avoid` |
| 引用 | 左侧 3pt 竖线、浅灰底、左右缩进 | 同左 |
| 表格 | 10.5pt，表头浅灰底、居中，边框 0.5pt，表头跨页重复 | 同左 |
| 页边距 | 上下 2.54cm，左右 3.17cm | 同左 |
| 页码 | 页脚居中“第 X 页 / 共 Y 页” | 同左 |

**关于首行缩进**：默认不缩进。原因是 Markdown 生态（Typora、Pandoc、Obsidian）都用“段间距”而不是“首行缩进”来区分段落，和 Markdown 的书写习惯一致。需要中文公文/论文风格时，可在导出设置中切换“正式文档（首行缩进 2 字符）”，底层实现见 [0004 - 导出设置、封面目录与批量导出](0004-导出设置与批量导出.md)。

### 4. 交互

- 顶部命令栏新增“导出”按钮，点开后是 Word / PDF / HTML 三个入口；
- 文件菜单保留三个对应菜单项，方便键盘用户；
- 导出失败会给出中文提示；部分图片无法转换时，会在成功提示中说明“有 N 处内容未完整转换”。

## 影响与风险

- **新增依赖**：`docx` 9.13.0（MIT）、`node-html-parser` 9.0.5（MIT）。未压缩约 24MB，打包后体积会增加（压缩后通常增加几 MB）。
- **字体依赖**：宋体、黑体、Consolas 是 Windows 自带字体；macOS/Linux 会回退到系统衬线/无衬线字体，排版结构不变，但字形会不同。
- **Word 版本差异**：页脚页码使用 Word 域（PAGE/NUMPAGES），并设置打开时更新域；极少数精简版 Word/WPS 可能需要手动更新域。
- **公式**：常见 LaTeX 命令可转成 Word 原生公式；非常用命令可能退回纯文本公式。KaTeX 渲染失败时会保留 LaTeX 原文。
- **图片**：本地图片、网络图片、data URL 都会尝试嵌入；WebP 会尝试转 PNG，SVG 依赖 Word 版本，缺失图片会跳过并在导出结果里提示。
- **HTML 导出**：图片仍以本机绝对 `file://` 地址引用，复制到其他电脑后图片会失效；这是原有行为，本次未改变。
- **可逆性**：所有导出都是新增文件，不修改源 Markdown；不引入数据库或私有格式。

## 验证

- `npm run smoke` 通过，包含：
  - Word 导出：文件头 `PK`、`word/document.xml` 含正文/表格/图片/公式、`word/styles.xml` 含宋体/黑体、`w:line="360"`、字符间距 `w:spacing w:val="4"`、`Quote`/`SourceCode` 样式、`tblHeader`、页脚 `PAGE`/`NUMPAGES`；
  - PDF 导出：文件头 `%PDF-`，页脚页码可被 PDF 文本层识别，表格表头跨页重复；
  - HTML 导出：包含完整文档结构、专用排版 CSS。
- 视觉抽检：Word 预览使用 `docx-preview` 渲染，PDF 使用 `pdfjs-dist` 渲染，确认标题层级、正文行距、列表、引用、代码块、表格、图片和页脚位置正常。
- 打包后的 portable exe 会执行同一套冒烟测试，确认 ASAR 内 `docx`/`node-html-parser` 与 `electron/export` 资源可正常加载。

## 备选方案（按推荐顺序）

1. **打包 Pandoc**：如果未来要求“Word 样式与 Pandoc 完全一致”且不介意 GPL 与体积，可切换；但需要重新评估许可证和安装包大小。
2. **md-to-pdf + Puppeteer**：如果未来 PDF 需要更复杂的 paged-media（页码、目录、跨页脚注），可评估 Paged.js 或 Puppeteer；当前 Electron 已足够。
3. **增加导出设置面板**：提供“通用 / 正式文档（首行缩进）”排版预设，以及页眉、页脚、封面、目录开关；已于 0.3.0 实施，见 [0004 - 导出设置、封面目录与批量导出](0004-导出设置与批量导出.md)。
