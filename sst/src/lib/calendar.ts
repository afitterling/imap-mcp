import ICAL from "ical.js";
import { createAccount, propfind, fetchCalendarObjects, createCalendarObject, updateCalendarObject, deleteCalendarObject, getBasicAuthHeaders, type DAVCalendar } from "tsdav";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { calendarPassword, type CalendarSource } from "./calstore.js";
import { buildVTimezone, isValidZone, zonedToUtc } from "./tz.js";

/* ------------------------------ normalised shape ------------------------------ */

export type Attendee = { email: string; name?: string; status?: string; role?: string };

export type CalendarEvent = {
  uid: string;
  summary: string;
  /** UTC instants, or plain YYYY-MM-DD dates for all-day events. */
  start: string;
  end: string;
  allDay: boolean;
  /** Wall-clock start as written in the event, with its zone, for people-friendly output. */
  startLocal?: string;
  timezone?: string;
  location?: string;
  description?: string;
  status?: string;
  recurring: boolean;
  rrule?: string;
  /** Set on expanded instances of a recurring event. */
  recurrenceId?: string;
  organizer?: string;
  attendees?: Attendee[];
  alarms?: { minutesBefore: number }[];
  lastModified?: string;
  sequence?: number;
  /** Where the object lives on the CalDAV server; needed to update or delete it. */
  href?: string;
  etag?: string;
};

export const MAX_WINDOW_DAYS = 366;
export const MAX_EVENTS = 200;
const MAX_INSTANCES = 500;

/* ---------------------------------- CalDAV ---------------------------------- */

function auth(src: CalendarSource) {
  if (src.kind !== "caldav" || !src.serverUrl || !src.username) throw new Error(`Calendar "${src.label}" is not a CalDAV source.`);
  const credentials = { username: src.username, password: calendarPassword(src) };
  return { credentials, headers: getBasicAuthHeaders(credentials) };
}

export type DiscoveredCalendar = { url: string; name: string; color?: string; readOnly: boolean; subscribed: boolean; components: string[] };

/**
 * Log in and list the calendar collections the account can see — including ones iCloud
 * exposes as subscriptions, which are read-only. Used by the setup dialog and "Test".
 */
