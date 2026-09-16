import "../test/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate, validate, refusal, type Guardrail } from "./guardrails.js";

const rule = (p: Partial<Guardrail>): Guardrail => ({ id: "r1", text: "t", tools: [], mode: "remind", enabled: true, createdAt: "", updatedAt: "", ...p });

test("block refuses regardless of acknowledgement", () => {
  const v = evaluate([rule({ mode: "block", tools: ["delete_event"] })], "delete_event", ["r1"]);
  assert.equal(v.ok, false);
  if (!v.ok) assert.equal(v.reason, "blocked");
  assert.ok(evaluate([rule({ mode: "block", tools: ["delete_event"] })], "list_events", []).ok);
});

test("confirm refuses until acknowledged, then reminds", () => {
  const r = rule({ mode: "confirm", tools: ["send_message"] });
  const first = evaluate([r], "send_message", undefined);
  assert.equal(first.ok, false);
  if (!first.ok) assert.equal(first.reason, "unacknowledged");
  const second = evaluate([r], "send_message", ["r1"]);
  assert.ok(second.ok);
  if (second.ok) assert.deepEqual(second.reminders.map((x) => x.id), ["r1"]);
});

test("remind never refuses; disabled rules are ignored; empty tools = all", () => {
  const v = evaluate([rule({ mode: "remind" }), rule({ id: "off", mode: "block", enabled: false })], "search_messages", []);
  assert.ok(v.ok);
  if (v.ok) assert.deepEqual(v.reminders.map((x) => x.id), ["r1"]);
});

test("validate trims, caps, filters unknown tools and defaults mode", () => {
  const known = new Set(["send_message"]);
  const v = validate({ text: "  ask me  ", tools: ["send_message", "nope"], mode: "weird" as any }, known);
  assert.deepEqual(v, { text: "ask me", tools: ["send_message"], mode: "remind", enabled: true });
  assert.throws(() => validate({ text: " " }, known), /required/);
  assert.throws(() => validate({ text: "x".repeat(601) }, known), /600/);
});

test("refusal text names the rule ids and the ack argument", () => {
  const v = evaluate([rule({ id: "abc", mode: "confirm", text: "Ask first" })], "send_message", []);
  assert.equal(v.ok, false);
  if (!v.ok) {
    const t = refusal(v);
    assert.match(t, /\[abc\]/);
    assert.match(t, /guardrails_ack: \["abc"\]/);
  }
});
