# 2bee.app local sign-in: design for cyber review, v2 (2026-11-23)

**Status:** DESIGN ONLY. No code until `cyber` signs off (ceo condition 3, ticket `11-17-40`).
**Founder:** "go on local auth" (home ticket `2026-11-23-11-30-00`). The reason is one less
dependency. Cost is not a reason: Cognito costs US$0 here.
**Background and measurements:** `docs/plan-local-auth.md`.
**Criteria answered:** cyber `2026-11-23-11-18-43`, items 1-8 plus the CVP H-072 check, in that order.
**Owners:** backend builds the server side; 2bee_app builds the sign-in screen and removes the
Cognito code from `web/src/auth.ts`.

**v2 changes:**
- v1 was email link plus passkey, with a Neon store.
- v2 takes backend's buildability read (`2026-11-23-11-33-45`): **passkey only, no email**. All
  state is in **DynamoDB**. The authorizer **accepts both** token types during cut-over. A
  **CloudFront Function** rewrites `/api/*`.
- Why passkey-only: one admin exists today. The email path (SES, SQS, sender Lambda, link tokens,
  enumeration-proofing, two rate-limit layers) protected a step the passkey already makes
  phishing-resistant. Dropping it is also closer to the founder's reason, one less dependency.
- The cost of dropping it: a lost passkey needs the operator CLI. v1 already made that the only
  recovery route, so nothing is lost there.
- v1 is in git history (`24dd5ac20d`) if cyber prefers it.

## 0. Shape, in one paragraph

2bee.app is an admin-only tool. Founder TODO #29 says "only admins can log in", and the browser
enforces it since H-083 (`b92aa2ba94`). The server also enforces it, through backend's interim
`_is_admin` in `app_docs.py`. The new design enforces admin in a Lambda authorizer on every
request.

Sign-in is one step:
1. The person presses "Sign in with passkey".
2. The browser runs a WebAuthn assertion with a discoverable credential, so the person types no
   username.
3. The server verifies it against a passkey that an operator-issued enrolment code registered.
4. The server issues an opaque session in a `__Host-` HttpOnly cookie, same-origin through
   2bee.app's own CloudFront.

There are no passwords, no email and no sign-up anywhere. Cognito is untouched and stays for
2bee.farm. Only the `2bee-app-oidc` client goes, after cut-over.

**Who is affected (measured 2026-11-23):**
- Table `two-bee-app-docs` holds 14 documents under **1** distinct `user_sub`.
- That sub is the founder's account, the pool's only `custom:role=admin`.
- The other 12 pool users have no 2bee.app data, and they cannot pass the admin check anyway.
- So the migration has **one** user.

## 1. Password hashing

**Not applicable: there are no passwords.**
- Secrets the server holds:
  - session tokens and enrolment codes, each 256 bits from `secrets.token_bytes(32)`, stored only
    as SHA-256;
  - WebAuthn public keys, which are not secret.
- A fast hash is right for 256-bit random values: brute force is infeasible at any hash speed.
  A slow hash only matters for low-entropy human passwords.
- WebAuthn library: `webauthn` (py_webauthn, Duo Labs), pure Python on top of `cryptography`,
  which the API bundle already ships. The version is pinned with a hash in `requirements.txt`, and
  backend records the exact version at build.

## 2. Admin role is never written by a user (H-073)

- DynamoDB table `two-bee-app-users`: PK `id`, with `role` (`admin` | `disabled`),
  `cognito_sub`, `label`, `created_at`.
- DynamoDB table `two-bee-app-passkeys`: PK `credential_id`, with `user_id`, `public_key`,
  `sign_count`, `created_at`, `last_used_at`.
- **IAM enforces it, not convention.**
  - The API and authorizer Lambda roles get `dynamodb:GetItem`/`Query` only on `app-users`.
  - On `app-passkeys` they get only `GetItem`, `Query` and a conditional `UpdateItem` limited to
    `sign_count`/`last_used_at`.
  - **Only the operator CLI `scripts/app_users.py`** writes users, roles or passkey rows. It runs
    with operator AWS credentials and is not reachable from any Lambda role.
  - Exception: the enrolment route writes exactly one passkey row, and only for the user named on
    a valid, unused enrolment code. The CLI creates that code (see 5).
