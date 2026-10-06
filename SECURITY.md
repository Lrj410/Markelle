# Markelle 威胁模型与安全边界

Markelle 是**本地优先 · 高性能**的 Markdown 知识库工作台（阅读、编辑、图谱、附件与本地 AI）。信任边界是本机用户进程与 WebView；默认不连接云端笔记服务，本地 AI 仅允许本机或显式开启的局域网私有端点。

## 信任假设

- 用户通过系统对话框 / 拖放 / 文件关联 / CLI 选择的路径是有意授权的。
- 笔记内容可能不可信（从网上下载的 Markdown）。渲染侧按不可信 HTML 处理。
- WebView 内 XSS 会获得与前端同等的 `invoke` 能力，因此 XSS 防御是核心。

## 访问控制

- Rust `AccessSet` 是读写命令的唯一授权源；`register_access` / `open_vault` 才会写入白名单。
- 磁盘根目录等过宽路径会被拒绝注册为库；系统目录前缀（`C:\Windows`、`C:\Program Files*`、`C:\ProgramData`、`%AppData%`、盘根，以及 Unix 的 `/etc` `/usr` `/bin` 等）同样被拒绝。
- 用户私密配置目录（`.ssh`、`.aws`、`.gnupg`、`.kube`、`.config`、`.docker`、`.azure`、`.npmrc`）出现在路径任意一段即拒绝注册（Windows 下不区分大小写），避免把私钥 / 凭据树纳入可读范围。
- 打开单个文件只授权该文件本身，以及**受支持扩展名**（Markdown / 图片 / 音视频 / PDF / zip）的同目录访问——不等于开放整个目录。
- CLI / 文件关联启动的路径**只接受受支持扩展名**（`md`/`markdown`/`mdown`/`mkd` 及图片 / 音视频 / PDF）后才注册进白名单；其余一律忽略，避免免确认地把任意文件纳入可读范围。
- 启动自动恢复库仅针对 `trustedVaultPaths`（用户曾通过「打开库」确认过的根）。
- 符号链接在打开库、读写、遍历、插件资源、库样式路径上被拒绝或跳过。
- 写入路径在创建父目录后、真正落盘前会重新规范化父目录并校验其仍在授权根内且非符号链接（缓解 ACL 检查—使用之间的 TOCTOU 窗口；句柄式 `openat` 重写不在范围内，仍存在极小残余窗口）。
- 附件文件名拒绝系统保留设备名（`CON`/`NUL`/`COM1`…/`LPT9`，含带扩展名如 `CON.md`）、结尾的点 / 空格，以及 Windows 下的 `:`（拦截 NTFS 备用数据流 `a.md:secret`）。

## 媒体与协议

- 图片等本地媒体经自定义协议 `mklasset` 提供，**每次请求**调用 `ensure_allowed`。
- 关闭库会撤销 ACL，随后的 `mklasset` 请求立即 403。
- 不再向 Tauri 内置 `asset:` 协议扩大递归目录授权（避免关库后 scope 无法收回）。
- `.svg` / `.svgz` 媒体被拒绝（可脚本面）。

## 内容安全策略（CSP）

- `default-src` / `script-src` 均限定为 `'self'`，脚本侧无 `unsafe-inline` / `unsafe-eval`。
- 追加 `form-action 'none'`（禁止表单外发）与 `frame-ancestors 'none'`（禁止被嵌入 / 点击劫持）。
- `img-src` / `media-src` 仅放行 `'self'`、`https:`、`data:`、`blob:` 与 `mklasset:`（**不含明文 `http:`**）。阅读器默认**剥离**远程 https 图片；需在设置中显式开启「允许远程 https 图片」——该 opt-in 依赖 `img-src`/`media-src` 中的 `https:`，故**保留** `https:`，远程图片默认在应用层被剥离。
- `style-src` 需 `'unsafe-inline'`（React 内联样式、KaTeX、插件 CSS 注入），已在构建中保留并注明原因。
- `connect-src` 仅放行本机 loopback、`mklasset:` 与 `api.github.com`；loopback 只保留明文 `http`（本地 AI 端口可由用户配置且为纯 HTTP），不再放行 `https` loopback 通配；局域网 AI 的连通性由应用层 URL 白名单强制（CSP 无法可靠表达 RFC1918）。
- 多窗口权限拆分：`doc-*` 次级窗口通过独立 capability 授权，不再继承主窗口的敏感窗口权限。

