# Changelog

本项目所有值得注意的变更都记录在此。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.2] — 2026-10-07

第二轮全仓库深度加固：修复 `force_full` 触发数据丢失的根因、mmap 截断崩溃与历史索引并发覆盖，收紧 ACL / 插件 / CSP 边界，把阻塞 I/O 移出 IPC 线程并优化索引与图谱性能；同步补齐无障碍对比度与工程校验门禁，并处理历史键迁移。本版含**两处行为变更**（历史目录键方案、Release panic 策略）。

### 安全与数据完整性
- **`force_full` 丢数据根因（捕获 + 链接改名）**：大文件/预览场景下 `force_full` 写盘会在捕获（capture）与重命名链接时用不完整缓冲覆写正文，导致内容被截断；现改为只在内容确实完整时以全文写回。
- **ACL 敏感目录拒绝**：访问控制拒绝把敏感目录（如系统/凭据目录）纳入授权范围。
- **插件边界收紧**：插件文件的读写严格限制在插件目录内，越界路径一律拒绝。
- **历史索引加锁**：历史索引的「读→改→写」以进程内锁串行化，避免同笔记并发保存互相覆盖、产生孤儿快照。
- **CSP / capability 加固**：收紧内容安全策略与能力（capability）权限，最小化前端可触达面。
- **资产大小上限**：`mklasset` 的 Range 流式分支新增独立硬上限，堵住「分块即可绕过 128 MB 上限」的缺口（视频拖动仍可用）。
- **退出握手**：退出前广播 `app://before-quit` 并给出极短（400ms，硬超时）宽限期，让编辑器缓冲与在途历史快照落盘；无监听者时优雅退化为立即退出，绝不卡死退出。

### 修复
- **mmap 截断崩溃**：内存映射读取在文件被外部截断时越界崩溃，现按实际长度安全读取。
- **行索引内存上限**：行索引此前无上限，超大文件可能耗尽内存；现设内存上限。
- **`append_markdown_file`**：补齐并修正追加写入命令，避免整文件重写。
- **阻塞 I/O 移出 IPC 线程**：文件/历史等阻塞操作改走 `spawn_blocking`，不再阻塞 IPC 事件线程。
- **按库文件监听**：文件监听改为按库（per-vault）实例，切换/多库时不再串扰或泄漏。

### 性能
- 索引与图谱构建优化，降低大库下的卡顿与内存占用。

### 无障碍
- 焦点可见性：焦点环改为满足对比度要求的实色，键盘可达性提升。
- 对比度：修正正文/次级文字与链接的对比度至 WCAG AA。

### 工程
- **Release panic 策略**：发布构建的 panic 策略由 `abort` 改为 `unwind`（见「行为变更」）。
- **CI 校验门禁**：新增 `cargo fmt --check`、Rust 构建缓存与 `npm audit --audit-level=high`，并收紧 workflow 权限。
- **发布前校验**：Release 流水线新增 `verify` job（typecheck / lint / test / cargo test / clippy），未通过则不发布。
- 版本号同步为 `0.1.2`（`package.json` / `package-lock.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock`）。

### 行为变更
- **历史目录键迁移**：历史目录键由「相对路径的裸 FNV-1a 哈希」改为「可读前缀 + 规范化路径哈希」。为**向后兼容**，当新键目录不存在时回退读取旧键目录并在首次成功读取时补写标记（`note.txt`），既有版本历史不会丢失。
- **Release panic 策略**：由 `abort` 改为 `unwind`，后台 panic 不再终止进程、避免丢失未保存内容。

## [0.1.1] — 2026-10-04

全仓库彻查后的安全与数据完整性迭代：堵住截断/双重加密等写盘风险，补齐图谱键盘与多窗提示，并隔离 API 密钥存储。

### 安全与数据完整性
- **保存守卫统一**：`documentGuards` 拦截 `truncated` / `backendBuffer` 预览写盘；`saveAs` 与 `saveFile` 对齐。
- **加密会话**：加密后编辑器保留明文+口令（磁盘写密文）；Lock/Save 跳过已密文，避免双重加密；`saveAs` 有口令时加密后再写。
- **重命名链接重构**：已打开的大文件改从磁盘全文改写，禁止把预览缓冲写回。
- **API Key**：迁入独立 `markelle.secrets.json`，并从 `markelle.json`  scrub；设置导出更安全。
- 多窗口打开同 path 前增加分叉覆盖确认。

### 图谱
- 画布可键盘操作：`+/-` 缩放、`0` 适应、方向键选择、Enter/空格打开；侧栏仍为完整可达路径。
- 边计算改为最多扫描前 256KB；大图力导衰减加快，降低卡顿。

### 工程
- 根级与图谱区 ErrorBoundary；多窗 dirty 退出探测；CHANGELOG 与 Windows NSIS 发布说明一致。
- 版本号同步为 `0.1.1`（`package.json` / `tauri.conf.json` / `Cargo.toml`）。

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
- 新增 ESLint 与发布流水线（tag 驱动；官方 Release 当前为 **Windows x64 NSIS**，macOS / Linux 可从源码按 Tauri 文档自行打包）。
- 版本号在 `package.json`、`tauri.conf.json`、`Cargo.toml` 间同步为 `0.1.0`。
