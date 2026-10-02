# Changelog

本项目所有值得注意的变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] — 2026-10-03

界面重做（墨纸设计语言）+ 四个维度（后端数据安全 / 安全边界 / 前端正确性 / 性能·无障碍·令牌一致性）的深度彻查与修复，全仓库死代码清理，以及**本地优先知识库 + 本地 AI** 产品定位落地。

### AI 助手
- 新增 AI 面板：快捷总结 / 润色 / 续写 / 纠错 / 翻译 / 提炼双链，支持插入、替换、追加、另存笔记与重试。
- 统一本地引擎客户端：OpenAI 兼容流式、`/api/chat`、llama.cpp、`/api/generate` 级联，带超时与错误诊断。
- 双记忆引擎：内置滑动窗口 + 可选 CogniStack 长期记忆（五段式沉淀、水位闭环、离线降级）。
- 安全：本机 / 局域网 URL 白名单；设置持久化不再误重置 IPv6 与 LAN 地址；快捷指令不再重复附带全文上下文。

### 修复（数据丢失，严重）
- **保存会截断大文件**：`>50MB` 文件后端只返回 256KB 预览，但标签的 `truncated` 被硬编码为 `false`，而 `Ctrl+S` 不检查脏标记直接保存 —— 按一次就会把整篇文件覆写成 256KB。现改为如实反映后端结果，并在保存链路叠加 `backendBuffer` 守卫。
- **原子写入失败会同时丢失原文件与临时文件**：回退分支先 `remove_file(目标)` 再 `rename`，二次失败时内容彻底消失。改为重试 + 经备份换名（原文件只挪不删，失败即回滚），三处重复实现合并为 `commit_atomic`。
- **GBK 大文件被误判为 UTF-8**：编码分类改在字符边界对齐后进行，但「对齐后的前缀必然合法」使 GBK 分支成为死代码；同时 `decode_bytes` 会把被读预算截断的 UTF-8 尾部误判成 windows-1251。两者都会让乱码被按 UTF-8 写回，永久损坏原件。

### 修复（无障碍）
- 焦点环原为半透明色，对比度仅 **1.60:1 / 1.71:1**（WCAG 1.4.11 要求 ≥3:1）→ 改用不透明强调色，实测 **5.93:1 / 5.07:1**。
- 三级文字对比度 **3.20:1 / 4.27:1** → 调整色值后 **5.17:1 / 4.94:1**（WCAG AA 正文要求 ≥4.5:1）。
- 正文链接 4.49:1 → 5.93:1。

### 修复（其他）
- 打开文件途中切换标签，读盘完成后不再把焦点抢回。
- 关闭仍在后台加载的大文件标签时，进程进度监听器不再泄漏。
- 修复 8 个「被引用但从未定义」的设计令牌（`--shadow-float`、`--reader-toolbar-h`、`--bg-hover`、`--bg-surface-overlay`、`--radius-pill`、`--radius-3xl`、`--fg`、`--fg-subtle`），此前这些声明会被整条丢弃。
- **2MB–50MB 文件被误判为大文件**：前端曾按 `size > 2MB` 猜测，而后端阈值是 50MB —— 这类文件其实已完整载入，却无法编辑、脏标记失灵（保存按钮不亮、自动保存不触发），虚拟文档还会按 `lineCount || 2000` 伪造出 2000 行。现改为只信后端结果，并把「内容是否完整在内存」与「文档是否算大」两件事拆开。

### 优化
- 拆分模式下输入卡顿：引入防抖（`useDebouncedValue`）。
- 删除不可达组件与冗余路径，界面重构为墨纸设计语言。

### 移除（死代码清理）
- 未接通的「大文件分页编辑」功能整套（组件 + lib + 样式 + 测试）——该 UI 从未被挂载。
- 其他不可达组件：`TitleBar`、`ReaderToolbar`。
- 前端死函数：`readMarkdownChunk`、`historyRestore`、`largeFileSave`、`largeFileReady`、`largeFileReplaceLines`、`rewritePrompt`。
- 后端死命令与函数：`read_markdown_chunk`、`search_large_file`、`large_file_save`、`large_file_replace_lines`、`large_file_ready`、`history_restore`、`available_phys_memory`、`seed_large_file_from_bytes`、`seed_large_file_entry`，以及 `vault_write_bytes`、`write_adjacent_bytes` 两个多余 IPC 暴露（函数体保留，仍被 `_raw` 变体内部调用）。
- i18n 死键 66 个；CSS 死规则约 275 行；npm 冗余依赖 `@codemirror/commands`、`@codemirror/theme-one-dark`、`@types/katex`。
- 补齐 3 个「源码直接 import 但未声明」的幽灵依赖：`@codemirror/language`、`@codemirror/autocomplete`、`@lezer/highlight`。

### 工程
- 新增 ESLint 与发布流水线（tag 驱动，Windows / macOS / Linux 三平台构建）。
- 版本号在 `package.json`、`tauri.conf.json`、`Cargo.toml` 间同步为 `0.1.0`。
