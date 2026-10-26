# Kapani — Supabase migration

The client migration moves Firebase Realtime Database/Auth/Storage to Supabase
Auth, Postgres RPC, Realtime, Storage and an Edge Function for Web Push.

See [`SUPABASE_MIGRATION.md`](SUPABASE_MIGRATION.md) for deployment and tests.

The folders `functions/`, `cloudflare-worker/` and `push-worker/` plus Firebase
reports are retained only as historical references; do not deploy those builds.

This is an integration draft until the new SQL and Edge Function are deployed.
The bridge deliberately rejects client-side money and role mutations: legacy
economic operations need the protected `kp_*` Supabase RPCs before release.
