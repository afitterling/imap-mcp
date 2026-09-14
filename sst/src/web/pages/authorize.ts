import { page, esc } from "../layout.js";

/** OAuth consent for MCP clients: the button hands the user to Cognito (password + MFA), then the grant is minted. */
export const authorizePage = (nonce: string, opts: { clientName: string; params: Record<string, string>; signedInAs?: string }) =>
  page({
    title: `Authorize ${opts.clientName}`,
    nonce,
    body: `<div class="auth">
  <form method="post" action="/oauth/authorize" class="card">
    <h1>Authorize ${esc(opts.clientName)}</h1>
    <p class="lead">It wants to connect to your mail and calendars through Private Office MCP. After you approve, it can act as you:</p>
    <ol class="steps">
      <li><b>Read and search</b> messages and events in everything you have connected</li>
      <li><b>Draft and queue mail</b> — sending still needs your approval in the Outbox</li>
      <li><b>Move messages, change flags, manage events</b>, except on accounts and calendars you mark read-only</li>
    </ol>
    ${Object.entries(opts.params)
      .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
      .join("")}
    <button type="submit" class="primary">Sign in and approve</button>
    <div class="foot">${opts.signedInAs ? `You are signed in to the web app as ${esc(opts.signedInAs)}; connecting an app asks for your credentials again.<br>` : ""}You can disconnect this app at any time under Connect Claude → Connected apps.</div>
  </form>
</div>`,
  });
