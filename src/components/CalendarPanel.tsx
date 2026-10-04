import { useMemo, useState } from "react";
import { formatDateYmd, dailyNotePath } from "../lib/templates";
import { t } from "../lib/i18n";
import { useLocale } from "../hooks/useLocale";

interface Props {
  vaultRoot: string | null;
  dailyFolder: string;
  /** YYYY-MM-DD notes that already exist under the daily folder. */
  existingDates?: ReadonlySet<string> | string[];
  onOpenDate: (path: string, ymd: string) => void;
}

const DOW_ZH = ["一", "二", "三", "四", "五", "六", "日"];
const DOW_EN = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

export function CalendarPanel({
  vaultRoot,
  dailyFolder,
  existingDates,
  onOpenDate,
}: Props) {
  const locale = useLocale();
  const today = new Date();
  const [cursor, setCursor] = useState(
    () => new Date(today.getFullYear(), today.getMonth(), 1),
  );

  const existing = useMemo(() => {
    if (!existingDates) return new Set<string>();
    return existingDates instanceof Set ? existingDates : new Set(existingDates);
  }, [existingDates]);

  const cells = useMemo(() => {
    const y = cursor.getFullYear();
    const m = cursor.getMonth();
    const firstDow = new Date(y, m, 1).getDay(); // 0 Sun
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const pad = (firstDow + 6) % 7; // Monday-first
    const out: Array<{ day: number | null; ymd: string | null }> = [];
    for (let i = 0; i < pad; i++) out.push({ day: null, ymd: null });
    for (let d = 1; d <= daysInMonth; d++) {
      const dt = new Date(y, m, d);
      out.push({ day: d, ymd: formatDateYmd(dt) });
    }
    while (out.length % 7 !== 0) out.push({ day: null, ymd: null });
    return out;
  }, [cursor]);

  const label = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
  const todayYmd = formatDateYmd(today);
  const dows = locale === "en" ? DOW_EN : DOW_ZH;

  const weeks = useMemo(() => {
    const out: Array<Array<{ day: number | null; ymd: string | null }>> = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  if (!vaultRoot) {
    return (
      <aside className="backlinks-panel dock-fill" aria-label={t("panel.calendar")}>
        <p className="backlinks-empty">{t("vault.needOpen")}</p>
      </aside>
    );
  }

  return (
    <aside className="backlinks-panel dock-fill calendar-panel" aria-label={t("panel.calendar")}>
      <div className="calendar-nav">
        <button
          type="button"
          className="btn ghost calendar-nav-btn"
          aria-label={t("calendar.prev")}
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}
        >
          ‹
        </button>
        <span className="calendar-nav-label" aria-live="polite">
          {label}
        </span>
        <button
          type="button"
          className="btn ghost calendar-nav-btn"
          aria-label={t("calendar.next")}
          onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}
        >
          ›
        </button>
      </div>
      <div className="cal-grid" role="grid" aria-label={label}>
        <div className="cal-row" role="row" style={{ display: "contents" }}>
          {dows.map((d) => (
            <div key={d} className="cal-dow" role="columnheader">
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={`w${wi}`} className="cal-row" role="row" style={{ display: "contents" }}>
            {week.map((c, i) =>
              c.day == null ? (
                <div key={`e${wi}-${i}`} className="cal-cell empty" role="gridcell" aria-hidden />
              ) : (
                <button
                  key={c.ymd}
                  type="button"
                  role="gridcell"
                  className={`cal-cell${c.ymd === todayYmd ? " today" : ""}${
                    existing.has(c.ymd!) ? " has-note" : ""
                  }`}
                  aria-label={
                    existing.has(c.ymd!)
                      ? `${c.ymd!} · note`
                      : c.ymd!
                  }
                  aria-current={c.ymd === todayYmd ? "date" : undefined}
                  onClick={() => {
                    const path = dailyNotePath(
                      vaultRoot,
                      new Date(c.ymd! + "T12:00:00"),
                      dailyFolder,
                    );
                    onOpenDate(path, c.ymd!);
                  }}
                >
                  {c.day}
                </button>
              ),
            )}
          </div>
        ))}
      </div>
      <p className="settings-hint calendar-hint">{t("calendar.hint")}</p>
    </aside>
  );
}
