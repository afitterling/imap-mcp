import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv, type AuditRow } from "./audit.js";

test("csv escapes quotes, commas and newlines", () => {
  const rows: AuditRow[] = [
    { userId: "u1", kind: "mcp", action: "mcp.send_message", outcome: "success", ts: "t", day: "d", at: "2026-09-14T10:00:00.000Z", target: "Work", details: { subject: 'Re: "Q3", plan\nnext' }, client: "MacBook", durationMs: 42 },
  ];
  const csv = toCsv(rows);
  const [header, line] = csv.split("\n");
  assert.equal(header, "time,user,actor,kind,action,outcome,target,client,ip,durationMs,details");
  assert.ok(line.startsWith("2026-09-14T10:00:00.000Z,u1,,mcp,mcp.send_message,success,Work,MacBook,,42,"));
  // details are JSON inside a quoted cell: inner quotes doubled, the JSON's own escapes kept
  assert.ok(line.includes('""subject"":""Re: \\""Q3\\"", plan\\nnext""'));
  assert.ok(csv.endsWith("\n"));
});
