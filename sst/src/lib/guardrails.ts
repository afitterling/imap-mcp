import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import { randomUUID } from "node:crypto";
import { doc } from "./db.js";

const TABLE = () => Resource.OAuth.name;

/**
 * remind  — shown to the model in the server instructions and on every matching result
 * confirm — a matching call is refused until the model re-calls with guardrails_ack: [id]
 * block   — matching calls are always refused
 */
export type GuardrailMode = "remind" | "confirm" | "block";

export type Guardrail = {
  id: string;
  text: string;
  /** Tool names this applies to; empty = every tool. */
  tools: string[];
  mode: GuardrailMode;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export const MAX_RULES = 30;
export const MAX_TEXT = 600;

export async function listGuardrails(userId: string): Promise<Guardrail[]> {
  const res = await doc.send(new GetCommand({ TableName: TABLE(), Key: { id: `config#guardrails#${userId}` } }));
  return ((res.Item?.rules as Guardrail[] | undefined) ?? []).slice();
}

async function save(userId: string, rules: Guardrail[]): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE(), Item: { id: `config#guardrails#${userId}`, userId, rules } }));
}

export function validate(input: Partial<Guardrail>, knownTools: Set<string>): Pick<Guardrail, "text" | "tools" | "mode" | "enabled"> {
  const text = String(input.text ?? "").trim();
  if (!text) throw new Error("The rule text is required.");
  if (text.length > MAX_TEXT) throw new Error(`Rule text may be at most ${MAX_TEXT} characters.`);
  const tools = Array.isArray(input.tools) ? input.tools.map(String).filter((t) => knownTools.has(t)) : [];
  const mode = input.mode === "confirm" || input.mode === "block" ? input.mode : "remind";
  return { text, tools, mode, enabled: input.enabled !== false };
}

export async function upsertGuardrail(userId: string, input: Partial<Guardrail>, knownTools: Set<string>): Promise<Guardrail> {
  const rules = await listGuardrails(userId);
  const valid = validate(input, knownTools);
  const now = new Date().toISOString();
  const idx = input.id ? rules.findIndex((r) => r.id === input.id) : -1;
  if (idx === -1) {
    if (rules.length >= MAX_RULES) throw new Error(`At most ${MAX_RULES} guardrails.`);
    const rule: Guardrail = { id: randomUUID().slice(0, 8), ...valid, createdAt: now, updatedAt: now };
    rules.push(rule);
    await save(userId, rules);
    return rule;
  }
  rules[idx] = { ...rules[idx], ...valid, updatedAt: now };
  await save(userId, rules);
  return rules[idx];
}

export async function deleteGuardrail(userId: string, id: string): Promise<boolean> {
  const rules = await listGuardrails(userId);
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) return false;
  await save(userId, next);
  return true;
}

/* ------------------------------- evaluation ------------------------------- */

export const applies = (r: Guardrail, tool: string) => r.enabled && (r.tools.length === 0 || r.tools.includes(tool));

export type Verdict =
  | { ok: true; reminders: Guardrail[] }
  | { ok: false; reason: "blocked" | "unacknowledged"; rules: Guardrail[]; reminders: Guardrail[] };

/**
 * Decide whether a tool call may proceed. `ack` is the model's guardrails_ack argument:
 * the ids of confirm-rules it states it has read and followed.
 */
export function evaluate(rules: Guardrail[], tool: string, ack: unknown): Verdict {
  const active = rules.filter((r) => applies(r, tool));
  const acked = new Set(Array.isArray(ack) ? ack.map(String) : []);
  const blocked = active.filter((r) => r.mode === "block");
  if (blocked.length) return { ok: false, reason: "blocked", rules: blocked, reminders: [] };
  const pending = active.filter((r) => r.mode === "confirm" && !acked.has(r.id));
  const reminders = active.filter((r) => r.mode !== "block");
  if (pending.length) return { ok: false, reason: "unacknowledged", rules: pending, reminders };
  return { ok: true, reminders };
}

export function describe(rules: Guardrail[]): string {
  return rules.map((r) => `[${r.id}] (${r.mode}${r.tools.length ? `; ${r.tools.join(", ")}` : ""}) ${r.text}`).join("\n");
}

/** Text the model sees when a call is refused. */
export function refusal(v: Extract<Verdict, { ok: false }>): string {
  if (v.reason === "blocked") {
    return `Refused by the user's guardrails — this action is not allowed:\n${describe(v.rules)}\nDo not retry. Tell the user which rule applies; they can change it under Guardrails in the app.`;
  }
  return `Stop: the user's guardrails require you to read and follow these rules before this action:\n${describe(v.rules)}\nComply with them (this may mean asking the user first or not proceeding). If the action is still right, call the tool again with guardrails_ack: [${v.rules.map((r) => `"${r.id}"`).join(", ")}].`;
}
