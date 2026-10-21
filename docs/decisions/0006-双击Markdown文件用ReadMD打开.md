# 决策：双击 Markdown 文件用 ReadMD 打开

- 日期：2026-10-21
- 状态：已采纳

## 背景

ReadMD 以 Windows 便携版（`ReadMD-*-portable.exe`）分发。用户双击 `.md` 文件时，Windows 会交给系统当前登记的默认程序，ReadMD 不会出现在候选列表里，因此“下载后双击文档直接用 ReadMD 打开”这一步走不通。

主进程原本已经具备接收文件路径的能力（`second-instance`、`open-file`、`app:renderer-ready`），缺的是**把 ReadMD 注册为 Markdown 文件的候选打开方式**，以及一个让用户完成“设为默认”的入口。

约束：

- 便携版没有安装程序，不能依赖 NSIS 安装器写关联；
- 不能要求管理员权限；
- Windows 10/11 不允许程序静默修改默认程序，必须由用户确认；
- 用户可能移动便携版 exe，关联不能因此失效；
- 操作必须可回退，不接管 `.txt`，不抢其他程序的默认设置。

## 对标与调研

| 产品/方案 | 相关做法 | 对本项目的启示 |
| --- | --- | --- |
| Typora | Windows 安装器提供文件关联选项；默认程序仍需用户在系统中确认 | 安装/首次运行时注册候选身份，默认选择交给用户 |
| Visual Studio Code | Windows 安装器注册“用 Code 打开”菜单和文件类型候选，安装时勾选 | 注册范围要明确，且提供可撤销入口 |
| Obsidian / MarkText | 安装器声明 `.md` 等文件类型；不静默篡改系统默认程序 | 不做 `UserChoice` 哈希劫持，避免被系统判定为恶意行为 |
| [Microsoft Default Programs](https://learn.microsoft.com/en-us/windows/win32/shell/default-programs) | 通过 `Capabilities` + `RegisteredApplications` + ProgID 注册候选程序；默认选择是用户驱动的，Windows 8 起禁止程序自行恢复默认 | 采用官方注册模型；只写 HKCU，不写 HKLM |
| [electron-builder 源码](https://github.com/electron-userland/electron-builder)（本地 26.15.3） | `fileAssociations` 只在 NSIS 安装器分支生效；`NsisTarget.js` 对 `isPortable` 直接返回，不生成关联注册脚本 | 便携版必须运行时自行注册，不能指望打包配置 |
| Windows `UserChoice` 注册表 | 由系统哈希保护；直接改写属于不受支持的做法，可能被重置或触发安全提示 | 不读写、不修改 `UserChoice`，只读取 ProgId 用于展示状态 |

结论：采用“**按用户注册候选身份 + 调用系统 UI 让用户确认默认**”的方案。这与头部产品和微软文档的做法一致，也不需要改分发方式。

## 决策

1. 在 `electron/file-association.js` 中通过 `reg.exe` 写入当前用户（HKCU）注册表：
   - `HKCU\Software\Classes\.md\OpenWithProgids` 等扩展名加入 `ReadMD.md`；
   - `HKCU\Software\Classes\ReadMD.md` 写入 ProgID、图标和 `shell\open\command`；
   - `HKCU\Software\ReadMD\Capabilities` + `HKCU\Software\RegisteredApplications` 让 ReadMD 出现在 Windows“默认应用”设置里。
2. 注册后调用系统“打开方式”窗口（`rundll32 shell32.dll,OpenAs_RunDLL`），由用户选择 ReadMD 并勾选“始终使用”。另提供“打开 Windows 设置”作为备用路径。
3. 不修改 `UserChoice`；弹窗只读取它来显示“当前默认程序”。
4. 关联命令优先使用 `PORTABLE_EXECUTABLE_FILE`，避免便携版解压后的临时路径；每次启动时如果检测到路径变化，自动刷新关联。
5. 支持 `.md`、`.markdown`、`.mdown`、`.mkd`，不注册 `.txt`。
6. 提供“从打开方式列表移除 ReadMD”入口，删除本次写入的 HKCU 键值。
7. 一次打开多个文件时，全部作为标签页打开；已有实例会复用窗口，不重复启动。

## 影响与风险

- **可逆性**：所有改动都在 HKCU，删除对应键值即可恢复；不修改系统级 HKLM，不删除用户已有的默认选择。
- **默认程序仍由用户确认**：如果用户在系统窗口里点取消，ReadMD 只会成为候选程序，不会自动变成默认。这是 Windows 10/11 的安全设计，不是缺陷。
- **移动便携版**：启动时会自动把关联路径更新为当前位置；如果移动后从未启动过 ReadMD，系统可能暂时找不到旧路径。
- **候选列表刷新**：少数系统上“打开方式”列表有缓存，弹窗里看不到 ReadMD 时，可点“打开 Windows 设置”在默认应用里选择。
- **范围**：当前只实现 Windows；macOS 需要在应用包 `Info.plist` 中声明 `CFBundleDocumentTypes`，留到后续打包时处理。
