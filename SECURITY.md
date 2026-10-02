# Markelle 威胁模型与安全边界

Markelle 是**本地优先 · 高性能**的 Markdown 知识库工作台（阅读、编辑、图谱、附件与本地 AI）。信任边界是本机用户进程与 WebView；默认不连接云端笔记服务，本地 AI 仅允许本机或显式开启的局域网私有端点。

## 信任假设

- 用户通过系统对话框 / 拖放 / 文件关联 / CLI 选择的路径是有意授权的。
- 笔记内容可能不可信（从网上下载的 Markdown）。渲染侧按不可信 HTML 处理。
- WebView 内 XSS 会获得与前端同等的 `invoke` 能力，因此 XSS 防御是核心。

## 访问控制

- Rust `AccessSet` 是读写命令的唯一授权源；`register_access` / `open_vault` 才会写入白名单。
- 磁盘根目录等过宽路径会被拒绝注册为库；系统目录前缀（`C:\Windows`、`C:\Program Files*`、`C:\ProgramData`、`%AppData%`、盘根，以及 Unix 的 `/etc` `/usr` `/bin` 等）同样被拒绝。
- 打开单个文件只授权该文件本身，以及**受支持扩展名**（Markdown / 图片 / 音视频 / PDF / zip）的同目录访问——不等于开放整个目录。
- 启动自动恢复库仅针对 `trustedVaultPaths`（用户曾通过「打开库」确认过的根）。
- 符号链接在打开库、读写、遍历、插件资源、库样式路径上被拒绝或跳过。

## 媒体与协议

- 图片等本地媒体经自定义协议 `mklasset` 提供，**每次请求**调用 `ensure_allowed`。
- 关闭库会撤销 ACL，随后的 `mklasset` 请求立即 403。
- 不再向 Tauri 内置 `asset:` 协议扩大递归目录授权（避免关库后 scope 无法收回）。
- `.svg` / `.svgz` 媒体被拒绝（可脚本面）。

## 内容安全策略（CSP）

- `default-src` / `script-src` 均限定为 `'self'`，脚本侧无 `unsafe-inline` / `unsafe-eval`。
- `img-src` / `media-src` 仅放行 `'self'`、`https:`、`data:`、`blob:` 与 `mklasset:`（**不含明文 `http:`**），降低"以图片请求外泄笔记内容"的风险。
- `style-src` 需 `'unsafe-inline'`（React 内联样式、KaTeX、插件 CSS 注入），已在构建中保留并注明原因。
- 多窗口权限拆分：`doc-*` 次级窗口通过独立 capability 授权，不再继承主窗口的敏感窗口权限。

## XSS / 内容

- `markdown-it`：`html: false`。
- Mermaid：`securityLevel: "strict"`，`htmlLabels: false`。
- 链接点击 default-deny；渲染阶段丢弃 `javascript:` 等非白名单 scheme。
- 插件：磁盘插件仅 CSS；`@scope` 包裹，阻断 `@import`、远程 `url()` 与不平衡括号。
- 渲染阶段丢弃 `file:` / `javascript:` 等非白名单 scheme。

## 插件

- 当前为 CSS 主题 + settings schema（API v2），无任意 JS 执行。
- 若未来引入 JS 插件，必须隔离（iframe / Worker）并单独审计。

## 删除

- 库内删除优先移入系统回收站 / 废纸篓；失败时回退为永久删除。

## 本地 AI 与局域网

- 默认仅允许连接 loopback（`127.0.0.1` / `localhost` / `[::1]`）。
- 「允许局域网私有端点」开启后，才可连接 RFC1918 私网与 `*.local`；公网 API 始终拒绝。
- CogniStack 网关地址使用同一套白名单策略。
- API Key / Bearer Token 仅存本机设置，请求发往用户配置的本地或局域网服务。

## 加密与更新

- 笔记加密为本地 WebCrypto AES-GCM（PBKDF2）；口令不落盘，丢失口令无法恢复。
- **加密时清除该笔记的本地历史快照**，避免明文残留在 `.markelle/history`；加密态笔记不再写入新历史。
- 「检查更新」仅请求 `api.github.com` 读取最新 Release 元数据，不自动下载安装。

## 库根与写入

- 拒绝将磁盘根或系统目录（如 `C:\Users`、`C:\Windows`）注册为库。
- Markdown 单次保存有硬上限（500 MB）；附件 / `mklasset` 有 128 MB 上限。

## 报告

请通过仓库 **Security Advisories**（若已启用）或维护者私信报告；Issues 中仅描述影响面与版本，**不要**公开粘贴可利用的 PoC / 利用链，直至修复发布。
