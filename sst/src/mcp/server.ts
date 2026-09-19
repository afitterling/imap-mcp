import { tools, toolMap, type CallerContext } from "./tools.js";
import { audit } from "../lib/audit.js";
import { listGuardrails, evaluate, refusal, describe, type Guardrail } from "../lib/guardrails.js";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "webmail-mcp", title: "WebMail / Private Office MCP", version: "0.2.0" };

type Req = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
type Res = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const INSTRUCTIONS = [
  "This server connects to the user's own mail accounts over IMAP and SMTP. You only ever see the",
  "accounts of the person whose token you are using.",
  "Call list_accounts first to discover which accounts exist, then pass an account label to the other tools.",
  "",
  "Some accounts are READ-ONLY (list_accounts shows readOnly: true). On those you can list, search and",
  "read, but every tool that changes anything — sending, drafting, flagging, moving, archiving, folder",
  "changes, even marking a message read — is refused. Do not retry; tell the user the account is",
  "read-only and that they can change that in the WebMail / Private Office MCP app under Accounts.",
  "",
  "NOTHING YOU DO HERE SENDS MAIL BY ITSELF. send_message composes the message, saves it to the",
  "mailbox and queues it for the user to release by hand in the WebMail / Private Office MCP app (Outbox). You cannot",
  "approve it. So never tell the user a mail has been sent: say it is waiting for their approval,",
  "and point them at the app. Report what the tool result actually says, nothing more.",
  "",
  "Use create_draft whenever the user wants to look a message over, reply in their own words, or when",
  "recipients or wording are not settled. Drafts are the normal way to work here; send_message is for",
  "when the user has asked for the mail to go out.",
  "",
  "Write mail that reads well: short paragraphs, a clear first line, headings and lists where they help,",
  "and a real greeting and sign-off. Plain text is rendered into a formatted HTML mail automatically, so",
  "write normal prose with markdown-style structure rather than ASCII tables or columns padded with spaces.",
  "Never invent facts, commitments or dates in a message written on the user's behalf — if something is",
  "unknown, leave a clearly marked gap and tell the user what to fill in.",
  "",
  "CALENDARS: list_calendars shows the user's iCloud/CalDAV calendars and ICS subscriptions. ICS feeds and",
  "read-only calendars can only be read. When creating or changing events always work in the user's own",
  "time zone (ask if you do not know it) and repeat the date, time and zone back. Adding attendees makes the",
  "calendar server send invitation e-mails immediately — show the list and get explicit approval first.",
  "Deleting an event needs the same confirmation as deleting a folder.",
  "",
  "GUARDRAILS: the user may have written rules (see list_guardrails and the section below). Rules marked",
  "'confirm' refuse a matching call until you re-call it with guardrails_ack listing the rule ids — do that",
  "only after you have actually followed the rule. Rules marked 'block' cannot be overridden.",
  "",
  "LINKS: every message from search_messages and get_message carries a `link` that opens exactly that mail",
  "in the WebMail / Private Office web app (sign-in required, the user's own session). Whenever you put a",
  "mail somewhere the user will come back to — a to-do, a calendar note, a summary, a reminder — include",
  "that link so one tap shows the message. Search headers first (the default scope); switch to scope=body",
  "only when the subject, sender and recipients did not turn it up.",
  "",
  "Every tool call is recorded in the user's activity log. Deleting messages and folders is visible to",
  "other people and often irreversible — confirm with the user before flagging a message \\Deleted or",
  "calling delete_folder.",
].join(" ");

/** The few arguments worth keeping in the audit trail. Never bodies, never attachments. */
const AUDITED_ARGS = ["account", "calendar", "folder", "uid", "uids", "to", "cc", "bcc", "subject", "summary", "start", "end", "target", "path", "query", "scope", "from", "add", "remove", "markSeen", "limit", "rrule"];
const CALENDAR_TOOLS = new Set(["list_calendars", "list_events", "get_event", "create_event", "update_event", "delete_event"]);

