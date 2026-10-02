import { useEffect, useState } from "react";
import type { ReaderSettings } from "../lib/types";

export function useResolvedDark(scheme: ReaderSettings["scheme"]) {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  if (scheme === "dark") return true;
  if (scheme === "light") return false;
  return systemDark;
}
