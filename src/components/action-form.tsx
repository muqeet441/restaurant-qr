"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { btnPrimary } from "@/components/ui";

export type ActionState = { error?: string; ok?: string } | null;
export type FormAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

function Submit({ label, className }: { label: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className ?? btnPrimary}>
      {pending ? "Working…" : label}
    </button>
  );
}

/**
 * Form bound to a server action. Shows the returned error/success message,
 * optionally asks for confirmation and resets the fields on success.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  submitClassName,
  className = "space-y-4",
  confirm,
  resetOnSuccess = false,
  inline = false,
}: {
  action: FormAction;
  children?: ReactNode;
  submitLabel: string;
  submitClassName?: string;
  className?: string;
  confirm?: string;
  resetOnSuccess?: boolean;
  inline?: boolean;
}) {
  const [state, formAction] = useActionState(action, null);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.ok && resetOnSuccess) ref.current?.reset();
  }, [state, resetOnSuccess]);

  return (
    <form
      ref={ref}
      action={formAction}
      className={inline ? "inline-flex flex-wrap items-center gap-2" : className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}
      <Submit label={submitLabel} className={submitClassName} />
      {state?.error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      )}
      {state?.ok && !inline && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {state.ok}
        </p>
      )}
    </form>
  );
}
