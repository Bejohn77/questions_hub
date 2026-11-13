# প্রশ্নপত্র | Bengali Question Paper Maker

Bengali-first MCQ/CQ editor with live A4 print preview, two-column question flow, locally bundled Noto Bengali fonts, MathLive equations, answer-key printing, account-backed drafts, Admin DOCX/text-based PDF question import without OCR, CSV/XLSX question export, protected question-image uploads, and browser-generated PDF output.

## Application structure

- `frontend/`: independent Next.js + TypeScript web application.
- `backend/`: independent Express + TypeScript REST API. Prisma schema, PostgreSQL access, migrations, and seed code are backend-only.
- Each project has its own `package.json`, npm lockfile, environment example, and dependency installation. No npm workspaces are required.
- Database schema and checked-in migrations remain in `backend/prisma/`. Existing PostgreSQL data is preserved; do not reset or replace the database.

## Hostinger Business Web Hosting support checked

Hostinger's current documentation lists Business Web Hosting as supporting managed Node.js web applications, including both Next.js and Express.js. The supported runtime versions include Node.js 22.x, which both project manifests select. Hostinger documents deploying each monorepo application as a separate Node.js website by setting that app's root directory. Business/Unlimited plans currently allow five Node.js websites, with a plan-wide process limit of 120 (60 entry processes) and a 120-second request timeout; Node.js web hosting does not support inbound WebSockets or always-running background workers. This project needs two web apps, has no WebSocket or worker requirement, and paper/PDF layout remains browser-rendered.

The Hostinger website-app runtime is not a VPS or a PostgreSQL server. The existing Prisma datasource is PostgreSQL, so point `DATABASE_URL` at the project's existing external PostgreSQL service (for example, its existing Supabase session-pooler connection on port 5432). Do not convert the schema to MySQL or run migrations against a new/empty database. Confirm the database provider allows connections from Hostinger and use TLS where available.

Official Hostinger references, checked 30 October 2026:

