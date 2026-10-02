import { t } from "./i18n";

/** Normalize errors into short localized status text. */
export function formatAppError(err: unknown, fallback?: string): string {
  const fb = fallback ?? t("error.fallback");
  const raw =
    err instanceof Error
      ? err.message
      : typeof err === "string"
        ? err
        : fb;

  const text = raw.trim() || fb;

  if (/permission|denied|拒绝/i.test(text)) {
    return t("error.denied");
  }
  if (/not found|不存在|ENOENT/i.test(text)) {
    return t("error.notFound");
  }
  if (/invalid|无效/i.test(text)) {
    // Vault errors may embed an absolute path — return a generic message instead.
    if (/vault|库/i.test(text)) return fb;
    return t("error.invalid", { detail: text });
  }
  if (/busy|locked|正在使用/i.test(text)) {
    return t("error.busy");
  }
  if (/too large|过大/i.test(text)) {
    return t("error.tooLarge");
  }

  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}