export async function discoverCalendars(input: { serverUrl: string; username: string; password: string }): Promise<DiscoveredCalendar[]> {
  const credentials = { username: input.username, password: input.password };
  const headers = getBasicAuthHeaders(credentials);
  const account = await createAccount({ account: { serverUrl: input.serverUrl, credentials, accountType: "caldav" }, headers });
  if (!account.homeUrl) throw new Error("Signed in, but the server did not report a calendar home. Check the server URL.");
  const res = await propfind({
    url: account.homeUrl,
    depth: "1",
    headers,
    props: {
      "d:displayname": {},
      "d:resourcetype": {},
      "ca:calendar-color": {},
      "d:current-user-privilege-set": {},
      "c:supported-calendar-component-set": {},
      "cs:source": {},
    },
  });
  const out: DiscoveredCalendar[] = [];
  for (const r of res) {
    const types = Object.keys(r.props?.resourcetype ?? {});
    const subscribed = types.includes("subscribed");
    if (!types.includes("calendar") && !subscribed) continue;
    const comps = r.props?.supportedCalendarComponentSet?.comp;
    const components = (Array.isArray(comps) ? comps : comps ? [comps] : []).map((c: any) => c?._attributes?.name).filter(Boolean);
    if (components.length && !components.includes("VEVENT")) continue; // reminders / tasks-only collections
    const privs = r.props?.currentUserPrivilegeSet?.privilege;
    const privKeys = (Array.isArray(privs) ? privs : privs ? [privs] : []).flatMap((p: any) => Object.keys(p ?? {}));
    const canWrite = privKeys.length === 0 ? !subscribed : privKeys.some((k) => ["write", "writeContent", "all", "bind"].includes(k));
    const name = r.props?.displayname?._cdata ?? r.props?.displayname;
    out.push({
      url: new URL(r.href ?? "", account.rootUrl ?? input.serverUrl).href,
      name: typeof name === "string" && name ? name : "(unnamed)",
      color: typeof r.props?.calendarColor === "string" ? r.props.calendarColor : undefined,
      readOnly: !canWrite || subscribed,
      subscribed,
      components,
    });
  }
  if (!out.length) throw new Error("Signed in, but no calendars were found on this account.");
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function collection(src: CalendarSource): DAVCalendar {
  if (!src.calendarUrl) throw new Error(`Calendar "${src.label}" has no collection selected. Edit it and pick a calendar.`);
  return { url: src.calendarUrl };
}

/* ---------------------------------- parsing ---------------------------------- */

function registerZones(root: ICAL.Component): void {
  for (const tz of root.getAllSubcomponents("vtimezone")) {
    const tzid = tz.getFirstPropertyValue("tzid");
    if (typeof tzid === "string" && !ICAL.TimezoneService.has(tzid)) ICAL.TimezoneService.register(new ICAL.Timezone(tz), tzid);
  }
}

/** All-day values stay plain dates ("2026-09-20"); everything else becomes a UTC instant. */
const iso = (t: ICAL.Time) => (t.isDate ? t.toString() : t.toJSDate().toISOString());

function attendeesOf(ev: ICAL.Event): Attendee[] | undefined {
  const list = ev.attendees.map((p) => {
    const value = String(p.getFirstValue() ?? "");
    return {
      email: value.replace(/^mailto:/i, ""),
      name: (p.getParameter("cn") as string | undefined) || undefined,
      status: (p.getParameter("partstat") as string | undefined) || undefined,
      role: (p.getParameter("role") as string | undefined) || undefined,
    };
  });
  return list.length ? list : undefined;
}

function alarmsOf(vevent: ICAL.Component): { minutesBefore: number }[] | undefined {
  const out: { minutesBefore: number }[] = [];
  for (const a of vevent.getAllSubcomponents("valarm")) {
    const trig = a.getFirstPropertyValue("trigger");
    if (trig instanceof ICAL.Duration) out.push({ minutesBefore: -Math.round(trig.toSeconds() / 60) });
  }
  return out.length ? out : undefined;
}

function toEvent(ev: ICAL.Event, start: ICAL.Time, end: ICAL.Time, extra: Partial<CalendarEvent>): CalendarEvent {
  const vevent = ev.component;
  const rrule = vevent.getFirstPropertyValue("rrule");
  const status = vevent.getFirstPropertyValue("status");
  const lm = vevent.getFirstPropertyValue("last-modified");
  return {
    uid: ev.uid,
    summary: ev.summary ?? "(no title)",
    start: iso(start),
    end: iso(end),
    allDay: start.isDate,
    startLocal: start.isDate ? undefined : start.toString(),
    timezone: start.zone?.tzid && start.zone.tzid !== "floating" ? start.zone.tzid : undefined,
    location: ev.location || undefined,
    description: ev.description ? ev.description.slice(0, 20_000) : undefined,
    status: typeof status === "string" ? status : undefined,
    recurring: ev.isRecurring(),
    rrule: rrule ? String(rrule) : undefined,
    organizer: ev.organizer ? String(ev.organizer).replace(/^mailto:/i, "") : undefined,
    attendees: attendeesOf(ev),
    alarms: alarmsOf(vevent),
    lastModified: lm instanceof ICAL.Time ? iso(lm) : undefined,
    sequence: ev.sequence || undefined,
    ...extra,
  };
}

/**
 * Turn one iCalendar document into the event instances that fall inside [from, to].
 * Recurring masters are expanded (exceptions honoured); one-off events are filtered.
 */
export function eventsInWindow(ics: string, from: Date, to: Date, extra: Partial<CalendarEvent> = {}, cap = MAX_INSTANCES): CalendarEvent[] {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerZones(root);
  const out: CalendarEvent[] = [];
  const windowStart = ICAL.Time.fromJSDate(from, true);
  const windowEnd = ICAL.Time.fromJSDate(to, true);

  for (const vevent of root.getAllSubcomponents("vevent")) {
    if (out.length >= cap) break;
    if (vevent.hasProperty("recurrence-id")) continue; // exceptions are reached through their master
    const ev = new ICAL.Event(vevent, { strictExceptions: false });
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      const s = ev.startDate;
      const e = ev.endDate ?? s;
      if (e.compare(windowStart) < 0 || s.compare(windowEnd) > 0) continue;
      out.push(toEvent(ev, s, e, extra));
      continue;
    }
    const it = ev.iterator();
    let next: ICAL.Time | null | undefined;
    let n = 0;
    while ((next = it.next()) && out.length < cap && n++ < 10_000) {
      if (next.compare(windowEnd) > 0) break;
      const d = ev.getOccurrenceDetails(next);
      if (d.endDate.compare(windowStart) < 0) continue;
      const item = d.item as ICAL.Event;
      out.push(toEvent(item, d.startDate, d.endDate, { ...extra, recurring: true, recurrenceId: iso(d.recurrenceId), rrule: undefined }));
    }
  }
  return out;
}

