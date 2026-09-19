/**
 * Deep links into the web app. A message is addressed by account id, folder path and
 * IMAP uid — the same triple every tool already works with — so a link can be pasted
 * into a to-do or a note and, when opened, shows that one message to the signed-in owner.
 *
 * The link carries the account *id*, never a label or address: ids are opaque and the
 * page resolves them only against the accounts of whoever is signed in.
 */

export const MESSAGE_PATH = "/mail";

export function messageLink(origin: string, accountId: string, folder: string, uid: number): string {
  return `${origin.replace(/\/+$/, "")}${MESSAGE_PATH}/${encodeURIComponent(accountId)}/${encodeURIComponent(folder)}/${uid}`;
}

/** Adds `link` to a message row when the caller's origin is known. */
export function withLink<T extends { folder: string; uid: number }>(origin: string | undefined, accountId: string, row: T): T & { link?: string } {
  return origin ? { ...row, link: messageLink(origin, accountId, row.folder, row.uid) } : row;
}
