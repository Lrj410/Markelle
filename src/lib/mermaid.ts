import { t } from "./i18n";

let initializedTheme: "dark" | "default" | null = null;

export async function renderMermaidBlocks(
  root: HTMLElement,
  dark: boolean,
): Promise<void> {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>("pre.mermaid:not([data-processed])"),
  );
  if (nodes.length === 0) return;

  const mermaid = (await import("mermaid")).default;
  const theme = dark ? "dark" : "default";
  if (initializedTheme !== theme) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme,
      fontFamily: "Segoe UI, system-ui, sans-serif",
      flowchart: { htmlLabels: false },
    });
    initializedTheme = theme;
  }

  try {
    await mermaid.run({ nodes });
  } catch (err) {
    for (const node of nodes) {
      if (!node.isConnected) continue;
      if (node.getAttribute("data-processed")) continue;
      const message = err instanceof Error ? err.message : String(err);
      // Prefer textContent mutation over outerHTML — avoids removeChild races
      // when React later replaces the article via dangerouslySetInnerHTML.
      node.className = "mermaid-error";
      node.textContent = t("md.mermaidRenderFailed", { error: message });
      node.setAttribute("data-processed", "true");
    }
  }
}
