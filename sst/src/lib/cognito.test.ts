import "../test/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const rows: Record<string, any> = {};
mock.module("./db.js", {
  namedExports: {
    epoch: () => 1_000,
    doc: {
      send: async (cmd: any) => {
        const n = cmd.constructor.name;
        if (n === "PutCommand") { rows[cmd.input.Item.id] = cmd.input.Item; return {}; }
        if (n === "GetCommand") return { Item: rows[cmd.input.Key.id] };
        if (n === "DeleteCommand") { delete rows[cmd.input.Key.id]; return {}; }
        throw new Error("unexpected " + n);
      },
    },
  },
});
mock.module("@aws-sdk/client-cognito-identity-provider", {
  namedExports: {
    CognitoIdentityProviderClient: class { async send(cmd: any) {
      if (cmd.constructor.name === "ListUserPoolClientsCommand") return { UserPoolClients: [{ ClientId: "abc123", ClientName: "Web" }] };
      if (cmd.constructor.name === "DescribeUserPoolClientCommand") return { UserPoolClient: { ClientSecret: "s3cret" } };
      return {};
    } },
    ListUserPoolClientsCommand: class { constructor(public input: any) {} },
    DescribeUserPoolClientCommand: class { constructor(public input: any) {} },
    AdminDisableUserCommand: class {}, AdminEnableUserCommand: class {}, AdminUserGlobalSignOutCommand: class {},
    AdminGetUserCommand: class {}, AssociateSoftwareTokenCommand: class {}, VerifySoftwareTokenCommand: class {}, SetUserMFAPreferenceCommand: class {},
  },
});
const { pkcePair, beginLogin, takeLoginState, issuer, clientConfig } = await import("./cognito.js");

test("PKCE pair is S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.ok(verifier.length >= 43);
  assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
});

test("client is looked up by name once and cached", async () => {
  const a = await clientConfig();
  const b = await clientConfig();
  assert.deepEqual(a, { clientId: "abc123", clientSecret: "s3cret" });
  assert.equal(a, b);
  assert.equal(issuer(), "https://cognito-idp.eu-central-1.amazonaws.com/eu-central-1_TESTPOOL");
});

test("beginLogin stores single-use state and builds the managed-login URL", async () => {
  const { url, state } = await beginLogin("https://app.example/auth/callback", { next: "/app" });
  const u = new URL(url);
  assert.equal(u.origin, "https://webmail-mcp-test.auth.eu-central-1.amazoncognito.com");
  assert.equal(u.pathname, "/oauth2/authorize");
  assert.equal(u.searchParams.get("client_id"), "abc123");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("state"), state);
  const row = await takeLoginState(state);
  assert.equal(row?.next, "/app");
  assert.equal(row?.redirectUri, "https://app.example/auth/callback");
  assert.equal(createHash("sha256").update(row!.verifier).digest("base64url"), u.searchParams.get("code_challenge"));
  assert.equal(await takeLoginState(state), undefined, "state is single-use");
});

test("OAuth consent state carries the client's request through the round-trip", async () => {
  const { state } = await beginLogin("https://app.example/auth/callback", { oauth: { client_id: "c1", redirect_uri: "https://claude.ai/cb", code_challenge: "x" } });
  const row = await takeLoginState(state);
  assert.equal(row?.oauth?.client_id, "c1");
  assert.equal(row?.next, undefined);
});
