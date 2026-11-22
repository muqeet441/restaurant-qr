import type { ReactNode } from "react";
import type { TableStatus } from "@/lib/types";

export const btn =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed";
export const btnPrimary = `${btn} bg-brand text-white hover:bg-brand-dark`;
export const btnSecondary = `${btn} border border-line bg-surface text-ink hover:bg-muted`;
export const btnDanger = `${btn} border border-red-300 bg-surface text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950`;
export const btnSmall = "!px-3 !py-1.5 !text-xs";

export const input =
  "w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-soft focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/20";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-line bg-surface p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-soft">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-soft">{hint}</span>}
    </label>
  );
}

const STATUS_STYLES: Record<TableStatus, string> = {
  available: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  reserved: "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  occupied: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  ordering: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  billing: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  cleaning: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function TableStatusBadge({ status }: { status: TableStatus }) {
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS_STYLES[status]}`}
    >
      {status}
    </span>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-ink-soft">
      {children}
    </span>
  );
}
