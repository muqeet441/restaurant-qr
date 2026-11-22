"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

type Note = { id: string; type: string; title: string; body: string | null; created_at: string; read_at: string | null };

const URGENT = new Set(["order.new", "ticket.new", "order.ready", "item.ready", "order.stale", "item.unavailable", "kitchen.question", "order.clarified"]);

/** Short two-tone chime via Web Audio, so no sound file is needed. */
function chime() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.18 + 0.3);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.18);
      osc.stop(ctx.currentTime + i * 0.18 + 0.32);
    });
    setTimeout(() => ctx.close(), 1000);
  } catch {
    // audio not allowed yet (no user interaction) — the badge still updates
  }
  navigator.vibrate?.(200);
}

/**
 * Unread notifications for the signed-in staff member (FR-155..159).
 * Persisted rows are the source of truth; Realtime only triggers a refetch.
 */
export function NotificationBell({ userId }: { userId: string }) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState(true);
  const seen = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("notifications")
      .select("id, type, title, body, created_at, notification_recipients!inner(read_at)")
      .eq("notification_recipients.user_id", userId)
      .order("created_at", { ascending: false })
      .limit(30);
    const list = ((data ?? []) as unknown as (Omit<Note, "read_at"> & { notification_recipients: { read_at: string | null }[] })[]).map(
      ({ notification_recipients, ...n }) => ({ ...n, read_at: notification_recipients[0]?.read_at ?? null }),
    );

    // Chime for urgent notifications that arrived since the last load.
    if (seen.current) {
      const fresh = list.filter((n) => !n.read_at && !seen.current!.has(n.id) && URGENT.has(n.type));
      if (fresh.length && sound) chime();
    }
    seen.current = new Set(list.map((n) => n.id));
    setNotes(list);
  }, [userId, sound]);

  useEffect(() => {
    try {
      setSound(localStorage.getItem("tableqr:sound") !== "off");
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel(`notes:${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notification_recipients", filter: `user_id=eq.${userId}` }, load)
      .subscribe((s) => s === "SUBSCRIBED" && load());
    const poll = setInterval(load, 60000);
    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [userId, load]);

  const unread = notes.filter((n) => !n.read_at).length;

  async function markAll() {
    await createClient().rpc("mark_all_notifications_read");
    load();
  }
  async function markOne(id: string) {
    await createClient().rpc("mark_notification_read", { p_notification_id: id });
    load();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        aria-label={`Notifications, ${unread} unread`}
        aria-expanded={open}
      >
        <span aria-hidden>🔔</span>
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-brand px-1 text-center text-[11px] font-semibold leading-5 text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            <div className="flex gap-3 text-xs">
              <button
                className="text-ink-soft underline"
                onClick={() => {
                  const next = !sound;
                  setSound(next);
                  try {
                    localStorage.setItem("tableqr:sound", next ? "on" : "off");
                  } catch {
                    // ignore
                  }
                  if (next) chime();
                }}
              >
                Sound {sound ? "on" : "off"}
              </button>
              {unread > 0 && (
                <button className="text-ink-soft underline" onClick={markAll}>
                  Mark all read
                </button>
              )}
            </div>
          </div>
          <ul className="max-h-96 divide-y divide-line overflow-y-auto">
            {notes.length === 0 && <li className="px-4 py-6 text-center text-sm text-ink-soft">Nothing yet.</li>}
            {notes.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => !n.read_at && markOne(n.id)}
                  className={`block w-full px-4 py-3 text-left ${n.read_at ? "opacity-60" : "bg-brand/5"}`}
                >
                  <p className="text-sm font-medium">{n.title}</p>
                  {n.body && <p className="text-xs text-ink-soft">{n.body}</p>}
                  <p className="mt-0.5 text-[11px] text-ink-soft">
                    {new Date(n.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
