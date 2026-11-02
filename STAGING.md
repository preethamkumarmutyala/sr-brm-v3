# Staging workflow

The `staging` branch is the pre-release copy of the site. Cloudflare Pages can
publish it at `staging.sr-brm-v3.pages.dev` when branch previews are enabled.
The canonical `sr-brm-v3.pages.dev` host continues to use the production API;
branch previews and local development use the staging API.

## Keep test data separate

The frontend selects its API by hostname in `app.js`. The Worker source is in
`worker/index.js`. Staging has its own D1 database and Worker. Never point it at
the production database.

1. Copy `worker/wrangler.toml.example` to `worker/wrangler.toml` and set its D1
   ID, Gmail address, administrator email, and staging Pages origin. Keep the
   local config out of commits.
2. Create a Gmail App Password for the sending account and set it as the
   `GMAIL_APP_PASSWORD` secret on the staging Worker. Do not put it in Git or
   send it in chat. Google requires 2-Step Verification for App Passwords.
3. From `worker/`, deploy staging with `npx wrangler deploy`.
4. In Cloudflare Pages, keep `main` as the production branch and enable branch
   previews for `staging`. Push the `staging` branch to publish its preview.
5. Visit `#team` on staging and choose “Set up first administrator”. The email
   must match `BOOTSTRAP_ADMIN_EMAIL`; the setup link is delivered by Gmail.
   Once the first account is active, administrators can invite and manage users
   from the Team desk. Editors can record ride data; administrators can also
   manage access. Users can change or reset their own passwords.
6. Use only test riders / consented devices on staging. Tracking codes, control
   entries, and location data are stored in the staging D1 database.

Invitations and password-reset links expire after one hour and work once.
Passwords are stored as salted PBKDF2 hashes. Sessions are revocable and expire
after 12 hours. The Worker creates the auth tables on first use. The app does
not promote staging database contents to production.

## Promote a tested change

After review, merge the tested `staging` commit into `main`. Cloudflare Pages
then publishes the same frontend code on the production host, where the host
check in `app.js` selects the production API. If the Worker changed too, copy
`worker/wrangler.production.toml.example` to
`worker/wrangler.production.toml`, set a production D1 ID, verified sender,
owner email and site origin, then deploy with `npx wrangler deploy --config
wrangler.production.toml` from `worker/`. Set a production-only
`GMAIL_APP_PASSWORD` secret. Keep production rollout separate from staging setup.

## One-time service setup

The staging D1 database and Pages preview setting already belong to Cloudflare.
Email delivery uses Gmail SMTP over a TLS connection. Google App Passwords
require 2-Step Verification and are stored only as a Worker secret. The staging
Worker and D1 binding are isolated from production.
