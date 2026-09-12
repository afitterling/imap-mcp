export const loginPage = (error?: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webmail MCP — Sign in</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1a1a18; --muted:#6b6b66; --line:#e3e3df; --accent:#c2552d; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#191917; --card:#222220; --fg:#f0efec; --muted:#9a9a94; --line:#33332f; --accent:#e07a4f; }
  }
  * { box-sizing:border-box }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; padding:24px }
  form { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:32px; width:min(380px,100%) }
  h1 { margin:0 0 4px; font-size:20px; letter-spacing:-.01em }
  p.sub { margin:0 0 24px; color:var(--muted); font-size:13px }
  label { display:block; font-size:12px; font-weight:600; color:var(--muted); margin-bottom:6px; text-transform:uppercase; letter-spacing:.04em }
  input { width:100%; padding:10px 12px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font-size:15px }
  input:focus { outline:2px solid var(--accent); outline-offset:1px }
  button { width:100%; margin-top:16px; padding:10px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-size:15px; font-weight:600; cursor:pointer }
  .err { margin-top:14px; padding:10px 12px; border-radius:8px; background:#c2552d1a; color:var(--accent); font-size:13px }
</style></head>
<body>
  <form method="post" action="/admin/login">
    <h1>Webmail MCP</h1>
    <p class="sub">Sign in to manage the mail accounts Claude can reach.</p>
    <label for="p">Admin password</label>
    <input id="p" name="password" type="password" autofocus autocomplete="current-password" required>
    <button type="submit">Sign in</button>
    ${error ? `<div class="err">${error}</div>` : ""}
  </form>
</body></html>`;
