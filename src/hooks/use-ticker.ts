import { useEffect, useState } from "react";

/** Re-renders every second while `active` so live durations stay fresh. */
export function useTicker(active: boolean | undefined) {
  const [, setN] = useState(0);
  useEffect(() => {
    if (!active) return;
    const h = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [active]);
}
