import QRCode from "qrcode";

export interface ReceiptData {
  invoice: {
    invoice_number: string;
    status: string;
    subtotal: number;
    discount_total: number;
    tax_total: number;
    service_charge_total: number;
    total: number;
    amount_paid: number;
    amount_refunded: number;
    tax_breakdown: { name: string; rate: number; inclusive: boolean; amount: number }[];
    charge_breakdown: { name: string; amount: number }[];
    finalized_at: string | null;
    created_at: string;
  };
  restaurant: { name: string; address: string | null; phone: string | null; email: string | null; currency: string; timezone: string };
  table: string;
  items: { description: string; quantity: number; unit_price: number; line_total: number }[];
  discounts: { reason: string; amount: number }[];
  payments: { method: string; amount: number; payer: string | null; change: number | null; at: string }[];
  refunds: { amount: number; at: string }[];
}

const METHOD: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank transfer",
  digital_wallet: "Wallet",
  online_gateway: "Online",
};

/** 80 mm thermal-printer friendly receipt; also readable on a phone. */
export async function Receipt({ data, url }: { data: ReceiptData; url?: string }) {
  const { invoice: inv, restaurant: r } = data;
  const money = new Intl.NumberFormat("en", { style: "currency", currency: r.currency });
  const when = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short", timeZone: r.timezone });
  const outstanding = Number(inv.total) - Number(inv.amount_paid);
  const qr = url ? await QRCode.toString(url, { type: "svg", margin: 0, errorCorrectionLevel: "M" }) : null;

  return (
    <article className="receipt mx-auto w-full max-w-[80mm] bg-white p-4 font-mono text-[12px] leading-snug text-black">
      <header className="text-center">
        <p className="text-base font-bold">{r.name}</p>
        {r.address && <p>{r.address}</p>}
        {r.phone && <p>{r.phone}</p>}
        <p className="mt-2">
          {inv.invoice_number} · Table {data.table}
        </p>
        <p>{when.format(new Date(inv.finalized_at ?? inv.created_at))}</p>
      </header>

      <hr className="my-2 border-dashed border-black" />
      <table className="w-full">
        <tbody>
          {data.items.map((i, n) => (
            <tr key={n} className="align-top">
              <td className="pr-1">{i.quantity}×</td>
              <td className="w-full pr-1">{i.description}</td>
              <td className="whitespace-nowrap text-right">{money.format(Number(i.line_total))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <hr className="my-2 border-dashed border-black" />

      <dl className="space-y-0.5">
        <Line label="Subtotal" value={money.format(Number(inv.subtotal))} />
        {data.discounts.map((d, n) => (
          <Line key={n} label={d.reason} value={`−${money.format(Number(d.amount))}`} />
        ))}
        {inv.tax_breakdown.map((t) => (
          <Line key={t.name} label={`${t.name} ${Number(t.rate)}%${t.inclusive ? " incl." : ""}`} value={money.format(Number(t.amount))} />
        ))}
        {inv.charge_breakdown.map((c) => (
          <Line key={c.name} label={c.name} value={money.format(Number(c.amount))} />
        ))}
        <div className="flex justify-between pt-1 text-sm font-bold">
          <dt>TOTAL</dt>
          <dd>{money.format(Number(inv.total))}</dd>
        </div>
      </dl>

      {data.payments.length > 0 && (
        <>
          <hr className="my-2 border-dashed border-black" />
          <dl className="space-y-0.5">
            {data.payments.map((p, n) => (
              <div key={n}>
                <Line label={`${METHOD[p.method] ?? p.method}${p.payer ? ` (${p.payer})` : ""}`} value={money.format(Number(p.amount))} />
                {p.change ? <Line label="  Change" value={money.format(Number(p.change))} /> : null}
              </div>
            ))}
            {data.refunds.map((f, n) => (
              <Line key={`r${n}`} label="Refund" value={`−${money.format(Number(f.amount))}`} />
            ))}
          </dl>
        </>
      )}

      <p className="mt-3 text-center font-bold">
        {outstanding > 0.0049 ? `BALANCE DUE ${money.format(outstanding)}` : "PAID — THANK YOU!"}
      </p>
      {qr && (
        <div className="mt-3 flex flex-col items-center">
          <div className="w-24" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className="mt-1 text-[10px]">Scan for your digital receipt</p>
        </div>
      )}
    </article>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="whitespace-pre-wrap">{label}</dt>
      <dd className="whitespace-nowrap">{value}</dd>
    </div>
  );
}
