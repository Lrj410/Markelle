import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import type { VaultFile } from "./vaultIndex";

/** CodeMirror completion source for `[[` wikilinks. */
export function wikiLinkCompletion(files: VaultFile[]) {
  return (context: CompletionContext): CompletionResult | null => {
    const match = context.matchBefore(/\[\[([^\]]*)$/);
    if (!match) return null;
    if (match.from === match.to && !context.explicit) return null;

    const typed = match.text.slice(2);
    if (typed.includes("|") || typed.includes("#")) return null;
    const q = typed.toLowerCase();

    const options = files
      .filter((f) => {
        if (!q) return true;
        return (
          f.stem.toLowerCase().includes(q) ||
          f.name.toLowerCase().includes(q) ||
          f.relative.toLowerCase().includes(q)
        );
      })
      .slice(0, 40)
      .map((f) => ({
        label: f.stem,
        detail: f.relative,
        apply: f.stem,
        type: "text" as const,
      }));

    return {
      from: match.from + 2,
      to: match.to,
      options,
      filter: false,
    };
  };
}
