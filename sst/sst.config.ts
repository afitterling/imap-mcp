/// <reference path="./.sst/platform/config.d.ts" />

const PROJECT = "webmail-mcp";

export default $config({
  app(input) {
    return {
      name: PROJECT,
      removal: input?.stage === "production" ? "retain" : "remove",
      //protect: input?.stage === "production",
      home: "aws",
      providers: {
        aws: {
          region: "eu-central-1",
          // Every resource carries the project definition.
          defaultTags: { tags: { Project: PROJECT, Stage: input?.stage ?? "unknown", ManagedBy: "SST" } },
        },
      },
    };
  },
  async run() {
    const logging = { retention: "1 month" as const, format: "json" as const };

    /* ------------------------------- identity ------------------------------- */

    // Sign-up is limited to the allowlist in src/lib/allowlist.ts; the trigger refuses everyone else.
    const preSignUp = new sst.aws.Function("PreSignUp", { handler: "src/triggers/pre-signup.handler", logging });

    // Users authenticate through Cognito's managed login: email + password + mandatory MFA (authenticator app).
    const auth = new sst.aws.CognitoUserPool("Auth", {
      usernames: ["email"],
      mfa: "on",
      softwareToken: true,
      triggers: { preSignUp: preSignUp.arn },
      domain: { prefix: `${PROJECT}-${$app.stage}` },
      transform: {
        userPool: (args, opts) => {
          // Cognito cannot change attribute schemas in place; a schema change must recreate the
          // pool (users then sign up again; the app re-keys their data by e-mail). Production has
          // deletion protection, so this can never fire there by accident.
          opts.replaceOnChanges = ["schemas"];
          opts.deleteBeforeReplace = true;
          args.passwordPolicy = {
            minimumLength: 12,
            requireLowercase: true,
            requireUppercase: true,
            requireNumbers: true,
            requireSymbols: true,
            temporaryPasswordValidityDays: 7,
          };
          args.accountRecoverySetting = { recoveryMechanisms: [{ name: "verified_email", priority: 1 }] };
          args.deletionProtection = $app.stage === "production" ? "ACTIVE" : "INACTIVE";
          args.schemas = [
            { name: "email", attributeDataType: "String", required: true, mutable: true, stringAttributeConstraints: { minLength: "3", maxLength: "254" } },
            { name: "name", attributeDataType: "String", required: false, mutable: true, stringAttributeConstraints: { minLength: "0", maxLength: "100" } },
          ];
        },
      },
    });

    /* --------------------------------- data --------------------------------- */

    // Profile mirror of the Cognito user (role, status, last sign-in) keyed by the Cognito `sub`.
    const users = new sst.aws.Dynamo("Users", {
      fields: { userId: "string", email: "string" },
      primaryIndex: { hashKey: "userId" },
      globalIndexes: { byEmail: { hashKey: "email" } },
    });

    // Mail account registry, one owner per account. Credentials are AES-256-GCM encrypted.
    const accounts = new sst.aws.Dynamo("Accounts", {
      fields: { accountId: "string", ownerId: "string" },
      primaryIndex: { hashKey: "accountId" },
      globalIndexes: { byOwner: { hashKey: "ownerId" } },
    });

    // Calendar sources (CalDAV collections and ICS feeds), one owner each.
    const calendars = new sst.aws.Dynamo("Calendars", {
      fields: { calendarId: "string", ownerId: "string" },
      primaryIndex: { hashKey: "calendarId" },
      globalIndexes: { byOwner: { hashKey: "ownerId" } },
    });

    // Generic key/value store: OAuth clients + grants, sessions, personal access tokens,
    // sign-in state, throttles, outbox and per-user settings. Rows carry `userId` so a
    // user's rows can be listed (and wiped) together.
    const oauth = new sst.aws.Dynamo("OAuth", {
      fields: { id: "string", userId: "string" },
      primaryIndex: { hashKey: "id" },
      globalIndexes: { byUser: { hashKey: "userId", rangeKey: "id" } },
      ttl: "expiresAt",
    });

    // Append-only audit trail, one year retention (also mirrored to CloudWatch Logs as JSON).
    const audit = new sst.aws.Dynamo("Audit", {
      fields: { userId: "string", ts: "string", day: "string" },
      primaryIndex: { hashKey: "userId", rangeKey: "ts" },
      globalIndexes: { byDay: { hashKey: "day", rangeKey: "ts" } },
      ttl: "expiresAt",
    });

    // Secrets: set with `sst secret set <name> <value>`
    const encryptionKey = new sst.Secret("EncryptionKey");

    /* -------------------------------- server -------------------------------- */

    const server = new sst.aws.Function("Server", {
      handler: "src/handler.handler",
      url: true,
      timeout: "60 seconds",
      memory: "1024 MB", // headroom for parsing messages with attachments
      logging,
      nodejs: { install: ["imapflow", "mailparser", "nodemailer", "tsdav", "ical.js", "qrcode"] },
      link: [users, accounts, calendars, oauth, audit, encryptionKey],
      // The pool is passed by id rather than linked so the function gets only the Cognito
      // actions it uses, instead of the link's cognito-idp:*.
      environment: { COGNITO_USER_POOL_ID: auth.id, COGNITO_DOMAIN: auth.domainUrl!, COGNITO_REGION: "eu-central-1" },
      permissions: [
        {
          // Only what the app does for the signed-in user itself; operator actions live in scripts/user.ts.
          actions: ["cognito-idp:ListUserPoolClients", "cognito-idp:DescribeUserPoolClient", "cognito-idp:AdminGetUser", "cognito-idp:AdminUserGlobalSignOut", "cognito-idp:AdminSetUserMFAPreference"],
          resources: [auth.arn],
        },
      ],
    });

    // The client's callback is the function URL, so the client is created after the function
    // and looked up at runtime by name (see src/lib/cognito.ts).
    auth.addClient("Web", {
      callbackUrls: [$interpolate`${server.url}auth/callback`],
      transform: {
        client: (args) => {
          args.allowedOauthFlows = ["code"];
          args.allowedOauthScopes = ["openid", "email", "profile"];
          args.generateSecret = true;
          args.logoutUrls = [server.url, $interpolate`${server.url}login`];
          args.supportedIdentityProviders = ["COGNITO"];
          args.preventUserExistenceErrors = "ENABLED";
          args.enableTokenRevocation = true;
          args.accessTokenValidity = 60;
          args.idTokenValidity = 60;
          args.refreshTokenValidity = 30;
          args.tokenValidityUnits = { accessToken: "minutes", idToken: "minutes", refreshToken: "days" };
        },
      },
    });

    return {
      url: server.url,
      mcp: $interpolate`${server.url}mcp`,
      app: $interpolate`${server.url}app`,
      login: auth.domainUrl,
    };
  },
});
