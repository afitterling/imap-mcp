/**
 * The only addresses that may create an account. Deliberately a constant rather than a
 * setting: changing who can sign up should be a code change that shows up in review.
 */
export const ALLOWED_EMAILS: readonly string[] = ["afitterling@icloud.com", "michael.meyer@mindyourstep.de"];

/** The first allowlisted address is the administrator. */
export const ADMIN_EMAIL = ALLOWED_EMAILS[0];

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isAllowed(email: string): boolean {
  const needle = normalizeEmail(email);
  return ALLOWED_EMAILS.some((e) => normalizeEmail(e) === needle);
}
