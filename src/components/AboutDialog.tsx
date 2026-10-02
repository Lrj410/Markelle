import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { getUserPluginsDir } from "../lib/plugins/host";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";
import { useModalFocusTrap } from "../hooks/useModalFocusTrap";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function AboutDialog({ open, onClose }: Props) {
  useLocale();
  const [version, setVersion] = useState("…");
  const [pluginsDir, setPluginsDir] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void getVersion()
      .then(setVersion)
      .catch(() => setVersion(t("about.versionUnknown")));
    void getUserPluginsDir().then(setPluginsDir).catch(() => setPluginsDir(""));
    setCopied(null);
  }, [open]);

  useModalFocusTrap({
    active: open,
    containerRef: panelRef,
    onEscape: onClose,
    initialFocusSelector: ".about-actions .btn, .btn.primary",
  });

  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
    }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <button type="button" className="modal-backdrop" onClick={onClose} aria-label={t("common.close")} />
      <div className="modal-panel about-panel" ref={panelRef}>
        <div className="about-brand">
          <img className="about-logo" src="/markelle.svg" alt="" width={52} height={52} />
          <div>
            <h2 id="about-title" className="about-name">
              Markelle
            </h2>
            <div className="about-ver">{t("about.version", { version })}</div>
          </div>
        </div>

        <p className="about-blurb">{t("about.blurb").split("\n").map((line, i) => (
              <span key={i}>
                {i > 0 ? <br /> : null}
                {line}
              </span>
            ))}</p>

        <dl className="about-meta">
          <div className="about-row">
            <dt>
              {t("about.appId")}
              <span className="about-tip">{t("about.appIdTip")}</span>
            </dt>
            <dd>
              <code className="about-code">com.markelle.reader</code>
              <button
                type="button"
                className="btn ghost about-copy"
                onClick={() => void copyText("id", "com.markelle.reader")}
              >
                {copied === "id" ? t("about.copied") : t("about.copy")}
              </button>
            </dd>
          </div>
          <div className="about-row">
            <dt>{t("about.stack")}</dt>
            <dd>Desktop · React · CodeMirror · Rust</dd>
          </div>
          {pluginsDir && (
            <div className="about-row">
              <dt>{t("about.pluginsDir")}</dt>
              <dd>
                <code className="about-path">{pluginsDir}</code>
                <button
                  type="button"
                  className="btn ghost about-copy"
                  onClick={() => void copyText("plugins", pluginsDir)}
                >
                  {copied === "plugins" ? t("about.copied") : t("about.copy")}
                </button>
              </dd>
            </div>
          )}
        </dl>

        <div className="about-actions">
          <button type="button" className="btn primary" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
