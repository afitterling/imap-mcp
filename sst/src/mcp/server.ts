import { tools, toolMap } from "./tools.js";

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "webmail-mcp", title: "Webmail MCP", version: "0.1.0" };

type Req = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
type Res = { jsonrpc: "2.0"; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const INSTRUCTIONS = [
  "This server connects to the user's real mail accounts over IMAP and SMTP.",
  "Call list_accounts first to discover which accounts exist, then pass an account label to the other tools.",
  "Sending mail and deleting messages are visible to other people — confirm with the user before calling send_message,",
  "or before flagging a message \\Deleted.",
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
