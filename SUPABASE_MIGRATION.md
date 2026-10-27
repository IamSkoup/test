# Kapani / Supabase — installation and verification

## KSB fines and emergency dispatch — 27 October 2026

The supplied site build now includes `supabase/007_duty_fines_and_emergency_calls.sql`.
**Apply this SQL in Supabase SQL Editor before publishing the new site files.**
The SQL is additive and does not reset existing accounts, wallets or calls.
Existing deployments should apply **007 only**, provided 001–006 are already installed.

This migration adds role-checked `kp_duty_fine` (atomic wallet debit,
ledger history and municipal treasury credit), and protected dispatch RPCs
for creating, listing and closing KSB/police or medical calls. It also adds
the staff-recipient lookup and displays the issuer/reason in bank history.
The previous browser-side `users/<other>/balance` write is removed.
Only the assigned KSB/police staff or mayor may fine people; medics can see
and close only medical calls. The mayor has dispatch supervision access.
The same fine request ID can be retried safely without charging twice.
Fines respect the site's -2500 ₽ debt limit; the RPC rejects a fine when
it would exceed that limit, rather than creating inconsistent ledger state.

Smoke-test using two authenticated test accounts after applying 007. Issue
a KSB fine and verify the recipient balance, bank history, treasury and
notification. Check that a normal resident cannot fine anyone or read/close
staff calls, that medical calls appear for both a doctor and assistant, and
that a KSB call cannot be closed by medical staff. The notification worker
needs its normal configured push service; failed push delivery does not erase
the durable dispatch call, which staff panels poll every 10 seconds.

Local regression coverage: `node tests/duty-dispatch.test.cjs` and
`python3 tests/validate-syntax.py`. Live multi-account tests are still
required; these scripts cannot confirm live Supabase permissions on their own.

Status on 26 October 2026: the KapaniPride project's SQL bridge, Storage bucket,
public-name lookup, and `kapani-push` Edge Function **have been deployed**.
The live `/health` endpoint returned `{"ok":true,"backend":"supabase","vapid":true}`.
This does not mean the website is published or the migration is complete.

Later repair status: live verification found that `kp_mayor_adjust_balance`,
bank transfers, savings transfers, referral statistics and private mayor
queues need their own server functions. The new definitions are in
`supabase/004_verified_money_and_mayor.sql` and **were installed on 26 October 2026**.
All 11 functions were confirmed to be SECURITY DEFINER, unavailable to `anon`
and executable by `authenticated` with internal role/ownership validation.
The live schema keeps RLS enabled and UPDATE privileges revoked for both
client roles on `kp_wallets`, `kp_ledger`, and `kp_tree_roots`. The SQL left
all balances untouched during installation. The existing site still uses its
previous published code until the fixed archive is deployed to GitHub Pages.

## Architecture

`config.js` contains only the project URL and public key. Browser database
operations run through `supabase-bridge.js` and the guarded SQL procedure in
`supabase/001_tree_bridge.sql`. Supabase Auth verifies passwords. An Edge
Function handles nickname-based registration, Web Push devices and creating
in-app notifications. Files use resumable TUS uploads with visible progress.

The existing protected tables and operations for `kp_wallets`, `kp_ledger`,
`kp_roles`, `kp_taxi_orders` and other core finance features are preserved.
The legacy adapter rejects self-issued money, roles and verification state.
Finance, subscription, municipal and order mutations must still be adapted
to use those protected operations before public release.

## Deployment

The intended Supabase project is `npivvwwkdnbeqmjcwrke`. An equivalent
additive SQL migration was applied through the dashboard, followed by the
`kp_public_profiles()` function. The migration creates new tables and functions,
Realtime invalidation, and the public-read `kapani-media` bucket. It does not
delete or overwrite any preexisting financial `kp_*` table or records.
The included SQL script is a reproducible definition for fresh deployments;
rerun it only after reviewing its impact on the target environment.

The function `kapani-push` has been deployed via Supabase's built-in editor.
The included `supabase/config.toml` disables gateway JWT verification because `/register`
and `/health` are intentionally accessible without a signed-in account.
Other endpoints verify the Supabase user JWT inside the function.

Edge Function secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
`VAPID_SUBJECT` were added through the dashboard. The VAPID subject is the
placeholder `mailto:push@kapani.example`; replace it with a real contact
address before public production. The two keys must belong to one P-256 key pair.
The public half in `config.js` must match. Never ship the private half in a
public repository or in an archive sent to users.

Deploy the site over HTTPS. The `firebase-messaging-sw.js` filename is
retained for existing Service Worker registrations, but the actual code is
standard Web Push, with no Firebase Messaging integration.

Old Firebase-only nick/password accounts which were never migrated into
Supabase Auth still need new registration. Existing Supabase Auth accounts
are preserved, including the old «Кайон» account. Password hashes stay inside
Supabase Auth and are not included in public user records.

## Acceptance tests

