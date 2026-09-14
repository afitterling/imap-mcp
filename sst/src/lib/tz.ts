/**
 * Just enough time-zone support to write correct CalDAV events without a tz database:
 * convert a wall-clock time in an IANA zone to UTC, and synthesise a VTIMEZONE for the
 * zone (DST rules derived from the transitions Intl reports for the current year).
 */

export function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `tz` from UTC, in minutes, at the given instant. */
export function offsetMinutes(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - at.getTime()) / 60000);
}

/** "2026-09-14T10:00" in `tz` → the UTC instant. Handles the DST gap/overlap by iterating once. */
export function zonedToUtc(local: { y: number; m: number; d: number; hh: number; mm: number; ss?: number }, tz: string): Date {
  const naive = Date.UTC(local.y, local.m - 1, local.d, local.hh, local.mm, local.ss ?? 0);
  let guess = new Date(naive - offsetMinutes(tz, new Date(naive)) * 60000);
  guess = new Date(naive - offsetMinutes(tz, guess) * 60000);
  return guess;
}

const fmtOffset = (min: number) => `${min < 0 ? "-" : "+"}${String(Math.floor(Math.abs(min) / 60)).padStart(2, "0")}${String(Math.abs(min) % 60).padStart(2, "0")}`;

/** Find DST transitions in `year`: [{ at, from, to }]. Scans day by day, then refines to the hour. */
function transitions(tz: string, year: number): { at: Date; from: number; to: number }[] {
  const out: { at: Date; from: number; to: number }[] = [];
  let prev = offsetMinutes(tz, new Date(Date.UTC(year, 0, 1)));
  for (let day = 1; day <= 366; day++) {
    const t = new Date(Date.UTC(year, 0, day));
    if (t.getUTCFullYear() !== year) break;
    const off = offsetMinutes(tz, t);
    if (off !== prev) {
      // Narrow down to the hour within the previous day.
      let at = new Date(t.getTime() - 86400000);
      while (offsetMinutes(tz, at) === prev) at = new Date(at.getTime() + 3600000);
      out.push({ at, from: prev, to: off });
      prev = off;
    }
  }
  return out;
}

/** Ordinal-weekday rule ("second Sunday of March", "last Sunday of October") for a local date. */
function byDayRule(localDate: Date): string {
  const dow = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][localDate.getUTCDay()];
  const dom = localDate.getUTCDate();
  const daysInMonth = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, 0)).getUTCDate();
  const ordinal = dom + 7 > daysInMonth ? -1 : Math.ceil(dom / 7);
  return `FREQ=YEARLY;BYMONTH=${localDate.getUTCMonth() + 1};BYDAY=${ordinal}${dow}`;
}

const stamp = (d: Date) => d.toISOString().slice(0, 19).replace(/[-:]/g, "");

/**
 * A VTIMEZONE block for `tzid`. Zones without DST get a single STANDARD component; zones
 * with DST get STANDARD + DAYLIGHT with yearly BYDAY rules inferred from this year's
 * transitions — right for every EU/US-style zone, which is what a mailbox owner has.
 */
export function buildVTimezone(tzid: string, year = new Date().getUTCFullYear()): string {
  const tr = transitions(tzid, year);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  if (tr.length < 2) {
    const off = offsetMinutes(tzid, new Date(Date.UTC(year, 0, 1)));
    lines.push("BEGIN:STANDARD", `DTSTART:19700101T000000`, `TZOFFSETFROM:${fmtOffset(off)}`, `TZOFFSETTO:${fmtOffset(off)}`, "END:STANDARD");
  } else {
    for (const t of tr.slice(0, 2)) {
      const kind = t.to > t.from ? "DAYLIGHT" : "STANDARD";
      // The rule's DTSTART is the local wall-clock time just before the switch.
      const local = new Date(t.at.getTime() + t.from * 60000);
      lines.push(
        `BEGIN:${kind}`,
        `DTSTART:${stamp(local).replace(/^\d{4}/, "1970").replace(/T\d{6}$/, `T${stamp(local).slice(9)}`)}`,
        `RRULE:${byDayRule(local)}`,
        `TZOFFSETFROM:${fmtOffset(t.from)}`,
        `TZOFFSETTO:${fmtOffset(t.to)}`,
        `END:${kind}`,
      );
    }
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}