- No HTTP route accepts `role`, `id`, `user_id` or `cognito_sub`. Route bodies are WebAuthn
  ceremony objects only. Unknown fields are rejected with 400.
- **Tests (backend):**
  - (a) Assertion and enrolment bodies with an added `role:"admin"`, `user_id` or `cognito_sub`
    are rejected and change nothing.
  - (b) An enrolment code cannot register a passkey for any user other than its own.
  - (c) A `disabled` user gets no session, and existing sessions stop at the next request.
  - (d) The IAM test: the authorizer role's `PutItem` on `app-users` is denied (policy simulator
    or a live call).

## 3. Sessions

- **No JWT and no signing key.**
  - The cookie carries a 256-bit random token.
  - DynamoDB table `two-bee-app-sessions` is keyed by `sha256(token)` and stores `user_id`,
    `created_at`, `last_seen_at`, `expires_at` (a TTL attribute) and `revoked`.
  - With no key, there is no key rotation. A table read leaks no usable token.
- **Lifetime:** idle timeout 24 h, absolute 7 days, then a new passkey sign-in. No refresh token.
  The server slides `last_seen_at` at most once a minute. TTL removes expired rows, so no sweep
  job is needed.
- **Transport:**
  - 2bee.app's CloudFront `E3FJDJCTELYYXY` gets a behaviour `/api/*` with a **CloudFront Function
    rewriting `/api/` → `/app/`** to the API Gateway origin.
  - Caching is disabled on that behaviour. The origin request policy forwards `Cookie`, `Origin`
    and `X-2bee`.
  - Cookie: `__Host-2bee_s`, `HttpOnly; Secure; SameSite=Strict; Path=/`. JavaScript never sees a
    token, which beats today's ID token in sessionStorage.
  - The WebAuthn RP ID is `2bee.app` and the origin is `https://2bee.app`. Both hold because the
    API is same-origin.
- **CSRF:** SameSite=Strict, plus every state-changing request must carry
  `Origin: https://2bee.app` and `X-2bee: 1`. The authorizer and handlers check both.
- **Revocation:**
  - Sign-out revokes this session.
  - "Sign out everywhere" revokes all of the user's sessions (a query on a `user_id` index).
  - `app_users.py disable` and `passkey-reset` revoke all sessions.
  - **A stolen session token is killed** by sign-out everywhere from any signed-in device, or by
    the CLI.
  - The authorizer reads the session and the user's role on every request, with result cache TTL
    0. A single-digit-ms DynamoDB `GetItem` makes that affordable, so a revocation takes effect at
    the next request.
- **Mobile:** not applicable. No mobile app uses 2bee.app's client.
- **The authorizer** is a Lambda authorizer on `/app/*`.
  - It allows only a live session whose user has `role=admin`, and passes `userId` and
    `admin=true`.
  - `app_docs.py` reads `authorizer.userId`. Backend's interim `_is_admin` accepts the
    authorizer's admin context, so there is no gap in the gate.
  - **During cut-over only** (8), the same authorizer also accepts a Cognito
    `Authorization: Bearer` ID token. It verifies the JWKS, issuer, audience `2bee-app-oidc` and
    `custom:role == admin`, as `auth.py` does today. This is needed because a REST method has
    exactly one authorizer.
  - The Cognito branch is deleted at step 5.
- **Quota (ceo addition, H-083):** a per-user counter of documents and bytes, kept in the same
  conditional write as each put. Limits are set by backend. The authorizer already limits callers
  to admins.

## 4. Rate limits and enumeration

- **WAF:**
  - Attach the existing CloudFront-scope `two-bee-waf-sites` (us-east-1) to `E3FJDJCTELYYXY`.
    That adds per-request cents and no second ACL fee.
  - Add `RateAppAuth` for `/api/auth/` at 100 per 5 min per IP, the WAF minimum.
  - Today the distribution has **no** web ACL (`WebACLId` empty, measured 2026-11-23).
- **Application:** 10 failed assertions or enrolments per IP per 15 min, then 429, kept as a
  DynamoDB atomic counter with TTL.
