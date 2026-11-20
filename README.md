# Olaseena

All your courses in one place. A local-first ERP for a private-course business:
members (students), trainers (teachers), courses, attendance, invoices,
payroll, and a dashboard. Bilingual English (US) and Bahasa Indonesia.

Your data stays in your browser (IndexedDB). There is no server, no
account, and no network call. Backups are ZIP files you keep yourself.

## Install

Requires Node.js 20 or later.

```sh
npm ci
```

## Run

```sh
npm run dev
```

Open http://localhost:3000 (it redirects to `/en/`).

## Build

```sh
npm run build
```

This produces a static export in `out/`, ready for any static host.

## Tests

```sh
npm test          # unit + service tests (Vitest)
npm run typecheck # TypeScript, no emit
```

Browser checks drive the real UI in Chromium against the static export:

```sh
npm run build
python3 -m http.server 8901 --directory out
BASE_URL=http://localhost:8901 npm run verify:browser
```

## Errors

Failures are never silent: every catch either reports to the central error
system (a toast with a copyable diagnostics report, plus an error log) or
rethrows, and every save, delete, payment, backup, and restore shows a
success toast on success. A render crash shows a recovery screen with a
reload button instead of a blank page.

## Deploy to GitHub Pages

1. Push this project to a GitHub repository.
2. In the repository settings, under Pages, choose **GitHub Actions** as the
   source. The included workflow (`.github/workflows/deploy.yml`) runs
   typecheck, tests, and the build, then uploads `out/` as the Pages
   artifact.
3. The site is served from the repository root, so no base-path setting is
   needed when you use a custom domain (recommended). If you deploy under a
   project subpath instead (for example `username.github.io/olaseena`), set
   `basePath: "/olaseena"` in `next.config.ts` first.

## Use

- **Dashboard**: money collected this month, outstanding invoices, attendance
  rate, active members, upcoming sessions, recent invoices.
- **Members / Trainers**: searchable lists with add, edit, and detail views.
- **Courses**: title, trainer, schedule, price, capacity; enroll members and
  add sessions from the course detail.
- **Attendance**: pick a session, mark each member present, absent, or late,
  and mark whether the trainer was there. Sessions where the trainer was
  present count toward their pay.
- **Invoices**: create from a member or an enrollment, add line items, record
  full or partial payments. Overdue is shown automatically after the due date.
- **Payroll**: pick a trainer and a period to generate a pay run from
  attended sessions (sessions x rate per session), then mark it paid.
- **Settings**: switch language, back up or restore everything as a ZIP
  (optionally protected with a passphrase), replay the guided tour.
- **Privacy**: the full policy lives at `/en/privacy/` (and `/id/privacy/`).

The first time you open the app, a short guided tour walks through each
screen. Press **Skip tour** on any step to end the whole tour. Replay it any
time from Settings.

## Backups

Settings has backup and restore. A backup is a versioned ZIP file with a
manifest and checksums. Restoring compares the backup with your current data
first: new records are added, identical ones are left alone, and you choose
per record whether a differing one is replaced or kept. A safety backup of
your current data can be downloaded before a restore is applied.

## Built for the future

The code is structured so a team and a server can be added later without a
rewrite: every module talks to a store interface (today backed by Dexie, later
by an API), a single owner actor travels with every call behind a permission
gate, every record carries an organization id, an owner id, timestamps, and a
revision number, every write carries an idempotency key, input is validated
with zod at the service boundary, and an append-only audit log records who
did what.

## Tech

Next.js 16 + React 19 (static export), Dexie/IndexedDB, next-intl (en-US,
id-ID), Tailwind CSS 4, Radix UI, motion, fflate, Vitest.

## License

MIT.
