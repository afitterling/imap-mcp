import { page, esc } from "../layout.js";

/** Shown only when a Cognito round-trip fails; the normal path is a straight redirect. */
export const authPage = (nonce: string, opts: { error?: string } = {}) =>
  page({
    title: "Sign in",
    nonce,
    body: `<div class="auth">
  <div class="card">
    <h1>Sign in</h1>
    <p class="lead">Sign-in is handled by the account service: e-mail, password and your authenticator app.</p>
    ${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ""}
    <a class="btn primary w100 mt16" href="/login">Continue to sign-in</a>
    <div class="foot">No account yet? The sign-in page has a <b>Sign up</b> link — only pre-approved addresses are accepted. · <a href="/support">Need help?</a></div>
  </div>
</div>`,
  });