- **Enumeration:** nothing to enumerate.
  - Discoverable credentials mean the server never takes a username or email.
  - The challenge endpoint takes no identifier and returns a random challenge (stored, single use,
    5 min TTL).
  - Every failure returns the same "sign-in failed": unknown credential, bad signature, replayed
    challenge, disabled user.

## 5. Account recovery

- **Lost passkey = operator reset, never self-service.**
  1. The founder confirms out of band, in person or at the founder's own terminal.
  2. Backend runs `app_users.py passkey-reset <user>`. It revokes all sessions, optionally
     deletes the lost credential, and prints a one-time **enrolment code**: 256-bit, valid 15 min,
     single use (conditional write), stored as SHA-256.
  3. On `https://2bee.app/#enrol`, the person enters the code and registers a new passkey.
- No route lets a user recover without the operator, so no route bypasses the factor.
- **Recommendation:** enrol two passkeys at cut-over (laptop and phone), so losing one device
  needs no reset.

## 6. MFA

- **Today:** pool `65Y4fzSoR` allows TOTP (OPTIONAL), but **0 of 13 users have enrolled**
  (measured 2026-11-23). No TOTP secret needs migrating; re-measure on cut-over day.
- **New path:** a passkey is phishing-resistant and is itself multi-factor: the device, plus the
  device's user verification. The design requires `userVerification: "required"`, so the
  biometric or device PIN must be checked. This meets H-072.
- **First passkey bootstrap:** **the CLI enrolment code** (5), the same route as recovery, so there
  is one enrolment path.
  - v1 bootstrapped from a Cognito admin ID token instead. That is kept as cyber's alternative
    (open question 2). It would let the founder enrol without backend, but it would keep a second
    enrolment path alive for the cut-over week.
- **Required test step:**
  1. Enrol a passkey.
  2. Sign out.
  3. Sign in again with the passkey and land in the app.
  4. Sign in with a cancelled or unknown passkey: no session.
  5. Old session after "sign out everywhere": 401.
  6. Enrolment code used twice: the second use is refused.

  Backend and 2bee_app both run it, and the founder runs steps 1-3 on the real account at
  cut-over.

## 7. User migration

- `app_users.py import-from-cognito` creates a user row for each pool user with
  `custom:role == admin` (1 today), with `id = cognito_sub`. The 14 documents stay under the same
  `user_sub`, so no data moves.
- Nobody else is imported. A non-admin cannot use 2bee.app, before or after.
- No password hashes are needed, so the fact that Cognito does not export them does not matter.
- No mail is sent. Backend hands the founder an enrolment code in person or at the terminal. The
  founder enrols two passkeys and signs in.

## 8. Cut-over and rollback

**Order on the jamesave route (cyber 2026-11-27; supersedes the AWS-route list below):**
1. Build the prod instance (own user, DB, roles, socket), `plant_test.sh`, socket and tunnel checks,
   cache and rate rules on a temporary hostname, header diff.
2. `migrate_docs` and `import-from-cognito`: dry run, real run, census (14 docs, count and sha256
   per body, both sides). BEFORE the switch: S3 bodies are CSP-blocked after it.
3. DNS switch, founder at the terminal. 4. Issue the CLI enrolment code at once; founder enrols two
   passkeys on `https://2bee.app` and runs the section 6 test; then the A test with two sessions
   (a passkey for `RP_ID=2bee.app` can only be enrolled at that origin, so prod enrolment follows the
   switch; a stage enrolment is a rehearsal only). 5. Any failure: DNS back to CloudFront, same sitting.
Then steps 4 to 7 below (measure, remove Cognito code, 7-day watch, delete `2bee-app-oidc`).
`/` must not be served `immutable`, or a rollback would show a stale bundle from browser caches.

**Order (original AWS-route list):**
1. Backend ships the tables, CLI, routes, the authorizer (accepting a session **or** a Cognito
   admin ID token), the CloudFront Function and behaviour, and the WAF attach and rule. The
   authorizer replaces the Cognito authorizer on `/app/*`. Today's bundle keeps working through
   the Cognito branch.
