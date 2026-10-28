# Vercel deployment setup

The app stores registration records in Neon Postgres whenever `DATABASE_URL` is
configured. In production, new voter-card files are stored in a private Neon
Object Storage bucket. Locally, card files use disk storage; JSON is used for
registrations only when `DATABASE_URL` is absent.

## Production environment

1. Connect the Vercel project to Neon and make `DATABASE_URL` available to the
   deployment.
2. In the same Neon project and production branch, enable Object Storage and
   create a bucket with **private** access. Neon currently documents 5 GB of
   free object storage per project, separate from PostgreSQL storage.
3. Create a Neon credential with `storage:read` and `storage:write` scopes.
   Configure these Vercel environment variables using the Neon Storage
   connection details:
   - `AWS_ENDPOINT_URL_S3`
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `NEON_STORAGE_BUCKET` (the private bucket name)
4. Generate a 32-byte account-encryption key with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
   Set it as `ACCOUNT_ENCRYPTION_KEY` in Vercel. Keep a secure backup of this
   key: losing or changing it makes stored account numbers unreadable.
5. Configure `ADMIN_USERNAME` and a strong, unique `ADMIN_PASSWORD`.
6. Use Node.js 20 or newer and redeploy.

The server creates the Postgres registration table when it is first needed.
Voter-card files uploaded in production are written to the private Neon bucket,
and the admin API streams those files only after successful admin
authentication. Bank account numbers are encrypted with AES-256-GCM before
they are saved; the admin API reveals them only when an authenticated admin
opens a record. The registration API returns only the account-number suffix in
the list response. Locally, set `DATABASE_URL` and `ACCOUNT_ENCRYPTION_KEY` to
use Neon for registration data and encrypted account numbers; uploads remain
in the local `data/uploads/` folder.

Existing uploads stored in private Vercel Blob remain readable and deletable
through the admin dashboard; they are not automatically copied to Neon. Keep
the existing Vercel Blob credentials available until those files are migrated
or removed.

The build script copies the root site pages and assets into `public/`, including
the locally hosted OCR and PDF.js browser workers under `public/vendor/`. Run
`npm run build` before deployment, or commit the generated public assets when
the Vercel project does not run a build command.

## Additional security hardening

The app serves its form and API from the same origin, so it does not enable
cross-origin API access. Responses include basic browser security headers, and
voter-card uploads are limited to 3 MB and checked against their image
signatures. The in-browser OCR only checks for voter-card-like text; it cannot
prove that a card is genuine or officially valid.

For production, use a unique admin password stored only in Vercel environment
variables, configure Vercel Firewall/WAF rules and rate limits for registration
and admin endpoints where available, and enable multi-factor authentication
for the Vercel and Neon accounts. Avoid in-memory rate limiting in a serverless
deployment, where instances do not share counters.
The `/admin` route is served directly by the app.

## Local development

Create a git-ignored `.env` file in the project root and set `DATABASE_URL` and
`ACCOUNT_ENCRYPTION_KEY` (a 64-character hexadecimal key). `npm start` and
`npm run dev` load `.env` automatically. If you omit `DATABASE_URL`, local
registrations use `data/registrations.json`. Never commit `.env` or storage
credentials.
