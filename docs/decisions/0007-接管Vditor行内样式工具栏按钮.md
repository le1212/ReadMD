# 决策：接管 Vditor IR 模式删除线/加粗/斜体工具栏按钮

- 日期：2026-10-22
- 状态：已采纳

## 背景

用户报告：正文编辑区对同一段文字重复点击"删除线"按钮，结果不一致——第一次正常，继续点击就开始出现 `~~`、`~~~~` 之类的奇怪符号（符号叠加）。

复现与定位过程（冒烟测试 `strikeRepeatTest` 实证）：

1. **Vditor 4.0.1 IR 模式"添加"分支缺陷**：对选中文字点删除线时，Vditor 用 `insertHTML` 插入 `~~<wbr>文字<wbr>~~`。Lute（Vditor 的 Markdown 引擎）不解析含 `<wbr>` 的删除线标记，`SpinVditorIRDOM` 原样保留字面 `~~` 文本。在 Node 中直接调用 Lute 验证：`SpinVditorIRDOM('~~<wbr>ABCDEF<wbr>~~')` 输出不变。结果是"加删除线"实际写入的是字面 `~~ABCDEF~~` 文本，连点 4 次得到 `~~~~~~~~ABCDEF~~~~~~~~`。
2. **"取消"分支依赖按钮高亮**：Vditor 根据按钮上的 `vditor-menu--current` 类（200ms 防抖后刷新）决定点击是添加还是取消，快速连点时读到旧状态，行为错乱。
3. ReadMD 使用 Vditor 的 IR 模式（所见即所得 Markdown），该问题影响删除线、加粗、斜体三个行内切换按钮。

约束：不 Fork Vditor（维持 npm 依赖）；修复不能影响其他工具栏按钮和正常输入；必须可验证。

## 对标与调研

- **Typora / Obsidian**：行内样式切换由编辑器内核直接操作文档模型，不依赖"按钮高亮状态"，重复点击可靠地翻转。
- **Vditor 上游**：`vditor` GitHub 仓库存在多个 IR 模式行内样式相关 issue（如 #1804、#1449 一类）；4.0.1 未修复 `<wbr>` 阻断解析的问题。等待上游修复不可控。
- **候选方案**：
  1. 等 Vditor 上游修复——不可控，时间无预期，淘汰。
  2. Fork Vditor 改 C# / TS 源码再自构建——维护成本高、巴士因子低，淘汰。
  3. 渲染进程在捕获阶段拦截这三个按钮的点击，自实现"加线/去线"（直接构造/摘除干净的 IR DOM 节点，再触发 Vditor 重解析）——不侵入依赖，改动局部，可测试。**采纳**。

## 决策

在 `renderer/app.js` 新增 `setupToolbarClickGuard()`：

- 绑定在工具栏容器的**捕获阶段**（target 上 Vditor 的监听器注册更早，只有祖先捕获能保证先执行）。
- **取消**（光标/选区已在对应行内节点内）：克隆节点、剔除 `.vditor-ir__marker`（`~~`/`**`/`*` 标记文本），把正文内容放回原处，恢复光标，触发 `input` 让 Vditor 重解析。
- **添加**（选区有文字）：用 `buildInlineNode()` 构造 Lute 认可的干净 IR 节点结构（`span[data-type=s] > marker + s[data-newline=1] + marker`）替换选中文本，恢复光标并触发重解析。
- **无选区光标点击**：仍走 Vditor 原逻辑（插入空标记对 `~~<wbr>~~`，该路径无 `<wbr>` 解析问题，后续输入自然进入删除线）。
- 同时在冒烟测试中新增 `strikeRepeatTest`：模拟对同一段文字连续点击 4 次，断言状态严格交替翻转（striked → plain → striked → plain），防止回归。

## 影响与风险

- 修复效果：重复点击同一处时，删除线/加粗/斜体在"有/无"之间确定地翻转，不再产生 `~~~~` 等叠加符号；冒烟测试连续两轮 PASS（`rounds: ["striked","plain","striked","plain"]`）。
- 风险：自实现依赖 Vditor IR 的 DOM 结构（`span[data-type]` + `.vditor-ir__marker`），若未来升级 Vditor 且结构变化，需要同步调整；已在 `buildInlineNode` 与守卫注释中标注来源。
- 兼容性：仅影响这三个按钮的点击处理；撤销/重做、保存、AI 助手等路径不受影响（冒烟全量回归通过）。
- 后续：若 Vditor 上游修复了 `<wbr>` 解析与高亮竞态，可移除该守卫。