/** The single event a document describes (master + exceptions), or undefined. */
export function eventFromIcs(ics: string, extra: Partial<CalendarEvent> = {}): CalendarEvent | undefined {
  const root = new ICAL.Component(ICAL.parse(ics));
  registerZones(root);
  const master = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id")) ?? root.getFirstSubcomponent("vevent");
  if (!master) return undefined;
  const ev = new ICAL.Event(master, { strictExceptions: false });
  return toEvent(ev, ev.startDate, ev.endDate ?? ev.startDate, extra);
}

/* ---------------------------------- reading ---------------------------------- */

export type ListArgs = { from?: string; to?: string; query?: string; limit?: number };

function window(args: ListArgs): { from: Date; to: Date } {
  const from = args.from ? new Date(args.from) : new Date();
  const to = args.to ? new Date(args.to) : new Date(from.getTime() + 14 * 86400000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error("from/to must be ISO 8601 dates.");
  if (to <= from) throw new Error("`to` must be after `from`.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * 86400000) throw new Error(`The window may span at most ${MAX_WINDOW_DAYS} days.`);
  return { from, to };
}

function finish(events: CalendarEvent[], args: ListArgs): CalendarEvent[] {
  const q = args.query?.trim().toLowerCase();
  const filtered = q
    ? events.filter((e) => [e.summary, e.location, e.description, ...(e.attendees ?? []).map((a) => `${a.name ?? ""} ${a.email}`)].some((s) => s?.toLowerCase().includes(q)))
    : events;
  return filtered.sort((a, b) => a.start.localeCompare(b.start)).slice(0, Math.min(args.limit ?? 50, MAX_EVENTS));
}

export async function listEvents(src: CalendarSource, args: ListArgs): Promise<CalendarEvent[]> {
  const { from, to } = window(args);
  if (src.kind === "ics") return finish(eventsInWindow(await fetchFeed(src), from, to), args);
  const { headers } = auth(src);
  const objects = await fetchCalendarObjects({ calendar: collection(src), headers, timeRange: { start: from.toISOString(), end: to.toISOString() } });
  const all: CalendarEvent[] = [];
  for (const o of objects) {
    if (typeof o.data !== "string") continue;
    all.push(...eventsInWindow(o.data, from, to, { href: o.url, etag: o.etag }));
  }
  return finish(all, args);
}

async function findObject(src: CalendarSource, uid: string) {
  const { headers } = auth(src);
  const objects = await fetchCalendarObjects({
    calendar: collection(src),
    headers,
    filters: [
      {
        "comp-filter": {
          _attributes: { name: "VCALENDAR" },
          "comp-filter": { _attributes: { name: "VEVENT" }, "prop-filter": { _attributes: { name: "UID" }, "text-match": { _attributes: { collation: "i;octet" }, _text: uid } } },
        },
      },
    ],
  });
  const hit = objects.find((o) => typeof o.data === "string" && o.data.includes(`UID:${uid}`)) ?? objects[0];
  if (!hit || typeof hit.data !== "string") throw new Error(`No event with uid ${uid} in "${src.label}".`);
  return { object: hit, headers };
}

export async function getEvent(src: CalendarSource, uid: string): Promise<CalendarEvent> {
  if (src.kind === "ics") {
    const root = new ICAL.Component(ICAL.parse(await fetchFeed(src)));
    registerZones(root);
    const v = root.getAllSubcomponents("vevent").find((c) => c.getFirstPropertyValue("uid") === uid && !c.hasProperty("recurrence-id"));
    if (!v) throw new Error(`No event with uid ${uid} in "${src.label}".`);
    const ev = new ICAL.Event(v, { strictExceptions: false });
    return toEvent(ev, ev.startDate, ev.endDate ?? ev.startDate, {});
  }
  const { object } = await findObject(src, uid);
  const ev = eventFromIcs(object.data, { href: object.url, etag: object.etag });
  if (!ev) throw new Error(`Object for uid ${uid} contains no event.`);
  return ev;
}

/* ---------------------------------- writing ---------------------------------- */

export type EventInput = {
  summary?: string;
  /** ISO 8601. With an offset or Z it is exact; without, it is wall-clock in `timezone`. */
  start?: string;
  end?: string;
  allDay?: boolean;
  timezone?: string;
  location?: string;
  description?: string;
  /** RFC 5545 RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO". Empty string removes it. */
  rrule?: string;
  remindMinutesBefore?: number | null;
  attendees?: { email: string; name?: string }[];
  status?: "CONFIRMED" | "TENTATIVE" | "CANCELLED";
};

type Parsed = { time: ICAL.Time; tzid?: string };

/** Accepts "2026-09-14" (all-day), "2026-09-14T10:00[:00]" (+ timezone), or a full ISO instant. */
function parseWhen(value: string, tz: string | undefined, allDay: boolean): Parsed {
  const v = value.trim();
  if (allDay) {
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) throw new Error(`"${value}" is not a date (YYYY-MM-DD).`);
    return { time: new ICAL.Time({ year: +m[1], month: +m[2], day: +m[3], isDate: true }, ICAL.Timezone.utcTimezone) };
  }
  const local = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local) {
    const zone = tz ?? "UTC";
    if (!isValidZone(zone)) throw new Error(`Unknown time zone "${zone}". Use an IANA name like Europe/Berlin.`);
    const t = new ICAL.Time({ year: +local[1], month: +local[2], day: +local[3], hour: +local[4], minute: +local[5], second: +(local[6] ?? 0), isDate: false }, ICAL.Timezone.localTimezone);
    if (zone === "UTC") {
      t.zone = ICAL.Timezone.utcTimezone;
      return { time: t };
    }
    return { time: t, tzid: zone };
  }
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`"${value}" is not an ISO 8601 date-time.`);
  if (tz && tz !== "UTC" && isValidZone(tz)) {
    // Exact instant, but shown in the requested zone so the wall-clock time survives DST.
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(d);
    const g = (k: string) => +parts.find((p) => p.type === k)!.value;
    return { time: new ICAL.Time({ year: g("year"), month: g("month"), day: g("day"), hour: g("hour"), minute: g("minute"), second: g("second"), isDate: false }, ICAL.Timezone.localTimezone), tzid: tz };
  }
  return { time: ICAL.Time.fromJSDate(d, true) };
}

