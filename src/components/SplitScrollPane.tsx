import { useRef, type ReactNode } from "react";
import { useSplitScrollSync } from "../hooks/useSplitScrollSync";

/** Split layout with ratio-synced scrolling between source and preview. */
export function SplitScrollPane({
  source,
  preview,
}: {
  source: ReactNode;
  preview: ReactNode;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  useSplitScrollSync(leftRef, rightRef, true);

  return (
    <div className="split-pane">
      <div ref={leftRef} className="split-half split-source">
        {source}
      </div>
      <div ref={rightRef} className="split-half split-preview">
        {preview}
      </div>
    </div>
  );
}
