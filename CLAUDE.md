# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project rules

- **All backend and server-side code must be built with SST on AWS.** Do not introduce other hosting platforms, serverless frameworks, or infrastructure-as-code tools for server-side code. Define infrastructure (functions, APIs, databases, queues, auth, etc.) as SST constructs and deploy with SST to AWS.
- **All mobile code must be written in Swift.** Build iOS/Apple-platform apps natively in Swift (SwiftUI/UIKit, Swift Package Manager). Do not introduce cross-platform mobile frameworks such as React Native, Flutter, Kotlin Multiplatform, or Capacitor, and do not write mobile app code in Objective-C, JavaScript, or Dart.
- **Authentication must use Amazon Cognito with OAuth 2.0 and MFA.** Define the Cognito user pool and app clients as SST constructs. Clients (mobile and web) authenticate through Cognito's OAuth 2.0 / OpenID Connect flows (authorization code with PKCE for the Swift app), never through hand-rolled login or a third-party identity provider. Enable multi-factor authentication on the user pool and require it for every user. Backend APIs must validate Cognito-issued JWTs.
- **Keep an audit trail in Amazon CloudWatch Logs.** Every backend function and API must emit structured (JSON) log entries to CloudWatch Logs for security- and data-relevant events: authentication and MFA outcomes, authorization failures, and every create/update/delete of user data, including who acted (Cognito `sub`), what changed, when, and the request ID. Never log secrets, tokens, passwords, or full PII. Configure log groups and retention in SST rather than relying on Lambda defaults.
- **Tag every SST resource with the project definition.** Project name: `webmail-mcp`. Set default tags in `sst.config.ts` so every AWS resource SST creates carries at least `Project=webmail-mcp`, `Stage=<stage>`, and `ManagedBy=SST`. Do not create untagged resources or override these tags per resource.
- **All code must have tests.** Every new feature or bug fix ships with automated tests covering it, and existing tests must pass before work is considered done. Use the project's native test tooling (Swift Testing / XCTest for Swift targets, the test runner defined in the package manifest for SST/TypeScript code).


## Security rules

- **No secrets in code or committed config.** Store API keys, tokens, and connection strings as SST Secrets (`sst.Secret`) and pass them to functions via resource linking. Never hardcode them, never commit `.env` files, and never bundle them into the Swift app.
- **Least-privilege IAM.** Grant permissions through SST resource linking so each function gets only the actions it needs on the resources it uses. Do not write IAM policies with `*` actions or `*` resources, and do not attach AWS managed admin policies.
- **Everything private by default.** No public S3 buckets, no publicly accessible databases, no security groups open to `0.0.0.0/0`. Expose only the API and static assets that must be reachable, through HTTPS with TLS 1.2 or newer.
- **Encrypt at rest and in transit.** Enable encryption on every data store (S3, DynamoDB, RDS, SQS, etc.) using AWS-managed or customer-managed KMS keys defined in SST. Reject plain HTTP.
- **Protect every API route.** Every route must have a Cognito JWT authorizer unless it is explicitly documented as public. Validate and schema-check all request input on the server; never trust client-supplied user IDs, use the `sub` from the validated token. Enable throttling on the API and put AWS WAF in front of public endpoints.
- **Harden the Swift app.** Store tokens only in the Keychain, never in `UserDefaults` or files. Keep App Transport Security enabled with no exceptions. Use short-lived access tokens with refresh via Cognito, and clear tokens on sign-out.
- **Keep dependencies clean.** Pin dependency versions, run `npm audit` and review Swift package updates before merging, and do not add unmaintained or unnecessary packages.
- **Minimise and protect user data.** Collect only the data the feature needs, define a retention period for it, and implement account and data deletion. Never write PII to logs or error messages (see the audit-trail rule above).

## Git workflow

- **Every project must be a git repository from the first file.** Before writing any code, run `git init` in the project root (with `main` as the default branch), commit the initial scaffold, and add a remote. Do not create or edit source files in a directory that is not under git. All branch work must happen in git worktrees as described below; refusing to use worktrees is not an option.

  ```bash
  git init -b main                                                 # initialise the repository (required first step)
  git add . && git commit -m "Initial commit"                       # commit the scaffold before any feature work
  git remote add origin <url> && git push -u origin main            # connect the remote
  ```

- **Use git worktrees for parallel work.** Never switch branches in the main checkout while a task is in progress. Create a worktree per feature or fix so each branch has its own working directory and its own `sst dev` session:

  ```bash
  git worktree add ../<repo>-<feature> -b feature/<feature> main   # new branch in a sibling directory
  git worktree list                                                # see all active worktrees
  git worktree remove ../<repo>-<feature>                          # remove after the branch is merged
  git worktree prune                                               # clean up stale worktree metadata
  ```

- Branch from `main`, keep branches short-lived, and open a pull request into `main`. Do not commit directly to `main`.
- Each worktree needs its own `npm install` (and `.sst/` state is per directory). Never share a `.env` file between worktrees; SST Secrets are read from the stage, not from the checkout.
- Run `sst dev` from inside the worktree so the personal stage it creates matches the branch you are working on.

## Deploy commands

All deployments go through SST. Stages map to AWS environments: every developer works in a personal stage with `sst dev`, shared integration lives in `dev`, and `production` is deployed only from `main`.

```bash
npm install                                   # install pinned dependencies first
npx sst dev                                   # live development on a personal stage (defaults to your local username)
npx sst dev --stage <name>                    # live development on an explicitly named personal stage

npx sst deploy --stage dev                    # deploy the shared dev environment
npx sst deploy --stage production             # deploy production (only from main, after tests pass)

npx sst diff --stage production               # preview infrastructure changes before a production deploy
npx sst secret set <Name> <value> --stage dev # set an SST Secret for a stage (never commit values)
npx sst secret list --stage production        # list secret names for a stage
npx sst remove --stage <personal-stage>       # tear down a personal stage when done
```

- Set `protect: true` for the `production` stage in `sst.config.ts` so `sst remove` cannot delete it, and use `removal: "retain"` for production data stores.
- Run `npx sst diff --stage production` and the full test suite before every production deploy. Never deploy production from a feature branch or a worktree other than `main`.
- Never run `sst remove` against `dev` or `production`; personal stages are the only ones that may be torn down freely.
- Deployments must run with an IAM identity scoped to the target stage; do not deploy with root or admin credentials.

## Keeping this file useful

Once the project has real content, add:

- **Commands**: how to build, lint, run tests, and run a single test, using the exact commands the project's tooling defines (package manifest scripts, Makefile targets, `sst` commands, `swift` commands, etc.).
- **Architecture**: the big-picture structure that requires reading several files to understand (how SST stacks relate to app code, how Swift targets are organized, deployment stages), not a file-by-file listing.

Do not add generic development advice here. Keep it specific to this repository.
