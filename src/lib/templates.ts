import { joinPath } from "./paths";

export interface TemplateVars {
  title: string;
  date: string;
  time: string;
}

/** Format a Date as local `YYYY-MM-DD`. */
export function formatDateYmd(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Format a Date as local `HH:mm`. */
export function formatTimeHm(date: Date = new Date()): string {
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${h}:${min}`;
}

/** Replace `{{title}}` / `{{date}}` / `{{time}}` placeholders. */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template
    .split("{{title}}")
    .join(vars.title)
    .split("{{date}}")
    .join(vars.date)
    .split("{{time}}")
    .join(vars.time);
}

/** Default daily-note folder under the vault (overridable via settings). */
export const DEFAULT_DAILY_FOLDER = "日记";

/** `vaultRoot/<folder>/YYYY-MM-DD.md` */
export function dailyNotePath(
  vaultRoot: string,
  date: Date = new Date(),
  folder: string = DEFAULT_DAILY_FOLDER,
): string {
  const seg = folder.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || DEFAULT_DAILY_FOLDER;
  return joinPath(vaultRoot, seg, `${formatDateYmd(date)}.md`);
}

/** Seed body for a daily note. */
export function dailyNoteSeed(date: Date = new Date()): string {
  const ymd = formatDateYmd(date);
  return `# ${ymd}\n\n${ymd}\n\n`;
}

/** Path + seed content for today's (or given) daily note. */
export function createDailyNote(
  vaultRoot: string,
  date: Date = new Date(),
  folder: string = DEFAULT_DAILY_FOLDER,
): { path: string; content: string; dateKey: string } {
  const dateKey = formatDateYmd(date);
  return {
    path: dailyNotePath(vaultRoot, date, folder),
    content: dailyNoteSeed(date),
    dateKey,
  };
}

/** Default template when `.markelle/templates/默认.md` is missing. */
export const DEFAULT_NOTE_TEMPLATE = "# {{title}}\n\n";
