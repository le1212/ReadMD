# 贡献指南

感谢你愿意参与 ReadMD。无论是报告 Bug、改进文档、提交设计建议还是代码，都会让这个项目变得更好。

## 行为准则

- 尊重不同经验和背景的参与者。
- 讨论问题对事不对人，避免人身攻击和情绪化表达。
- 对不确定的结论保持诚实，说明验证方式和已知限制。
- 不提交来源不明、许可证不兼容或侵犯版权的代码和素材。

## 开始之前

1. 先搜索现有的 Issues 和 Pull Requests，避免重复。
2. 小改动可以直接提交 PR；涉及架构、依赖、数据模型、UI 风格或功能范围的大改动，请先开 Issue 说明动机和方案。
3. 安全问题不要公开提交 Issue，请使用 GitHub Security Advisories 或仓库提供的私密渠道联系维护者。

本仓库的 [AGENTS.md](AGENTS.md) 记录了选型、决策记录和验证标准，提交前建议阅读。

## 开发环境

- Node.js 20+
- npm 9+
- Windows 10 / 11（当前只在 Windows 10 1809 x64 验证）

```bash
git clone <你的仓库地址>
cd ReadMD
npm install
npm start
```

`npm install` 会自动把 Vditor 的离线资源复制到 `renderer/vendor/vditor`。

## 代码约定

### 通用

- 使用 2 个空格缩进、单引号、分号。
- 不引入新的运行时依赖前，先在 Issue 中说明理由和替代方案。
- 保持改动聚焦，一个 PR 只做一件事。
- 不提交 `node_modules/`、`renderer/vendor/`、`dist/` 和日志文件。

### Electron 主进程

- 所有文件操作必须经过 `assertAllowed()` 路径白名单。
- 新增 IPC 时同时更新 `preload.js`，不要在渲染进程直接暴露 Node.js API。
- 涉及用户数据的操作要可回退，删除操作优先使用系统回收站。

### 渲染进程

- 不启用 `nodeIntegration`，不关闭 `contextIsolation` 或 `sandbox`。
- 通过 `window.readmd` 调用主进程能力。
- 新增 UI 组件复用 `.btn`、`.icon-btn`、`.tree-row` 等基础类和 CSS 变量，避免临时写死高度、间距和颜色。
- 不在 Markdown 渲染路径中执行不可信脚本。

### 文档与决策

- 行为、架构、依赖或 UI 风格发生变化时，同步更新 README。
- 影响架构、依赖或产品行为的决定，在 `docs/decisions/` 下新增 ADR（编号递增）。
- UI 改动建议附上修改前后的截图。

## 测试

提交 PR 前至少运行：

```bash
npm run smoke
```

冒烟测试会启动真实 Electron 窗口，检查文件树、标签页、编辑器、图片加载、查找、HTML/PDF 导出、标签切换和保存流程。测试会临时修改 `sample/欢迎使用 ReadMD.md`，结束后自动还原。

如果改动涉及以下内容，请额外手动验证：

- 打开/切换文件夹
- 新建、重命名、删除（回收站）
- 深色/浅色主题
- 大文件或含中文路径的文件
- 打包后的 `dist/ReadMD-0.1.0-portable.exe`

## 提交 PR

1. 从 `main` 创建分支：`feat/...`、`fix/...`、`docs/...`、`refactor/...`
2. 完成改动并运行 `npm run smoke`
3. 提交 PR，说明：
   - 为什么需要这个改动
   - 改了什么
   - 如何验证
   - 已知限制或后续工作
4. 如果 UI 有变化，附上截图。

提交信息建议使用清晰的动词开头，例如：

```text
feat: add folder-wide search
fix: prevent duplicate save when switching tabs
docs: update README quick start
```

## 报告问题

请尽量提供：

- ReadMD 版本（程序内“帮助 → 关于”）
- Windows 版本
- 复现步骤
- 期望结果与实际结果
- 相关截图或控制台日志
- 文件是否包含特殊语法、图片或中文路径

## 许可证

提交的代码默认按本项目的 [MIT License](LICENSE) 授权。
