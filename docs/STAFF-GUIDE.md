# Staff guide

Everyone signs in at **/login** with the email and password the administrator gave them. On a
tablet, use *Add to Home Screen* so the app opens full-screen. Tap the 🔔 bell for notifications;
turn **Sound on** at the start of every shift.

---

## Waiter — `/waiter`

**Start of shift:** open *Waiter*, choose **My tables**, sound on.

| When | Do this |
|---|---|
| Guests arrive | **Floor** → the table → **Seat guests** (or **Seat _name_** for a booking). They can now scan the QR code. |
| Order chimes | It's under **Needs you**. Check it, then **Confirm & send to kitchen**. |
| Something's unclear | **More actions → Ask customer**. The order waits until they reply. |
| Can't accept it | **More actions → Reject order** with a reason the customer will read. |
| Food is ready (chime) | **Ready to serve** → take it out → **Served**. Serve part of it with *Serve selected*. |
| Customer changes their mind | **More actions → Cancel an item**. If the kitchen already started, a manager must approve. |
| Customer taps Help | It appears under **Customer requests** → **On my way** → **Done**. |
| Party wants to join another table | **Floor → Move or merge → Merge into table …** (one bill). |

Rules the system enforces: you can't serve food the kitchen hasn't marked ready, and nothing goes to
the kitchen until you confirm it.

## Kitchen — `/kitchen`

- Tickets show only your stations (pick another station at the top if you cover it).
- **New** → **Start cooking** → tap **Ready** on each item as it's plated, or **All ready**.
- Timers turn amber at 10 minutes and red at 20.
- **Problem? → Report out of stock** takes the dish off the menu immediately and tells the waiter.
- **Problem? → Message waiter** for questions about a ticket.
- Cancelled items show in red on the ticket — stop making them.

## Cashier — `/pos`

**Start of shift:** **Cash register → Open register** with the float in the drawer.

1. Tables asking for the bill are highlighted. Open one → **Prepare bill** (or **Open bill**).
2. Add a discount (with a reason) or a coupon code *before* taking payment — the first payment makes
   the bill final.
3. **Take payment**: Everything / Split equally / By items / Custom amount → method → for cash, type
   what you received to see the change → **Record payment**. Card declined? Tick *Card declined*.
4. When it says **Paid in full**: **Print receipt** → **Close table**.
5. **Refunds:** on the payment → *Refund*. A manager approves it.

**End of shift:** **Cash register** → count the drawer → **Close register**. Any difference goes to
the manager.

## Manager

Everything a waiter and cashier can do, plus:
- Approve item cancellations (top of *Waiter*) and refunds (top of *POS*).
- Discounts above the cashier limit; void a bill with no payments on it (reopens the table).
- **Floor → Move or merge → Move party** to another table.
- Close a table that can't pay, with a recorded reason.
- Sign off register counts (*Cash register*, *Sign off*).
- You're alerted when an order waits too long, a register doesn't balance, or a customer reports a problem.

## Reservations — `/reservations`

Waiters, cashiers and managers can take bookings. Pick a table if you can — the system refuses
double bookings and tables that are too small. Confirm, mark **No-show** or **Cancel booking** as
needed; seat the party from the **Floor**.

## Administrator — `/admin`

Menu, extras, stations, tables & QR codes, employees and roles, promotions, settings, customer
feedback and the audit log. Regenerating a table's QR code makes the printed one stop working —
reprint it straight away.
