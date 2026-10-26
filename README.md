# Kapani — Supabase migration

The client migration moves Firebase Realtime Database/Auth/Storage to Supabase
Auth, Postgres RPC, Realtime, Storage and an Edge Function for Web Push.

See [`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md) for deployment and tests.

The folders `functions/`, `cloudflare-worker/` and `push-worker/` plus Firebase
reports are retained only as historical references; do not deploy those builds.

The KapaniPride Supabase project now contains the compatible SQL bridge,
public-name lookup, media bucket, and the deployed `kapani-push` Edge Function.
The function's health endpoint has reported `vapid: true`.

The downloadable website is still a **pre-release**. It has not yet been
published or tested with two signed-in users on the target GitHub Pages URL.
The bridge deliberately rejects client-side money and role mutations:
legacy economic operations need the protected `kp_*` Supabase RPCs before
public release. See the migration status for the remaining work.
