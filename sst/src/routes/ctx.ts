import type { Context } from "hono";
import { randomBytes } from "node:crypto";

export type Env = { Variables: { nonce: string } };
export type Ctx = Context<Env>;

export const origin = (c: Context) => new URL(c.req.url).origin;
export const ip = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0].trim();
export const ua = (c: Context) => c.req.header("user-agent")?.slice(0, 200);
export const newNonce = () => randomBytes(16).toString("base64url");

export async function form(c: Context): Promise<Record<string, string>> {
  const body = await c.req.parseBody();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
  return out;
}

export async function jsonBody<T = any>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (message: string) => new HttpError(400, message);