- [Node.js website deployment and supported frameworks/plans](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)
- [Deploy separate applications from a monorepo](https://www.hostinger.com/support/how-to-deploy-monorepos-with-npm-yarn-or-pnpm-on-hostinger/)
- [Node.js runtime version selection](https://www.hostinger.com/support/how-to-select-the-node-js-version-for-your-application/)
- [Business plan Node.js process and timeout limits](https://www.hostinger.com/support/hostinger-node-js-limits-for-web-and-cloud-plans/)

## Local development

Requirements: Node.js 22, npm, and access to the existing or a local PostgreSQL database.

```powershell
Copy-Item backend\.env.example backend\.env
Copy-Item frontend\.env.example frontend\.env.local
npm ci --prefix backend
npm ci --prefix frontend
```

In `backend\.env`, configure `DATABASE_URL`, a random `JWT_SECRET` of at least 32 characters, and `WEB_ORIGIN=http://localhost:3000`. Set `API_ORIGIN=http://localhost:4000` in `frontend\.env.local`. The frontend API proxy forwards REST requests at runtime and returns a JSON 502 if the backend cannot be reached. New question images are stored as PostgreSQL `BYTEA`; Supabase settings are optional and used only to read images uploaded by the legacy storage implementation.

Run the applications in separate terminals:

```powershell
npm run dev:backend
npm run dev:frontend
```

Or run `npm run dev` from each application's directory. The frontend is at <http://localhost:3000> and the API is at <http://localhost:4000>. The Next.js `/api/*` proxy forwards requests to `API_ORIGIN`, keeping the HttpOnly session cookie same-origin in the browser. The backend CORS allowlist uses the exact `WEB_ORIGIN`.

The public home page is `/`. Teacher registration and sign-in are at `/register` and `/login`. The authenticated teacher dashboard is `/app`; the separate administrator sign-in and dashboard are `/admin/login` and `/admin`. The API validates every private request and enforces administrator roles. A new administrator must change the bootstrap password before using dashboard or management APIs.

Root convenience commands run both applications' checks:

```powershell
npm run build
npm run lint
npm run typecheck
npm test
```

Apply checked-in additive migrations with `npm run db:deploy` from `backend\`. Build the backend (`npm run build`) so the seed script is compiled, then bootstrap the initial administrator by setting `ADMIN_EMAIL=admin@gmail.com`, `ADMIN_PASSWORD=1234`, and optionally `ADMIN_NAME` in the backend process environment and running `npm run db:seed` from `backend\`. Do not put the temporary password in source control or frontend environment variables. The seed hashes the password, creates an administrator only if no administrator or account with that email exists, refuses to promote or overwrite accounts, and marks the account to require a password change at first login. The same one-time process may be run in production with the environment variables configured as deployment secrets. After bootstrap, remove `ADMIN_PASSWORD` from the backend environment. Set a strong password of at least 12 characters at `/change-password`. Configure SMTP variables to enable password reset.

## Hostinger deployment

Use Hostinger's **Web App / Node.js** deployment flow. With GitHub, create two separate Node.js websites from the same monorepo and set **Root directory** to `frontend` and `backend`, respectively. Hostinger also accepts ZIP uploads: if deploying without a single GitHub monorepo, create and upload one ZIP from each app directory. Select Node.js **22.x** for each website. Use the `package-lock.json` within each selected app, not the root convenience scripts.

| Website | Root directory | Framework | Build command | Output directory | Start/entry |
| --- | --- | --- | --- | --- | --- |
| Frontend | `frontend` | Next.js | `npm ci && npm run build` | `.next` | `npm run start` from the package's `start` script; no custom server entry file |
| Backend | `backend` | Express.js | `npm ci && npm run build` | `dist` | `npm run start`; if an entry file is required, use `dist/src/index.js` |

Set these environment variables in the corresponding Hostinger website settings, never in Git:

**Frontend website**

- `NODE_ENV=production`
- `API_ORIGIN` — the actual backend website's HTTPS origin, with no path or trailing route. Replace any documentation example with the deployed API domain; reserved `example.*` / `.invalid` domains are rejected for production builds.

**Backend website**

- `NODE_ENV=production`
- `DATABASE_URL` — the existing PostgreSQL connection URL. Use the provider's recommended persistent/session connection rather than a transaction-only pooler for migrations.
- `JWT_SECRET` — a random secret of at least 32 characters.
- `WEB_ORIGIN=https://app.example.com` — the exact frontend origin.
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and optionally `SUPABASE_STORAGE_BUCKET` only if legacy Supabase-hosted images must remain readable. New question images are stored in PostgreSQL.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM` if password reset email is enabled.
- Token costs are fixed per question: MCQ `1`, CQ `10`, and Short Question `5`; no token-rate environment setting is required. Set `PAYMENT_WEBHOOK_SECRET` if payment verification is used.

Assign the frontend and API their own HTTPS domains, then set the two origin variables to those exact domains. Hostinger supplies the listening `PORT`; the backend already binds to `0.0.0.0` and uses that variable. Health check: `/health`. The frontend proxy sends REST calls to the API while keeping authentication cookies on the frontend origin. Do not expose backend environment values as `NEXT_PUBLIC_*`.

Prisma migrations are intentionally not run automatically during startup or deployment. Before applying anything to the existing production database, take a backup and inspect status from a machine with the backend dependencies and database access:

```powershell
Set-Location backend
npx prisma migrate status
npm run db:deploy
```

`prisma migrate deploy` applies only checked-in pending migrations; it does not reset or seed existing data. Verify the migration status and review any pending SQL before applying. Hostinger Business has a 120-second request timeout and shared process resources, so keep synchronous imports and API operations within the plan's documented limits. The app does not use inbound WebSockets or background workers.

## Existing features and data

The existing Admin and teacher panels, business rules, question exports, image uploads, equation editor, Bengali typography, MCQ/CQ generation, and browser-generated DOC/PDF/answer-key output remain in the original UI and API implementation. Admins use **Question Upload** to choose MCQ or CQ and set class/subject/chapter/topic, then extract editable question drafts from DOCX or text-based PDF files. Embedded DOCX media is preserved from its original file bytes; PDF image objects are extracted locally without reading their contents. Review question text, options/answers, and image previews before confirming transactional saving. Imports support up to 1,000 questions per request. Scanned/image-only PDFs are rejected; OCR and AI vision are not used. MCQ paper output remains two portrait columns. CQ offers a one-page A4 landscape layout with sequential questions flowing through the left and then right column, and retains the original two-page booklet formula: Page 1 right = Section 1, Page 2 left = Section 2, Page 2 right = Section 3, Page 1 left = Section 4. Questions fill sections sequentially; complete subquestions stay together where possible and continuations retain their question number. CQ output remains limited to 12 questions, does not create overflow pages, and is blocked when selected questions do not fit the selected layout.

Document import is synchronous and uses local DOCX/PDF parsers only. Upload limits are five files, 8 MB per file, and 20 MB combined; PDFs are limited to 200 pages. PDF-derived images are stored as lossless PNG previews, and DOCX media bytes are stored unchanged. Admin review and server-side validation are required before transactional database saving. No OCR service key or native OCR runtime is required.

## Tests and tools

Frontend: `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test:ui`, and `npm run demo:pdf`. Backend: `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test`. GitLab CI installs and validates both applications independently; it does not deploy or apply database migrations.
