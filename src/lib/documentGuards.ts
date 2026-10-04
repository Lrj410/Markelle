import type { DocTab } from "./tabs";

/** Why a tab must not be written from the preview buffer. */
export type WriteBlockReason = "truncated" | "backendBuffer";

export function getWriteBlockReason(
  tab: Pick<DocTab, "truncated" | "backendBuffer"> | null | undefined,
): WriteBlockReason | null {
  if (!tab) return null;
  if (tab.truncated) return "truncated";
  if (tab.backendBuffer) return "backendBuffer";
  return null;
}

export function canWriteTabContent(
  tab: Pick<DocTab, "truncated" | "backendBuffer"> | null | undefined,
): boolean {
  return getWriteBlockReason(tab) == null;
}
