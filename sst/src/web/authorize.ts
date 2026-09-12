export const authorizePage = (opts: {
  clientName: string;
  params: Record<string, string>;
  error?: string;
}) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize ${opts.clientName} — Webmail MCP</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1a1a18; --muted:#6b6b66; --line:#e3e3df; --accent:#c2552d; --chip:#efefeb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#191917; --card:#222220; --fg:#f0efec; --muted:#9a9a94; --line:#33332f; --accent:#e07a4f; --chip:#2c2c29; }
  }
  * { box-sizing:border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; padding:24px }
  form { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:32px; width:min(420px,100%) }
  .brand { display:flex; align-items:center; gap:9px; font-size:13px; font-weight:600; color:var(--muted);
           text-transform:uppercase; letter-spacing:.06em; margin-bottom:20px }
  .dot { width:9px; height:9px; border-radius:50%; background:var(--accent) }
  h1 { margin:0 0 8px; font-size:20px; letter-spacing:-.01em }
  p.sub { margin:0 0 20px; color:var(--muted); font-size:13.5px }
  ul { margin:0 0 22px; padding:0; list-style:none; border:1px solid var(--line); border-radius:10px; overflow:hidden }
  li { padding:10px 14px; font-size:13.5px; display:flex; gap:10px; align-items:baseline }
  li + li { border-top:1px solid var(--line) }
  li b { color:var(--accent); font-size:15px; line-height:1 }
  label { display:block; font-size:11.5px; font-weight:650; color:var(--muted); margin-bottom:6px; text-transform:uppercase; letter-spacing:.04em }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font-size:15px }
  input:focus { outline:2px solid var(--accent); outline-offset:1px }
  button { width:100%; margin-top:16px; padding:11px; border:0; border-radius:8px; background:var(--accent);
           color:#fff; font-size:15px; font-weight:600; cursor:pointer }
  .err { margin-top:14px; padding:10px 12px; border-radius:8px; background:#c2552d1a; color:var(--accent); font-size:13px }
  .foot { margin-top:18px; font-size:12px; color:var(--muted); text-align:center }
</style></head>
<body>
  <form method="post" action="/oauth/authorize">
    <div class="brand"><span class="dot"></span> Webmail MCP</div>
    <h1>Authorize ${opts.clientName}</h1>
    <p class="sub">It is asking to connect to your mail accounts. Once you approve, it will be able to:</p>
    <ul>
      <li><b>&bull;</b><span>Read and search messages in every connected mailbox</span></li>
      <li><b>&bull;</b><span>Send mail from those addresses</span></li>
      <li><b>&bull;</b><span>Move messages and change their flags</span></li>
    </ul>
    <label for="p">Admin password</label>
    <input id="p" name="password" type="password" autofocus autocomplete="current-password" required>
    ${Object.entries(opts.params)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeAttr(v)}">`)
      .join("")}
    <button type="submit">Approve and connect</button>
    ${opts.error ? `<div class="err">${opts.error}</div>` : ""}
    <div class="foot">You can revoke access any time by rotating the admin password.</div>
  </form>
</body></html>`;

function escapeAttr(v: string): string {
  return v.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
