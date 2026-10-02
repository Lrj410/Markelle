import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  clampAutosaveDelayMs,
  clampRecentPreviewCount,
  type ReaderSettings,
} from "../lib/types";
import { t, type MessageKey } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";
import { Select } from "./Select";
import { ollamaCheckConnection } from "../lib/ollama";
import { cogniStackCheckHealth } from "../lib/cognistack";

interface Props {
  open: boolean;
  settings: ReaderSettings;
  onClose: () => void;
  onChange: (patch: Partial<ReaderSettings>) => void;
}

type SectionId = "system" | "interface" | "reading" | "editor" | "integrations" | "panels";

export function SettingsDialog({ open, settings, onClose, onChange }: Props) {
  const locale = useLocale();
  const [section, setSection] = useState<SectionId>("system");
  const [testingOllama, setTestingOllama] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<{
    tested: boolean;
    ok: boolean;
    models: string[];
    provider?: string;
    error?: string;
  } | null>(null);

  const [testingCogni, setTestingCogni] = useState(false);
  const [cogniStatus, setCogniStatus] = useState<{
    tested: boolean;
    ok: boolean;
    version?: string;
    error?: string;
  } | null>(null);

  const handleTestOllama = async () => {
    setTestingOllama(true);
    setOllamaStatus(null);
    try {
      const res = await ollamaCheckConnection(
        settings.ollamaBaseUrl,
        settings.ollamaApiKey,
        settings.ollamaAllowLan,
      );
      setOllamaStatus({ tested: true, ...res });
    } finally {
      setTestingOllama(false);
    }
  };

  const handleTestCogni = async () => {
    setTestingCogni(true);
    setCogniStatus(null);
    try {
      const res = await cogniStackCheckHealth(
        settings.cogniStackUrl,
        settings.cogniStackApiKey,
        settings.ollamaAllowLan,
      );
      setCogniStatus({ tested: true, ...res });
    } finally {
      setTestingCogni(false);
    }
  };

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const sections = useMemo(() => {
    void locale;
    return (
      [
        { id: "system", label: "settings.system", hint: "settings.systemHint" },
        { id: "interface", label: "settings.interface", hint: "settings.interfaceHint" },
        { id: "reading", label: "settings.reading", hint: "settings.readingHint" },
        { id: "editor", label: "settings.editor", hint: "settings.editorHint" },
        { id: "integrations", label: "settings.integrations", hint: "settings.integrationsHint" },
        { id: "panels", label: "settings.panels", hint: "settings.panelsHint" },
      ] as const
    ).map((s) => ({
      id: s.id as SectionId,
      label: t(s.label),
      hint: t(s.hint),
    }));
  }, [locale]);

  useEffect(() => {
    if (open) setSection("system");
  }, [open]);

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector: ".settings-nav-item",
  });

  if (!open) return null;

  const row = (label: MessageKey, desc: MessageKey | null, control: ReactNode) => (
    <label className={clsx("settings-row", "settings-row-check")}>
      <span>
        {t(label)}
        {desc ? <em className="settings-row-desc">{t(desc)}</em> : null}
      </span>
      {control}
    </label>
  );

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        className="modal-backdrop"
        onClick={onClose}
        aria-label={t("common.close")}
      />
      <div className="modal-panel settings-panel" ref={panelRef}>
        <div className="modal-head settings-head">
          <div>
            <div className="modal-kicker">Markelle</div>
            <h2 id={titleId}>{t("settings.title")}</h2>
          </div>
          <button
            type="button"
            className="settings-close"
            onClick={onClose}
            aria-label={t("settings.closeAria")}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path
                d="M3.2 3.2l7.6 7.6M10.8 3.2l-7.6 7.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("settings.navAria")}>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={clsx("settings-nav-item", { active: section === s.id })}
                onClick={() => setSection(s.id)}
              >
                <span className="settings-nav-label">{s.label}</span>
                <span className="settings-nav-hint">{s.hint}</span>
              </button>
            ))}
          </nav>

          <div className="settings-content modal-body">
            {section === "system" ? (
            <section className="settings-section" id="settings-system" key="system">
              <header className="settings-section-head">
                <h3>{t("settings.systemHead")}</h3>
                <p>{t("settings.systemDesc")}</p>
              </header>
              <div className="settings-grid">
                {row(
                  "settings.tray",
                  "settings.trayDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.trayEnabled}
                    onChange={(e) => {
                      const trayEnabled = e.target.checked;
                      onChange(
                        trayEnabled ? { trayEnabled } : { trayEnabled, closeToTray: false },
                      );
                    }}
                  />,
                )}
                {row(
                  "settings.closeToTray",
                  "settings.closeToTrayDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.closeToTray && settings.trayEnabled}
                    disabled={!settings.trayEnabled}
                    onChange={(e) => onChange({ closeToTray: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.restoreVault",
                  "settings.restoreVaultDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.restoreLastVault}
                    onChange={(e) => onChange({ restoreLastVault: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.restoreFile",
                  "settings.restoreFileDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.restoreLastFile}
                    onChange={(e) => onChange({ restoreLastFile: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.confirmQuit",
                  "settings.confirmQuitDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.confirmQuitDirty}
                    onChange={(e) => onChange({ confirmQuitDirty: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.openNewWindow",
                  "settings.openNewWindowDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.openFilesInNewWindow}
                    onChange={(e) => onChange({ openFilesInNewWindow: e.target.checked })}
                  />,
                )}
              </div>
            </section>
            ) : null}

            {section === "interface" ? (
            <section className="settings-section" id="settings-interface" key="interface">
              <header className="settings-section-head">
                <h3>{t("settings.interfaceHead")}</h3>
                <p>{t("settings.interfaceDesc")}</p>
              </header>
              <div className="settings-grid">
                <label className="settings-row">
                  <span>{t("settings.scheme")}</span>
                  <Select
                    aria-label={t("settings.scheme")}
                    value={settings.scheme}
                    onChange={(scheme) => onChange({ scheme })}
                    options={[
                      { value: "system", label: t("settings.schemeSystem") },
                      { value: "light", label: t("settings.schemeLight") },
                      { value: "dark", label: t("settings.schemeDark") },
                    ]}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("settings.layout")}</span>
                  <Select
                    aria-label={t("settings.layout")}
                    value={settings.layout}
                    onChange={(layout) => onChange({ layout })}
                    options={[
                      { value: "docs", label: t("settings.layoutDocs") },
                      { value: "book", label: t("settings.layoutBook") },
                    ]}
                  />
                </label>
                <label className="settings-row">
                  <span>{t("settings.locale")}</span>
                  <Select
                    aria-label={t("settings.locale")}
                    value={settings.locale}
                    onChange={(locale) => onChange({ locale })}
                    options={[
                      { value: "zh", label: "中文" },
                      { value: "en", label: "English" },
                    ]}
                  />
                </label>
                <label className="settings-row settings-row-range">
                  <span>
                    {t("settings.recentCount")}
                    <em className="settings-row-desc">{t("settings.recentCountDesc")}</em>
                  </span>
                  <div className="settings-range">
                    <input
                      type="range"
                      min={4}
                      max={20}
                      step={2}
                      value={settings.recentPreviewCount}
                      onChange={(e) =>
                        onChange({
                          recentPreviewCount: clampRecentPreviewCount(Number(e.target.value)),
                        })
                      }
                    />
                    <em>{settings.recentPreviewCount}</em>
                  </div>
                </label>
                <label className="settings-row">
                  <span>
                    {t("settings.dailyFolder")}
                    <em className="settings-row-desc">{t("settings.dailyFolderDesc")}</em>
                  </span>
                  <input
                    type="text"
                    className="ui-input"
                    value={settings.dailyFolder}
                    onChange={(e) =>
                      onChange({
                        dailyFolder: e.target.value.trim() || "日记",
                      })
                    }
                    spellCheck={false}
                  />
                </label>
                <label className="settings-row">
                  <span>
                    {t("settings.attachmentFolder")}
                    <em className="settings-row-desc">{t("settings.attachmentFolderDesc")}</em>
                  </span>
                  <input
                    type="text"
                    className="ui-input"
                    value={settings.attachmentFolder}
                    onChange={(e) =>
                      onChange({
                        attachmentFolder: e.target.value.trim() || "attachments",
                      })
                    }
                    spellCheck={false}
                  />
                </label>
              </div>
            </section>
            ) : null}

            {section === "reading" ? (
            <section className="settings-section" id="settings-reading" key="reading">
              <header className="settings-section-head">
                <h3>{t("settings.readingHead")}</h3>
                <p>{t("settings.readingDesc")}</p>
              </header>
              <div className="settings-grid">
                {row(
                  "settings.autosave",
                  null,
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.autosave}
                    onChange={(e) => onChange({ autosave: e.target.checked })}
                  />,
                )}
                <label className="settings-row settings-row-range">
                  <span>{t("settings.autosaveDelay")}</span>
                  <div className="settings-range">
                    <input
                      type="range"
                      min={500}
                      max={5000}
                      step={250}
                      value={settings.autosaveDelayMs}
                      disabled={!settings.autosave}
                      onChange={(e) =>
                        onChange({
                          autosaveDelayMs: clampAutosaveDelayMs(Number(e.target.value)),
                        })
                      }
                    />
                    <em>{(settings.autosaveDelayMs / 1000).toFixed(1)}s</em>
                  </div>
                </label>
                <label className="settings-row settings-row-range">
                  <span>{t("settings.fontSize")}</span>
                  <div className="settings-range">
                    <input
                      type="range"
                      min={12}
                      max={32}
                      value={settings.fontSize}
                      onChange={(e) => onChange({ fontSize: Number(e.target.value) })}
                    />
                    <em>{settings.fontSize}px</em>
                  </div>
                  <span className="settings-hint">{t("settings.fontSizeHint")}</span>
                </label>
                <label className="settings-row settings-row-range">
                  <span>{t("settings.lineWidth")}</span>
                  <div className="settings-range">
                    <input
                      type="range"
                      min={56}
                      max={90}
                      value={settings.lineWidth}
                      onChange={(e) => onChange({ lineWidth: Number(e.target.value) })}
                    />
                    <em>{settings.lineWidth}ch</em>
                  </div>
                </label>
                {row(
                  "settings.showProperties",
                  null,
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.showProperties}
                    onChange={(e) => onChange({ showProperties: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.sourceWrap",
                  null,
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.sourceWordWrap}
                    onChange={(e) => onChange({ sourceWordWrap: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.sourceLines",
                  null,
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.sourceLineNumbers}
                    onChange={(e) => onChange({ sourceLineNumbers: e.target.checked })}
                  />,
                )}
              </div>
            </section>
            ) : null}

            {section === "editor" ? (
            <section className="settings-section" id="settings-editor" key="editor">
              <header className="settings-section-head">
                <h3>{t("settings.editorHead")}</h3>
                <p>{t("settings.editorDesc")}</p>
              </header>
              <div className="settings-stack">
                {row(
                  "settings.vimMode",
                  "settings.vimModeDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.vimMode}
                    onChange={(e) => onChange({ vimMode: e.target.checked })}
                  />,
                )}
                {row(
                  "settings.historyEnabled",
                  "settings.historyEnabledDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.historyEnabled}
                    onChange={(e) => onChange({ historyEnabled: e.target.checked })}
                  />,
                )}
                <label className="settings-row">
                  <span>{t("settings.historyMaxVersions")}</span>
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={settings.historyMaxVersions}
                    onChange={(e) =>
                      onChange({
                        historyMaxVersions: Math.min(
                          100,
                          Math.max(1, Number(e.target.value) || 20),
                        ),
                      })
                    }
                  />
                </label>
                {row(
                  "settings.spellcheck",
                  "settings.spellcheckDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.spellcheck}
                    onChange={(e) => onChange({ spellcheck: e.target.checked })}
                  />,
                )}
              </div>
            </section>
            ) : null}

            {section === "integrations" ? (
            <section className="settings-section" id="settings-integrations" key="integrations">
              <header className="settings-section-head">
                <h3>{t("settings.integrationsHead")}</h3>
                <p>{t("settings.integrationsDesc")}</p>
              </header>
              <div className="settings-stack">
                <div className="settings-group-title">{t("settings.captureHead")}</div>
                <p className="settings-group-desc">{t("settings.captureDesc")}</p>
                <label className="settings-row">
                  <span>{t("settings.captureTarget")}</span>
                  <Select
                    aria-label={t("settings.captureTarget")}
                    value={settings.captureTarget}
                    onChange={(v) =>
                      onChange({ captureTarget: v === "inbox" ? "inbox" : "daily" })
                    }
                    options={[
                      { value: "daily", label: t("settings.captureTargetDaily") },
                      { value: "inbox", label: t("settings.captureTargetInbox") },
                    ]}
                  />
                </label>

                <div className="settings-group-title" style={{ marginTop: 14 }}>
                  {t("settings.ollamaHead")}
                </div>
                <p className="settings-group-desc">{t("settings.ollamaHelp")}</p>
                {row(
                  "settings.ollamaEnabled",
                  "settings.ollamaEnabledDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.ollamaEnabled}
                    onChange={(e) => onChange({ ollamaEnabled: e.target.checked })}
                  />,
                )}
                <div className="ai-field-block" style={{ marginTop: 10 }}>
                  <label className="ai-field-label">{t("settings.ollamaBaseUrl")}</label>
                  <input
                    type="text"
                    className="ai-field-input"
                    value={settings.ollamaBaseUrl}
                    onChange={(e) => onChange({ ollamaBaseUrl: e.target.value })}
                    disabled={!settings.ollamaEnabled}
                    placeholder="http://127.0.0.1:11434"
                  />
                </div>
                {settings.ollamaEnabled && (
                  <div className="settings-ollama-presets" style={{ marginTop: 0 }}>
                    <span className="settings-ollama-models-lbl">
                      {t("settings.urlPresets")}
                    </span>
                    <div className="settings-ollama-model-chips">
                      {[
                        { label: "Ollama (11434)", url: "http://127.0.0.1:11434" },
                        { label: "llama.cpp (8080)", url: "http://127.0.0.1:8080" },
                        { label: "LM Studio (1234)", url: "http://127.0.0.1:1234" },
                        { label: "IPv6 本机 [::1]", url: "http://[::1]:11434" },
                      ].map((item) => (
                        <button
                          key={item.url}
                          type="button"
                          className={clsx(
                            "settings-ollama-chip",
                            settings.ollamaBaseUrl.startsWith(item.url) && "is-active",
                          )}
                          onClick={() => onChange({ ollamaBaseUrl: item.url })}
                          title={`填入 ${item.url}`}
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="ai-field-block" style={{ marginTop: 6 }}>
                  <label className="ai-field-label">API 密钥 / Bearer Token (可选)</label>
                  <span className="ai-field-desc">连接带有身份鉴权的私有大模型端点时填入</span>
                  <input
                    type="password"
                    className="ai-field-input"
                    value={settings.ollamaApiKey || ""}
                    onChange={(e) => onChange({ ollamaApiKey: e.target.value })}
                    disabled={!settings.ollamaEnabled}
                    placeholder="留空即表示无需鉴权密钥"
                  />
                </div>
                <label className="settings-row settings-row-check" style={{ marginTop: 6 }}>
                  <span>
                    允许局域网私有端点 (LAN Private IP)
                    <em className="settings-row-desc">
                      允许连接 192.168.x.x, 10.x.x.x, 172.16-31.x.x 等家庭 NAS 或内网 GPU 算力机
                    </em>
                  </span>
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.ollamaAllowLan || false}
                    onChange={(e) => onChange({ ollamaAllowLan: e.target.checked })}
                    disabled={!settings.ollamaEnabled}
                  />
                </label>
                <div className="ai-field-block" style={{ marginTop: 8 }}>
                  <label className="ai-field-label">{t("settings.ollamaModel")}</label>
                  <input
                    type="text"
                    className="ai-field-input"
                    value={settings.ollamaModel}
                    onChange={(e) => onChange({ ollamaModel: e.target.value })}
                    disabled={!settings.ollamaEnabled}
                    placeholder="llama3.2 / qwen2.5:7b / gemma-4-e4b"
                  />
                </div>
                {settings.ollamaEnabled && (
                  <div className="settings-ollama-test-row">
                    <button
                      type="button"
                      className="btn secondary"
                      disabled={testingOllama}
                      onClick={() => void handleTestOllama()}
                    >
                      {testingOllama ? t("settings.ollamaTesting") : t("settings.ollamaTest")}
                    </button>
                    {ollamaStatus?.tested && (
                      <span
                        className={
                          ollamaStatus.ok ? "ollama-status-ok" : "ollama-status-err"
                        }
                      >
                        {ollamaStatus.ok
                          ? t("settings.ollamaConnected", {
                              provider: ollamaStatus.provider || "本地部署服务",
                              count: String(ollamaStatus.models.length),
                            })
                          : ollamaStatus.error || t("settings.ollamaFailed")}
                      </span>
                    )}
                  </div>
                )}
                {settings.ollamaEnabled && ollamaStatus?.ok && ollamaStatus.models.length > 0 && (
                  <div className="settings-ollama-models">
                    <span className="settings-ollama-models-lbl">
                      {t("settings.ollamaAvailableModels")}
                    </span>
                    <div className="settings-ollama-model-chips">
                      {ollamaStatus.models.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className="settings-ollama-chip"
                          onClick={() => onChange({ ollamaModel: m })}
                          title={`填入 ${m}`}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Context & Memory Fusion Engine Selection */}
                <div className="settings-group-title" style={{ marginTop: 20 }}>
                  上下文与记忆引擎 (Context & Memory Engine)
                </div>
                <p className="settings-group-desc">
                  自由选择使用 Markelle 内置智能记忆引擎，还是接入外置强大的 CogniStack 上下文融合引擎。
                </p>

                <div className="ai-engine-cards">
                  <div
                    className={clsx(
                      "ai-engine-card",
                      (settings.aiEngineMode || "builtin") === "builtin" && "is-active",
                    )}
                    onClick={() => onChange({ aiEngineMode: "builtin" })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") onChange({ aiEngineMode: "builtin" });
                    }}
                  >
                    <div className="ai-engine-card-head">
                      <span className="ai-engine-card-title">✨ Markelle 内置引擎</span>
                      <span className="ai-engine-badge">原生零配置</span>
                    </div>
                    <p className="ai-engine-card-desc">
                      多轮智能滑动窗口，内置 Markdown 代码块与段落完整性保护，纯本地极速计算，无需额外启动外部服务。
                    </p>
                  </div>

                  <div
                    className={clsx(
                      "ai-engine-card",
                      settings.aiEngineMode === "cognistack" && "is-active",
                    )}
                    onClick={() => onChange({ aiEngineMode: "cognistack" })}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") onChange({ aiEngineMode: "cognistack" });
                    }}
                  >
                    <div className="ai-engine-card-head">
                      <span className="ai-engine-card-title">🧠 CogniStack 融合引擎</span>
                      <span className="ai-engine-badge">高级 Token 预算</span>
                    </div>
                    <p className="ai-engine-card-desc">
                      外接 CogniStack 网关，支持复杂提示词装配、严格 Token 预算软裁剪、水位触发与长期记忆块闭环。
                    </p>
                  </div>
                </div>

                {settings.aiEngineMode === "cognistack" && (
                  <div className="ai-subpanel-card">
                    <div className="ai-subpanel-head">
                      <span className="ai-subpanel-title">
                        <span>🔌</span> CogniStack 网关连接配置
                      </span>
                    </div>

                    <div className="ai-field-block">
                      <label className="ai-field-label">CogniStack 网关地址 (URL)</label>
                      <input
                        type="text"
                        className="ai-field-input"
                        value={settings.cogniStackUrl || "http://127.0.0.1:7331"}
                        onChange={(e) => onChange({ cogniStackUrl: e.target.value })}
                        placeholder="http://127.0.0.1:7331"
                      />
                    </div>

                    <div className="settings-ollama-presets" style={{ marginTop: 0 }}>
                      <span className="settings-ollama-models-lbl">一键填入网关预设：</span>
                      <div className="settings-ollama-model-chips">
                        {[
                          { label: "⚡ 本机主网关 (127.0.0.1:7331)", url: "http://127.0.0.1:7331" },
                          { label: "🌐 局域网端口 (127.0.0.1:7332)", url: "http://127.0.0.1:7332" },
                        ].map((item) => (
                          <button
                            key={item.url}
                            type="button"
                            className={clsx(
                              "settings-ollama-chip",
                              settings.cogniStackUrl === item.url && "is-active",
                            )}
                            onClick={() => onChange({ cogniStackUrl: item.url })}
                            title={`填入 ${item.url}`}
                          >
                            {item.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="ai-field-block">
                      <label className="ai-field-label">CogniStack 访问密钥 / Key (可选)</label>
                      <span className="ai-field-desc">若网关启动时启用了 `--key` 或 `--local-key` 鉴权时填入</span>
                      <input
                        type="password"
                        className="ai-field-input"
                        value={settings.cogniStackApiKey || ""}
                        onChange={(e) => onChange({ cogniStackApiKey: e.target.value })}
                        placeholder="留空即表示无需密码鉴权"
                      />
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                      <div className="ai-field-block">
                        <label className="ai-field-label">上下文总预算上限 (Tokens)</label>
                        <select
                          className="ai-field-input"
                          value={settings.cogniStackTokenLimit || 8192}
                          onChange={(e) => onChange({ cogniStackTokenLimit: Number(e.target.value) })}
                        >
                          <option value={4096}>4,096 tokens (小型轻量)</option>
                          <option value={8192}>8,192 tokens (标准推荐)</option>
                          <option value={16384}>16,384 tokens (长文深度)</option>
                          <option value={32768}>32,768 tokens (超大窗口)</option>
                          <option value={65536}>65,536 tokens (极限容量)</option>
                        </select>
                      </div>

                      <div className="ai-field-block">
                        <label className="ai-field-label">字数 Token 转换系数 (charsPerToken)</label>
                        <select
                          className="ai-field-input"
                          value={settings.cogniStackCharsPerToken || 2}
                          onChange={(e) => onChange({ cogniStackCharsPerToken: Number(e.target.value) })}
                        >
                          <option value={1}>1.0（保守 1字=1token，严格防超顶）</option>
                          <option value={2}>2.0（推荐 中英双语/笔记标准比）</option>
                          <option value={3}>3.0（激进 英文/代码较多时选用）</option>
                        </select>
                      </div>
                    </div>

                    <div className="settings-ollama-test-row" style={{ marginTop: 4 }}>
                      <button
                        type="button"
                        className="btn secondary"
                        disabled={testingCogni}
                        onClick={() => void handleTestCogni()}
                      >
                        {testingCogni ? "正在测试 CogniStack..." : "测试 CogniStack 连接"}
                      </button>
                      {cogniStatus?.tested && (
                        <span className={cogniStatus.ok ? "ollama-status-ok" : "ollama-status-err"}>
                          {cogniStatus.ok
                            ? `✓ CogniStack 引擎在线 (v${cogniStatus.version || "1.3.0"})`
                            : `✗ ${cogniStatus.error || "未在目标端口检测到服务"}`}
                        </span>
                      )}
                    </div>
                  </div>
                )}

                {/* Model parameters & System Prompt */}
                <div className="settings-group-title" style={{ marginTop: 22 }}>
                  AI 行为与模型微调 (Persona & Tuning)
                </div>

                <div className="ai-field-block" style={{ marginTop: 8 }}>
                  <label className="ai-field-label">系统角色设定 (System Prompt)</label>
                  <span className="ai-field-desc">注入大模型顶部的全局指令，约束其回答格式与行文风格</span>
                  <textarea
                    className="ai-field-input"
                    rows={3}
                    value={settings.aiSystemPrompt || ""}
                    onChange={(e) => onChange({ aiSystemPrompt: e.target.value })}
                    placeholder="你是一位专业高效的个人知识库助手，请直接输出精炼、准确的 Markdown 格式结果。"
                    style={{ resize: "vertical", minHeight: 64, lineHeight: 1.45 }}
                  />
                </div>

                <label className="settings-row" style={{ marginTop: 8 }}>
                  <span>
                    发散度 / 温度 (Temperature)
                    <em className="settings-row-desc">较低值结果更精确稳定（如纠错），较高值更有创意（如续写）</em>
                  </span>
                  <div className="ai-range-wrap">
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={settings.aiTemperature ?? 0.7}
                      onChange={(e) => onChange({ aiTemperature: Number(e.target.value) })}
                    />
                    <span className="ai-range-badge">{settings.aiTemperature ?? 0.7}</span>
                  </div>
                </label>
              </div>
            </section>
            ) : null}

            {section === "panels" ? (
            <section className="settings-section" id="settings-panels" key="panels">
              <header className="settings-section-head">
                <h3>{t("settings.panelsHead")}</h3>
                <p>{t("settings.panelsDesc")}</p>
              </header>
              <div className="settings-grid">
                {row(
                  "settings.activityBarExpanded",
                  "settings.activityBarExpandedDesc",
                  <input
                    type="checkbox"
                    className="ui-switch"
                    checked={settings.activityBarExpanded}
                    onChange={(e) => onChange({ activityBarExpanded: e.target.checked })}
                  />,
                )}
              </div>
              <p className="settings-hint">{t("settings.panelsHintBody")}</p>
            </section>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
