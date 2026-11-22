"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { friendlyError } from "@/lib/errors";
import { cartTotals, imageUrl, type CartLine, type MenuItem } from "@/lib/menu";
import type { JoinResult } from "@/lib/types";
import { btnPrimary } from "@/components/ui";
import { loadMenu, type MenuData } from "./load-menu";
import { ItemSheet } from "./item-sheet";
import { CartSheet } from "./cart-sheet";
import { OrdersView, useSessionOrders } from "./orders-view";
import { BillCard } from "./bill-card";
import { ServicePanel } from "./service-panel";
import { CATEGORY_ICON, FoodArt, foodKind } from "./food-art";

type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "waiting"; info: JoinResult }
  | { kind: "ended"; info: JoinResult }
  | { kind: "joined"; info: JoinResult & { session: NonNullable<JoinResult["session"]> } };

const WAIT_POLL_MS = 8000;

export function CustomerTable({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });

  const join = useCallback(async () => {
    const supabase = createClient();
    // Customers never register: each device gets an anonymous Supabase user.
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        setState({ kind: "error", message: "Could not start your visit. Please try again." });
        return;
      }
    }
    const { data, error } = await supabase.rpc("join_table_session", { p_qr_token: token });
    if (error) {
      setState({ kind: "error", message: friendlyError(error) });
      return;
    }
    const info = data as JoinResult;
    if (info.status === "joined" && info.session) {
      setState({ kind: "joined", info: info as JoinResult & { session: NonNullable<JoinResult["session"]> } });
    } else {
      setState({ kind: "waiting", info });
    }
  }, [token]);

  useEffect(() => {
    const first = setTimeout(join, 0);
    return () => clearTimeout(first);
  }, [join]);

  useEffect(() => {
    if (state.kind !== "waiting") return;
    const id = setInterval(join, WAIT_POLL_MS);
    return () => clearInterval(id);
  }, [state.kind, join]);

  if (state.kind === "loading") return <Shell><p className="text-ink-soft">Finding your table…</p></Shell>;
  if (state.kind === "error") {
    return (
      <Shell>
        <h1 className="text-xl font-semibold">Something isn&apos;t right</h1>
        <p className="mt-2 text-ink-soft">{state.message}</p>
      </Shell>
    );
  }
  if (state.kind === "waiting" || state.kind === "ended") {
    return (
      <Shell>
        <Header info={state.info} />
        <div className="rounded-xl border border-line bg-surface p-5">
          {state.kind === "waiting" ? (
            <>
              <p className="font-medium">Welcome! A member of staff will seat you shortly.</p>
              <p className="mt-1 text-sm text-ink-soft">The menu opens here automatically once your table is ready.</p>
            </>
          ) : (
            <>
              <p className="font-medium">Thanks for visiting!</p>
              <p className="mt-1 text-sm text-ink-soft">This table&apos;s visit has ended. Scan the code again if you&apos;re still here.</p>
            </>
          )}
        </div>
      </Shell>
    );
  }
  return <TableApp info={state.info} onEnded={() => setState({ kind: "ended", info: state.info })} />;
}

// ---------------------------------------------------------------------------

type Stored = { lines: CartLine[]; note: string; key: string };
const newKey = () => crypto.randomUUID();

function readCart(sessionId: string): Stored {
  try {
    const raw = localStorage.getItem(`tableqr:cart:${sessionId}`);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    // storage unavailable, start empty
  }
  return { lines: [], note: "", key: newKey() };
}

type SheetState = { type: "item"; itemId: string; editKey?: string } | { type: "cart" } | null;

