import type { Context } from "hono";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Resource } from "sst";

export type Env = { Variables: { nonce: string } };
export type Ctx = Context<Env>;

/**
 * The secret CloudFront adds to every request it forwards (x-origin-verify). Undefined where
 * no edge is linked, i.e. in unit tests; every deployed stage has one.
 */
export function edgeSecret(): string | undefined {
  try {
    return (Resource as unknown as { OriginVerify?: { value?: string } }).OriginVerify?.value || undefined;
  } catch {
    return undefined;
  }
}

/** The request came through our CloudFront distribution (and so through the WAF). */
export function fromEdge(c: Context): boolean {
  const expected = edgeSecret();
  const got = c.req.header("x-origin-verify");
  if (!expected || !got) return false;
  const a = Buffer.from(got), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

/**
 * This server's public https origin, for links, OAuth metadata and Cognito redirects. Behind
 * CloudFront the request URL names the Lambda Function URL, so the public host comes from
 * x-forwarded-host — trusted only on requests the edge vouched for.
 */
export const origin = (c: Context) => {
  const forwarded = c.req.header("x-forwarded-host");
  if (forwarded && HOST.test(forwarded) && fromEdge(c)) return `https://${forwarded.toLowerCase()}`;
  return new URL(c.req.url).origin;
};
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
