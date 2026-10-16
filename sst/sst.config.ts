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
        // For the CloudFront origin secret; creates no AWS resources.
        random: "4.16.6",
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

    // iCloud notes as last pushed by the user's Mac relay (mac/NotesRelay): a snapshot of the
    // folders they chose to share, title and text encrypted with EncryptionKey. Rows the Mac
    // stops re-sending expire after 90 days.
    const notes = new sst.aws.Dynamo("Notes", {
      fields: { ownerId: "string", noteId: "string" },
      primaryIndex: { hashKey: "ownerId", rangeKey: "noteId" },
      ttl: "expiresAt",
    });

    // Secrets: set with `sst secret set <name> <value>`
    const encryptionKey = new sst.Secret("EncryptionKey");

    // The Mac Notes relay signs in as a native app: public client, authorization code + PKCE,
    // custom-scheme callback. Its access tokens are accepted only on /relay (src/lib/cognito.ts).
    const relayClient = auth.addClient("MacRelay", {
      callbackUrls: ["privateoffice-relay://callback"],
      transform: {
        client: (args) => {
          args.allowedOauthFlows = ["code"];
          args.allowedOauthScopes = ["openid", "email"];
          args.generateSecret = false;
          args.logoutUrls = ["privateoffice-relay://signed-out"];
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

    // The header CloudFront adds to every request it forwards. The server refuses requests
    // without it, so the Function URL cannot be used to step around the WAF.
    const originSecret = new random.RandomPassword("OriginVerifySecret", { length: 48, special: false });
    const originVerify = new sst.Linkable("OriginVerify", { properties: { value: originSecret.result } });

    /* -------------------------------- server -------------------------------- */

    const server = new sst.aws.Function("Server", {
      handler: "src/handler.handler",
      url: true,
      timeout: "60 seconds",
      memory: "1024 MB", // headroom for parsing messages with attachments
      logging,
      nodejs: { install: ["imapflow", "mailparser", "nodemailer", "tsdav", "ical.js", "qrcode"] },
      link: [users, accounts, calendars, oauth, audit, notes, encryptionKey, originVerify],
      // The pool is passed by id rather than linked so the function gets only the Cognito
      // actions it uses, instead of the link's cognito-idp:*.
      environment: { COGNITO_USER_POOL_ID: auth.id, COGNITO_DOMAIN: auth.domainUrl!, COGNITO_REGION: "eu-central-1", RELAY_CLIENT_ID: relayClient.id },
      permissions: [
        {
          // Only what the app does for the signed-in user itself; operator actions live in scripts/user.ts.
          actions: ["cognito-idp:ListUserPoolClients", "cognito-idp:DescribeUserPoolClient", "cognito-idp:AdminGetUser", "cognito-idp:AdminUserGlobalSignOut", "cognito-idp:AdminSetUserMFAPreference"],
          resources: [auth.arn],
        },
      ],
    });

    /* --------------------------------- edge --------------------------------- */

    // Everything public goes through CloudFront so the account's shared WAF (WAF202606: IP
    // blocklists, AWS managed rules, per-IP rate limits; /mcp is exempt from its POST limit)
    // sees every request. AWS-generated *.cloudfront.net domain, no custom domain yet.
    const usEast1 = new aws.Provider("UsEast1", { region: "us-east-1" });
    const waf = aws.wafv2.getWebAclOutput({ name: "WAF202606", scope: "CLOUDFRONT" }, { provider: usEast1 });

    // Nothing is cached (TTL 0, and the server answers no-store), but Authorization must be in
    // the cache key: otherwise CloudFront strips it from GET requests (the relay's GETs need it).
    const edgeCache = new aws.cloudfront.CachePolicy("EdgeCache", {
      name: `${PROJECT}-${$app.stage}-no-store`,
      minTtl: 0,
      defaultTtl: 0,
      maxTtl: 1,
      parametersInCacheKeyAndForwardedToOrigin: {
        headersConfig: { headerBehavior: "whitelist", headers: { items: ["Authorization"] } },
        cookiesConfig: { cookieBehavior: "all" },
        queryStringsConfig: { queryStringBehavior: "all" },
        enableAcceptEncodingGzip: true,
        enableAcceptEncodingBrotli: true,
      },
    });

    // The Function URL must see its own Host; the public one travels as x-forwarded-host and
    // is trusted by the server only together with the origin secret (src/routes/ctx.ts).
    const forwardHost = new aws.cloudfront.Function("EdgeForwardHost", {
      name: `${PROJECT}-${$app.stage}-forward-host`,
      runtime: "cloudfront-js-2.0",
      publish: true,
      code: [
        "function handler(event) {",
        "  var r = event.request;",
        "  r.headers['x-forwarded-host'] = { value: r.headers.host.value };",
        "  return r;",
        "}",
      ].join("\n"),
    });

    const edge = new aws.cloudfront.Distribution("Edge", {
      comment: `${PROJECT} ${$app.stage}`,
      enabled: true,
      isIpv6Enabled: true,
      httpVersion: "http2and3",
      priceClass: "PriceClass_100",
      webAclId: waf.arn,
      origins: [
        {
          originId: "server",
          domainName: server.url.apply((u) => new URL(u).host),
          customOriginConfig: { httpPort: 80, httpsPort: 443, originProtocolPolicy: "https-only", originSslProtocols: ["TLSv1.2"], originReadTimeout: 60, originKeepaliveTimeout: 5 },
          customHeaders: [{ name: "x-origin-verify", value: originSecret.result }],
        },
      ],
      defaultCacheBehavior: {
        targetOriginId: "server",
        viewerProtocolPolicy: "redirect-to-https",
        allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        cachedMethods: ["GET", "HEAD"],
        cachePolicyId: edgeCache.id,
        // Managed AllViewerExceptHostHeader: everything from the viewer except Host.
        originRequestPolicyId: "b689b0a8-53d0-40ab-baf2-68738e2966ac",
        compress: true,
        functionAssociations: [{ eventType: "viewer-request", functionArn: forwardHost.arn }],
      },
      restrictions: { geoRestriction: { restrictionType: "none" } },
      // The default *.cloudfront.net certificate; a custom domain would allow pinning TLS 1.2+.
      viewerCertificate: { cloudfrontDefaultCertificate: true },
    });
    const publicUrl = $interpolate`https://${edge.domainName}/`;

    // The client's callback is the public (CloudFront) URL, so the client is created after the
    // edge and looked up at runtime by name (see src/lib/cognito.ts).
    auth.addClient("Web", {
      callbackUrls: [$interpolate`${publicUrl}auth/callback`],
      transform: {
        client: (args) => {
          args.allowedOauthFlows = ["code"];
          args.allowedOauthScopes = ["openid", "email", "profile"];
          args.generateSecret = true;
          args.logoutUrls = [publicUrl, $interpolate`${publicUrl}login`];
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
      url: publicUrl,
      mcp: $interpolate`${publicUrl}mcp`,
      app: $interpolate`${publicUrl}app`,
      login: auth.domainUrl,
      relayClientId: relayClient.id,
    };
  },
});
