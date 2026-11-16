# 第三方组件与许可证

ReadMD 自身以 MIT 许可证发布（见 `LICENSE`）。下面列出本次新增的运行时组件及其许可证；完整许可证文本随应用一起分发在 `licenses/` 目录，Vditor 的许可证在 `renderer/vendor/vditor/LICENSE`。

| 组件 | 版本 | 许可证 | 用途 | 项目主页 |
| --- | --- | --- | --- | --- |
| [mammoth.js](https://github.com/mwilliamson/mammoth.js) | 1.13.0 | BSD-2-Clause | 把 `.docx` 转成语义化 HTML 供只读预览 | https://github.com/mwilliamson/mammoth.js |
| [pdf.js](https://github.com/mozilla/pdf.js) | 6.5.438 | Apache-2.0 | 在应用内渲染 PDF 页面 | https://github.com/mozilla/pdf.js |
| [Vditor](https://github.com/Vanessa219/vditor) | 4.0.1 | MIT | Markdown 编辑器内核 | https://github.com/Vanessa219/vditor |

说明：

- 上述组件均未修改源代码；pdf.js 只复制了官方构建产物与字体/CMap/WASM 资源。
- 分发时保留各组件的版权声明与许可证文本，不改变其许可证要求。
- 如果后续升级版本，应重新核对许可证并更新本文件。
