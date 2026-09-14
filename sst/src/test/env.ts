/** Fake SST links so modules that touch `Resource` load outside a deployment. */
process.env.SST_RESOURCE_App = JSON.stringify({ name: "webmail-mcp", stage: "test" });
process.env.SST_RESOURCE_EncryptionKey = JSON.stringify({ value: "unit-test-key-not-secret" });
for (const t of ["Accounts", "Calendars", "OAuth", "Users", "Audit"]) process.env[`SST_RESOURCE_${t}`] = JSON.stringify({ name: t, type: "sst.aws.Dynamo" });
process.env.AWS_REGION ??= "eu-central-1";
process.env.COGNITO_USER_POOL_ID ??= "eu-central-1_TESTPOOL";
process.env.COGNITO_DOMAIN ??= "https://webmail-mcp-test.auth.eu-central-1.amazoncognito.com";
process.env.COGNITO_REGION ??= "eu-central-1";
