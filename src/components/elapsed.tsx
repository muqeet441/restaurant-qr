"use client";

import { useEffect, useState } from "react";

/** "7 min" that keeps ticking; turns amber/red past the thresholds (minutes). */
export function Elapsed({ since, warn = 10, late = 20 }: { since: string; warn?: number; late?: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, 30000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);
  if (now === null) return <span className="tabular-nums">…</span>;
  const mins = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60000));
  const tone = mins >= late ? "text-red-600 dark:text-red-400 font-semibold" : mins >= warn ? "text-amber-600 dark:text-amber-400 font-medium" : "text-ink-soft";
  return <span className={`tabular-nums ${tone}`}>{mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`}</span>;
}
