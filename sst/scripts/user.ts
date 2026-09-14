/**
 * Operator CLI for the rare things that must be done *to* a user. There is no admin in
 * the web app; run this from `sst/` with AWS credentials for the stage:
 *
 *   npm run user -- list --stage dev
 *   npm run user -- reset-mfa michael.meyer@mindyourstep.de --stage dev
 *   npm run user -- signout <email> | disable <email> | enable <email>
 */
import {
  CognitoIdentityProviderClient,
  ListUserPoolsCommand,
  ListUsersCommand,
  AdminGetUserCommand,
  AdminSetUserMFAPreferenceCommand,
  AdminUserGlobalSignOutCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";

const args = process.argv.slice(2);
const stageIdx = args.indexOf("--stage");
const stage = stageIdx >= 0 ? args[stageIdx + 1] : process.env.SST_STAGE;
const [command, email] = args.filter((_, i) => i !== stageIdx && i !== stageIdx + 1);
const region = process.env.AWS_REGION ?? "eu-central-1";
const idp = new CognitoIdentityProviderClient({ region });

function usage(): never {
  console.error("usage: npm run user -- <list|reset-mfa|signout|disable|enable> [email] --stage <stage>");
  process.exit(2);
}

async function poolId(): Promise<string> {
  if (!stage) usage();
  const res = await idp.send(new ListUserPoolsCommand({ MaxResults: 60 }));
  const pool = res.UserPools?.find((p) => p.Name?.startsWith(`webmail-mcp-${stage}-AuthUserPool`));
  if (!pool?.Id) throw new Error(`No user pool found for stage "${stage}" in ${region}.`);
  return pool.Id;
}

async function main() {
  if (!command) usage();
  const UserPoolId = await poolId();
  if (command === "list") {
    const res = await idp.send(new ListUsersCommand({ UserPoolId }));
    for (const u of res.Users ?? []) {
      const mail = u.Attributes?.find((a) => a.Name === "email")?.Value;
      const detail = await idp.send(new AdminGetUserCommand({ UserPoolId, Username: u.Username! }));
      const mfa = (detail.UserMFASettingList ?? []).map((m) => (m === "SOFTWARE_TOKEN_MFA" ? "authenticator" : m)).join(",") || "none";
      console.log(`${mail?.padEnd(34)} ${u.Enabled ? "enabled " : "DISABLED"} ${u.UserStatus?.padEnd(18)} mfa: ${mfa}`);
    }
    return;
  }
  if (!email) usage();
  const Username = email.trim().toLowerCase();
  switch (command) {
    case "reset-mfa":
      await idp.send(new AdminSetUserMFAPreferenceCommand({ UserPoolId, Username, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } }));
      await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username }));
      console.log(`MFA cleared for ${Username}; they will set up a new authenticator at the next sign-in. Sessions revoked.`);
      break;
    case "signout":
      await idp.send(new AdminUserGlobalSignOutCommand({ UserPoolId, Username }));
      console.log(`All Cognito sessions and refresh tokens revoked for ${Username}. (App sessions expire within the hour; personal tokens stay valid.)`);
      break;
    case "disable":
      await idp.send(new AdminDisableUserCommand({ UserPoolId, Username }));
      console.log(`${Username} disabled: sign-in, connectors and Cognito tokens refused.`);
      break;
    case "enable":
      await idp.send(new AdminEnableUserCommand({ UserPoolId, Username }));
      console.log(`${Username} enabled.`);
      break;
    default:
      usage();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
