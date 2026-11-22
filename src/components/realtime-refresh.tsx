"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

/**
 * Re-renders the current server page when any of the watched tables change.
 * The database is the source of truth: on a change (or a reconnect) the page
 * refetches instead of patching local state (FR-159).
 */
export function RealtimeRefresh({
  channel,
  watch,
}: {
  channel: string;
  watch: { table: string; filter?: string }[];
}) {
  const router = useRouter();
  const [live, setLive] = useState(false);
  const key = JSON.stringify(watch);

  useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 250);
    };

    let ch = supabase.channel(channel);
    for (const w of JSON.parse(key) as { table: string; filter?: string }[]) {
      ch = ch.on("postgres_changes", { event: "*", schema: "public", table: w.table, filter: w.filter }, refresh);
    }
    ch.subscribe((status) => {
      setLive(status === "SUBSCRIBED");
      if (status === "SUBSCRIBED") refresh(); // catch up after (re)connecting
    });

    window.addEventListener("focus", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      supabase.removeChannel(ch);
    };
  }, [channel, key, router]);

  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-soft">
      <span className={`size-2 rounded-full ${live ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden />
      {live ? "Live" : "Connecting…"}
    </span>
  );
}
