# Staging workflow

The `staging` branch is the pre-release copy of the site. Cloudflare Pages can
publish it at `staging.sr-brm-v3.pages.dev` when that branch is enabled for
preview deployments. The canonical `sr-brm-v3.pages.dev` host continues to use
the production API; branch previews and local development use the staging API.

## Keep test data separate

The frontend selects its API by hostname in `app.js`. The Worker source is in
`worker/index.js`. Before using the staging site, create a **separate D1 database**
for staging and deploy the Worker with the staging environment. Do not point the
staging Worker at the production database.

1. Copy `worker/wrangler.toml.example` to `worker/wrangler.toml` and replace its
   D1 ID placeholder with the staging database ID. This config can only target
   the staging Worker and database. Keep the local config out of commits.
2. From `worker/`, deploy staging with `npx wrangler deploy`.
3. Set the staging-only `TEAM_PINS` secret with
   `npx wrangler secret put TEAM_PINS --env staging`.
4. In Cloudflare Pages, keep `main` as the production branch and enable branch
   previews for `staging`. Push the `staging` branch to publish its preview.
5. Use only test riders / consented devices on staging. Its tracking codes,
   checkpoint entries, and location data are stored in the staging D1 database.

The Worker creates its tables on first use. The app does not promote staging
database contents to production.

## Promote a tested change

After review, merge the tested `staging` commit into `main`. Cloudflare Pages
then publishes the same frontend code on the production host, where the host
check in `app.js` selects the production API. If the Worker changed too, copy
`worker/wrangler.production.toml.example` to
`worker/wrangler.production.toml`, set the production D1 ID, and deploy with
`npx wrangler deploy --config wrangler.production.toml` from `worker/`. Production
requires its own `TEAM_PINS` secret. Keep staging and production PIN secrets
separate.

## One-time Cloudflare setup still needed

This repository contains the Worker source now, but Cloudflare account settings
are not stored in Git. The staging D1 database, its ID, the staging `TEAM_PINS`
secret, and Pages preview-branch setting must be configured in the Cloudflare
account before the preview can exercise team features. Staging is configured
with its own Worker name and D1 binding, so its deploy command cannot target the
production Worker or database.