function setTime(vevent: ICAL.Component, prop: "dtstart" | "dtend", p: Parsed): void {
  vevent.removeAllProperties(prop);
  const property = new ICAL.Property(prop);
  if (p.tzid) {
    // Register a synthesised zone so ical.js serialises TZID=… with a local time.
    if (!ICAL.TimezoneService.has(p.tzid)) {
      ICAL.TimezoneService.register(new ICAL.Timezone(new ICAL.Component(ICAL.parse(buildVTimezone(p.tzid)))), p.tzid);
    }
    p.time.zone = ICAL.TimezoneService.get(p.tzid)!;
    property.setParameter("tzid", p.tzid);
  }
  property.setValue(p.time);
  vevent.addProperty(property);
}

function applyInput(vevent: ICAL.Component, input: EventInput, existing?: CalendarEvent): string[] {
  const zones: string[] = [];
  const allDay = input.allDay ?? existing?.allDay ?? false;
  const tz = input.timezone ?? existing?.timezone;
  if (input.summary !== undefined) vevent.updatePropertyWithValue("summary", input.summary);
  if (input.location !== undefined) input.location ? vevent.updatePropertyWithValue("location", input.location) : vevent.removeAllProperties("location");
  if (input.description !== undefined) input.description ? vevent.updatePropertyWithValue("description", input.description) : vevent.removeAllProperties("description");
  if (input.status !== undefined) vevent.updatePropertyWithValue("status", input.status);

  if (input.start !== undefined || input.allDay !== undefined || input.timezone !== undefined) {
    const startSrc = input.start ?? existing?.start;
    if (!startSrc) throw new Error("`start` is required.");
    const s = parseWhen(startSrc, tz, allDay);
    setTime(vevent, "dtstart", s);
    if (s.tzid) zones.push(s.tzid);
  }
  if (input.end !== undefined || input.start !== undefined || input.allDay !== undefined || input.timezone !== undefined) {
    const startProp = vevent.getFirstPropertyValue("dtstart") as ICAL.Time;
    let e: Parsed;
    if (input.end) e = parseWhen(input.end, tz, allDay);
    else if (existing?.end && input.start === undefined) e = parseWhen(existing.end, tz, allDay);
    else {
      // Default length: one day for all-day events, one hour otherwise.
      const t = startProp.clone();
      if (allDay) t.addDuration(ICAL.Duration.fromSeconds(86400));
      else t.addDuration(ICAL.Duration.fromSeconds(3600));
      e = { time: t, tzid: startProp.zone?.tzid && startProp.zone.tzid !== "UTC" && startProp.zone.tzid !== "floating" ? startProp.zone.tzid : undefined };
    }
    if (e.time.compare(startProp) <= 0) throw new Error("`end` must be after `start`.");
    setTime(vevent, "dtend", e);
    if (e.tzid) zones.push(e.tzid);
  }

  if (input.rrule !== undefined) {
    vevent.removeAllProperties("rrule");
    if (input.rrule) {
      try {
        vevent.addPropertyWithValue("rrule", ICAL.Recur.fromString(input.rrule.replace(/^RRULE:/i, "")));
      } catch {
        throw new Error(`"${input.rrule}" is not a valid RRULE (example: FREQ=WEEKLY;BYDAY=MO;COUNT=10).`);
      }
    }
  }

  if (input.remindMinutesBefore !== undefined) {
    for (const a of vevent.getAllSubcomponents("valarm")) vevent.removeSubcomponent(a);
    if (input.remindMinutesBefore !== null && input.remindMinutesBefore >= 0) {
      const alarm = new ICAL.Component("valarm");
      alarm.addPropertyWithValue("action", "DISPLAY");
      alarm.addPropertyWithValue("description", "Reminder");
      const trig = new ICAL.Property("trigger", alarm);
      trig.setValue(ICAL.Duration.fromSeconds(-Math.round(input.remindMinutesBefore) * 60));
      alarm.addProperty(trig);
      vevent.addSubcomponent(alarm);
    }
  }

  if (input.attendees !== undefined) {
    vevent.removeAllProperties("attendee");
    for (const a of input.attendees) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.email)) throw new Error(`"${a.email}" is not an email address.`);
      const p = new ICAL.Property("attendee", vevent);
      p.setValue(`mailto:${a.email.trim()}`);
      if (a.name) p.setParameter("cn", a.name);
      p.setParameter("role", "REQ-PARTICIPANT");
      p.setParameter("partstat", "NEEDS-ACTION");
      p.setParameter("rsvp", "TRUE");
      vevent.addProperty(p);
    }
  }
  return zones;
}

