# User acceptance test

Maps to PRD §12 *Acceptance Criteria*. Run on real devices: one phone (customer), one tablet
(waiter), one screen (kitchen), one computer (cashier/admin). Tick each line; note the order or
invoice number for anything that fails.

**Automated coverage:** every rule below is also checked in `npm test` (278 database checks) and,
against the live project, by `npm run e2e:live`. This checklist is about the experience on real
hardware and with real staff.

## Setup (admin)
- [ ] Sign in at `/login` as admin.
- [ ] **Settings:** name, currency, time zone, a tax, a service charge, discount limit.
- [ ] **Kitchen stations:** at least two (e.g. Grill, Bar).
- [ ] **Menu:** two categories; an item with options (sizes) and an extras group with a max; a photo.
- [ ] **Employees:** one waiter, one kitchen (assigned to Grill), one cashier, one manager.
- [ ] **Tables & QR:** three tables; assign the waiter; print QR codes.

## Customer ordering
- [ ] Scan a QR code before the table is seated → "a member of staff will seat you".
- [ ] Waiter seats the table on **Floor** → the customer page opens the menu by itself.
- [ ] Correct restaurant and table number shown.
- [ ] Open an item, choose an option and extras; the price updates. Exceeding the extras max isn't possible.
- [ ] Add, change quantity, edit and remove cart items; estimated tax and service shown.
- [ ] Send the order → "Waiting for waiter"; double-tapping Send creates only one order.
- [ ] Mark an item unavailable in Admin → it can't be ordered (the cart flags it).

## Waiter
- [ ] New order chimes and appears under **Needs you** with items, options, extras, notes.
- [ ] **Ask customer** → the customer sees the question and replies → order returns to Needs you.
- [ ] **Reject** with a reason → customer sees "Rejected" and the reason; kitchen sees nothing.
- [ ] **Confirm** → order moves to In the kitchen.

## Kitchen
- [ ] Ticket appears (chime) only on the right station; a cook assigned to another station doesn't see it.
- [ ] Accept → Start cooking → mark one item Ready → waiter is notified.
- [ ] All ready → waiter sees it under **Ready to serve**.
- [ ] Report out of stock → item becomes unavailable on the menu and the waiter is told.

## Serving and cancellations
- [ ] Waiter can't serve items that aren't ready; serving ready items works; order shows Served for the customer.
- [ ] Cancel an item before cooking → cancelled at once and the kitchen is told.
- [ ] Cancel an item while cooking → manager sees an approval request; deny and approve both work.

## Tables
- [ ] Customer taps **Help → Water** → waiter sees it; "On my way" shows on the phone; Done clears it.
- [ ] Manager **moves** the party to another table → orders follow; the customer keeps ordering.
- [ ] **Merge** two tables → one bill; scanning the merged table's QR shows the combined orders.
- [ ] Closed table goes to **Cleaning**; **Mark clean** → Available.

## Billing and payments
- [ ] Customer taps **Request the bill** → cashier sees "Bill requested".
- [ ] **POS → Prepare bill**: all confirmed items, tax and service correct (check by hand once).
- [ ] Cashier discount within the limit works; above the limit is refused; manager can apply it.
- [ ] Coupon code from **Admin → Promotions** applies; an automatic promotion appears by itself.
- [ ] Cash without an open register is refused; open the register.
- [ ] Split **by items** for one person, **equally** for the rest; the last share clears the balance exactly.
- [ ] A declined card is recorded and the bill stays unpaid.
- [ ] Paid in full → print receipt (80 mm) → scan its QR → digital receipt opens on a phone.
- [ ] Customer sees "Paid", can open the receipt and leave stars.
- [ ] Refund as cashier → waits for manager; approve → shown on the bill and the receipt.
- [ ] Close table; close the register with the counted cash → difference shown; manager signs off.

## Reservations
- [ ] Create a booking for a table; a second overlapping booking for that table is refused.
- [ ] A party bigger than the table is refused.
- [ ] 30 minutes before, staff get a reminder and the table shows Reserved on the floor.
- [ ] **Seat Dana** on the floor → arrived; closing the visit → completed. Mark another as no-show.

## Access control
- [ ] Waiter opening `/admin` or `/pos` is sent to the staff home.
- [ ] Kitchen account can't open `/waiter`.
- [ ] Deactivated employee can't sign in.
- [ ] Old QR code stops working after **Regenerate**.

## Resilience
- [ ] Turn the waiter tablet's Wi-Fi off for a minute while an order is placed; turn it back on →
      the order appears without reloading (missed updates are fetched on reconnect).
- [ ] Close and reopen the customer's browser → cart and orders are still there.

Sign-off: ____________________  Date: __________
