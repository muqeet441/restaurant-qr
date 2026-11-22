"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { subscribeAuthed } from "@/lib/supabase/realtime";
import { friendlyError } from "@/lib/errors";
import { Sheet } from "./sheet";

type RequestType = "call_waiter" | "water" | "assistance" | "problem" | "bill";
type Req = { id: string; type: RequestType; status: string; note: string | null; created_at: string };

const OPTIONS: { type: Exclude<RequestType, "bill">; label: string; icon: string }[] = [
  { type: "call_waiter", label: "Call the waiter", icon: "🙋" },
  { type: "water", label: "Water, please", icon: "💧" },
  { type: "assistance", label: "Something else", icon: "💬" },
  { type: "problem", label: "Report a problem", icon: "⚠️" },
];
const LABEL: Record<RequestType, string> = {
  call_waiter: "Waiter called",
  water: "Water",
  assistance: "Assistance",
  problem: "Problem reported",
  bill: "Bill",
};

/** Customer assistance (Module 5): requests and their live status. */
export function ServicePanel({ sessionId, onDark = false }: { sessionId: string; onDark?: boolean }) {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<Req[]>([]);
  const [note, setNote] = useState("");
  const [choice, setChoice] = useState<RequestType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await createClient()
      .from("customer_service_requests")
      .select("id, type, status, note, created_at")
      .eq("session_id", sessionId)
      .in("status", ["open", "accepted"])
      .order("created_at", { ascending: false });
    setRequests((data ?? []) as Req[]);
  }, [sessionId]);

  useEffect(() => {
    const supabase = createClient();
    const unsubscribe = subscribeAuthed(supabase, `guest-requests:${sessionId}`, (ch) =>
      ch
        .on("postgres_changes", { event: "*", schema: "public", table: "customer_service_requests", filter: `session_id=eq.${sessionId}` }, load)
        .subscribe((s) => s === "SUBSCRIBED" && load()),
    );
    const poll = setInterval(load, 20000);
    return () => {
      clearInterval(poll);
      unsubscribe();
    };
  }, [sessionId, load]);

  async function send(type: RequestType) {
    if ((type === "problem" || type === "assistance") && choice !== type) {
      setChoice(type);
      return;
    }
    setBusy(true);
    setError(null);
    const { error } = await createClient().rpc("create_service_request", {
      p_session_id: sessionId,
      p_type: type,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (error) {
      setError(friendlyError(error));
      return;
    }
    setNote("");
    setChoice(null);
    load();
  }

  async function cancel(id: string) {
    await createClient().rpc("cancel_service_request", { p_request_id: id });
    load();
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={`rounded-full border px-3 py-1.5 text-sm font-semibold shadow-sm ${
          onDark ? "border-white/30 bg-white/15 text-white backdrop-blur" : "border-line bg-surface"
        }`}
        aria-label="Ask for help"
      >
        🙋 Help
        {requests.length > 0 && <span className="ml-1.5 rounded-full bg-brand px-1.5 text-[10px] text-white">{requests.length}</span>}
      </button>

      {open && (
        <Sheet open onClose={() => setOpen(false)} title="How can we help?">
          {requests.length > 0 && (
            <ul className="mb-4 space-y-2">
              {requests.map((r) => (
                <li key={r.id} className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
                  <span className="flex-1">
                    <strong>{LABEL[r.type]}</strong> · {r.status === "accepted" ? "On the way" : "Sent"}
                    {r.note && <span className="block text-xs text-ink-soft">{r.note}</span>}
                  </span>
                  {r.status === "open" && (
                    <button onClick={() => cancel(r.id)} className="text-xs text-ink-soft underline">
                      Cancel
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <div className="grid grid-cols-2 gap-3">
            {OPTIONS.map((o) => (
              <button
                key={o.type}
                disabled={busy}
                onClick={() => send(o.type)}
                className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-4 text-sm font-medium disabled:opacity-50 ${
                  choice === o.type ? "border-brand bg-brand/10" : "border-line bg-surface"
                }`}
              >
                <span className="text-2xl" aria-hidden>
                  {o.icon}
                </span>
                {o.label}
              </button>
            ))}
          </div>
          {choice && (
            <form
              className="mt-4 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                send(choice);
              }}
            >
              <label className="block text-sm font-medium" htmlFor="service-note">
                {choice === "problem" ? "What's wrong?" : "What do you need?"}
              </label>
              <textarea
                id="service-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={300}
                rows={2}
                required={choice === "problem"}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm"
              />
              <button disabled={busy} className="w-full rounded-lg bg-brand px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">
                {busy ? "Sending…" : "Send"}
              </button>
            </form>
          )}
          {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
        </Sheet>
      )}
    </>
  );
}
