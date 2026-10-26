# Kapani / Supabase — installation and verification

Status: migration code prepared; **live schema/function changes not deployed**.

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

Execute `supabase/001_tree_bridge.sql` on the intended Supabase project after
review. It creates additional tables and functions, configures Realtime
invalidation and a public-read `kapani-media` bucket. Existing `kp_*` tables
are not deleted or overwritten.

Deploy `supabase/functions/kapani-push/index.ts`. The included
`supabase/config.toml` disables gateway JWT verification because `/register`
and `/health` are intentionally accessible without a signed-in account.
Other endpoints verify the Supabase user JWT inside the function.

Set Edge Function secrets `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and
`VAPID_SUBJECT` (a `mailto:` contact). They must belong to one P-256 key pair.
The public half in `config.js` must match. Never ship the private half in a
public repository or in an archive sent to users.

Deploy the site over HTTPS. The `firebase-messaging-sw.js` filename is
retained for existing Service Worker registrations, but the actual code is
standard Web Push, with no Firebase Messaging integration.

Since old Firebase data is intentionally discarded, old Kapani nick/password
accounts will need new registration. New password hashes stay inside
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

This package is not a verified complete production migration until the
protected finance/order flows and deployed push stack pass integration tests.