## XSS / 内容

- `markdown-it`：`html: false`。
- Mermaid：`securityLevel: "strict"`，`htmlLabels: false`。
- 链接点击 default-deny；渲染阶段丢弃 `javascript:` 等非白名单 scheme。
- 插件：磁盘插件仅 CSS；`@scope` 包裹，阻断 `@import`、**全部** `url()` / `image-set()` 与不平衡括号。
- 渲染阶段丢弃 `file:` / `javascript:` 等非白名单 scheme。

## 插件

- 当前为 CSS 主题 + settings schema（API v2），无任意 JS 执行。
- 插件资源读取仅放行 `.css` / `.json`；`.js` / `.mjs` / `.cjs` / `.html` / `.svg` 及其他脚本 / 可执行扩展名一律拒绝，插件扫描时跳过符号链接目录。
- 若未来引入 JS 插件，必须隔离（iframe / Worker）并单独审计。

## 删除

- 库内删除优先移入系统回收站 / 废纸篓；失败时回退为永久删除。

## 本地 AI 与局域网

- 默认仅允许连接 loopback（`127.0.0.1` / `localhost` / `[::1]`）。
- 「允许局域网私有端点」开启后，才可连接 RFC1918 **字面量 IP**（`192.168.x` / `10.x` / `172.16–31.x`）；**不接受** `*.local`（DNS 可能解析到公网）。公网 API 始终拒绝。
- CogniStack 网关地址使用同一套白名单策略。
- API Key / Bearer Token 存于独立的本机 `markelle.secrets.json`（与常规 `markelle.json` 设置分离）；请求仅发往用户配置的本地或局域网服务。

## 加密与更新

- 笔记加密为本地 WebCrypto AES-GCM（PBKDF2）；口令不落盘，丢失口令无法恢复。
- **加密时清除该笔记的本地历史快照**，避免明文残留在 `.markelle/history`；加密态笔记不再写入新历史。
- 历史版本目录键由**规范化后**的相对路径（分隔符统一，大小写仅在 Windows 折叠）生成「可读前缀 + 短哈希」，目录内写入归属笔记路径标记，键冲突 / 大小写不一致会被检出并报错，而不是静默合并两条笔记的历史。
- 「检查更新」仅请求 `api.github.com` 读取最新 Release 元数据，不自动下载安装。

## 库根与写入

- 拒绝将磁盘根或系统目录（如 `C:\Users`、`C:\Windows`）注册为库。
- Markdown 单次保存有硬上限（500 MB）；附件 / `mklasset` 有 128 MB 上限。
- 路径键（索引 / 图谱 / 大文件缓存）分隔符统一为 `/`，大小写**仅在 Windows** 折叠；macOS/Linux 上 `Note.md` 与 `note.md` 为不同文件，不会相互串味。
- 附件文件名采用 `create_new` 原子占位，两个并发同名导入不会选中同一后缀互相覆盖。
- 原子写（`.tmp` → 目标）在改写失败且 `.bak` 回滚也失败时，会显式报错并给出 `.bak` 绝对路径，绝不静默吞掉（避免笔记「消失」在隐藏备份里）。

## 报告

请通过仓库 **Security Advisories**（若已启用）或维护者私信报告；Issues 中仅描述影响面与版本，**不要**公开粘贴可利用的 PoC / 利用链，直至修复发布。