2. 2bee_app ships a bundle that offers "Sign in with passkey" and keeps the Cognito sign-in.
3. The founder enrols passkeys, signs in on the new path, and runs the section 6 test step.
4. Measure (below).
5. Delete the authorizer's Cognito branch, and remove the Cognito code from the bundle.
6. Watch for 7 days.
7. Delete the `2bee-app-oidc` client, and tell home and ceo.

**The pool is never deleted. It belongs to 2bee.farm.**

**"Every active user" is measured, not assumed:**
- The set is every `user_sub` with an item in `two-bee-app-docs`, plus every pool user with
  `custom:role=admin`, re-read on the day (1 today).
- Each one must have a passkey row and a session created on the new path.
- The query and its output are pasted into the cut-over ticket.

**Rollback (CORRECTED 2026-11-27, backend on cyber 14-36-19):**
- On the jamesave route the whole `2bee.app` hostname moves to the tunnel, and the CSP stays
  `connect-src 'self'` (Cognito and S3 are NOT added back). Once the hostname is on jamesave the
  bundle's Cognito branch is dead there, so the DNS switch IS the user-facing cut-over. **Rollback
  before step 5 is the DNS edit back to CloudFront `E3FJDJCTELYYXY` (left untouched), not a bundle
  redeploy.** The "Cognito still works" claim below holds only on the old AWS route.
- Old AWS route only: until step 5, Cognito still works through the same authorizer. Rollback is a
  bundle redeploy of the previous commit (`build-info.json` records it).
- After step 5 and before step 7, rollback is restoring the Cognito branch (a code revert and
  redeploy) plus the previous bundle.
- After step 7, rollback means re-creating the client with the same settings. That is the reason
  for the 7-day watch.

## CVP H-072 check

No 2bee.app feature invokes Claude through company credentials.
- The CAD assistant talks only to `tools/claude-bridge` on the user's own computer: 127.0.0.1,
  with the user's own `claude` CLI and key.
- `web/src` contains no `api.anthropic.com` call and no Anthropic key (grep, 2026-11-23).

v2 has no magic link at all, and every sign-in is a user-verified passkey. So this design meets
the 2026-12-15 phishing-resistant requirement whatever the scope reading.

## 9. Signed off, and the API contract (2026-11-23)

> **STACK MOVED, 2026-11-23 11:45.** The founder chose **jamesave** for the platform (home
> `12-45-00`, ceo `2026-11-23-11-45-02`). Backend builds the sign-in service there once, on the
> target stack, not on AWS:
> - a systemd unit under its own user, behind the Cloudflare Tunnel;
> - a separate Postgres with separate API and CLI roles;
> - cyber's app gates A1-A8, which include an SSRF sandbox (cyber `2026-11-23-11-43-58`).
>
> **What that supersedes:** the AWS-specific server parts of sections 2-4 and condition C:
> DynamoDB tables and IAM, the Lambda authorizer, CloudFront Function, WAF rule, and CloudTrail
> data events. Their jamesave equivalents (Postgres roles, the INSERT-only audit table,
> Cloudflare rules) are backend's and cyber's to state.
>
> **What stands unchanged:**
> - The WebAuthn rules (condition B) and the Cognito time-box (E).
> - Session lifetimes, CLI-only enrolment, passkey-only.
> - **The browser contract in the table below.** It names only same-origin paths, a cookie and
>   JSON, so it does not depend on where the server runs.
>
> The browser half shipped against it (`bf1202a192`), hidden until `/api/auth/session` answers
> the contract's JSON.

**cyber signed v2 off** (`2026-11-23-11-36-29`):
- 24 h idle / 7 d absolute sessions are accepted.
- The first passkey comes from the CLI enrolment code. There is NO Cognito-token enrolment route.
- Passkey-only.

**Build conditions A-E, verified at the cut-over test (section 8 step 3) before step 5:**
- **A.** Two sessions through CloudFront get two different `/api/*` responses, and `x-cache` is
  never `Hit from cloudfront`.
- **B.** Assertions:
  - The assertion's `userHandle` must equal the credential row's `user_id`.
  - A sign-count regression is rejected when either count is non-zero (conditional `UpdateItem`).
  - Enrolment uses `residentKey: required` and `userVerification: required`, and binds to the
    code's user only.
  - `rpId=2bee.app`, origin exactly `https://2bee.app`.
