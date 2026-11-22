"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/components/action-form";

function safeNext(next: FormDataEntryValue | null) {
  const value = typeof next === "string" ? next : "";
  // Only allow same-site relative paths.
  return value.startsWith("/") && !value.startsWith("//") ? value : "/staff";
}

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Enter your email and password." };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: "Incorrect email or password." };

  const h = await headers();
  await supabase.rpc("record_login", {
    p_ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    p_user_agent: h.get("user-agent"),
  });

  redirect(safeNext(formData.get("next")));
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
