import { isAllowed, normalizeEmail } from "../lib/allowlist.js";

type PreSignUpEvent = {
  triggerSource: string;
  userName: string;
  request: { userAttributes: Record<string, string> };
  response: { autoConfirmUser?: boolean; autoVerifyEmail?: boolean };
};

/**
 * Cognito Pre-Sign-Up trigger: the only gate on who can create an account. Throwing makes
 * Cognito refuse the sign-up and show the message in the managed login UI.
 */
export const handler = async (event: PreSignUpEvent): Promise<PreSignUpEvent> => {
  const email = normalizeEmail(event.request.userAttributes.email ?? "");
  const allowed = isAllowed(email);
  // Structured audit line for CloudWatch; never the full attribute set.
  console.log(JSON.stringify({ type: "audit", kind: "auth", action: "auth.signup.attempt", outcome: allowed ? "success" : "denied", target: email, trigger: event.triggerSource, at: new Date().toISOString() }));
  if (!allowed) throw new Error("This address is not permitted to sign up. Only pre-approved addresses may create an account.");
  return event;
};
