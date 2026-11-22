"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { subscribeAuthed } from "@/lib/supabase/realtime";

const SAFETY_REFRESH_MS = 20000;

/**
 * Re-renders the current server page when any of the watched tables change.
 * The database is the source of truth: on a change (or a reconnect) the page
 * refetches instead of patching local state (FR-159). A slow safety refresh
 * covers dropped connections.
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
      // Tiny debounce so a burst of row changes becomes one refresh.
      timer = setTimeout(() => router.refresh(), 60);
    };

    const unsubscribe = subscribeAuthed(supabase, channel, (ch) => {
      for (const w of JSON.parse(key) as { table: string; filter?: string }[]) {
        ch = ch.on("postgres_changes", { event: "*", schema: "public", table: w.table, filter: w.filter }, refresh);
      }
      ch.on("system", {}, (p: { status?: string; message?: string }) => {
        if (p?.status === "error") setLive(false);
      });
      return ch.subscribe((status) => {
        setLive(status === "SUBSCRIBED");
        if (status === "SUBSCRIBED") refresh(); // catch up after (re)connecting
      });
    });

    const safety = setInterval(refresh, SAFETY_REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      clearInterval(safety);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [channel, key, router]);

  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-soft">
      <span className={`size-2 rounded-full ${live ? "bg-emerald-500" : "bg-slate-400"}`} aria-hidden />
      {live ? "Live" : "Connecting…"}
    </span>
  );
}