function TableApp({
  info,
  onEnded,
}: {
  info: JoinResult & { session: NonNullable<JoinResult["session"]> };
  onEnded: () => void;
}) {
  const sessionId = info.session.id;
  const money = useMemo(
    () => new Intl.NumberFormat(undefined, { style: "currency", currency: info.restaurant.currency }),
    [info.restaurant.currency],
  );
  const [menu, setMenu] = useState<MenuData | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [tab, setTab] = useState<"menu" | "orders">("menu");
  const [sheet, setSheet] = useState<SheetState>(null);
  const [cart, setCartState] = useState<Stored>({ lines: [], note: "", key: "" });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const { orders, reload } = useSessionOrders(sessionId);

  // Cart survives reloads on this device (an unsent draft).
  useEffect(() => {
    const t = setTimeout(() => setCartState(readCart(sessionId)), 0);
    return () => clearTimeout(t);
  }, [sessionId]);

  const setCart = useCallback(
    (update: (c: Stored) => Omit<Stored, "key">) => {
      setCartState((c) => {
        // Any change to the cart gets a new idempotency key; retrying an
        // unchanged cart reuses the old one, so a lost response can't double-order.
        const next = { ...update(c), key: newKey() };
        try {
          localStorage.setItem(`tableqr:cart:${sessionId}`, JSON.stringify(next));
        } catch {
          // ignore
        }
        return next;
      });
      setSubmitError(null);
    },
    [sessionId],
  );

  const fetchMenu = useCallback(async () => {
    try {
      setMenu(await loadMenu(createClient(), info.restaurant.id));
      setMenuError(null);
    } catch {
      setMenuError("We couldn't load the menu. Check your connection and try again.");
    }
  }, [info.restaurant.id]);

  useEffect(() => {
    const t = setTimeout(fetchMenu, 0);
    // Pick up availability changes during the visit.
    const id = setInterval(fetchMenu, 60000);
    return () => {
      clearTimeout(t);
      clearInterval(id);
    };
  }, [fetchMenu]);

  // Detect the end of the visit: once closed, RLS hides the session row.
  useEffect(() => {
    const supabase = createClient();
    const check = async () => {
      const { data, error } = await supabase.from("table_sessions").select("id").eq("id", sessionId).maybeSingle();
      if (!error && !data) onEnded();
    };
    const id = setInterval(check, 30000);
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, onEnded]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  async function submit() {
    if (!menu || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    const items = cart.lines.map((l) => ({
      menu_item_id: l.menu_item_id,
      variation_id: l.variation_id,
      quantity: l.quantity,
      add_on_ids: l.add_on_ids,
      special_instructions: l.special_instructions || null,
    }));
    const { data, error } = await createClient().rpc("submit_order", {
      p_session_id: sessionId,
      p_items: items,
      p_idempotency_key: cart.key,
      p_note: cart.note || null,
    });
    setSubmitting(false);

    if (error) {
      if (error.message.includes("session_closed") || error.message.includes("forbidden")) {
        onEnded();
        return;
      }
      setSubmitError(friendlyError(error));
      if (/item_|variation|add_on/.test(error.message)) fetchMenu(); // refresh availability
      return;
    }
    const result = data as { order_number: string };
    setCart(() => ({ lines: [], note: "" }));
    setSheet(null);
    setTab("orders");
    setToast(`Order ${result.order_number} sent. Your waiter will confirm it shortly.`);
    reload();
  }

  const totals = menu ? cartTotals(cart.lines, menu.items, menu.taxes, menu.charges) : null;
  const count = cart.lines.reduce((n, l) => n + l.quantity, 0);
  const activeOrders = (orders ?? []).filter((o) => !["rejected", "cancelled", "served", "completed"].includes(o.status)).length;
  const sheetItem = sheet?.type === "item" ? menu?.items.get(sheet.itemId) : undefined;
  const editing = sheet?.type === "item" && sheet.editKey ? cart.lines.find((l) => l.key === sheet.editKey) : undefined;

  // One tap adds items that need no choices; anything with sizes or required
  // extras opens the item sheet instead.
  const canQuickAdd = (item: MenuItem) =>
    item.is_available &&
    item.variations.filter((v) => v.is_active).length <= 1 &&
    item.groups.every((g) => g.min_select === 0);
  const quickAdd = (item: MenuItem) => {
    const only = item.variations.find((v) => v.is_active);
    setCart((c) => ({
      ...c,
      lines: [
        ...c.lines,
        { key: newKey(), menu_item_id: item.id, variation_id: only?.id ?? null, add_on_ids: [], quantity: 1, special_instructions: "" },
      ],
    }));
    setToast(`${item.name} added`);
  };

  return (
    <div className="mx-auto min-h-screen max-w-lg pb-28">
      <Hero info={info} help={<ServicePanel sessionId={sessionId} onDark />} />

      <div className="sticky top-0 z-30 bg-bg/90 px-4 pb-2 pt-3 backdrop-blur-md">
        <div className="grid grid-cols-2 rounded-full bg-muted p-1" role="tablist">
          {(["menu", "orders"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-full py-2 text-sm font-semibold transition ${tab === t ? "bg-surface text-ink shadow-sm" : "text-ink-soft"}`}
            >
              {t === "menu" ? "🍕 Menu" : "🧾 My orders"}
              {t === "orders" && activeOrders > 0 && (
                <span className="ml-1.5 rounded-full bg-brand px-1.5 py-0.5 text-[10px] text-white">{activeOrders}</span>
              )}
            </button>
          ))}
        </div>
        {tab === "menu" && menu && menu.categories.length > 1 && (
          <nav className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" aria-label="Categories">
            {menu.categories.map((c) => (
              <a
                key={c.id}
                href={`#cat-${c.id}`}
                className="flex shrink-0 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 py-1.5 text-sm font-medium shadow-sm active:scale-95"
              >
                <span aria-hidden>{categoryIcon(c.name)}</span>
                {c.name}
              </a>
            ))}
          </nav>
        )}
      </div>

      <div className="px-4 pt-3">
        {tab === "orders" ? (
          <div className="space-y-4">
            <OrdersView orders={orders} reload={reload} money={money} onOrderMore={() => setTab("menu")} />
            <BillCard
              sessionId={sessionId}
              money={money}
              hasOrders={(orders ?? []).some((o) => !["rejected", "cancelled", "pending_confirmation", "on_hold"].includes(o.status))}
            />
          </div>
        ) : menuError ? (
          <div className="py-8 text-center">
            <p className="text-ink-soft">{menuError}</p>
            <button onClick={fetchMenu} className="mt-3 text-brand underline">
              Try again
            </button>
          </div>
        ) : !menu ? (
          <p className="py-8 text-center text-ink-soft">Loading the menu…</p>
        ) : menu.categories.length === 0 ? (
          <p className="py-8 text-center text-ink-soft">The menu is being prepared.</p>
        ) : (
          <div className="space-y-9">
            {(() => {
              const popular = menu.categories
                .flatMap((c) => c.items.map((i) => ({ ...i, categoryName: c.name })))
                .filter((i) => i.is_available && i.dietary_tags.some((t) => /popular|best/i.test(t)));
              if (popular.length < 2) return null;
              return (
                <section aria-label="Popular right now">
                  <h2 className="mb-3 flex items-center gap-2 text-lg font-bold">🔥 Popular right now</h2>
                  <ul className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none]">
                    {popular.map((i) => (
                      <li key={i.id} className="w-40 shrink-0 snap-start">
                        <FeaturedCard
                          item={i}
                          category={i.categoryName}
                          money={money}
                          onOpen={() => setSheet({ type: "item", itemId: i.id })}
                          onQuickAdd={canQuickAdd(i) ? () => quickAdd(i) : undefined}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })()}

            {menu.categories.map((c) => (
              <section key={c.id} id={`cat-${c.id}`} className="scroll-mt-36">
                <h2 className="flex items-center gap-2 text-xl font-bold">
                  <span aria-hidden>{categoryIcon(c.name)}</span>
                  {c.name}
                  <span className="text-sm font-normal text-ink-soft">· {c.items.length}</span>
                </h2>
                {c.description && <p className="mt-0.5 text-sm text-ink-soft">{c.description}</p>}
                <ul className="mt-3 space-y-3">
                  {c.items.map((i) => (
                    <li key={i.id}>
                      <ItemCard
                        item={i}
                        category={c.name}
                        money={money}
                        onOpen={() => setSheet({ type: "item", itemId: i.id })}
                        onQuickAdd={canQuickAdd(i) ? () => quickAdd(i) : undefined}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>

      {count > 0 && totals && !sheet && (
        <div className="fixed inset-x-0 bottom-0 z-40 mx-auto max-w-lg p-4">
          <button onClick={() => setSheet({ type: "cart" })} className={`${btnPrimary} w-full justify-between !py-3.5 text-base shadow-lg`}>
            <span className="rounded-md bg-white/20 px-2 py-0.5 text-sm tabular-nums">{count}</span>
            <span>View order</span>
            <span className="tabular-nums">{money.format(totals.subtotal)}</span>
          </button>
        </div>
      )}

      {toast && (
        <div role="status" className="fixed inset-x-0 top-4 z-50 mx-auto w-[calc(100%-2rem)] max-w-md rounded-xl bg-ink px-4 py-3 text-sm text-bg shadow-lg">
          {toast}
        </div>
      )}

      {sheet?.type === "item" && sheetItem && (
        <ItemSheet
          key={sheet.editKey ?? sheet.itemId}
          item={sheetItem}
          category={menu?.categories.find((c) => c.id === sheetItem.category_id)?.name}
          editing={editing}
          money={money}
          onClose={() => setSheet(editing ? { type: "cart" } : null)}
          onSave={(line) => {
            setCart((c) => ({
              ...c,
              lines: editing
                ? c.lines.map((l) => (l.key === editing.key ? { ...line, key: l.key } : l))
                : [...c.lines, { ...line, key: newKey() }],
            }));
            setSheet(editing ? { type: "cart" } : null);
            if (!editing) setToast(`${sheetItem.name} added`);
          }}
        />
      )}

      {sheet?.type === "cart" && menu && (
        <CartSheet
          lines={cart.lines}
          menu={menu}
          money={money}
          note={cart.note}
          error={submitError}
          submitting={submitting}
          onNote={(note) => setCart((c) => ({ ...c, note }))}
          onQuantity={(key, quantity) => setCart((c) => ({ ...c, lines: c.lines.map((l) => (l.key === key ? { ...l, quantity } : l)) }))}
          onRemove={(key) => setCart((c) => ({ ...c, lines: c.lines.filter((l) => l.key !== key) }))}
          onEdit={(key) => {
            const line = cart.lines.find((l) => l.key === key);
            if (line) setSheet({ type: "item", itemId: line.menu_item_id, editKey: key });
          }}
          onSubmit={submit}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  );
}

// --- Menu presentation ------------------------------------------------------

const TAG_STYLE: [RegExp, string, string][] = [
  [/popular|best/i, "🔥 Popular", "bg-orange-100 text-orange-800 dark:bg-orange-950 dark:text-orange-200"],
  [/chef/i, "👨‍🍳 Chef's pick", "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200"],
  [/new/i, "✨ New", "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200"],
  [/spicy|hot/i, "🌶️ Spicy", "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"],
  [/veg/i, "🌱 Veg", "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200"],
  [/value|deal|save/i, "💰 Great value", "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200"],
];

function Badges({ tags, max = 3 }: { tags: string[]; max?: number }) {
  const shown = TAG_STYLE.filter(([re]) => tags.some((t) => re.test(t))).slice(0, max);
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map(([, label, cls]) => (
        <span key={label} className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls}`}>
          {label}
        </span>
      ))}
    </div>
  );
}

function priceFrom(item: MenuItem) {
  const deltas = item.variations.map((v) => Number(v.price_delta));
  return { from: Math.max(item.base_price + (deltas.length ? Math.min(...deltas) : 0), 0), sizes: deltas.length > 1 };
}

function Visual({ item, category, className }: { item: MenuItem; category: string; className: string }) {
  const photo = imageUrl(item.image_path);
  return photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={photo} alt="" loading="lazy" className={`${className} object-cover`} />
  ) : (
    <FoodArt name={item.name} category={category} className={className} />
  );
}

function AddButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="grid size-9 place-items-center rounded-full bg-brand text-xl font-bold leading-none text-white shadow-md ring-4 ring-surface transition active:scale-90"
    >
      +
    </button>
  );
}

function ItemCard({
  item,
  category,
  money,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  category: string;
  money: Intl.NumberFormat;
  onOpen: () => void;
  onQuickAdd?: () => void;
}) {
  const { from, sizes } = priceFrom(item);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
      className={`flex w-full cursor-pointer gap-3 rounded-2xl border border-line bg-surface p-3 text-left shadow-sm transition hover:shadow-md active:scale-[0.99] ${
        item.is_available ? "" : "opacity-55 grayscale"
      }`}
    >
      <div className="min-w-0 flex-1 py-0.5">
        <Badges tags={item.dietary_tags} max={2} />
        <p className="mt-1 font-semibold leading-snug">{item.name}</p>
        {item.description && <p className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-soft">{item.description}</p>}
        <p className="mt-2 text-[15px] font-bold tabular-nums text-brand">
          {sizes && <span className="mr-1 text-xs font-medium text-ink-soft">from</span>}
          {money.format(from)}
          {!item.is_available && <span className="ml-2 text-xs font-medium text-ink-soft">Sold out</span>}
        </p>
      </div>
      <div className="relative shrink-0">
        <Visual item={item} category={category} className="size-28 rounded-xl" />
        {item.is_available && (
          <span className="absolute -bottom-2 -right-2">
            <AddButton label={`Add ${item.name}`} onClick={onQuickAdd ?? onOpen} />
          </span>
        )}
      </div>
    </div>
  );
}

function FeaturedCard({
  item,
  category,
  money,
  onOpen,
  onQuickAdd,
}: {
  item: MenuItem;
  category: string;
  money: Intl.NumberFormat;
  onOpen: () => void;
  onQuickAdd?: () => void;
}) {
  const { from, sizes } = priceFrom(item);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpen()}
      className="flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-sm active:scale-[0.98]"
    >
      <div className="relative">
        <Visual item={item} category={category} className="aspect-square w-full" />
        <span className="absolute bottom-2 right-2">
          <AddButton label={`Add ${item.name}`} onClick={onQuickAdd ?? onOpen} />
        </span>
      </div>
      <div className="flex flex-1 flex-col p-2.5">
        <p className="line-clamp-2 text-sm font-semibold leading-snug">{item.name}</p>
        <p className="mt-auto pt-1 text-sm font-bold tabular-nums text-brand">
          {sizes && <span className="mr-1 text-[11px] font-medium text-ink-soft">from</span>}
          {money.format(from)}
        </p>
      </div>
    </div>
  );
}

function categoryIcon(name: string) {
  if (/side|snack|starter|appet/i.test(name)) return "🍟";
  if (/dessert|sweet/i.test(name)) return "🍫";
  return CATEGORY_ICON[foodKind(name, name)] ?? "🍽️";
}

function Hero({ info, help }: { info: JoinResult; help?: React.ReactNode }) {
  return (
    <header className="relative overflow-hidden bg-gradient-to-br from-orange-500 via-red-600 to-rose-700 px-5 pb-7 pt-6 text-white">
      <svg aria-hidden viewBox="0 0 200 200" className="pointer-events-none absolute -right-10 -top-12 size-56 opacity-20">
        <circle cx="100" cy="100" r="90" fill="#fde68a" />
        <circle cx="100" cy="100" r="76" fill="#fbbf24" />
        {[[70, 70], [130, 65], [140, 120], [85, 135], [55, 110], [105, 100]].map(([x, y]) => (
          <circle key={`${x}${y}`} cx={x} cy={y} r="11" fill="#b91c1c" />
        ))}
      </svg>
      <div className="relative flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/80">Welcome to</p>
          <h1 className="mt-1 text-3xl font-black leading-tight tracking-tight">{info.restaurant.name}</h1>
          {info.restaurant.description && <p className="mt-1 text-sm text-white/85">{info.restaurant.description}</p>}
          <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-white/20 px-3 py-1 text-sm font-semibold backdrop-blur">
            🪑 Table {info.table.table_number}
          </span>
        </div>
        <div className="shrink-0">{help}</div>
      </div>
    </header>
  );
}

function Header({ info }: { info: JoinResult }) {
  return (
    <header className="mb-4">
      <p className="text-sm font-semibold uppercase tracking-wide text-brand">{info.restaurant.name}</p>
      <h1 className="mt-1 text-2xl font-semibold">Table {info.table.table_number}</h1>
      {info.restaurant.description && <p className="mt-1 text-sm text-ink-soft">{info.restaurant.description}</p>}
    </header>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto min-h-screen max-w-lg px-4 py-8">{children}</main>;
}