function ensureOrganizer(vevent: ICAL.Component, src: CalendarSource): void {
  if (vevent.getAllProperties("attendee").length && !vevent.hasProperty("organizer") && src.username?.includes("@")) {
    const p = new ICAL.Property("organizer", vevent);
    p.setValue(`mailto:${src.username}`);
    vevent.addProperty(p);
  }
}

function serialize(root: ICAL.Component, vevent: ICAL.Component, zones: string[]): string {
  // Ship a VTIMEZONE for every zone the event references, as RFC 5545 requires.
  const have = new Set(root.getAllSubcomponents("vtimezone").map((c) => c.getFirstPropertyValue("tzid")));
  for (const z of new Set(zones)) {
    if (!have.has(z)) root.addSubcomponent(new ICAL.Component(ICAL.parse(buildVTimezone(z))));
  }
  vevent.updatePropertyWithValue("dtstamp", ICAL.Time.now());
  vevent.updatePropertyWithValue("last-modified", ICAL.Time.now());
  return root.toString();
}

export async function createEvent(src: CalendarSource, input: EventInput): Promise<CalendarEvent> {
  if (!input.summary?.trim()) throw new Error("`summary` is required.");
  if (!input.start) throw new Error("`start` is required.");
  const { headers } = auth(src);
  const uid = randomUUID();
  const root = new ICAL.Component(["vcalendar", [], []]);
  root.updatePropertyWithValue("prodid", "-//Private Office MCP//EN");
  root.updatePropertyWithValue("version", "2.0");
  const vevent = new ICAL.Component("vevent");
  vevent.updatePropertyWithValue("uid", uid);
  vevent.updatePropertyWithValue("created", ICAL.Time.now());
  vevent.updatePropertyWithValue("sequence", 0);
  root.addSubcomponent(vevent);
  const zones = applyInput(vevent, { status: "CONFIRMED", ...input });
  ensureOrganizer(vevent, src);
  const ics = serialize(root, vevent, zones);
  const res = await createCalendarObject({ calendar: collection(src), headers, filename: `${uid}.ics`, iCalString: ics });
  if (!res.ok) throw new Error(`The calendar server refused the event (${res.status} ${res.statusText}).`);
  const created = eventFromIcs(ics, { href: `${src.calendarUrl}${uid}.ics`, etag: res.headers.get("etag") ?? undefined });
  return created!;
}

