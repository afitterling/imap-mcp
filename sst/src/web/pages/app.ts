import { page, esc, json, CLIENT_LIB } from "../layout.js";
import type { PublicUser } from "../../lib/users.js";

export const appPage = (nonce: string, user: PublicUser, mcpUrl: string) =>
  page({
    title: "My mail",
    nonce,
    user,
    active: "app",
    wide: true,
    body: `<div class="wrap wide">
  <div class="row between">
    <div><h1>My mail</h1><p class="lead mb0">Mailboxes Claude can reach as you, and everything it has done with them.</p></div>
    <div class="row"><button class="primary" id="addAcct">Add mail account</button><button id="addCal">Add calendar</button></div>
  </div>

  <div class="tabs" id="tabs">
    <button data-tab="accounts" class="cur">Accounts</button>
    <button data-tab="calendars">Calendars</button>
    <button data-tab="outbox">Outbox <span id="obCount" class="chip accent hidden"></span></button>
    <button data-tab="connect">Connect Claude</button>
    <button data-tab="activity">Activity</button>
    <button data-tab="security">Security</button>
  </div>

  <!-- ------------------------------ Accounts ------------------------------ -->
  <section class="tab cur" id="tab-accounts">
    <div class="grid" id="accounts"><div class="empty">Loading…</div></div>
  </section>

  <!-- ------------------------------ Calendars ------------------------------ -->
  <section class="tab" id="tab-calendars">
    <div class="grid" id="calendars"><div class="empty">Loading…</div></div>
  </section>

  <!-- ------------------------------- Outbox ------------------------------- -->
  <section class="tab" id="tab-outbox">
    <div class="card mb12">
      <label class="inline"><input type="checkbox" id="reqApproval"> Hold every mail Claude composes until I approve it here</label>
      <div class="hint mt8">With this on, <code>send_message</code> cannot put mail on the wire. Claude composes it, it is saved to your Drafts,
        and it goes out only when you press <b>Send now</b> below. Turning it off lets Claude send directly — the change is logged.</div>
    </div>
    <div class="grid" id="outbox"></div>
  </section>

  <!-- --------------------------- Connect Claude --------------------------- -->
  <section class="tab" id="tab-connect">
    <h2 class="mt8">MCP endpoint</h2>
    <div class="card">
      <div class="row"><span class="mono field" id="url">${esc(mcpUrl)}</span><button data-copy="url">Copy URL</button></div>
      <label>Claude Code — run in a terminal (paste your token in place of &lt;token&gt;)</label>
      <div class="row"><span class="mono field" id="cliTpl">claude mcp add --transport http --scope user private-office ${esc(mcpUrl)} --header "Authorization: Bearer &lt;token&gt;"</span><button data-copy="cliTpl">Copy command</button></div>
      <label>claude.ai / Claude desktop</label>
      <div class="hint mb0">Settings → Connectors → Add custom connector → paste the URL above → Connect. You will sign in here to approve it.</div>
    </div>

    <h2>Personal tokens <span class="muted">(Claude Code and other clients that send a header)</span></h2>
    <div class="card">
      <div class="row">
        <input id="tokName" placeholder="Token name, e.g. MacBook" maxlength="60" class="grow">
        <select id="tokTtl"><option value="30">30 days</option><option value="90" selected>90 days</option><option value="365">1 year</option></select>
        <button class="primary" id="tokCreate">Create token</button>
      </div>
      <div id="tokNew" class="hidden mt12">
        <div class="note warn">Copy this token now — it is shown only once. The command below already contains it.</div>
        <div class="row mt8"><span class="mono field" id="tokValue"></span><button data-copy="tokValue">Copy token</button></div>
        <div class="row mt8"><span class="mono field" id="tokCli"></span><button data-copy="tokCli">Copy command</button></div>
      </div>
      <div class="status" id="tokStatus"></div>
      <div class="tbl mt12"><table><thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody id="tokens"></tbody></table></div>
    </div>

    <h2>Connected apps <span class="muted">(claude.ai, Claude desktop — via OAuth)</span></h2>
    <div class="card">
      <p class="muted small">In claude.ai: Settings → Connectors → Add custom connector → paste the URL above → Connect. You will be asked to sign in here.</p>
      <div class="tbl"><table><thead><tr><th>App</th><th>Connected</th><th>Last used</th><th></th></tr></thead><tbody id="grants"></tbody></table></div>
    </div>
  </section>

  <!-- ------------------------------ Activity ------------------------------ -->
  <section class="tab" id="tab-activity">
    <div class="card">
      <div class="row">
        <select id="actKind" class="grow"><option value="">All kinds</option>
          <option value="auth">Sign-in</option><option value="mfa">Two-factor</option><option value="oauth">Connected apps</option>
          <option value="token">Tokens</option><option value="mcp">Claude mail tools</option><option value="calendar">Calendars &amp; calendar tools</option><option value="account">Mail accounts</option>
          <option value="outbox">Outbox</option><option value="security">Security</option><option value="user">Users</option></select>
        <input type="date" id="actFrom" class="grow"><input type="date" id="actTo" class="grow">
        <button id="actLoad">Filter</button><a class="btn" id="actCsv" href="/api/activity.csv">Export CSV</a>
      </div>
      <div class="tbl mt12"><table><thead><tr><th>When</th><th>What</th><th>Outcome</th><th>Details</th><th>From</th></tr></thead><tbody id="activity"></tbody></table></div>
      <div class="row mt12"><button id="actMore" class="hidden">Load more</button></div>
    </div>
  </section>

  <!-- ------------------------------ Security ------------------------------ -->
  <section class="tab" id="tab-security">
    <div class="grid cols2">
      <div class="card">
        <h3>Sign-in</h3>
        <p class="muted small">Your password and two-factor authentication are managed by the account service, not stored here.</p>
        <div class="mt12"><b>Two-factor</b> <span id="mfaState" class="chip"></span></div>
        <ul class="small muted mt12">
          <li><b>Change password:</b> sign out, then use <i>Forgot your password?</i> on the sign-in page.</li>
          <li><b>New phone / lost authenticator:</b> the operator resets it on the command line (<a href="/docs#ops">manual</a>); you set it up again at your next sign-in.</li>
        </ul>
      </div>
      <div class="card">
        <h3>Sessions</h3>
        <p class="muted small">Browsers currently signed in as you.</p>
        <div class="tbl"><table><thead><tr><th>Signed in</th><th>Last seen</th><th>IP</th><th></th></tr></thead><tbody id="sessions"></tbody></table></div>
        <div class="row mt12"><button class="danger" id="sessAll">Sign out everywhere</button></div>
      </div>
    </div>
  </section>
</div>

<!-- account form -->
<dialog id="dlg"><form id="form">
  <div class="dlg-body">
    <h3 id="dlgTitle">Add mail account</h3>
    <div class="hint">Credentials are encrypted with AES-256-GCM before they are stored, and are only ever used to reach your mail server.</div>
    <input type="hidden" name="accountId" id="accountId">
    <label>Provider preset</label>
    <select id="preset">
      <option value="">Custom / other</option><option value="gmail">Gmail (app password)</option><option value="outlook">Outlook / Microsoft 365</option>
      <option value="fastmail">Fastmail</option><option value="icloud">iCloud Mail</option><option value="yahoo">Yahoo Mail</option>
    </select>
    <div class="grid cols2">
      <div><label>Label</label><input name="label" id="label" placeholder="Work" required></div>
      <div><label>Email address</label><input name="email" id="email" type="email" placeholder="you@example.com" required></div>
      <div><label>IMAP host</label><input name="imapHost" id="imapHost" placeholder="imap.example.com" required></div>
      <div><label>IMAP port</label><input name="imapPort" id="imapPort" type="number" value="993" required></div>
      <div><label>IMAP username</label><input name="imapUser" id="imapUser" placeholder="defaults to the email address"></div>
      <div><label>IMAP password</label><input name="imapPassword" id="imapPassword" type="password" placeholder="unchanged"></div>
      <div><label>SMTP host</label><input name="smtpHost" id="smtpHost" placeholder="smtp.example.com" required></div>
      <div><label>SMTP port</label><input name="smtpPort" id="smtpPort" type="number" value="465" required></div>
      <div><label>SMTP username</label><input name="smtpUser" id="smtpUser" placeholder="defaults to IMAP username"></div>
      <div><label>SMTP password</label><input name="smtpPassword" id="smtpPassword" type="password" placeholder="defaults to IMAP password"></div>
    </div>
    <label class="inline mt16"><input type="checkbox" name="readOnly" id="readOnly"> Read-only: Claude may read but never change, draft or send</label>
    <div class="hint">Ports 993 (IMAP) and 465 (SMTP) use implicit TLS. Port 587 is sent as STARTTLS automatically.</div>
    <div class="status" id="formStatus"></div>
  </div>
  <div class="dlg-foot"><button type="button" class="ghost" id="dlgCancel">Cancel</button><button type="submit" class="primary" id="saveBtn">Save account</button></div>
</form></dialog>

<!-- calendar form -->
<dialog id="calDlg"><form id="calForm">
  <div class="dlg-body">
    <h3 id="calTitle">Add calendar</h3>
    <div class="hint">Passwords are encrypted with AES-256-GCM before they are stored. For iCloud use an app-specific password.</div>
    <input type="hidden" id="calId">
    <label>Source</label>
    <select id="calKind">
      <option value="icloud">Apple iCloud Calendar</option>
      <option value="fastmail">Fastmail</option>
      <option value="google">Google Calendar (CalDAV)</option>
      <option value="nextcloud">Nextcloud / other CalDAV</option>
      <option value="ics">ICS / webcal subscription (read-only)</option>
    </select>
    <label>Label</label><input id="calLabel" placeholder="Work calendar" maxlength="60">
    <div class="hint">For a single calendar this is its name for Claude; with “Add all” it becomes an optional prefix (e.g. “iCloud”).</div>
    <div id="calDav">
      <label>CalDAV server URL</label><input id="calServer" placeholder="https://caldav.icloud.com">
      <div class="grid cols2">
        <div><label>Username</label><input id="calUser" placeholder="you@icloud.com" autocomplete="username"></div>
        <div><label>Password</label><input id="calPass" type="password" autocomplete="off" placeholder="app-specific password"></div>
      </div>
      <div class="row mt12" id="calConnectRow">
        <button type="button" class="primary" id="calAddAll">Connect &amp; add all calendars</button>
        <button type="button" id="calDiscover">Connect &amp; pick one calendar</button>
        <span class="status" id="calDiscStatus"></span>
      </div>
      <div class="hint">“Add all” creates one entry per calendar on the account, each named after it (Label = optional prefix). Subscribed calendars come in read-only; you can flip Read-only on any entry afterwards.</div>
      <div id="calPick" class="hidden">
        <label>Calendar</label><select id="calChoice"></select>
        <div class="hint">Subscribed calendars are read-only on the server and show as such.</div>
      </div>
      <label class="inline mt16"><input type="checkbox" id="calRo"> Read-only: Claude may read but never create, change or delete events</label>
    </div>
    <div id="calIcs" class="hidden">
      <label>Feed URL</label><input id="calFeed" placeholder="webcal://… or https://…/calendar.ics">
      <div class="hint">Public subscription links only (https or webcal). Always read-only.</div>
    </div>
    <div class="status" id="calStatus"></div>
  </div>
  <div class="dlg-foot"><button type="button" class="ghost" id="calCancel">Cancel</button><button type="submit" class="primary" id="calSave">Save calendar</button></div>
</form></dialog>
`,
    script: `${CLIENT_LIB}
const ME = ${json(user)};
const MCP_URL = ${json(mcpUrl)};
const PRESETS = {
  gmail:    { imapHost:'imap.gmail.com',        imapPort:993, smtpHost:'smtp.gmail.com',        smtpPort:465 },
  outlook:  { imapHost:'outlook.office365.com', imapPort:993, smtpHost:'smtp.office365.com',    smtpPort:587 },
  fastmail: { imapHost:'imap.fastmail.com',     imapPort:993, smtpHost:'smtp.fastmail.com',     smtpPort:465 },
  icloud:   { imapHost:'imap.mail.me.com',      imapPort:993, smtpHost:'smtp.mail.me.com',      smtpPort:587 },
  yahoo:    { imapHost:'imap.mail.yahoo.com',   imapPort:993, smtpHost:'smtp.mail.yahoo.com',   smtpPort:465 }
};

/* ------------------------------- tabs ------------------------------- */
const loaders = { accounts: loadAccounts, calendars: loadCalendars, outbox: loadOutbox, connect: loadConnect, activity: () => loadActivity(true), security: loadSecurity };
function showTab(name, push) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('cur', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('cur', t.id === 'tab-' + name));
  if (push !== false) history.replaceState(null, '', '#' + name);
  loaders[name]();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ----------------------------- accounts ----------------------------- */
async function loadAccounts() {
  const accounts = await api('/api/accounts');
  const el = $('accounts');
  if (!accounts.length) { el.innerHTML = '<div class="empty">No mail accounts yet.<br>Add one and Claude can read (and, with your approval, send) mail from it.</div>'; return; }
  el.innerHTML = accounts.map(a => \`<div class="item"><div class="grow">
      <h3>\${esc(a.label)} \${a.readOnly ? '<span class="chip warn">read-only</span>' : ''}</h3>
      <div class="meta">\${esc(a.email)}</div>
      <div class="chips"><span class="chip">IMAP \${esc(a.imap.host)}:\${a.imap.port}</span><span class="chip">SMTP \${esc(a.smtp.host)}:\${a.smtp.port}</span></div>
      <div class="status" id="s-\${a.accountId}"></div>
    </div><div class="row">
      <label class="toggle"><input type="checkbox" data-ro="\${a.accountId}" \${a.readOnly ? 'checked' : ''}> Read-only</label>
      <button data-test="\${a.accountId}">Test</button>
      <button data-edit="\${a.accountId}">Edit</button>
      <button class="danger" data-del="\${a.accountId}" data-label="\${esc(a.label)}">Delete</button>
    </div></div>\`).join('');
  el.querySelectorAll('[data-ro]').forEach(cb => cb.addEventListener('change', async () => {
    try { await api('/api/accounts/' + cb.dataset.ro + '/readonly', { method: 'POST', body: { readOnly: cb.checked } }); loadAccounts(); }
    catch (e) { status('s-' + cb.dataset.ro, e.message, 'bad'); cb.checked = !cb.checked; }
  }));
  el.querySelectorAll('[data-test]').forEach(b => b.addEventListener('click', () => test(b.dataset.test)));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => edit(accounts.find(a => a.accountId === b.dataset.edit))));
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => del(b.dataset.del, b.dataset.label)));
}
async function test(id) {
  status('s-' + id, 'Testing connection…');
  try { const r = await api('/api/accounts/' + id + '/test', { method: 'POST' }); status('s-' + id, 'IMAP ' + r.imap + ' · SMTP ' + r.smtp, 'ok'); }
  catch (e) { status('s-' + id, e.message, 'bad'); }
}
function openForm() {
  $('form').reset(); $('accountId').value = ''; status('formStatus', '');
  $('dlgTitle').textContent = 'Add mail account'; $('imapPassword').placeholder = 'required'; $('dlg').showModal();
}
function edit(a) {
  openForm(); $('dlgTitle').textContent = 'Edit ' + a.label; $('accountId').value = a.accountId;
  $('label').value = a.label; $('email').value = a.email;
  $('imapHost').value = a.imap.host; $('imapPort').value = a.imap.port; $('imapUser').value = a.imap.user;
  $('smtpHost').value = a.smtp.host; $('smtpPort').value = a.smtp.port; $('smtpUser').value = a.smtp.user;
  $('readOnly').checked = !!a.readOnly; $('imapPassword').placeholder = 'leave blank to keep current';
}
async function del(id, label) {
  if (!confirm('Remove "' + label + '"? Claude will lose access to this mailbox and its credentials are deleted.')) return;
  await api('/api/accounts/' + id, { method: 'DELETE' }); loadAccounts();
}
$('addAcct').addEventListener('click', openForm);
$('dlgCancel').addEventListener('click', () => $('dlg').close());
$('preset').addEventListener('change', () => { const p = PRESETS[$('preset').value]; if (!p) return;
  $('imapHost').value = p.imapHost; $('imapPort').value = p.imapPort; $('smtpHost').value = p.smtpHost; $('smtpPort').value = p.smtpPort; });
$('form').addEventListener('submit', async (e) => {
  e.preventDefault(); status('formStatus', 'Saving…'); $('saveBtn').disabled = true;
  const data = Object.fromEntries(new FormData($('form'))); data.readOnly = $('readOnly').checked;
  try { await api('/api/accounts', { method: 'POST', body: data }); $('dlg').close(); loadAccounts(); }
  catch (err) { status('formStatus', err.message, 'bad'); }
  $('saveBtn').disabled = false;
});

/* ----------------------------- calendars ----------------------------- */
const CAL_PRESETS = {
  icloud:    { server: 'https://caldav.icloud.com', userHint: 'Apple ID e-mail address', passHint: 'app-specific password (appleid.apple.com)' },
  fastmail:  { server: 'https://caldav.fastmail.com/dav/', userHint: 'you@fastmail.com', passHint: 'app password with calendar access' },
  google:    { server: 'https://apidata.googleusercontent.com/caldav/v2/', userHint: 'you@gmail.com', passHint: 'app password (2-step verification required)' },
  nextcloud: { server: '', userHint: 'username', passHint: 'password or app token' }
};
let calFound = [];
async function loadCalendars() {
  const cals = await api('/api/calendars');
  const el = $('calendars');
  if (!cals.length) { el.innerHTML = '<div class="empty">No calendars yet.<br>Add your iCloud calendar or an ICS subscription and Claude can see (and, unless read-only, manage) your events.</div>'; return; }
  el.innerHTML = cals.map(c => \`<div class="item"><div class="grow">
      <h3>\${esc(c.label)} <span class="chip">\${c.kind === 'ics' ? 'ICS feed' : 'CalDAV'}</span>\${c.readOnly ? '<span class="chip warn">read-only</span>' : ''}</h3>
      <div class="meta">\${c.kind === 'ics' ? esc(c.feedUrl) : esc(c.calendarName || '') + ' · ' + esc(c.username || '') + ' @ ' + esc((c.serverUrl || '').replace(/^https:\\/\\//, ''))}</div>
      <div class="status" id="c-\${c.calendarId}"></div>
    </div><div class="row">
      \${c.kind === 'ics' ? '' : '<label class="toggle"><input type="checkbox" data-cro="' + c.calendarId + '" ' + (c.readOnly ? 'checked' : '') + '> Read-only</label>'}
      \${c.kind === 'ics' ? '' : '<button data-call="' + c.calendarId + '" title="Add every other calendar on this account">Add all</button>'}
      <button data-ctest="\${c.calendarId}">Test</button>
      <button data-cedit="\${c.calendarId}">Edit</button>
      <button class="danger" data-cdel="\${c.calendarId}" data-label="\${esc(c.label)}">Delete</button>
    </div></div>\`).join('');
  el.querySelectorAll('[data-cro]').forEach(cb => cb.addEventListener('change', async () => {
    try { await api('/api/calendars/' + cb.dataset.cro + '/readonly', { method: 'POST', body: { readOnly: cb.checked } }); loadCalendars(); }
    catch (e) { status('c-' + cb.dataset.cro, e.message, 'bad'); cb.checked = !cb.checked; }
  }));
  el.querySelectorAll('[data-call]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Add every other calendar on this account, each as its own entry?')) return;
    status('c-' + b.dataset.call, 'Connecting and adding…');
    try { const r = await api('/api/calendars/bulk', { method: 'POST', body: { calendarId: b.dataset.call } });
      status('c-' + b.dataset.call, 'Added ' + r.created.length + (r.skipped.length ? ', already present: ' + r.skipped.length : ''), 'ok'); loadCalendars(); }
    catch (e) { status('c-' + b.dataset.call, e.message, 'bad'); }
  }));
  el.querySelectorAll('[data-ctest]').forEach(b => b.addEventListener('click', async () => {
    status('c-' + b.dataset.ctest, 'Testing…');
    try { const r = await api('/api/calendars/' + b.dataset.ctest + '/test', { method: 'POST' }); status('c-' + b.dataset.ctest, r.status, 'ok'); }
    catch (e) { status('c-' + b.dataset.ctest, e.message, 'bad'); }
  }));
  el.querySelectorAll('[data-cedit]').forEach(b => b.addEventListener('click', () => editCal(cals.find(c => c.calendarId === b.dataset.cedit))));
  el.querySelectorAll('[data-cdel]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Remove "' + b.dataset.label + '"? Claude will lose access to this calendar.')) return;
    await api('/api/calendars/' + b.dataset.cdel, { method: 'DELETE' }); loadCalendars();
  }));
}
function calKindChanged() {
  const k = $('calKind').value; const ics = k === 'ics';
  $('calDav').classList.toggle('hidden', ics); $('calIcs').classList.toggle('hidden', !ics);
  const p = CAL_PRESETS[k];
  if (p) { if (!$('calId').value || p.server) $('calServer').value = p.server; $('calUser').placeholder = p.userHint; $('calPass').placeholder = $('calId').value ? 'leave blank to keep current' : p.passHint; }
}
function openCal() {
  $('calForm').reset(); $('calId').value = ''; calFound = []; $('calPick').classList.add('hidden'); $('calChoice').innerHTML = ''; delete $('calLabel').dataset.own;
  status('calStatus', ''); status('calDiscStatus', ''); $('calTitle').textContent = 'Add calendar'; $('calKind').value = 'icloud'; calKindChanged(); $('calDlg').showModal();
}
function editCal(c) {
  openCal(); $('calTitle').textContent = 'Edit ' + c.label; $('calId').value = c.calendarId; $('calLabel').value = c.label; $('calLabel').dataset.own = c.label;
  if (c.kind === 'ics') { $('calKind').value = 'ics'; calKindChanged(); $('calFeed').value = c.feedUrl || ''; return; }
  const preset = Object.keys(CAL_PRESETS).find(k => CAL_PRESETS[k].server && c.serverUrl && c.serverUrl.startsWith(CAL_PRESETS[k].server)) || 'nextcloud';
  $('calKind').value = preset; calKindChanged();
  $('calServer').value = c.serverUrl || ''; $('calUser').value = c.username || ''; $('calRo').checked = !!c.readOnly;
  calFound = [{ url: c.calendarUrl, name: c.calendarName || c.calendarUrl, readOnly: false }];
  $('calChoice').innerHTML = '<option value="' + esc(c.calendarUrl) + '">' + esc(c.calendarName || c.calendarUrl) + '</option>'; $('calPick').classList.remove('hidden');
}
$('addCal').addEventListener('click', openCal);
$('calCancel').addEventListener('click', () => $('calDlg').close());
$('calKind').addEventListener('change', calKindChanged);
$('calDiscover').addEventListener('click', async () => {
  status('calDiscStatus', 'Connecting…'); $('calDiscover').disabled = true;
  try {
    calFound = await api('/api/calendars/discover', { method: 'POST', body: { serverUrl: $('calServer').value, username: $('calUser').value, password: $('calPass').value, calendarId: $('calId').value || undefined } });
    $('calChoice').innerHTML = calFound.map(f => '<option value="' + esc(f.url) + '">' + esc(f.name) + (f.subscribed ? ' (subscription, read-only)' : f.readOnly ? ' (read-only)' : '') + '</option>').join('');
    $('calPick').classList.remove('hidden'); status('calDiscStatus', calFound.length + ' calendar(s) found', 'ok');
  } catch (e) { status('calDiscStatus', e.message, 'bad'); }
  $('calDiscover').disabled = false;
});
$('calAddAll').addEventListener('click', async () => {
  if (!$('calServer').value || !$('calUser').value || (!$('calPass').value && !$('calId').value)) { status('calDiscStatus', 'Enter server, username and password first.', 'bad'); return; }
  status('calDiscStatus', 'Connecting and adding every calendar…'); $('calAddAll').disabled = true;
  try {
    const r = await api('/api/calendars/bulk', { method: 'POST', body: { calendarId: $('calId').value || undefined, serverUrl: $('calServer').value, username: $('calUser').value, password: $('calPass').value, readOnly: $('calRo').checked, labelPrefix: $('calLabel').value === $('calLabel').dataset.own ? '' : $('calLabel').value } });
    $('calDlg').close(); loadCalendars();
    if (r.skipped.length) alert('Added ' + r.created.length + '. Already present, skipped: ' + r.skipped.join(', '));
  } catch (e) { status('calDiscStatus', e.message, 'bad'); }
  $('calAddAll').disabled = false;
});
$('calForm').addEventListener('submit', async (e) => {
  e.preventDefault(); status('calStatus', 'Saving…'); $('calSave').disabled = true;
  const ics = $('calKind').value === 'ics';
  const chosen = calFound.find(f => f.url === $('calChoice').value);
  const body = ics
    ? { calendarId: $('calId').value || undefined, kind: 'ics', label: $('calLabel').value, feedUrl: $('calFeed').value }
    : { calendarId: $('calId').value || undefined, kind: 'caldav', label: $('calLabel').value, serverUrl: $('calServer').value, username: $('calUser').value,
        password: $('calPass').value || undefined, calendarUrl: $('calChoice').value, calendarName: chosen ? chosen.name : '', readOnly: $('calRo').checked || (chosen && chosen.readOnly) };
  if (!body.label.trim()) { status('calStatus', 'Please give the calendar a label.', 'bad'); $('calSave').disabled = false; return; }
  if (!ics && !body.calendarUrl) { status('calStatus', 'Connect first and pick a calendar.', 'bad'); $('calSave').disabled = false; return; }
  try { await api('/api/calendars', { method: 'POST', body }); $('calDlg').close(); loadCalendars(); }
  catch (err) { status('calStatus', err.message, 'bad'); }
  $('calSave').disabled = false;
});

/* ------------------------------ outbox ------------------------------ */
async function loadOutbox() {
  const data = await api('/api/outbox');
  $('reqApproval').checked = data.requireApproval;
  const el = $('outbox'); const n = data.pending.length;
  $('obCount').textContent = n; $('obCount').classList.toggle('hidden', !n);
  if (!n) { el.innerHTML = '<div class="empty">Nothing waiting for approval.</div>'; return; }
  el.innerHTML = data.pending.map(p => \`<div class="item"><div class="grow">
      <h3>\${esc(p.subject || '(no subject)')}</h3>
      <div class="meta">To \${esc(p.to)}\${p.cc ? ' · cc ' + esc(p.cc) : ''}\${p.bcc ? ' · bcc ' + esc(p.bcc) : ''}</div>
      <div class="chips"><span class="chip">\${esc(p.accountLabel)}</span><span class="chip">\${esc(p.folder)} uid \${p.uid}</span>
        \${p.attachments && p.attachments.length ? '<span class="chip">' + p.attachments.length + ' attachment(s)</span>' : ''}<span class="chip">queued \${ago(p.createdAt)}</span></div>
      <pre class="preview">\${esc(p.preview)}…</pre>
      <div class="status" id="ob-\${p.id}"></div>
    </div><div class="row top">
      <button class="primary" data-approve="\${p.id}">Send now</button><button class="danger" data-discard="\${p.id}">Discard</button>
    </div></div>\`).join('');
  el.querySelectorAll('[data-approve]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Send this mail now? It cannot be recalled.')) return;
    status('ob-' + b.dataset.approve, 'Sending…');
    try { await api('/api/outbox/' + b.dataset.approve + '/approve', { method: 'POST' }); loadOutbox(); }
    catch (e) { status('ob-' + b.dataset.approve, e.message, 'bad'); }
  }));
  el.querySelectorAll('[data-discard]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Discard this queued mail? The draft stays in your Drafts folder.')) return;
    await api('/api/outbox/' + b.dataset.discard + '/discard', { method: 'POST' }); loadOutbox();
  }));
}
$('reqApproval').addEventListener('change', async () => {
  if (!$('reqApproval').checked && !confirm('Allow Claude to send mail directly, without your approval?')) { $('reqApproval').checked = true; return; }
  await api('/api/outbox/settings', { method: 'POST', body: { requireApproval: $('reqApproval').checked } }); loadOutbox();
});

/* ------------------------------ connect ------------------------------ */
async function loadConnect() {
  const [tokens, grants] = await Promise.all([api('/api/tokens'), api('/api/grants')]);
  $('tokens').innerHTML = tokens.length ? tokens.map(t => \`<tr><td>\${esc(t.name)}</td><td class="mono">\${esc(t.prefix)}…</td><td>\${when(t.createdAt)}</td>
    <td>\${ago(t.lastUsedAt)}</td><td>\${when(new Date(t.expiresAt * 1000).toISOString())}</td><td class="right"><button class="sm danger" data-revoke="\${t.id}">Revoke</button></td></tr>\`).join('')
    : '<tr><td colspan="6" class="muted">No tokens yet.</td></tr>';
  $('tokens').querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Revoke this token? Anything using it stops working now.')) return;
    await api('/api/tokens/' + b.dataset.revoke, { method: 'DELETE' }); loadConnect();
  }));
  $('grants').innerHTML = grants.length ? grants.map(g => \`<tr><td>\${esc(g.clientName)}</td><td>\${when(g.createdAt)}</td><td>\${ago(g.lastUsedAt)}</td>
    <td class="right"><button class="sm danger" data-grant="\${g.id}">Disconnect</button></td></tr>\`).join('')
    : '<tr><td colspan="4" class="muted">No connected apps.</td></tr>';
  $('grants').querySelectorAll('[data-grant]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Disconnect this app? It will have to be authorized again.')) return;
    await api('/api/grants/' + b.dataset.grant, { method: 'DELETE' }); loadConnect();
  }));
}
$('tokCreate').addEventListener('click', async () => {
  status('tokStatus', 'Creating…');
  try {
    const r = await api('/api/tokens', { method: 'POST', body: { name: $('tokName').value, ttlDays: Number($('tokTtl').value) } });
    $('tokValue').textContent = r.token;
    $('tokCli').textContent = 'claude mcp add --transport http --scope user private-office ' + MCP_URL + ' --header "Authorization: Bearer ' + r.token + '"';
    $('tokNew').classList.remove('hidden'); $('tokName').value = ''; status('tokStatus', '');
    loadConnect();
  } catch (e) { status('tokStatus', e.message, 'bad'); }
});

/* ------------------------------ activity ------------------------------ */
let actCursor;
function describe(r) {
  const d = r.details || {}; const bits = [];
  if (r.target) bits.push(esc(r.target));
  for (const k of ['tool','folder','uid','uids','to','subject','path','target','label','name','client','error','reason','method','role','status'])
    if (d[k] !== undefined && k !== 'target') bits.push('<span class="muted">' + k + '</span> ' + esc(d[k]));
  return bits.join(' · ');
}
async function loadActivity(reset) {
  if (reset) { actCursor = undefined; $('activity').innerHTML = ''; }
  const q = new URLSearchParams();
  if ($('actKind').value) q.set('kind', $('actKind').value);
  if ($('actFrom').value) q.set('from', $('actFrom').value);
  if ($('actTo').value) q.set('to', $('actTo').value);
  if (actCursor) q.set('cursor', actCursor);
  $('actCsv').href = '/api/activity.csv?' + q.toString();
  const page = await api('/api/activity?' + q.toString());
  actCursor = page.cursor; $('actMore').classList.toggle('hidden', !actCursor);
  const rows = page.items.map(r => \`<tr><td class="nowrap">\${when(r.at)}</td><td><b>\${esc(r.action)}</b>\${r.durationMs ? ' <span class="muted small">' + r.durationMs + ' ms</span>' : ''}</td>
    <td><span class="chip \${r.outcome === 'success' ? 'ok' : r.outcome === 'denied' ? 'warn' : 'bad'}">\${r.outcome}</span></td>
    <td class="small">\${describe(r)}</td><td class="small muted">\${esc(r.client || r.ip || '')}</td></tr>\`).join('');
  $('activity').insertAdjacentHTML('beforeend', rows || (reset ? '<tr><td colspan="5" class="muted">Nothing in this range.</td></tr>' : ''));
}
$('actLoad').addEventListener('click', () => loadActivity(true));
$('actMore').addEventListener('click', () => loadActivity(false));

/* ------------------------------ security ------------------------------ */
async function loadSecurity() {
  const me = await api('/api/me');
  const m = me.mfa || [];
  $('mfaState').textContent = m.length ? 'enabled (' + m.map(x => x === 'totp' ? 'authenticator app' : x).join(', ') + ')' : 'set up at next sign-in';
  $('mfaState').className = 'chip ' + (m.length ? 'ok' : 'warn');
  const sessions = await api('/api/sessions');
  $('sessions').innerHTML = sessions.map(s => \`<tr><td>\${when(s.createdAt)}\${s.current ? ' <span class="chip ok">this browser</span>' : ''}</td><td>\${ago(s.lastSeenAt)}</td>
    <td class="mono">\${esc(s.ip || '')}</td><td class="right">\${s.current ? '' : '<button class="sm danger" data-sess="' + s.id + '">Sign out</button>'}</td></tr>\`).join('');
  $('sessions').querySelectorAll('[data-sess]').forEach(b => b.addEventListener('click', async () => { await api('/api/sessions/' + b.dataset.sess, { method: 'DELETE' }); loadSecurity(); }));
}
$('sessAll').addEventListener('click', async () => {
  if (!confirm('Sign out of every browser, including this one?')) return;
  await api('/api/sessions/revoke-all', { method: 'POST' }); location.href = '/';
});

/* -------------------------------- boot -------------------------------- */
const initial = location.hash.slice(1);
showTab(loaders[initial] ? initial : 'accounts', false);
api('/api/outbox').then(d => { $('obCount').textContent = d.pending.length; $('obCount').classList.toggle('hidden', !d.pending.length); }).catch(() => {});
`,
  });
