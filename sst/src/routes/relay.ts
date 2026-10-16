import { Hono, type Context } from "hono";
import { z } from "zod";
import { type Env, HttpError, ip, ua } from "./ctx.js";
import { verifyRelayToken, relayConfig } from "../lib/cognito.js";
import { getUser } from "../lib/users.js";
import { hit, LIMITS, RateLimited } from "../lib/ratelimit.js";
import { audit, ANONYMOUS } from "../lib/audit.js";
import {
  upsertNotes,
  pruneNotes,
  countNotes,
  touchRelay,
  listNoteCreates,
  ackNoteCreate,
  wipeNotes,
  MAX_TITLE_CHARS,
  MAX_TEXT_CHARS,
} from "../lib/notestore.js";

/**
 * The Mac Notes relay (mac/NotesRelay) talks to these routes. It signs in through Cognito's
 * hosted UI with PKCE (MFA enforced by the pool) and sends its access token as a bearer;
 * the user is always the token's `sub`. No cookies, so no CSRF surface.
 */
export const relay = new Hono<Env>();

export const MAX_NOTES_PER_PUSH = 200;
const SYNCS_PER_HOUR = 240;

const iso = z.string().max(40).refine((v) => !Number.isNaN(new Date(v).getTime()), "not a date");
const device = z.string().trim().min(1).max(100);

export const pushSchema = z.object({
  device,
  notes: z
    .array(
      z.object({
        noteId: z.string().min(1).max(512),
        account: z.string().max(200),
        folder: z.string().max(200),
        title: z.string().max(MAX_TITLE_CHARS),
        text: z.string().max(MAX_TEXT_CHARS),
        created: iso.optional(),
        modified: iso,
      }),
    )
    .max(MAX_NOTES_PER_PUSH),
});
export const pruneSchema = z.object({ device, keep: z.array(z.string().min(1).max(512)).max(50_000) });
export const ackSchema = z.object({ ok: z.boolean(), error: z.string().max(300).optional() });

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, "Body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, `Invalid request: ${parsed.error.issues.map((i) => `${i.path.join(".") || "body"} ${i.message}`).join("; ").slice(0, 300)}`);
  return parsed.data;
}

/** The signed-in relay user, or 401. Failed attempts are throttled per IP and audited. */
async function relayUser(c: Context): Promise<{ userId: string; ip?: string; ua?: string }> {
  const header = c.req.header("authorization") ?? "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  const jwt = bearer ? await verifyRelayToken(bearer) : undefined;
  const user = jwt ? await getUser(jwt.sub) : undefined;
  if (!user || user.status !== "active") {
    const addr = ip(c) ?? "unknown";
    const allowed = await hit("relay-auth", addr, LIMITS.mcpAuthFailPerIp.limit, LIMITS.mcpAuthFailPerIp.window);
    await audit({ userId: ANONYMOUS, kind: "security", action: "relay.auth", outcome: "denied", details: { ratelimited: !allowed }, ip: addr, ua: ua(c) });
    if (!allowed) throw new RateLimited();
    throw new HttpError(401, "Sign in to the Notes relay again.");
  }
  if (!(await hit("relay-sync", user.userId, SYNCS_PER_HOUR, 3600))) throw new RateLimited("Too many relay requests; the next sync will catch up.");
  return { userId: user.userId, ip: ip(c), ua: ua(c) };
}

/** Public: lets the Mac app sign in knowing only the server URL. */
relay.get("/relay/config", (c) => c.json(relayConfig()));

relay.put("/relay/notes", async (c) => {
  const who = await relayUser(c);
  const b = await body(c, pushSchema);
  await upsertNotes(who.userId, b.notes);
  const total = await countNotes(who.userId);
  await touchRelay(who.userId, b.device, total);
  await audit({ ...who, kind: "notes", action: "notes.sync", outcome: "success", target: b.device, details: { pushed: b.notes.length, total } });
  return c.json({ stored: b.notes.length, total });
});

relay.post("/relay/notes/prune", async (c) => {
  const who = await relayUser(c);
  const b = await body(c, pruneSchema);
  const removed = await pruneNotes(who.userId, b.keep);
  const total = await countNotes(who.userId);
  await touchRelay(who.userId, b.device, total);
  await audit({ ...who, kind: "notes", action: "notes.prune", outcome: "success", target: b.device, details: { removed, total } });
  return c.json({ removed, total });
});

relay.get("/relay/notes/pending", async (c) => {
  const who = await relayUser(c);
  return c.json({ pending: await listNoteCreates(who.userId) });
});

relay.post("/relay/notes/pending/:id/ack", async (c) => {
  const who = await relayUser(c);
  const b = await body(c, ackSchema);
  const id = c.req.param("id");
  // A failed create is acknowledged too: retrying a note Notes.app refused would only repeat the failure.
  const found = await ackNoteCreate(who.userId, id);
  if (!found) throw new HttpError(404, "No such queued note.");
  await audit({ ...who, kind: "notes", action: "notes.create.done", outcome: b.ok ? "success" : "failure", details: { error: b.error } });
  return c.json({ acknowledged: true });
});

/** Signing out of the relay deletes what it synced; the web app has the same button. */
relay.delete("/relay/notes", async (c) => {
  const who = await relayUser(c);
  const removed = await wipeNotes(who.userId);
  await audit({ ...who, kind: "notes", action: "notes.disconnect", outcome: "success", details: { removed, via: "relay" } });
  return c.json({ removed });
});
