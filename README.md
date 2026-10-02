# Markelle

**本地优先 · 高性能** Markdown 知识库工作台。打开本机文件夹即成「库」：阅读、编辑、图谱、日记、附件与本地 AI 助手，数据不出本机。

**English:** Markelle is a local-first, high-performance Markdown knowledge workspace. Open a folder as a vault — read, edit, graph, capture, and chat with your local LLM. No cloud sync.

![version](https://img.shields.io/badge/version-0.1.0-0d9488)
![license](https://img.shields.io/badge/license-MIT-blue)
![tauri](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri&logoColor=black)
![react](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![platform](https://img.shields.io/badge/install-Windows%20x64%20NSIS-0078D4?logo=windows&logoColor=white)

| | |
|---|---|
| **当前版本** | `0.1.0` |
| **仓库** | [github.com/Lrj410/Markelle](https://github.com/Lrj410/Markelle) |
| **安装包** | [Releases](https://github.com/Lrj410/Markelle/releases) · `Markelle_0.1.0_x64-setup.exe` |
| **技术栈** | Tauri 2 · React 19 · TypeScript · Vite · Rust · CodeMirror 6 |
| **变更记录** | [CHANGELOG.md](./CHANGELOG.md) |
| **安全说明** | [SECURITY.md](./SECURITY.md) |

---

## 适合谁

- 想把本机文件夹当 Obsidian 式知识库，但更轻、更快、更干净
- 需要双链、图谱、日记、附件，又坚持**离线 / 本地优先**
- 已有 Ollama / llama.cpp / LM Studio，想在笔记旁用本地大模型

**不做：** 云同步、多人协作、账号体系。

---

## 能力一览（v0.1.0）

### 库与文件
- 打开**知识库**（文件夹）或单个 `.md` / `.markdown` / `.mdown` / `.mkd`
- 多标签；库内新建笔记 / 文件夹 / 重命名 / 删除（优先进系统回收站）
- 今日日记、**日历面板**、模板新建；欢迎页最近文件与**最近库**
- Windows 安装后注册 Markdown 文件关联；支持拖放打开
- **附件导入**：拖放 / 粘贴 / 选图（含 HEIC→JPEG、长边缩图）；嵌套笔记路径正确解析
- **快速捕获**（`Ctrl+Shift+N`）写入今日日记或 `Inbox.md`
- **历史版本**：保存时快照到 `.markelle/history`，侧栏对比与恢复
- **笔记加密 / 解密**（AES-GCM，经命令面板）

### 阅读与编辑
- 阅读 / 源码（Ink Bench）/ 分栏；大纲（**H± 改级 / 拖拽排序**）、可编辑 YAML 属性条
- Markdown：任务列表、脚注、KaTeX、代码高亮、Mermaid、Callout、wikilink
- 源码：`[[` 补全、查找/替换、可选 Vim / 拼写检查
- `Ctrl` + 滚轮缩放字号；自动保存（默认开）；中 / 英界面
- **超大文件**：磁盘行索引 + 分页浏览，不全文进内存
- **导出 HTML** / **打印 → PDF**（命令面板）

### 导航与图谱
- 命令面板 `Ctrl+K`（命令 + 库内全文搜索）；检查更新
- **标签** / **查询**（`tag:` / `path:` / `name:`）侧栏
- 反向链接；知识图谱（局部 / 全库、邻居检视、双击打开；Markdown 相对链接 + Wikilink）
- 简易**画布**（文本卡片 → `.markelle/canvas/`）

### 本地 AI 助手
- 侧栏 AI 面板：总结 / 润色 / 续写 / 纠错 / 翻译 / 提炼双链
- 对接 **llama.cpp / Ollama / LM Studio** 等本机（或可选局域网）OpenAI 兼容端点
- **内置滑动窗口记忆**，或外接 **CogniStack** 长期记忆（五段式沉淀与水位闭环）
- 插入光标 / 替换全文或选区 / 追加末尾 / 存为新笔记 / 重试；Esc 中止生成
- 模型由你本地加载，Markelle **不内置、不硬编码**任何云端模型

### 插件与壳层
- 内置：沉浸阅读、羊皮纸主题
- 用户 / 库级 **CSS 插件**（无任意 JS）；库级 `.markelle/style.css`
- 无边框标题栏、系统托盘、关窗到托盘、启动恢复信任库

---

## 快速开始（用户）

1. 打开 [Releases](https://github.com/Lrj410/Markelle/releases)，下载并安装 `Markelle_0.1.0_x64-setup.exe`
2. 启动后点**打开库**，选择任意本地文件夹作为知识库
3. 试一下：`Ctrl+K`、活动栏 **AI 助手**、日历、大纲拖拽、`Ctrl+Shift+N` 捕获

> 安装包默认**未代码签名**。首次运行若出现 Windows SmartScreen，选择「仍要运行」即可。

### 文件关联（Windows）

1. 资源管理器中右键任意 `.md` →「打开方式」应能看到 Markelle  
2. 双击 `.md` 应启动并打开该文件  

发行物为 **Windows x64 NSIS**。从源码也可按 Tauri 文档在其他平台打包，但官方 Release 目前只发布 Windows 安装包。

---

## 从源码开发

### 运行环境（用户）

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11（x64） |
| 运行时 | Microsoft Edge **WebView2 Runtime**（Win11 通常自带；Win10 缺失时安装程序会尝试下载） |

### 环境要求（开发）

| 工具 | 建议版本 |
|------|----------|
| Node.js | 22 LTS |
| Rust | stable（[rustup](https://rustup.rs/)） |
| 平台依赖 | 见 [Tauri 前置条件](https://v2.tauri.app/start/prerequisites/) |

### 命令

```bash
npm install
npm run tauri dev
npm run typecheck
npm run lint
npm test
npm run build
npm run tauri build
```

安装包输出：`src-tauri/target/release/bundle/nsis/Markelle_<version>_x64-setup.exe`

推送形如 `v0.1.0` 的 tag 会触发 GitHub Actions，自动构建并发布 Windows 安装包。

---

## 常用快捷键

| 快捷键 | 作用 |
|--------|------|
| `Ctrl+K` | 命令面板 |
| `Ctrl+O` / `Ctrl+Shift+O` | 打开文件 / 打开库 |
| `Ctrl+N` | 库内新建笔记 |
| `Ctrl+Shift+N` | 快速捕获 |
| `Ctrl+S` | 保存 |
| `Ctrl+E` | 阅读 / 源码 / 分栏 |
| `Ctrl+G` | 知识图谱 |
| `Ctrl+B` | 库面板 |
| `Alt+A` | AI 助手面板 |
| `Ctrl+,` | 插件面板 |
| `F11` | 沉浸阅读 |
| `Esc` | 退出沉浸 / 中止 AI 生成 |

macOS 上多数 `Ctrl` 对应 `⌘`（若自行构建）。

---

## 安全要点（摘要）

- 读写路径经 Rust **访问白名单**；符号链接拒绝
- 本地媒体走 `mklasset`，每次请求校验 ACL；拒 SVG
- Markdown `html: false`；链接 default-deny；剥离 `file:`；插件 CSS 拦截 `@import` / 远程 `url()`
- 本地 AI / CogniStack 仅允许本机或显式开启的局域网私有网段
- 详情：[SECURITY.md](./SECURITY.md)

---

## 版本与路线

当前版本 **0.1.0**。完整变更见 [CHANGELOG.md](./CHANGELOG.md)。

后续可能：跨平台官方包、多库工作区增强。明确**不做**云同步 / 协作。

---

## 许可

MIT — Copyright 2026 [Lrj410](https://github.com/Lrj410)
