import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { Card, Field, input } from "@/components/ui";
import { signIn } from "./actions";

export const metadata: Metadata = { title: "Staff sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand">TableQR</p>
      <h1 className="mb-6 mt-1 text-2xl font-semibold">Staff sign in</h1>
      <Card>
        <ActionForm action={signIn} submitLabel="Sign in" submitClassName={undefined}>
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Email">
            <input name="email" type="email" autoComplete="username" required className={input} />
          </Field>
          <Field label="Password">
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className={input}
            />
          </Field>
        </ActionForm>
      </Card>
      <p className="mt-4 text-xs text-ink-soft">
        Forgot your password? Ask your restaurant administrator to reset it.
      </p>
    </main>
  );
}
