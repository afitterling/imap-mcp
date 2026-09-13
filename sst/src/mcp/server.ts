import { tools, toolMap } from "./tools.js";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "webmail-mcp", title: "Webmail MCP", version: "0.1.0" };

type Req = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
type Res = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const INSTRUCTIONS = [
  "This server connects to the user's real mail accounts over IMAP and SMTP.",
  "Call list_accounts first to discover which accounts exist, then pass an account label to the other tools.",
  "",
  "NOTHING YOU DO HERE SENDS MAIL BY ITSELF. send_message composes the message, saves it to the",
  "mailbox and queues it for the user to release by hand on the Webmail MCP admin page. You cannot",
  "approve it. So never tell the user a mail has been sent: say it is waiting for their approval,",
  "and point them at the admin page. Report what the tool result actually says, nothing more.",
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
  "Deleting messages and folders is visible to other people and often irreversible — confirm with the user",
  "before flagging a message \\Deleted or calling delete_folder.",
].join(" ");

async function dispatch(req: Req): Promise<Res | null> {
  const id = req.id ?? null;
  const ok = (result: unknown): Res => ({ jsonrpc: "2.0", id, result });

  switch (req.method) {
    case "initialize": {
      const asked = req.params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: tools.map(({ name, title, description, inputSchema }) => ({
          name,
          title,
          description,
          inputSchema,
        })),
      });
    case "tools/call": {
      const tool = toolMap.get(req.params?.name);
      if (!tool) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${req.params?.name}` } };
      }
      try {
        const result = await tool.handler(req.params?.arguments ?? {});
        // Tools returning binary or viewable content emit their own MCP blocks.
        if (result && typeof result === "object" && "__mcpContent" in result) {
          return ok({ content: (result as { __mcpContent: unknown[] }).__mcpContent, isError: false });
        }
        return ok({
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { result },
          isError: false,
        });
      } catch (err) {
        // Tool failures are reported in-band so the model can recover, not as JSON-RPC errors.
        return ok({
          content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
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

/** Handle one Streamable HTTP POST body (single message or batch). Returns null for notification-only bodies. */
export async function handleRpc(body: unknown): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => dispatch(m as Req)))).filter(Boolean);
    return out.length ? out : null;
  }
  return dispatch(body as Req);
}