Run `python3 tests/validate-syntax.py` and
`node --test tests/supabase-migration.test.cjs` first. Then use two devices
or browsers to check registration, login persistence, logout, chat messages,
DMs, image/audio/video/video-circle media, progress, cancellation and retry.
Afterward test in-app notification delivery and genuine push after the
recipient closes the site tab. Verify that the media link actually plays on
the receiving device.

Supabase Free limits files to 50 MB; this client allows at most 49 MB per
upload. On iOS, background push requires installing the web app to the Home
Screen. Push when the entire browser process is stopped depends on the OS;
the server can deliver to the browser Push Service independently of an open
Kapani tab, but cannot override platform restrictions.

Security checks in the live SQL editor confirmed that direct browser calls
cannot change account balances, casino balances, administrative roles or the
municipal treasury. An additional privilege check confirmed RLS enabled and
no direct authenticated UPDATE grants on `kp_wallets`, `kp_ledger`, `kp_roles`,
`kp_treasury`, `kp_tree_roots`, and `kp_push_devices`.

Not yet completed: port the legacy finance, casino outcomes, subscriptions,
jobs, taxi/delivery and mayor actions to protected server-side operations;
publish the static website; then run genuine multi-account, multi-browser
end-to-end tests for sign-in, chat, image/audio/video uploads, and closed-tab
push. Failed protected legacy mutations should display errors rather than
silently re-enable unsafe balance editing. Do not consider this package ready
for all public features until those gaps are closed.

## Compatibility repair / 26 October

The complete `supabase/002_account_and_tasks.sql` was applied to the
`npivvwwkdnbeqmjcwrke` project on 26 October 2026. Verification in the SQL
Editor found all six procedures installed: `kp_public_profiles`,
`kp_ensure_my_profile`, `kp_manage_notifications`, `kp_profile_patch`,
`kp_claim_task`, and `kp_withdraw_tasks`. The five owner-only procedures
are executable by authenticated users only, while `kp_public_profiles`
returns public names to guests for the login screen.

This migration adds owner-only RPCs for notification
removal, safe profile updates, verified limited task rewards and atomic
withdrawal from the task balance into the canonical `kp_wallets` balance with
ledger entry. No browser operation can choose reward amounts or directly set
balances. The browser UI must still be published and two-account operations
smoke-tested. Other finance and job features described above remain blocked.

The initial database migrations have already been run. Do not run them again merely to
deploy the new frontend. Apply only new `006_auth_referrals.sql` if upgrading an existing
installation, then upload the updated static files to `/test/` with the
same relative directory layout. Existing `kp_*` accounts, wallets and messages
were not deleted by the migration. If creating a fresh Supabase project, run
the complete SQL in the editor with no selection (button "Run" rather than
"Run selected").

Registration now sees all nicknames reserved in `kp_profiles`, including old
accounts whose profile document was never created. Login and registration are
separate flows: login never creates a new account. The UI accepts only nickname
and password, with an optional inviter nickname available only on registration.
The `kapani-push` Edge Function has a public `nickname-login` route: it securely
resolves original Auth emails server-side for older accounts, asks Supabase Auth
to verify the password, and returns session tokens without exposing the email.
**Redeploy the updated `supabase/functions/kapani-push/index.ts`** with gateway
JWT verification disabled, as for the original `register` route. Without this
redeployment, older accounts using nonstandard Auth emails cannot sign in via
nickname only. On successful sign-in, `kp_ensure_my_profile()` creates its
missing JSON user document only for the caller and keeps the wallet balance.
If the password is forgotten, recovery remains an administrator-assisted
Supabase Auth task; never publish or share a password or JWT.
Changing the public display name preserves the
stable internal username so conversations, authentication and references are
not orphaned. Login resolves the new display name to that original username.

The leaderboard now uses a default avatar when none was saved, and a failed
avatar URL also falls back. Account password changes use Supabase Auth, not
client-side `passwordHash`. Avatar changes do not require mayoral confirmation.

The website now supports opening `index.html` directly from a local folder
with `file://` (for example, by double-clicking it on Windows). Startup uses
ordered, deferred classic JavaScript scripts instead of same-origin ES module
imports. The Supabase browser SDK still loads from jsDelivr, so a working
internet connection is required to sign in or read/write account data.
`start-kapani.bat` remains an optional local HTTP preview. Browser push,
Service Workers and PWA installation require HTTPS, not `file://`.

`supabase/003_protected_app_operations.sql` is the follow-up migration for
passports, administrative account verification, municipal treasury snapshot,
treasury withdrawal/clear, and weekly account maintenance. It must be applied
in the Supabase SQL Editor after migrations 001 and 002 *before* deploying the
matching frontend; copying HTML alone does not create these functions.
Protected legacy operations not covered by the migration, including arbitrary
business fees, salaries, savings interest and many cashier/casino commands,
remain unavailable. Never relax row-level security to make those work; they
need individually audited transactional server functions.

`supabase/006_auth_referrals.sql` is a narrow follow-up migration for the
optional inviter field. Apply it once in Supabase SQL Editor after 005. It
validates that the inviter exists and isn't the new account before persisting
referral fields with server-generated timestamps. Privileged fields supplied
by the browser (including balances and jobs) continue to be discarded.
