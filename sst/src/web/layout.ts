/**
 * One shell for every page. All CSS and JS is inline and carries the per-request CSP
 * nonce; nothing loads from a CDN. Inline `style=""` attributes are not allowed by the
 * CSP, so layout is done with the utility classes below.
 */

export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Safely embed a JSON value inside a <script> block. */
export function json(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export type NavUser = { name: string; email: string; role: "admin" | "user" };

export type PageOpts = {
  title: string;
  nonce: string;
  body: string;
  script?: string;
  /** Signed-in header with app navigation; omitted on public pages. */
  user?: NavUser;
  /** Which nav item is current. */
  active?: "app" | "admin" | "support" | "docs" | "home";
  wide?: boolean;
  description?: string;
};

export const CSS = `
  :root { color-scheme: light dark; --bg:#f6f6f4; --card:#fff; --fg:#1a1a18; --muted:#6b6b66; --line:#e3e3df;
          --accent:#c2552d; --accent-soft:#c2552d1a; --ok:#2f7d4f; --ok-soft:#2f7d4f1a; --bad:#b3392c; --bad-soft:#b3392c1a;
          --warn:#a8720c; --warn-soft:#a8720c1a; --chip:#efefeb; --shadow:0 1px 2px #0000000a, 0 8px 24px -16px #00000033; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#191917; --card:#222220; --fg:#f0efec; --muted:#9a9a94; --line:#33332f;
            --accent:#e07a4f; --accent-soft:#e07a4f22; --ok:#63b183; --ok-soft:#63b18322; --bad:#e08074; --bad-soft:#e0807422;
            --warn:#d9a441; --warn-soft:#d9a44122; --chip:#2c2c29; --shadow:none; }
  }
  * { box-sizing:border-box }
  html { -webkit-text-size-adjust:100% }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif }
  a { color:var(--accent); text-decoration:none } a:hover { text-decoration:underline }
  .wrap { max-width:960px; margin:0 auto; padding:28px 20px 80px } .wrap.wide { max-width:1180px }
  .topbar { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 88%, transparent); backdrop-filter:blur(10px);
            border-bottom:1px solid var(--line) }
  .topbar .in { max-width:1180px; margin:0 auto; padding:12px 20px; display:flex; align-items:center; gap:18px; flex-wrap:wrap }
  .brand { display:flex; align-items:center; gap:10px; font-size:17px; font-weight:650; letter-spacing:-.01em; color:var(--fg) }
  .brand:hover { text-decoration:none }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--accent) }
  .nav { display:flex; gap:4px; margin-left:auto; align-items:center; flex-wrap:wrap }
  .nav a { color:var(--muted); padding:6px 10px; border-radius:8px; font-size:14px; font-weight:550 }
  .nav a:hover { color:var(--fg); background:var(--chip); text-decoration:none }
  .nav a.cur { color:var(--fg); background:var(--chip) }
  .who { font-size:13px; color:var(--muted); padding:0 6px; max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
  h1 { font-size:26px; letter-spacing:-.02em; margin:0 0 6px }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:34px 0 12px }
  h3 { margin:0 0 3px; font-size:15.5px }
  p.lead { color:var(--muted); margin:0 0 20px; font-size:15px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px; box-shadow:var(--shadow) }
  .card + .card { margin-top:12px }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap }
  .between { justify-content:space-between }
  .top { align-items:flex-start }
  .grow { flex:1; min-width:0 }
  .grid { display:grid; gap:12px }
  .cols2 { grid-template-columns:1fr 1fr } .cols3 { grid-template-columns:1fr 1fr 1fr }
  @media (max-width:720px) { .cols2, .cols3 { grid-template-columns:1fr } }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px }
  .field { flex:1; min-width:0; background:var(--bg); border:1px solid var(--line); border-radius:8px;
           padding:9px 11px; overflow-x:auto; white-space:nowrap }
  button, .btn { border:1px solid var(--line); background:var(--card); color:var(--fg); border-radius:8px;
           padding:8px 13px; font-size:13.5px; font-weight:550; cursor:pointer; font-family:inherit; line-height:1.3 }
  button:hover, .btn:hover { border-color:var(--accent); text-decoration:none }
  button.primary, .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff }
  button.ghost { background:transparent }
  button.sm { padding:5px 9px; font-size:12.5px }
  button.danger:hover { border-color:var(--bad); color:var(--bad) }
  button:disabled { opacity:.55; cursor:default }
  .item { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:18px 20px;
          display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; box-shadow:var(--shadow) }
  .meta { color:var(--muted); font-size:13px }
  .chips { margin-top:9px }
  .chip { display:inline-block; background:var(--chip); border-radius:6px; padding:2px 7px; font-size:11.5px; color:var(--muted); margin:0 6px 4px 0 }
  .chip.ok { background:var(--ok-soft); color:var(--ok) } .chip.bad { background:var(--bad-soft); color:var(--bad) }
  .chip.warn { background:var(--warn-soft); color:var(--warn) } .chip.accent { background:var(--accent-soft); color:var(--accent) }
  .empty { color:var(--muted); text-align:center; padding:36px 20px; border:1px dashed var(--line); border-radius:14px }
  dialog { border:1px solid var(--line); border-radius:16px; background:var(--card); color:var(--fg);
           padding:0; width:min(560px,94vw); max-height:90vh }
  dialog::backdrop { background:#0008 }
  .dlg-body { padding:24px; overflow-y:auto; max-height:calc(90vh - 74px) }
  .dlg-foot { display:flex; justify-content:flex-end; gap:8px; padding:14px 24px; border-top:1px solid var(--line) }
  label { display:block; font-size:11.5px; font-weight:650; color:var(--muted); margin:14px 0 5px; text-transform:uppercase; letter-spacing:.04em }
  label.inline { display:flex; align-items:center; gap:10px; margin:0; text-transform:none; letter-spacing:0; font-size:14px; color:var(--fg); font-weight:500 }
  label.inline input { width:auto; margin:0 }
  input, select, textarea { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font-size:14.5px; font-family:inherit }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent); outline-offset:1px }
  input.code { font-family:ui-monospace,Menlo,monospace; font-size:22px; letter-spacing:.3em; text-align:center }
  .hint { font-size:12px; color:var(--muted); margin-top:5px }
  .status { font-size:13px; margin-top:10px; min-height:1em }
  .ok { color:var(--ok) } .bad { color:var(--bad) } .muted { color:var(--muted) }
  .err { margin-top:14px; padding:10px 12px; border-radius:8px; background:var(--bad-soft); color:var(--bad); font-size:13px }
  .note { padding:12px 14px; border-radius:10px; background:var(--accent-soft); font-size:13.5px }
  .note.ok { background:var(--ok-soft); color:var(--fg) } .note.warn { background:var(--warn-soft); color:var(--fg) }
  ol.steps { padding-left:20px; color:var(--muted); font-size:13.5px } ol.steps li { margin:7px 0 } ol.steps b { color:var(--fg); font-weight:600 }
  pre.preview { white-space:pre-wrap; font:12.5px/1.5 ui-monospace,Menlo,monospace; background:var(--bg);
        border:1px solid var(--line); border-radius:8px; padding:10px; margin:10px 0 0; max-height:150px; overflow:auto }
  table { width:100%; border-collapse:collapse; font-size:13px }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top }
  th { font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:650 }
  .tbl { overflow-x:auto }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--line); margin:8px 0 24px; overflow-x:auto }
  .tabs button { border:0; border-bottom:2px solid transparent; border-radius:0; background:none; color:var(--muted); padding:10px 12px; margin-bottom:-1px; white-space:nowrap }
  .tabs button.cur { color:var(--fg); border-bottom-color:var(--accent) }
  .tabs button:hover { color:var(--fg) }
  .tab { display:none } .tab.cur { display:block }
  .auth { min-height:calc(100vh - 60px); display:grid; place-items:center; padding:24px }
  .auth form, .auth .card { width:min(440px,100%) }
  .auth h1 { font-size:21px }
  .auth button.primary { width:100%; margin-top:16px; padding:11px; font-size:15px }
  .auth .foot { margin-top:18px; font-size:12.5px; color:var(--muted); text-align:center }
  .rules { list-style:none; padding:0; margin:8px 0 0; font-size:12.5px; color:var(--muted); display:grid; grid-template-columns:1fr 1fr; gap:3px 12px }
  .rules li::before { content:"○ "; color:var(--muted) } .rules li.ok { color:var(--ok) } .rules li.ok::before { content:"● " }
  .choice { display:grid; gap:10px; margin-top:8px }
  .choice a, .choice button.card { display:block; text-align:left; padding:14px 16px; color:var(--fg); width:100%; font:inherit }
  .choice a:hover { text-decoration:none; border-color:var(--accent) }
  .choice small { display:block; color:var(--muted); margin-top:3px; font-size:12.5px }
  .codes { display:grid; grid-template-columns:1fr 1fr; gap:6px 18px; font-family:ui-monospace,Menlo,monospace; font-size:15px;
           background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:14px 18px; margin:12px 0 }
  .qr { background:#fff; border-radius:12px; padding:12px; width:200px; height:200px; margin:12px auto } .qr svg { width:100%; height:100% }
  .docs { display:grid; grid-template-columns:220px 1fr; gap:36px } @media (max-width:820px) { .docs { grid-template-columns:1fr } .toc { position:static } }
  .toc { position:sticky; top:70px; align-self:start; font-size:13.5px } .toc a { display:block; color:var(--muted); padding:4px 0 } .toc a:hover { color:var(--fg); text-decoration:none }
  .toc .sub { padding-left:12px; font-size:12.5px }
  .prose h2 { font-size:22px; text-transform:none; letter-spacing:-.01em; color:var(--fg); margin:44px 0 10px; padding-top:8px; border-top:1px solid var(--line) }
  .prose h2:first-child { margin-top:0; border:0; padding-top:0 }
  .prose h3 { font-size:16px; margin:26px 0 8px } .prose p, .prose li { font-size:14.5px; color:var(--fg) } .prose p { margin:0 0 12px }
  .prose ol, .prose ul { padding-left:22px; margin:0 0 14px } .prose li { margin:5px 0 } .prose li b { font-weight:600 }
  .prose code { background:var(--chip); padding:1px 5px; border-radius:5px }
  .kv { display:grid; grid-template-columns:auto 1fr auto; gap:6px 14px; align-items:center; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:12px 14px; margin:8px 0 14px; font-size:13.5px }
  .kv .k { color:var(--muted) }
  .hero { padding:56px 0 30px } .hero h1 { font-size:38px; line-height:1.1; margin-bottom:14px; max-width:720px }
  .hero p { font-size:17px; color:var(--muted); max-width:620px; margin:0 0 24px }
  .feature h3 { font-size:15px; margin-bottom:6px } .feature p { margin:0; color:var(--muted); font-size:13.5px }
  .faq details { border-bottom:1px solid var(--line); padding:12px 0 }
  .faq summary { cursor:pointer; font-weight:600; font-size:14.5px } .faq details p, .faq details li { color:var(--muted); font-size:13.5px }
  .faq details p { margin:8px 0 0 }
  .center{justify-content:center}.mt8{margin-top:8px}.mt12{margin-top:12px}.mt16{margin-top:16px}.mt24{margin-top:24px}.mb0{margin-bottom:0}.mb12{margin-bottom:12px}
  .small{font-size:12.5px}.right{text-align:right}.nowrap{white-space:nowrap}.w100{width:100%}.hidden{display:none!important}
  .toggle { display:inline-flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); cursor:pointer }
  .toggle input { width:auto; margin:0 }
  footer { margin-top:60px; padding-top:20px; border-top:1px solid var(--line); color:var(--muted); font-size:12.5px; display:flex; gap:16px; flex-wrap:wrap }
`;

export function page(o: PageOpts): string {
  const nav = o.user
    ? `<nav class="nav">
        <a href="/app" class="${o.active === "app" ? "cur" : ""}">My mail</a>
        ${o.user.role === "admin" ? `<a href="/admin" class="${o.active === "admin" ? "cur" : ""}">Admin</a>` : ""}
        <a href="/docs" class="${o.active === "docs" ? "cur" : ""}">Manual</a>
        <a href="/support" class="${o.active === "support" ? "cur" : ""}">Support</a>
        <span class="who" title="${esc(o.user.email)}">${esc(o.user.name)}</span>
        <form method="post" action="/logout"><button class="ghost sm">Sign out</button></form>
      </nav>`
    : `<nav class="nav">
        <a href="/docs" class="${o.active === "docs" ? "cur" : ""}">Manual</a>
        <a href="/support" class="${o.active === "support" ? "cur" : ""}">Support</a>
        <a href="/login" class="btn primary">Sign in</a>
      </nav>`;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(o.title)} — Private Office MCP</title>
${o.description ? `<meta name="description" content="${esc(o.description)}">` : ""}
<style nonce="${o.nonce}">${CSS}</style>
</head>
<body>
<div class="topbar"><div class="in"><a class="brand" href="/"><span class="dot"></span> Private Office MCP</a>${nav}</div></div>
${o.body}
${o.script ? `<script nonce="${o.nonce}">${o.script}</script>` : ""}
</body></html>`;
}

/** Shared browser helpers, prepended to every page script. */
export const CLIENT_LIB = `
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(path, opts) {
  const o = Object.assign({ headers: {} }, opts || {});
  if (o.body && typeof o.body !== 'string') { o.body = JSON.stringify(o.body); o.headers['content-type'] = 'application/json'; }
  o.headers['x-requested-with'] = 'fetch';
  const res = await fetch(path, o);
  if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!res.ok) throw new Error(body.error || ('Request failed (' + res.status + ')'));
  return body;
}
function status(id, msg, cls) { const s = $(id); if (!s) return; s.className = 'status ' + (cls || ''); s.textContent = msg || ''; }
function copyText(text, btn) {
  navigator.clipboard.writeText(text);
  if (btn) { const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1200); }
}
function when(iso) { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString(); }
function ago(iso) { if (!iso) return 'never'; const s = (Date.now() - new Date(iso)) / 1000; if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s/60) + ' min ago'; if (s < 86400) return Math.floor(s/3600) + ' h ago'; return Math.floor(s/86400) + ' d ago'; }
document.addEventListener('click', (e) => { const b = e.target.closest('[data-copy]'); if (b) copyText($(b.dataset.copy).textContent.trim(), b); });
`;
