import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

/**
 * Opens a Realtime channel *after* the signed-in user's token is loaded.
 *
 * The browser client reads the session from cookies asynchronously. If a
 * channel joins before that, it joins as the anonymous role, Supabase rejects
 * every `postgres_changes` binding ("Unable to subscribe to changes"), and the
 * screen silently stops receiving updates. Setting the token first avoids it.
 */
export async function authedChannel(supabase: SupabaseClient, name: string): Promise<RealtimeChannel> {
  const { data } = await supabase.auth.getSession();
  if (data.session) await supabase.realtime.setAuth(data.session.access_token);
  return supabase.channel(name);
}

/**
 * Runs `setup` with an authenticated channel and returns a cleanup function,
 * for use inside React effects.
 */
export function subscribeAuthed(
  supabase: SupabaseClient,
  name: string,
  setup: (channel: RealtimeChannel) => RealtimeChannel,
): () => void {
  let channel: RealtimeChannel | null = null;
  let cancelled = false;
  authedChannel(supabase, name).then((ch) => {
    if (cancelled) return;
    channel = setup(ch);
  });
  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}
