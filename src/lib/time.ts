/** "2026-11-22" + "19:30" as wall-clock time in `timeZone` → UTC ISO string. */
export function zonedToUtc(date: string, time: string, timeZone: string): string {
  const guess = new Date(`${date}T${time}:00Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const asZoned = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess.getTime() - (asZoned - guess.getTime())).toISOString();
}

/** Today's date (YYYY-MM-DD) in `timeZone`. */
export function todayIn(timeZone: string, offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(Date.now() + offsetDays * 86400000));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Wall-clock date and time of an instant in `timeZone`, for form inputs. */
export function toZonedParts(iso: string, timeZone: string): { date: string; time: string } {
  const d = new Date(iso);
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone }).format(d),
    time: new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d),
  };
}
