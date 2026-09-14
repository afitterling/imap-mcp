import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";

const items: Record<string, any> = {
  c1: { calendarId: "c1", ownerId: "alice", label: "Work", kind: "caldav", calendarName: "Work", readOnly: false, pass: "enc" },
  c2: { calendarId: "c2", ownerId: "alice", label: "Holidays", kind: "ics", feedUrl: "https://x/y.ics", readOnly: false },
  d1: { calendarId: "d1", ownerId: "bob", label: "Work", kind: "caldav", calendarName: "Home", readOnly: false },
};
mock.module("./db.js", {
  namedExports: {
    epoch: () => 0,
    doc: {
      send: async (cmd: any) => {
        const name = cmd.constructor.name;
        if (name === "GetCommand") return { Item: items[cmd.input.Key.calendarId] };
        if (name === "QueryCommand") return { Items: Object.values(items).filter((i) => i.ownerId === cmd.input.ExpressionAttributeValues[":o"]) };
        throw new Error("unexpected " + name);
      },
    },
  },
});
const { resolveCalendar, listCalendars, redactCalendar, isReadOnly } = await import("./calstore.js");

test("calendars are owner-scoped by id, label and calendar name", async () => {
  assert.deepEqual((await listCalendars("alice")).map((c) => c.calendarId), ["c2", "c1"]);
  assert.equal((await resolveCalendar("c1", "alice")).label, "Work");
  assert.equal((await resolveCalendar("home", "bob")).calendarId, "d1");
  await assert.rejects(resolveCalendar("d1", "alice"), /No calendar matches/);
  await assert.rejects(resolveCalendar("holidays", "bob"), /No calendar matches/);
});

test("ICS feeds are read-only regardless of the flag, and secrets are redacted", () => {
  assert.equal(isReadOnly(items.c2), true);
  assert.equal(isReadOnly(items.c1), false);
  const pub = redactCalendar(items.c2);
  assert.equal(pub.readOnly, true);
  assert.ok(!("pass" in redactCalendar(items.c1)) && !("ownerId" in pub));
});
