export const appPage = (mcpUrl: string, mcpToken: string) => `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Webmail MCP</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1a1a18; --muted:#6b6b66; --line:#e3e3df;
          --accent:#c2552d; --ok:#2f7d4f; --bad:#b3392c; --chip:#efefeb; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#191917; --card:#222220; --fg:#f0efec; --muted:#9a9a94; --line:#33332f;
            --accent:#e07a4f; --ok:#63b183; --bad:#e08074; --chip:#2c2c29; }
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",sans-serif }
  .wrap { max-width:900px; margin:0 auto; padding:32px 20px 80px }
  header { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:28px; flex-wrap:wrap }
  .brand { display:flex; align-items:center; gap:10px; font-size:18px; font-weight:650; letter-spacing:-.01em }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--accent) }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:34px 0 12px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px }
  .field { flex:1; min-width:0; background:var(--bg); border:1px solid var(--line); border-radius:8px;
           padding:9px 11px; overflow-x:auto; white-space:nowrap }
  button { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px;
           padding:8px 13px; font-size:13.5px; font-weight:550; cursor:pointer }
  button:hover { border-color:var(--accent) }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff }
  button.ghost { background:transparent }
  button.danger:hover { border-color:var(--bad); color:var(--bad) }
  .grid { display:grid; gap:12px }
  .acct { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px;
          display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap }
  .acct h3 { margin:0 0 3px; font-size:15.5px }
  .acct .meta { color:var(--muted); font-size:13px }
  .chip { display:inline-block; background:var(--chip); border-radius:6px; padding:2px 7px; font-size:11.5px; color:var(--muted); margin-right:6px }
  .empty { color:var(--muted); text-align:center; padding:36px 20px; border:1px dashed var(--line); border-radius:14px }
  dialog { border:1px solid var(--line); border-radius:16px; background:var(--card); color:var(--fg);
           padding:0; width:min(560px,94vw); max-height:90vh }
  dialog::backdrop { background:#0008 }
  .dlg-body { padding:24px; overflow-y:auto; max-height:calc(90vh - 74px) }
  .dlg-foot { display:flex; justify-content:flex-end; gap:8px; padding:14px 24px; border-top:1px solid var(--line) }
  label { display:block; font-size:11.5px; font-weight:650; color:var(--muted); margin:14px 0 5px; text-transform:uppercase; letter-spacing:.04em }
  input, select { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font-size:14.5px }
  input:focus, select:focus { outline:2px solid var(--accent); outline-offset:1px }
  .two { display:grid; grid-template-columns:1fr 1fr; gap:12px }
  .hint { font-size:12px; color:var(--muted); margin-top:5px }
  .status { font-size:13px; margin-top:10px }
  .ok { color:var(--ok) } .bad { color:var(--bad) }
  ol { padding-left:20px; color:var(--muted); font-size:13.5px } ol li { margin:7px 0 }
  ol b { color:var(--fg); font-weight:600 }
  @media (max-width:560px) { .two { grid-template-columns:1fr } }
</style></head>
<body><div class="wrap">
  <header>
    <div class="brand"><span class="dot"></span> Webmail MCP</div>
    <div class="row">
      <button class="primary" onclick="openForm()">Add mail account</button>
      <form method="post" action="/admin/logout"><button class="ghost">Sign out</button></form>
    </div>
  </header>

  <h2>Connect Claude</h2>
  <div class="card">
    <div class="row"><span class="mono field" id="url">${mcpUrl}</span><button onclick="copy('url')">Copy URL</button></div>
    <div class="row" style="margin-top:10px"><span class="mono field" id="tok">${mcpToken}</span><button onclick="copy('tok')">Copy token</button></div>
    <div class="row" style="margin-top:10px"><span class="mono field" id="cli">claude mcp add --transport http webmail ${mcpUrl} --header "Authorization: Bearer ${mcpToken}"</span><button onclick="copy('cli')">Copy command</button></div>
    <ol style="margin-top:16px">
      <li><b>Claude Code</b> — run the command above in any terminal.</li>
      <li><b>Claude desktop or claude.ai</b> — Settings &rarr; Connectors &rarr; Add custom connector, paste the URL, and add the header <code>Authorization: Bearer &lt;token&gt;</code>. Where headers can't be set, append <code>?token=&lt;token&gt;</code> to the URL instead.</li>
      <li>Ask Claude <i>"what's in my inbox?"</i> to confirm the connection.</li>
    </ol>
  </div>

  <h2>Mail accounts</h2>
  <div class="grid" id="accounts"><div class="empty">Loading…</div></div>

<dialog id="dlg"><form id="form" onsubmit="save(event)">
  <div class="dlg-body">
    <h3 id="dlgTitle" style="margin:0 0 4px">Add mail account</h3>
    <div class="hint">Credentials are encrypted with AES-256-GCM before they are stored, and are only ever used to reach your mail server.</div>
    <input type="hidden" name="accountId" id="accountId">
    <label>Provider preset</label>
    <select id="preset" onchange="applyPreset()">
      <option value="">Custom / other</option>
      <option value="gmail">Gmail (app password)</option>
      <option value="outlook">Outlook / Microsoft 365</option>
      <option value="fastmail">Fastmail</option>
      <option value="icloud">iCloud Mail</option>
      <option value="yahoo">Yahoo Mail</option>
    </select>
    <div class="two">
      <div><label>Label</label><input name="label" id="label" placeholder="Work" required></div>
      <div><label>Email address</label><input name="email" id="email" type="email" placeholder="you@example.com" required></div>
    </div>
    <div class="two">
      <div><label>IMAP host</label><input name="imapHost" id="imapHost" placeholder="imap.example.com" required></div>
      <div><label>IMAP port</label><input name="imapPort" id="imapPort" type="number" value="993" required></div>
    </div>
    <div class="two">
      <div><label>IMAP username</label><input name="imapUser" id="imapUser" placeholder="defaults to the email address"></div>
      <div><label>IMAP password</label><input name="imapPassword" id="imapPassword" type="password" placeholder="unchanged"></div>
    </div>
    <div class="two">
      <div><label>SMTP host</label><input name="smtpHost" id="smtpHost" placeholder="smtp.example.com" required></div>
      <div><label>SMTP port</label><input name="smtpPort" id="smtpPort" type="number" value="465" required></div>
    </div>
    <div class="two">
      <div><label>SMTP username</label><input name="smtpUser" id="smtpUser" placeholder="defaults to IMAP username"></div>
      <div><label>SMTP password</label><input name="smtpPassword" id="smtpPassword" type="password" placeholder="defaults to IMAP password"></div>
    </div>
    <div class="hint">Ports 993 (IMAP) and 465 (SMTP) use implicit TLS. Port 587 is sent as STARTTLS automatically.</div>
    <div class="status" id="formStatus"></div>
  </div>
  <div class="dlg-foot">
    <button type="button" class="ghost" onclick="dlg.close()">Cancel</button>
    <button type="submit" class="primary" id="saveBtn">Save account</button>
  </div>
</form></dialog>
</div>
<script>
const PRESETS = {
  gmail:    { imapHost:'imap.gmail.com',        imapPort:993, smtpHost:'smtp.gmail.com',        smtpPort:465 },
  outlook:  { imapHost:'outlook.office365.com', imapPort:993, smtpHost:'smtp.office365.com',    smtpPort:587 },
  fastmail: { imapHost:'imap.fastmail.com',     imapPort:993, smtpHost:'smtp.fastmail.com',     smtpPort:465 },
  icloud:   { imapHost:'imap.mail.me.com',      imapPort:993, smtpHost:'smtp.mail.me.com',      smtpPort:587 },
  yahoo:    { imapHost:'imap.mail.yahoo.com',   imapPort:993, smtpHost:'smtp.mail.yahoo.com',   smtpPort:465 }
};
const $ = function(id) { return document.getElementById(id); };
function applyPreset() {
  const p = PRESETS[$('preset').value];
  if (!p) return;
  $('imapHost').value = p.imapHost; $('imapPort').value = p.imapPort;
  $('smtpHost').value = p.smtpHost; $('smtpPort').value = p.smtpPort;
}
function copy(id) {
  navigator.clipboard.writeText($(id).textContent.trim());
  const b = event.target; const old = b.textContent;
  b.textContent = 'Copied'; setTimeout(function(){ b.textContent = old; }, 1200);
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, function(c) {
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
  });
}
async function load() {
  const res = await fetch('/api/accounts');
  if (res.status === 401) return location.reload();
  const accounts = await res.json();
  const el = $('accounts');
  if (!accounts.length) {
    el.innerHTML = '<div class="empty">No mail accounts yet.<br>Add one and Claude can read and send mail from it.</div>';
    return;
  }
  el.innerHTML = accounts.map(function(a) {
    return '<div class="acct"><div>' +
      '<h3>' + esc(a.label) + '</h3>' +
      '<div class="meta">' + esc(a.email) + '</div>' +
      '<div style="margin-top:9px">' +
        '<span class="chip">IMAP ' + esc(a.imap.host) + ':' + a.imap.port + '</span>' +
        '<span class="chip">SMTP ' + esc(a.smtp.host) + ':' + a.smtp.port + '</span>' +
      '</div>' +
      '<div class="status" id="s-' + a.accountId + '"></div>' +
    '</div><div class="row">' +
      '<button onclick="test(\\'' + a.accountId + '\\')">Test</button>' +
      '<button onclick=\\'edit(' + JSON.stringify(a).replace(/'/g, '&#39;') + ')\\'>Edit</button>' +
      '<button class="danger" onclick="del(\\'' + a.accountId + '\\',\\'' + esc(a.label) + '\\')">Delete</button>' +
    '</div></div>';
  }).join('');
}
async function test(id) {
  const s = $('s-' + id);
  s.className = 'status'; s.textContent = 'Testing connection…';
  const res = await fetch('/api/accounts/' + id + '/test', { method:'POST' });
  const body = await res.json();
  s.className = 'status ' + (res.ok ? 'ok' : 'bad');
  s.textContent = res.ok ? 'IMAP ' + body.imap + ' · SMTP ' + body.smtp : body.error;
}
function openForm() {
  $('form').reset(); $('accountId').value = ''; $('formStatus').textContent = '';
  $('dlgTitle').textContent = 'Add mail account';
  $('imapPassword').placeholder = 'required';
  $('dlg').showModal();
}
function edit(a) {
  openForm();
  $('dlgTitle').textContent = 'Edit ' + a.label;
  $('accountId').value = a.accountId;
  $('label').value = a.label; $('email').value = a.email;
  $('imapHost').value = a.imap.host; $('imapPort').value = a.imap.port; $('imapUser').value = a.imap.user;
  $('smtpHost').value = a.smtp.host; $('smtpPort').value = a.smtp.port; $('smtpUser').value = a.smtp.user;
  $('imapPassword').placeholder = 'leave blank to keep current';
}
async function save(e) {
  e.preventDefault();
  const s = $('formStatus'); s.className = 'status'; s.textContent = 'Saving…';
  $('saveBtn').disabled = true;
  const data = Object.fromEntries(new FormData($('form')));
  const res = await fetch('/api/accounts', {
    method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(data)
  });
  $('saveBtn').disabled = false;
  if (!res.ok) { const b = await res.json(); s.className = 'status bad'; s.textContent = b.error; return; }
  $('dlg').close(); load();
}
async function del(id, label) {
  if (!confirm('Remove "' + label + '"? Claude will lose access to this mailbox.')) return;
  await fetch('/api/accounts/' + id, { method:'DELETE' });
  load();
}
const dlg = $('dlg');
load();
</script></body></html>`;
