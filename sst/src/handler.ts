import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { type Env, HttpError } from "./routes/ctx.js";
import { security } from "./routes/security.js";
import { mcp } from "./routes/mcp.js";
import { oauth } from "./routes/oauth.js";
import { pages } from "./routes/pages.js";
import { api } from "./routes/api.js";
import { Unauthorized } from "./lib/sessions.js";
import { RateLimited } from "./lib/ratelimit.js";

const app = new Hono<Env>();

security(app);
app.route("/", mcp);
app.route("/", oauth);
app.route("/api", api);
app.route("/", pages);

app.notFound((c) => c.text("Not found", 404));

app.onError((err, c) => {
  const path = new URL(c.req.url).pathname;
  const wantsJson = path.startsWith("/api/") || path === "/mcp";
  if (err instanceof Unauthorized) return wantsJson ? c.json({ error: err.message }, 401) : c.redirect("/login");
  if (err instanceof RateLimited) return wantsJson ? c.json({ error: err.message }, 429) : c.text(err.message, 429);
  if (err instanceof HttpError) return wantsJson ? c.json({ error: err.message }, err.status as any) : c.text(err.message, err.status as any);
  // Anything else: log the detail, tell the client only that it failed.
  console.error("[handler]", err);
  return wantsJson ? c.json({ error: "Something went wrong." }, 500) : c.text("Something went wrong.", 500);
});

export const handler = handle(app);
