export const INVOICE_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  partially_paid: "Partly paid",
  paid: "Paid",
  payment_failed: "Payment failed",
  refund_pending: "Refund pending",
  partially_refunded: "Partly refunded",
  refunded: "Refunded",
  void: "Void",
};

export const METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  bank_transfer: "Bank transfer",
  digital_wallet: "Digital wallet",
  online_gateway: "Online",
};
