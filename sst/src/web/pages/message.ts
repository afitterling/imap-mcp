import { page, esc, type NavUser } from "../layout.js";

export type MessageView = {
  uid: number;
  folder: string;
  subject?: string;
  from?: string;
  to?: string;
  cc?: string;
  date?: string;
  messageId?: string;
  text?: string;
  html?: string;
  attachments?: { index: number; filename?: string; contentType?: string; size?: number }[];
};

/** A readable text body: the text part when there is one, else the HTML with its tags stripped. */
export function bodyText(m: Pick<MessageView, "text" | "html">): string {
  if (m.text && m.text.trim()) return m.text;
  if (!m.html) return "";
  return m.html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|blockquote|table)>/gi, "\n\n")
    .replace(/<\/(tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function size(n?: number): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "full", timeStyle: "short" }) : "");

/**
 * One message, read-only, for the person who owns the account. This is where a deep link
 * lands. Only text is rendered: HTML mail is never injected into the page, so a message
 * cannot run scripts, load trackers or restyle the app.
 */
export const messagePage = (nonce: string, user: NavUser, m: MessageView, account: { label: string; email: string }) =>
  page({
    title: m.subject || "(no subject)",
    nonce,
    user,
    active: "app",
    body: `<div class="wrap">
  <p class="muted small mb0"><a href="/app">Accounts</a> › ${esc(account.label)} › ${esc(m.folder)} · uid ${m.uid}</p>
  <h1>${esc(m.subject || "(no subject)")}</h1>
  <div class="card">
    <div class="mail-kv">
      <div><b>From</b></div><div>${esc(m.from ?? "")}</div>
      <div><b>To</b></div><div>${esc(m.to ?? "")}</div>
      ${m.cc ? `<div><b>Cc</b></div><div>${esc(m.cc)}</div>` : ""}
      <div><b>Date</b></div><div>${esc(when(m.date))}</div>
    </div>
    <hr class="sep">
    <pre class="mail-body">${esc(bodyText(m))}</pre>
    ${
      m.attachments?.length
        ? `<hr class="sep"><h3>Attachments</h3><ul class="plain">${m.attachments
            .map((a) => `<li><span class="chip">${esc(a.filename ?? `attachment ${a.index}`)}</span> <span class="muted small">${esc(a.contentType ?? "")} ${esc(size(a.size))}</span></li>`)
            .join("")}</ul>`
        : ""
    }
  </div>
  <p class="muted small">Shown as plain text. Attachments and HTML formatting are available through Claude (<code>get_attachment</code>) or your mail client.
  ${m.messageId ? `Apple Mail can open it directly: <a href="message://${esc(encodeURIComponent(m.messageId))}">message://…</a>` : ""}</p>
  <footer><span>WebMail / Private Office MCP</span><a href="/app">App</a><a href="/docs">Manual</a></footer>
</div>`,
  });
