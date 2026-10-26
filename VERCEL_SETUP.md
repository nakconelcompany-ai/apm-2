# Vercel deployment setup

This project uses local JSON files while running on a computer. On Vercel, it
uses Neon Postgres for registrations and a private Vercel Blob store for voter
card uploads because function filesystems are not persistent.

1. In the Vercel project, install the Neon Postgres Marketplace integration and
   connect it to the project. Make sure `DATABASE_URL` is available to the
   deployment.
2. From the project's **Storage** tab, create a Vercel Blob store with **Private**
   access and connect it to the project. Enable it for Production and Preview.
   Vercel should provide `BLOB_STORE_ID` (or configure the store's read/write
   token for the deployment).
3. Add a strong, unique `ADMIN_PASSWORD` environment variable to the project.
   The admin page asks for this password before loading registration data or
   viewing uploaded files.
4. Use Node.js 20 or newer in the Vercel project settings, then redeploy.

The build script copies the root-level site pages and images into `public/` for
Vercel's static asset delivery. Keep the generated `public/` files committed so
the static assets are included even when the Vercel project does not run a build
command.
Registration data and voter card files are not stored on the Vercel function's
local filesystem. Uploads are limited to 4 MB on Vercel to stay within the
function request-body limit; local development retains the 10 MB limit.
