# Smart Automation Cloud — Node.js

This Node.js service replaces the Java/Tomcat cloud service for accounts, workflow marketplace access, wallets, subscriptions, and downloads. The desktop automation engine remains the local JavaFX app. The service stores account and marketplace data in MySQL/MariaDB and keeps user batch inputs, Chrome profiles, cookies, and uploaded workflow files on each desktop.

## Requirements

- Node.js 20 or newer, npm, and MySQL/MariaDB with persistent storage.
- A host that can run a long-lived Node.js application and route HTTPS traffic to its port.
- Writable persistent storage for desktop installer releases. Keep `SA_STORAGE_DIR` outside public web roots.

## Local setup

```powershell
Copy-Item .env.example .env
npm install
```

Create a MySQL database and database user in the hosting/database control panel. Set the database credentials and bootstrap admin values in `.env`. Generate private values; use at least 14 characters for the initial admin password.

```powershell
npm start
```

Open `http://localhost:3000/`. The `npm test` command runs the package, money, and security tests without connecting to a production database. For real account, purchase, and admin-panel use, configure a dedicated MySQL/MariaDB database first.

## Hosting

1. Create a MySQL database and a database user with permissions on that database.
2. Upload the contents of `cloud-server-node/` to the Node application directory, excluding `.env`, `node_modules`, `storage`, and local development files.
3. Set the application start file to `src/server.js` or the start command to `npm start`. Use Node 20+.
4. Configure these environment variables in the host's Node application settings:
   - `NODE_ENV=production`
   - `PORT` if required by the host; otherwise the default is 3000.
   - `SA_DB_HOST`, `SA_DB_PORT`, `SA_DB_NAME`, `SA_DB_USER`, `SA_DB_PASSWORD`
   - `SA_BOOTSTRAP_ADMIN`, `SA_BOOTSTRAP_PASSWORD` (minimum 14 characters)
   - `SA_STORAGE_DIR` as a persistent writable directory outside the public document root.
   - `SA_COOKIE_SECURE=true` and `SA_TRUST_PROXY=1` when the host terminates HTTPS in front of Node.
5. Run `npm install --omit=dev`, then start/restart the Node application in the hosting panel. The service creates/updates its tables on startup and creates the first admin only if no active admin already exists.
6. If Google signup is enabled, create a Google OAuth **Web application** client ID, add each app origin (such as `http://localhost:3000` and your HTTPS domain) under **Authorized JavaScript origins**, and set `SA_GOOGLE_CLIENT_ID` in the app environment. Then route the domain over HTTPS, test `/health`, sign in to `/` with the bootstrap admin, and review new Google signup requests in **Admin → Signup requests**.

Host-specific application paths and environment-variable screens vary. Do not upload the local desktop SQLite database, `.env`, Chrome profile, or private workflow batch values to the hosting account.

## Wallet and subscriptions

All prices are entered in BDT and stored as integer poisha. Users submit a top-up request with their payment reference. The service does not charge a card, mobile wallet, or bank account; an admin verifies the request and approves or rejects it. Approval credits the wallet and creates an immutable ledger record. It must not be treated as proof of payment by itself: the admin verifies the payment using the process outside the app.

Purchases use one database transaction and a locked wallet row. If the balance is insufficient, the purchase fails without creating workflow access. A successful purchase debits the wallet, records the order, and creates an expiring workflow subscription (or subscriptions for every workflow in the package). Retrying a purchase with the same idempotency key does not charge twice. Marketplace shows **Buy** only for products the account has not purchased and does not already access; a product purchase is recorded in the database so a new request cannot debit the wallet again. Access begins when the purchase succeeds. Active subscriptions cannot be purchased again. After expiry, **Renew subscription** appears in the Subscriptions tab and renews that exact workflow or package from the wallet; renewal starts at its purchase time. Admins can open **Transactions** for a user in the Users tab to review balance changes and top-up request statuses. Admin-created access grants are available for complimentary time-limited access.