function summarizeArgs(args: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const k of AUDITED_ARGS) {
    const v = args?.[k];
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.slice(0, 20).join(",") : typeof v === "object" ? "[object]" : (v as string | number | boolean);
  }
  // Invitations are consequential: keep how many were sent, never who.
  if (Array.isArray(args?.attendees)) out.attendees = args!.attendees.length;
  return out;
}

const ACK_PROP = {
  guardrails_ack: {
    type: "array",
    items: { type: "string" },
    description: "Ids of the user's 'confirm' guardrails you have read and followed for this call. Only needed when a call was refused with such a rule.",
  },
};

function withAck(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
  return { ...schema, properties: { ...props, ...ACK_PROP } };
}

async function dispatch(req: Req, ctx: CallerContext): Promise<Res | null> {
  const id = req.id ?? null;
  const ok = (result: unknown): Res => ({ jsonrpc: "2.0", id, result });

  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      const rules = (await listGuardrails(ctx.userId).catch(() => [])).filter((r) => r.enabled);
      const extra = rules.length ? ` USER GUARDRAILS (in effect for every call): ${describe(rules).replace(/\n/g, " | ")}` : "";
      return ok({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS + extra,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map(({ name, title, description, inputSchema, mutating, destructive }) => ({
          name,
          title,
          description,
          inputSchema: withAck(inputSchema),
          annotations: { title, readOnlyHint: !mutating, destructiveHint: destructive === true, openWorldHint: true },
        })),
      });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const tool = toolMap.get(name);
      if (!tool) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      }
      const { guardrails_ack: ack, ...args } = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const started = Date.now();
      const record = (outcome: "success" | "failure" | "denied", extra: Record<string, string | undefined> = {}) =>
        audit({
          userId: ctx.userId,
          kind: CALENDAR_TOOLS.has(name) ? "calendar" : "mcp",
          action: `mcp.${name}`,
          outcome,
          target: typeof args.account === "string" ? args.account : typeof args.calendar === "string" ? args.calendar : undefined,
          details: { ...summarizeArgs(args), ...extra, auth: ctx.auth },
          client: ctx.client,
          ip: ctx.ip,
          durationMs: Date.now() - started,
        });
      // The user's guardrails run before anything else, on every call.
      const verdict = evaluate(await listGuardrails(ctx.userId).catch(() => [] as Guardrail[]), name, ack);
      if (!verdict.ok) {
        await record("denied", { guardrail: verdict.rules.map((r) => r.id).join(","), reason: verdict.reason });
        return ok({ content: [{ type: "text", text: refusal(verdict) }], isError: true });
      }
      const banner = verdict.reminders.length ? `Guardrails in effect: ${describe(verdict.reminders).replace(/\n/g, " | ")}\n\n` : "";
      try {
        const result = await tool.handler(args, ctx);
        await record("success", verdict.reminders.length ? { guardrails: verdict.reminders.map((r) => r.id).join(",") } : {});
        // Tools returning binary or viewable content emit their own MCP blocks.
        if (result && typeof result === "object" && "__mcpContent" in result) {
          const blocks = (result as { __mcpContent: unknown[] }).__mcpContent;
          return ok({ content: banner ? [{ type: "text", text: banner.trim() }, ...blocks] : blocks, isError: false });
        }
        return ok({
          content: [{ type: "text", text: banner + JSON.stringify(result, null, 2) }],
          structuredContent: { result },
          isError: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await record(err instanceof ReadOnlyError ? "denied" : "failure", { error: message });
        // Tool failures are reported in-band so the model can recover, not as JSON-RPC errors.
        return ok({ content: [{ type: "text", text: `Error: ${message}` }], isError: true });
      }
    }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      // Notifications (no id) need no response.
      if (req.id === undefined) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

export { ReadOnlyError } from "./tools.js";
import { ReadOnlyError } from "./tools.js";

/** Handle one Streamable HTTP POST body (single message or batch). Returns null for notification-only bodies. */
export async function handleRpc(body: unknown, ctx: CallerContext): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => dispatch(m as Req, ctx)))).filter(Boolean);
    return out.length ? out : null;
  }
  return dispatch(body as Req, ctx);
}