export async function updateEvent(src: CalendarSource, uid: string, input: EventInput): Promise<CalendarEvent> {
  const { object, headers } = await findObject(src, uid);
  const existing = eventFromIcs(object.data, { href: object.url, etag: object.etag });
  const root = new ICAL.Component(ICAL.parse(object.data));
  registerZones(root);
  const vevent = root.getAllSubcomponents("vevent").find((v) => !v.hasProperty("recurrence-id")) ?? root.getFirstSubcomponent("vevent");
  if (!vevent) throw new Error(`Object for uid ${uid} contains no event.`);
  const zones = applyInput(vevent, input, existing);
  ensureOrganizer(vevent, src);
  vevent.updatePropertyWithValue("sequence", (Number(vevent.getFirstPropertyValue("sequence")) || 0) + 1);
  const ics = serialize(root, vevent, zones);
  // If-Match on the etag we read: a concurrent edit in Calendar.app makes this fail instead of being overwritten.
  const res = await updateCalendarObject({ calendarObject: { url: object.url, data: ics, etag: object.etag }, headers });
  if (res.status === 412) throw new Error("The event changed on the server while editing. Fetch it again and retry.");
  if (!res.ok) throw new Error(`The calendar server refused the update (${res.status} ${res.statusText}).`);
  return eventFromIcs(ics, { href: object.url, etag: res.headers.get("etag") ?? undefined })!;
}

export async function deleteEvent(src: CalendarSource, uid: string): Promise<{ uid: string; summary: string; deleted: true }> {
  const { object, headers } = await findObject(src, uid);
  const ev = eventFromIcs(object.data);
  const res = await deleteCalendarObject({ calendarObject: { url: object.url, etag: object.etag }, headers });
  if (!res.ok && res.status !== 404) throw new Error(`The calendar server refused the delete (${res.status} ${res.statusText}).`);
  return { uid, summary: ev?.summary ?? "", deleted: true };
}

/* ------------------------------------ ICS ------------------------------------ */

const MAX_FEED_BYTES = 5 * 1024 * 1024;

export function normalizeFeedUrl(input: string): string {
  const raw = input.trim().replace(/^webcal:\/\//i, "https://").replace(/^webcals:\/\//i, "https://");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new Error("Only https:// (or webcal://) feeds are supported.");
  if (url.username || url.password) throw new Error("Credentials in the URL are not supported.");
  return url.href;
}

/** Refuse anything that resolves to a private, loopback or link-local address (SSRF). */
export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Local hosts are not allowed.");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Could not resolve ${hostname}.`);
  for (const { address } of addrs) if (isPrivateAddress(address)) throw new Error("Feeds on private or local networks are not allowed.");
}

export function isPrivateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fe80:") || v.startsWith("fc") || v.startsWith("fd")) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]) : false;
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

export async function fetchFeed(src: CalendarSource): Promise<string> {
  if (!src.feedUrl) throw new Error(`Calendar "${src.label}" has no feed URL.`);
  const url = new URL(src.feedUrl);
  await assertPublicHost(url.hostname);
  const res = await fetch(url, {
    headers: { accept: "text/calendar, text/plain;q=0.5, */*;q=0.1", "user-agent": "webmail-mcp/0.2" },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status >= 300 && res.status < 400) throw new Error("The feed redirects; use the final URL instead.");
  if (!res.ok) throw new Error(`The feed returned ${res.status} ${res.statusText}.`);
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_FEED_BYTES) throw new Error("The feed is larger than 5 MB.");
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error("The feed is larger than 5 MB.");
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("The URL did not return an iCalendar document.");
  return text;
}

/** Setup-time check for either kind; returns a one-line status. */
export async function testCalendar(src: CalendarSource): Promise<{ status: string }> {
  if (src.kind === "ics") {
    const text = await fetchFeed(src);
    const root = new ICAL.Component(ICAL.parse(text));
    return { status: `OK — feed has ${root.getAllSubcomponents("vevent").length} events` };
  }
  const cals = await discoverCalendars({ serverUrl: src.serverUrl!, username: src.username!, password: calendarPassword(src) });
  const mine = cals.find((c) => c.url === src.calendarUrl);
  if (!mine) throw new Error(`Signed in, but the selected calendar was not found. Available: ${cals.map((c) => c.name).join(", ")}`);
  const upcoming = await listEvents(src, { limit: 1 });
  return { status: `OK — "${mine.name}"${mine.readOnly ? " (server says read-only)" : ""}, ${upcoming.length ? "has upcoming events" : "no events in the next 14 days"}` };
}
