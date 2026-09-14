import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { eventsInWindow, eventFromIcs, normalizeFeedUrl, isPrivateAddress, assertPublicHost } from "./calendar.js";
import { buildVTimezone, zonedToUtc, offsetMinutes } from "./tz.js";

const FIXTURE = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//test//EN
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:single
DTSTART;TZID=Europe/Berlin:20260914T100000
DTEND;TZID=Europe/Berlin:20260914T110000
SUMMARY:Dentist
LOCATION:Main St
ORGANIZER;CN=Alex:mailto:alex@example.com
ATTENDEE;CN=Bob;PARTSTAT=ACCEPTED:mailto:bob@example.com
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
END:VALARM
END:VEVENT
BEGIN:VEVENT
UID:weekly
DTSTART;TZID=Europe/Berlin:20260907T090000
DTEND;TZID=Europe/Berlin:20260907T093000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=Europe/Berlin:20260921T090000
DTSTART;TZID=Europe/Berlin:20260921T100000
DTEND;TZID=Europe/Berlin:20260921T103000
SUMMARY:Standup (moved)
END:VEVENT
BEGIN:VEVENT
UID:allday
DTSTART;VALUE=DATE:20260920
DTEND;VALUE=DATE:20260921
SUMMARY:Holiday
END:VEVENT
END:VCALENDAR
`;

test("single event: zone conversion, attendees, alarm", () => {
  const evs = eventsInWindow(FIXTURE, new Date("2026-09-14T00:00:00Z"), new Date("2026-09-15T00:00:00Z"));
  const dentist = evs.find((e) => e.uid === "single")!;
  assert.equal(dentist.start, "2026-09-14T08:00:00.000Z"); // 10:00 CEST
  assert.equal(dentist.end, "2026-09-14T09:00:00.000Z");
  assert.equal(dentist.timezone, "Europe/Berlin");
  assert.equal(dentist.startLocal, "2026-09-14T10:00:00");
  assert.equal(dentist.allDay, false);
  assert.equal(dentist.organizer, "alex@example.com");
  assert.deepEqual(dentist.attendees, [{ email: "bob@example.com", name: "Bob", status: "ACCEPTED", role: undefined }]);
  assert.deepEqual(dentist.alarms, [{ minutesBefore: 15 }]);
});

test("recurrence expansion honours the window and exceptions", () => {
  const evs = eventsInWindow(FIXTURE, new Date("2026-09-01T00:00:00Z"), new Date("2026-09-30T00:00:00Z"));
  const standups = evs.filter((e) => e.uid === "weekly");
  assert.deepEqual(standups.map((e) => e.start), ["2026-09-07T07:00:00.000Z", "2026-09-14T07:00:00.000Z", "2026-09-21T08:00:00.000Z", "2026-09-28T07:00:00.000Z"]);
  assert.equal(standups[2].summary, "Standup (moved)");
  assert.ok(standups.every((e) => e.recurring && e.recurrenceId));
  const later = eventsInWindow(FIXTURE, new Date("2026-11-01T00:00:00Z"), new Date("2026-11-10T00:00:00Z")).filter((e) => e.uid === "weekly");
  assert.deepEqual(later.map((e) => e.start), ["2026-11-02T08:00:00.000Z", "2026-11-09T08:00:00.000Z"]); // CET after DST ends
});

test("all-day events and the instance cap", () => {
  const evs = eventsInWindow(FIXTURE, new Date("2026-09-19T00:00:00Z"), new Date("2026-09-22T00:00:00Z"));
  const holiday = evs.find((e) => e.uid === "allday")!;
  assert.equal(holiday.allDay, true);
  assert.equal(holiday.start, "2026-09-20");
  assert.equal(holiday.end, "2026-09-21");
  const capped = eventsInWindow(FIXTURE, new Date("2026-01-01T00:00:00Z"), new Date("2026-12-31T00:00:00Z"), {}, 3);
  assert.equal(capped.length, 3);
});

test("eventFromIcs picks the master of a recurring set", () => {
  const ev = eventFromIcs(FIXTURE)!;
  assert.equal(ev.uid, "single");
  assert.equal(ev.summary, "Dentist");
});

test("feed URL normalisation", () => {
  assert.equal(normalizeFeedUrl("webcal://example.com/cal.ics"), "https://example.com/cal.ics");
  assert.equal(normalizeFeedUrl(" https://example.com/x "), "https://example.com/x");
  assert.throws(() => normalizeFeedUrl("http://example.com/cal.ics"), /https/);
  assert.throws(() => normalizeFeedUrl("https://user:pw@example.com/cal.ics"), /Credentials/);
  assert.throws(() => normalizeFeedUrl("not a url"), /valid URL/);
});

test("SSRF guard", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:10.0.0.1"]) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "17.253.144.10", "2a00:1450:4001::1"]) assert.ok(!isPrivateAddress(ip), ip);
  await assert.rejects(assertPublicHost("localhost"), /Local hosts/);
  await assert.rejects(assertPublicHost("metadata.internal"), /Local hosts/);
  await assert.rejects(assertPublicHost("169.254.169.254"), /private/);
  await assertPublicHost("8.8.8.8");
});

test("zone arithmetic without a tz database", () => {
  assert.equal(offsetMinutes("Europe/Berlin", new Date("2026-07-01T00:00:00Z")), 120);
  assert.equal(offsetMinutes("Europe/Berlin", new Date("2026-01-01T00:00:00Z")), 60);
  assert.equal(zonedToUtc({ y: 2026, m: 9, d: 14, hh: 10, mm: 0 }, "Europe/Berlin").toISOString(), "2026-09-14T08:00:00.000Z");
  assert.equal(zonedToUtc({ y: 2026, m: 1, d: 14, hh: 10, mm: 0 }, "America/New_York").toISOString(), "2026-01-14T15:00:00.000Z");
});

test("synthesised VTIMEZONE carries EU and US rules, and none for fixed zones", () => {
  const berlin = buildVTimezone("Europe/Berlin", 2026);
  assert.match(berlin, /BEGIN:DAYLIGHT[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU[\s\S]*TZOFFSETTO:\+0200/);
  assert.match(berlin, /BEGIN:STANDARD[\s\S]*RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU[\s\S]*TZOFFSETTO:\+0100/);
  const ny = buildVTimezone("America/New_York", 2026);
  assert.match(ny, /BYMONTH=3;BYDAY=2SU/);
  assert.match(ny, /BYMONTH=11;BYDAY=1SU/);
  const tokyo = buildVTimezone("Asia/Tokyo", 2026);
  assert.ok(!tokyo.includes("DAYLIGHT"));
  assert.match(tokyo, /TZOFFSETTO:\+0900/);
});
