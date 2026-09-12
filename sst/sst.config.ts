/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "webmail-mcp",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
      home: "aws",
      providers: { aws: { region: "eu-central-1" } },
    };
  },
  async run() {
    // Mail account registry. Credentials are stored encrypted (AES-256-GCM).
    const accounts = new sst.aws.Dynamo("Accounts", {
      fields: { accountId: "string" },
      primaryIndex: { hashKey: "accountId" },
    });

    // OAuth clients and short-lived authorization codes.
    const oauth = new sst.aws.Dynamo("OAuth", {
      fields: { id: "string" },
      primaryIndex: { hashKey: "id" },
      ttl: "expiresAt",
    });

    // Secrets: set with `sst secret set <name> <value>`
    const encryptionKey = new sst.Secret("EncryptionKey");
    const adminPassword = new sst.Secret("AdminPassword");
    const mcpToken = new sst.Secret("McpToken");

    const server = new sst.aws.Function("Server", {
      handler: "src/handler.handler",
      url: true,
      timeout: "60 seconds",
      memory: "512 MB",
      nodejs: { install: ["imapflow", "mailparser", "nodemailer"] },
      link: [accounts, oauth, encryptionKey, adminPassword, mcpToken],
    });

    return {
      url: server.url,
      mcp: $interpolate`${server.url}mcp`,
      admin: $interpolate`${server.url}admin`,
    };
  },
});
