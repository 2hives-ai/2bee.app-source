# 2bee.app sign-in without Cognito: findings and proposal (2026-11-23)

Ticket: `handover/2bee_app/2026-11-23-12-25-00-home-2bee-app-local-auth-no-cognito.md`.
Founder, 23 Nov: *"2bee.app can use local authentication as well (no cognito)"*, raised during
the AWS cost cuts and the teardown of account 304870251905.

## 1. What 2bee.app signs in against (measured 2026-11-23)

| fact | value | how measured |
|---|---|---|
| Hosted UI domain | `2bee-farm.auth.ap-southeast-2.amazoncognito.com` | `software/backend/scripts/deploy_app_2bee.sh:76` |
| Pool | `ap-southeast-2_65Y4fzSoR` (`two-bee-users`) | `aws --profile 696 cognito-idp describe-user-pool-domain --domain 2bee-farm` |
| Account | **696616821268**, not 304 | same call, `AWSAccountId` |
| 2bee.app's client | `2bee-app-oidc` (public, PKCE) | `list-user-pool-clients` |
| Users in the pool | 13 (10 CONFIRMED, 3 UNCONFIRMED) | `list-users` |
| MFA | pool `OPTIONAL`; **0 users** have MFA set up | `admin-get-user` per user, `UserMFASettingList` |
| Tier | ESSENTIALS | `describe-user-pool` |
| Cognito cost on 696 | **$0.00** for Sep, Oct, Nov 2026 | `aws --profile 696 ce get-cost-and-usage`, SERVICE = Amazon Cognito |
| Pools in 304 | none in ap-southeast-2 or us-east-1 | `aws --profile 304 cognito-idp list-user-pools` |

**The pool is shared.** Besides `2bee-app-oidc` it has the 2bee.farm app client
(`HiveUserPoolHiveAppClient…`), two `fleet-admin-ai` clients, and it is the authorizer of three
REST APIs in 696: `2bee-api`, `two-bee-qr-api` and `2bee-api-game`.

So:
- 2bee.app does not hold anything up in the 304 teardown.
- Moving 2bee.app off Cognito does **not** let the pool be deleted. 2bee.farm still needs it.
  Only the `2bee-app-oidc` client could be deleted.
- It saves **$0** today. 13 users is far inside the Essentials free tier.

## 2. How 2bee.app uses the pool today

- `web/src/auth.ts`: Authorization Code + PKCE against the Hosted UI. Tokens in sessionStorage.
  An "admin only" check on the `cognito:groups` claim (no `admin` group exists in the pool, so
  every signed-in user passes).
- `web/src/serverStore.ts`: sends the Cognito **ID token** to `https://api.2bee.farm/app/docs`.
  API Gateway checks it with the Cognito authorizer. The docs Lambda (`app_docs.py`) keys every
  document on the token's `sub` claim.
- No mobile app uses the `2bee-app-oidc` client. The 2bee.farm mobile app is a separate client.
- 2bee.app has no server of its own. Local sign-in therefore needs a backend piece, and that
  piece belongs to `backend`.

## 3. Proposal, if the founder still wants it

Email sign-in links, the 2hives.com M4 shape (`home/2hives/app/twohives/accounts.py`):

1. **Users table** (Neon, owned by backend): `id`, `email` (unique, lower-case),
   `cognito_sub` (nullable, for migration), `created_at`, `disabled`.
2. **Sign-in link**: `POST /app/auth/link {email}`. It always answers 202, so the reply never
   says whether an account exists. The server stores only the SHA-256 of a 32-byte random token,
   valid 15 minutes and usable once, and mails `https://2bee.app/#signin=<token>`. Rate limits
   apply per email and per IP. Mail needs SES set up from scratch: the live pool sends with `COGNITO_DEFAULT`, not SES (backend correction, ticket `2026-11-23-11-23-50`).
3. **Session**: `POST /app/auth/redeem {token}` returns an HttpOnly, Secure, SameSite=Strict
   cookie on `api.2bee.farm` (session id stored as a hash, 30-day sliding), or a short-lived
   bearer if a cross-site cookie is refused. `POST /app/auth/logout` ends the session.
4. **Authorizer**: a Lambda authorizer on `/app/*` reads the session and passes `userId`. The
   docs Lambda keys on that instead of `sub`.
5. **Migration of the 13 users**: copy each user's email and `sub` into the table. Document keys
   do not change: for a migrated user `userId = cognito_sub`, so every document stays where it
   is. Every existing user signs in with one email link. No passwords move, and none are needed.
6. **MFA**: none to carry over (0 enrolled). An email link already proves the mailbox.
7. **Cut-over**: both paths accepted for one week, then the Cognito path and `auth.ts`'s PKCE
   code removed, then `2bee-app-oidc` deleted. **The pool stays** for 2bee.farm.

Rough size: backend about 2 days (table, 3 routes, authorizer, SES template, tests); 2bee.app
about 1 day (sign-in screen, cookie or bearer handling, removal of `auth.ts`).

## 4. Recommendation

**Hold until the founder rules on it.** The ticket's reason was cost and a blocked teardown.
Measured, neither applies: the pool costs $0, it is in 696 not 304, and 2bee.farm keeps it alive
either way. What the move would buy is one fewer dependency for 2bee.app alone. What it would
cost is about three days of work and a new home-built sign-in system, which is the riskiest code
in any app. If the founder still says go, section 3 is the plan, and backend builds steps 1-4.

## 5. Status and the review criteria (2026-11-23, later)

**UPDATE 11:30: founder GO** (home ticket `2026-11-23-11-30-00`). The design for cyber is now
`docs/design-local-auth.md`. It supersedes section 3 here: link plus passkey, admins only,
same-origin sessions. The "HELD" paragraph below is history.

**HELD.** `ceo` (ticket `2026-11-23-11-21-55`) put go/no-go in the founder queue with a no-go
recommendation. No code starts before a founder go **and** a `cyber` sign-off against
`handover/2bee_app/_done/2026-11-23-11-18-43-cyber-local-auth-design-review-criteria.md`.
If the founder says go, rewrite section 3 as the one-page answer to those 8 items first.

Facts already measured for that page:
- **MFA (item 6):** the pool allows TOTP (`OPTIONAL`), but **0 of 13 users have enrolled**
  (`admin-get-user` → empty `UserMFASettingList` for every user, 2026-11-23). No TOTP secret
  needs migrating today. Re-measure at cut-over.
- **CVP H-072 scope:** no 2bee.app feature calls Claude with company credentials. The CAD
  assistant talks only to `tools/claude-bridge` on the user's own computer (127.0.0.1, the
  user's own `claude` CLI and key). `web/src` has no `api.anthropic.com` call and no Anthropic
  key (grep, 2026-11-23). Re-check if a server-side assistant is ever added.
- **Role (item 2):** 2bee.app reads only `cognito:groups` (`web/src/auth.ts:276`), never a
  `custom:role`. The pool has no `admin` group, so every signed-in user passes the admin check
  today. The new design must store role in a server-only column, as cyber asks.
