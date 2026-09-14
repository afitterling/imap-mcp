import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { bodyLimit } from "hono/body-limit";
import { newNonce, origin, type Env } from "./ctx.js";

/**
 * Cross-cutting protections for the browser-facing surface. The MCP and OAuth token
 * endpoints are machine-to-machine and get their own CORS handling elsewhere.
 */
export function security(app: Hono<Env>) {
  app.use("*", async (c, next) => {
    c.set("nonce", newNonce());
    await next();
  });

  app.use(
    "*",
    secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: [(c) => `'nonce-${(c as any).get("nonce")}'`],
        styleSrc: [(c) => `'nonce-${(c as any).get("nonce")}'`],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'"],
        // Chrome applies form-action to the redirect after a POST, and the OAuth consent
        // form ends in a redirect to the client (https, or loopback for local tools).
        formAction: ["'self'", "https:", "http://localhost:*", "http://127.0.0.1:*"], // includes *.amazoncognito.com
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
      },
      strictTransportSecurity: "max-age=63072000; includeSubDomains",
      referrerPolicy: "no-referrer",
      xFrameOptions: "DENY",
      permissionsPolicy: { camera: [], microphone: [], geolocation: [], payment: [], usb: [] },
      crossOriginResourcePolicy: false,
      crossOriginOpenerPolicy: false,
    }),
  );

  // Attachments can be large but nothing a browser posts here should be.
  app.use("/api/*", bodyLimit({ maxSize: 256 * 1024 }));
  app.use("/login/*", bodyLimit({ maxSize: 16 * 1024 }));

  /**
   * CSRF: a state-changing request from a browser must come from this origin. Fetch
   * metadata is checked first; the Origin header second; and the JSON API additionally
   * needs a custom header, which no cross-site form can add.
   */
  app.use("*", async (c, next) => {
    const method = c.req.method;
    const path = new URL(c.req.url).pathname;
    // /oauth/authorize's POST only starts a Cognito sign-in for a client the consent page
    // already named; MCP clients open that page in popups and embedded views whose Origin
    // is unpredictable, and a forged POST buys nothing a plain link to the GET would not.
    const exempt =
      path === "/mcp" || path === "/oauth/authorize" || path.startsWith("/oauth/token") || path.startsWith("/oauth/register") || path.startsWith("/.well-known/");
    if (method === "GET" || method === "HEAD" || method === "OPTIONS" || exempt) return next();

    const refuse = (why: string) => {
      console.log(JSON.stringify({ type: "csrf", why, path, origin: c.req.header("origin"), site: c.req.header("sec-fetch-site"), expected: origin(c), ua: c.req.header("user-agent")?.slice(0, 80) }));
      return c.text(`${why} request refused.`, 403);
    };
    // Fetch metadata is authoritative when present: Safari sends "Origin: null" on same-origin
    // form posts under Referrer-Policy: no-referrer, so Origin is only the fallback.
    const site = c.req.header("sec-fetch-site");
    if (site) {
      if (site !== "same-origin" && site !== "none") return refuse("Cross-site");
      return next();
    }
    const from = c.req.header("origin");
    if (from && from !== "null" && from !== origin(c)) return refuse("Cross-origin");
    if (from === "null") return refuse("Cross-origin");
    if (path.startsWith("/api/") && c.req.header("x-requested-with") !== "fetch") return c.json({ error: "Missing request header." }, 403);
    return next();
  });
}
