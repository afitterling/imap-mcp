import { page, esc, json, CLIENT_LIB } from "../layout.js";
import { ALLOWED_EMAILS } from "../../lib/allowlist.js";
import type { PublicUser } from "../../lib/users.js";

export const adminPage = (nonce: string, user: PublicUser) =>
  page({
    title: "Admin",
    nonce,
    user,
    active: "admin",
    wide: true,
    body: `<div class="wrap wide">
  <h1>Administration</h1>
  <p class="lead">Who may use this server, what everyone has done, and how it sends its own mail.</p>

  <div class="tabs" id="tabs">
    <button data-tab="users" class="cur">Users</button>
    <button data-tab="activity">All activity</button>
    <button data-tab="settings">Settings</button>
  </div>

  <section class="tab cur" id="tab-users">
    <div class="card mb12">
      <h3>Sign-up allowlist</h3>
      <p class="muted small mb0">Only these addresses can create an account (enforced by the Cognito pre-sign-up trigger); the first one is the administrator. The list is fixed in code (<code>src/lib/allowlist.ts</code>).</p>
      <div class="chips">${ALLOWED_EMAILS.map((e) => `<span class="chip">${esc(e)}</span>`).join("")}</div>
    </div>
    <div class="grid" id="users"><div class="empty">Loading…</div></div>
  </section>

  <section class="tab" id="tab-activity">
    <div class="card">
      <div class="row">
        <input type="date" id="actDay" class="grow">
        <select id="actKind" class="grow"><option value="">All kinds</option>
          <option value="auth">Sign-in</option><option value="mfa">Two-factor</option><option value="oauth">Connected apps</option>
          <option value="token">Tokens</option><option value="mcp">Claude mail tools</option><option value="calendar">Calendars &amp; calendar tools</option><option value="account">Mail accounts</option>
          <option value="outbox">Outbox</option><option value="security">Security</option><option value="user">Users</option><option value="settings">Settings</option></select>
        <button id="actLoad">Show</button><a class="btn" id="actCsv" href="#">Export CSV</a>
      </div>
      <div class="tbl mt12"><table><thead><tr><th>When</th><th>User</th><th>What</th><th>Outcome</th><th>Details</th><th>From</th></tr></thead><tbody id="activity"></tbody></table></div>
      <div class="row mt12"><button id="actMore" class="hidden">Load more</button></div>
    </div>
  </section>

  <section class="tab" id="tab-settings">
    <div class="grid cols2">
      <div class="card">
        <h3>System sender</h3>
        <p class="muted small">The mail account used for security alerts and verification codes. Only your own accounts can be chosen.</p>
        <select id="sender"></select>
        <div class="hint">Falls back to the first account of any administrator when unset.</div>
      </div>
      <div class="card">
        <h3>Support contact</h3>
        <label>Email shown on the support page</label><input id="supEmail" type="email" placeholder="ops@example.com">
        <label>Note</label><textarea id="supNote" rows="3" maxlength="500" placeholder="e.g. response within one working day"></textarea>
      </div>
    </div>
    <div class="row mt12"><button class="primary" id="setSave">Save settings</button><span class="status" id="setStatus"></span></div>
  </section>
</div>`,
    script: `${CLIENT_LIB}
const ME = ${json(user)};
const loaders = { users: loadUsers, activity: () => loadActivity(true), settings: loadSettings };
function showTab(name, push) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('cur', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('cur', t.id === 'tab-' + name));
  if (push !== false) history.replaceState(null, '', '#' + name);
  loaders[name]();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

async function loadUsers() {
  const users = await api('/api/admin/users');
  $('users').innerHTML = users.length ? users.map(u => \`<div class="item"><div class="grow">
      <h3>\${esc(u.name)} <span class="chip \${u.role === 'admin' ? 'accent' : ''}">\${u.role}</span>
        <span class="chip \${u.status === 'active' ? 'ok' : 'bad'}">\${u.status}</span>\${u.cognito && !u.cognito.enabled ? '<span class="chip bad">disabled in Cognito</span>' : ''}</h3>
      <div class="meta">\${esc(u.email)}\${u.cognito && u.cognito.status && u.cognito.status !== 'CONFIRMED' ? ' <span class="chip warn">' + esc(u.cognito.status) + '</span>' : ''}</div>
      <div class="chips"><span class="chip">\${u.accounts} account(s)</span><span class="chip">\${u.calendars} calendar(s)</span><span class="chip">\${u.tokens} token(s)</span><span class="chip">\${u.grants} app(s)</span>
        <span class="chip">MFA: \${u.cognito ? ((u.cognito.mfa || []).join(', ') || 'pending setup') : 'unknown'}</span>
        <span class="chip">joined \${when(u.createdAt)}</span><span class="chip">last sign-in \${ago(u.lastLoginAt)}</span></div>
      <div class="status" id="u-\${u.userId}"></div>
    </div><div class="row top">
      \${u.userId === ME.userId ? '<span class="muted small">This is you.</span>' : \`
      <button class="sm" data-act="status" data-val="\${u.status === 'disabled' ? 'active' : 'disabled'}" data-id="\${u.userId}">\${u.status === 'disabled' ? 'Enable' : 'Disable'}</button>
      <button class="sm" data-act="role" data-val="\${u.role === 'admin' ? 'user' : 'admin'}" data-id="\${u.userId}">\${u.role === 'admin' ? 'Make user' : 'Make admin'}</button>
      <button class="sm danger" data-act="reset-mfa" data-id="\${u.userId}">Reset 2FA</button>
      <button class="sm danger" data-act="signout" data-id="\${u.userId}">Sign out everywhere</button>\`}
    </div></div>\`).join('') : '<div class="empty">No users yet.</div>';
  $('users').querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', async () => {
    const msgs = { status: 'Change this user\\'s status?', role: 'Change this user\\'s role?',
      'reset-mfa': 'Reset two-factor for this user? Cognito asks them to set up a new authenticator at next sign-in, and every session, token and app is revoked.',
      signout: 'Sign this user out of every browser and revoke all tokens and apps?' };
    if (!confirm(msgs[b.dataset.act])) return;
    try { await api('/api/admin/users/' + b.dataset.id + '/' + b.dataset.act, { method: 'POST', body: { value: b.dataset.val } }); loadUsers(); }
    catch (e) { status('u-' + b.dataset.id, e.message, 'bad'); }
  }));
}

let actCursor;
function describe(r) {
  const d = r.details || {}; const bits = [];
  if (r.target) bits.push(esc(r.target));
  if (r.actorId && r.actorId !== r.userId) bits.push('<span class="muted">by</span> ' + esc(r.actorEmail || r.actorId));
  for (const k in d) bits.push('<span class="muted">' + esc(k) + '</span> ' + esc(d[k]));
  return bits.join(' · ');
}
async function loadActivity(reset) {
  if (reset) { actCursor = undefined; $('activity').innerHTML = ''; }
  if (!$('actDay').value) $('actDay').value = new Date().toISOString().slice(0, 10);
  const q = new URLSearchParams({ day: $('actDay').value });
  if ($('actKind').value) q.set('kind', $('actKind').value);
  if (actCursor) q.set('cursor', actCursor);
  $('actCsv').href = '/api/admin/activity.csv?' + q.toString();
  const page = await api('/api/admin/activity?' + q.toString());
  actCursor = page.cursor; $('actMore').classList.toggle('hidden', !actCursor);
  const rows = page.items.map(r => \`<tr><td class="nowrap">\${when(r.at)}</td><td class="small">\${esc(r.userEmail || r.userId)}</td>
    <td><b>\${esc(r.action)}</b>\${r.durationMs ? ' <span class="muted small">' + r.durationMs + ' ms</span>' : ''}</td>
    <td><span class="chip \${r.outcome === 'success' ? 'ok' : r.outcome === 'denied' ? 'warn' : 'bad'}">\${r.outcome}</span></td>
    <td class="small">\${describe(r)}</td><td class="small muted">\${esc(r.client || r.ip || '')}</td></tr>\`).join('');
  $('activity').insertAdjacentHTML('beforeend', rows || (reset ? '<tr><td colspan="6" class="muted">Nothing on this day.</td></tr>' : ''));
}
$('actLoad').addEventListener('click', () => loadActivity(true));
$('actMore').addEventListener('click', () => loadActivity(false));

async function loadSettings() {
  const s = await api('/api/admin/settings');
  $('sender').innerHTML = '<option value="">— automatic —</option>' + s.accounts.map(a => '<option value="' + esc(a.accountId) + '"' + (a.accountId === s.systemSender ? ' selected' : '') + '>' + esc(a.label) + ' <' + esc(a.email) + '></option>').join('');
  $('supEmail').value = s.support.email || ''; $('supNote').value = s.support.note || '';
}
$('setSave').addEventListener('click', async () => {
  status('setStatus', 'Saving…');
  try { await api('/api/admin/settings', { method: 'POST', body: { systemSender: $('sender').value, supportEmail: $('supEmail').value, supportNote: $('supNote').value } }); status('setStatus', 'Saved.', 'ok'); }
  catch (e) { status('setStatus', e.message, 'bad'); }
});

const initial = location.hash.slice(1);
showTab(loaders[initial] ? initial : 'users', false);
`,
  });