Before a purchase or renewal is sent, the dashboard asks the user to confirm the product, price, duration, and resulting balance. If the wallet is short, it explains how to submit a top-up request and open the Wallet tab; no purchase is attempted until the user confirms adequate funds.

Free products can be published with price `0.00`. An admin may later unlist or update a listing. Removing a package from the catalog does not erase already-paid workflow subscription records; deleting a workflow itself cascades its grants and subscriptions.

## Panels

- `/` or `/login`: username/password sign-in, a public account request form, and optional Google sign-in/signup. Public form requests retain the requested username, email, name, and a password hash until admin review; approval creates the member account and zero-balance wallet. Google requests also wait for admin approval and link the verified Google identity. Configure `SA_GOOGLE_CLIENT_ID` to enable Google sign-in.
- Marketplace: browse workflow/package listings, inspect their price and duration, and buy eligible products from the wallet. Renew expired purchases from the Subscriptions tab.
- Wallet: submit top-up requests, see review state and the transaction ledger.
- Package requests: ask an administrator for a custom package.
- Subscriptions: see each workflow entitlement and expiry.
- Desktop app: download the latest installer published by an administrator.
- `/admin`: in-app administration for users, Google signup approvals, listings, packages, top-up decisions, package-request replies, complimentary grants, tutorials, YouTube videos, blog posts, and desktop installer releases. Published learning content appears in separate Tutorials, YouTube videos, and Blog posts groups on each user's Overview dashboard.
- Signup screen and workspace sidebar: administrator contact links for WhatsApp `01746144544` and email `sultanahmedaskan@gmail.com`.

The first active administrator is created from the bootstrap environment variables. Only an administrator can create or promote accounts. Google signup approval provisions member accounts; users subsequently sign in with the same verified Google identity. Publish only packages you are authorized to share.

## Desktop-compatible API

The Java desktop client continues to use the established contract:

- `POST /api/auth/login` — JSON `{ "username": "...", "password": "..." }`; returns `{ "token", "username", "expiresAt" }` and an additional web-panel CSRF token.
- `POST /api/auth/logout` — revokes a bearer session.
- `GET /api/workflows` — active grants and paid subscriptions in the existing `id`, `name`, `description`, `version`, `canView`, `canRun`, `canEdit`, `expiresAt` shape.
- `GET /api/workflows/{id}/package` — downloads the sanitized `.saworkflow` while the access is active.

New web endpoints include `/api/me`, `/api/wallet`, `/api/wallet/topups`, `/api/marketplace`, `/api/purchases`, `/api/subscriptions`, `/api/package-requests`, `/api/releases/latest`, and administrator routes beneath `/api/admin/`. All panels and mutations require a session; admin routes also enforce the `ADMIN` role. Web sessions use an HTTP-only, secure (in production), same-site cookie and CSRF header. Desktop requests continue to authenticate with short-lived bearer tokens. The service stores only hashed session tokens and BCrypt password hashes. Public account registration is disabled; accounts are provisioned by an admin.

## Workflow package handling

The admin panel accepts `.saworkflow` archives only. It validates the archive and `smart-automation-workflow` manifest, stores only a rebuilt `workflow.json`, and clears batch items and asset references. Recorded select/list option definitions stay in the manifest so the desktop can replay selections. Installer binaries are served through an authenticated download route and stored under the private release-storage directory.

## Database and operational notes

`schema.sql` creates the service tables. Startup applies additive migrations to the existing Java cloud-service tables (`sa_user`, `sa_workflow`, `sa_grant`, and `sa_session`) and adds the marketplace tables. This preserves existing admin accounts, user accounts, workflow packages, manual grants, and session storage. Back up MySQL before replacing a live deployment, and run only one cloud-service version against the database while migrating. Once the Node deployment is verified, stop the old WAR service; its stored data is reused by the Node server.

Keep both MySQL backups and installer storage persistent. Put the Node app behind HTTPS, set `SA_COOKIE_SECURE=true`, restrict database access to the application, and protect bootstrap credentials. The release-upload maximum is 150 MB and may also be restricted by the hosting panel. Keep software installers and database backups out of public static folders.
