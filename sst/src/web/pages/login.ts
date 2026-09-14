import { page, esc, CLIENT_LIB } from "../layout.js";

/** Shown only when a Cognito round-trip fails; the normal path is a straight redirect. */
export const authPage = (nonce: string, opts: { error?: string; continueHref?: string } = {}) =>
  page({
    title: "Sign in",
    nonce,
    body: `<div class="auth">
  <div class="card">
    <h1>Sign in</h1>
    <p class="lead">Sign-in is handled by the account service: e-mail, password and your authenticator app.</p>
    ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
    <a class="btn primary w100 mt16" href="${esc(opts.continueHref ?? "/login")}">Continue to sign-in</a>
    <div class="foot">No account yet? The sign-in page has a <b>Sign up</b> link — only pre-approved addresses are accepted. · <a href="/support">Need help?</a></div>
  </div>
</div>`,
  });

/** Mandatory first step after a sign-in without a registered authenticator. */
export const setupMfaPage = (nonce: string, opts: { qrSvg: string; secret: string; email: string; error?: string }) =>
  page({
    title: "Set up your authenticator",
    nonce,
    body: `<div class="auth">
  <form method="post" action="/setup-mfa" class="card">
    <h1>One more step: your authenticator app</h1>
    <p class="lead">Every account needs an authenticator app (1Password, Apple Passwords, Google Authenticator, Authy…). Scan the code, then enter the 6 digits it shows.</p>
    <div class="qr">${opts.qrSvg}</div>
    <div class="hint">Can't scan? Manual key for <b>${esc(opts.email)}</b>: <code id="sec">${esc(opts.secret.replace(/(.{4})/g, "$1 ").trim())}</code> <button type="button" class="sm" data-copy="sec">Copy</button></div>
    <label for="c">Code from the app</label>
    <input id="c" name="code" class="code" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" maxlength="7" required autofocus>
    <button type="submit" class="primary">Activate and continue</button>
    ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
    <div class="foot"><form method="post" action="/logout"><button class="ghost sm">Cancel and sign out</button></form></div>
  </form>
</div>`,
    script: CLIENT_LIB,
  });