- **C.** Audit trail:
  - CloudTrail data events (WriteOnly) for `two-bee-app-users` and `two-bee-app-passkeys` on
    `two-bee-main`.
  - A metric filter and alarm on `two-bee-app-users` writes by any principal other than the CLI's,
    paging `two-bee-audit-alerts`.
  - Management events stay WriteOnly (H-081).
- **D.** Every unauthenticated endpoint is under `/api/auth/`, so `RateAppAuth` covers it.
- **E.** The authorizer's Cognito branch checks `token_use=id`, `exp`, `iss`,
  `aud=2bee-app-oidc` and `custom:role == admin`. It is deleted at step 5, and **no later than
  14 days after step 1 ships**.

**H-083 closes** when cyber sees a non-admin or missing session get 401 on `/api/app/docs`
after step 5.

**Quota:** dropped. ceo withdrew it (`11-34-55`), and cyber calls it optional once only admins can
hold a session.

**API contract.** The browser sees these paths through CloudFront. The CloudFront Function
rewrites `/api/` to the API Gateway `/app/` prefix: `/api/auth/x` reaches `/app/auth/x`, and
`/api/docs/...` reaches `/app/docs/...`.

**Every request:**
- Same-origin, `credentials: 'same-origin'`.
- Header `X-2bee: 1`.
- `Content-Type: application/json` when there is a body.
- WebAuthn binary fields are base64url strings, in the W3C JSON shape
  (`PublicKeyCredential.toJSON()`, py_webauthn `options_to_json` /
  `parse_*_credential_json`).
- Every error body is `{"error": "<code>"}`.

| method + path | body | success | failure |
|---|---|---|---|
| `GET /api/auth/session` | none | `200 {"userId": str, "admin": true, "expiresAt": epoch-seconds}` | `401 {"error":"unauthenticated"}` |
| `POST /api/auth/challenge` | `{}` | `200 {"publicKey": PublicKeyCredentialRequestOptionsJSON}` (`allowCredentials` empty, `userVerification: "required"`, `rpId: "2bee.app"`, `timeout` ≤ 300000) | `429 {"error":"rate_limited"}` |
| `POST /api/auth/assert` | `{"credential": AuthenticationResponseJSON}` | `204`, sets `__Host-2bee_s` | `401 {"error":"sign_in_failed"}` (one code for every cause) · `429` |
| `POST /api/auth/enrol/options` | `{"code": str}` | `200 {"publicKey": PublicKeyCredentialCreationOptionsJSON}` (`residentKey: "required"`, `userVerification: "required"`, `user.id` = the code's user, `excludeCredentials` = their existing passkeys) | `401 {"error":"enrol_failed"}` (bad, used or expired code) · `429` |
| `POST /api/auth/enrol/finish` | `{"code": str, "credential": RegistrationResponseJSON, "label": str ≤ 40}` | `204`. Uses up the code. Starts no session: the user signs in next. | `401 {"error":"enrol_failed"}` · `429` |
| `POST /api/auth/signout` | `{}` | `204`, clears the cookie | `204` even with no session |
| `POST /api/auth/signout-all` | `{}` | `204`, revokes every session of the user | `401` |
| `* /api/docs/...` | as `app_docs.py` today | as today | `401 {"error":"unauthenticated"}` |

**The browser shows the passkey sign-in only when `GET /api/auth/session` answers JSON** (401 or
200). Until backend ships, the path falls through to the S3 origin and answers something else, so
the button stays hidden and the deployed page is unchanged.

**Node migration script:** `web/scripts/migrate-local-to-server.ts` sends an ID token to
`api.2bee.farm`. That keeps working through the Cognito branch until step 5. Before step 5, the
remaining founder doc migration either runs, or the script learns the session cookie. 2bee_app's
item.

## Open questions for cyber (answered in section 9)

1. Is a 24 h idle and 7-day absolute session acceptable for an admin-only tool, or should it be shorter?
2. First passkey: the CLI enrolment code (v2 default, one enrolment path), or a Cognito admin ID token
   during the cut-over week (no backend hand-off)?
3. Passkey-only (v2) or email link plus passkey (v1)?
