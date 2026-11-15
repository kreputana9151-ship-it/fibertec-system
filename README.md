# FiberTec ISP Management System

Billing system para sa FiberTec IT Solutions: web app (HTML/CSS/JS) + REST API (Node + Express + PostgreSQL)

---

## Group Setup & Testing Guide

### Option A: Live Website Testing (Walang Install, Browser Lang)
Kung gusto niyo lang i-test ang system sa browser nang hindi nagda-download ng code, buksan lang ang live link na ito:
- **Live Link:** https://fibertec-system.onrender.com/index.html

*(Note: Naka-connect na ito sa shared Neon PostgreSQL database at Brevo email service natin. Kapag may nag-add o nag-edit ng data, makikita agad ng lahat.)*

---

### Option B: Paano I-run ang System sa Sariling Laptop (VS Code)

#### Step 1: I-check ang Requirements
Siguraduhing naka-install na sa laptop mo ang mga ito bago magsimula:
- **Node.js (v18+ LTS)**
- **Git**
- **Visual Studio Code (VS Code)**

#### Step 2: I-download (Clone) ang Project
1. Magbukas ng **VS Code**.
2. Buksan ang Terminal sa loob ng VS Code (`Ctrl + ~` o click **Terminal → New Terminal** sa itaas).
3. I-type at i-enter ang mga commands na ito nang sunod-sunod:
   ```bash
   git clone git clone https://github.com/kreputana9151-ship-it/fibertec-system.git
   cd fibertec-system
   npm install
   ```

#### Step 3: Gumawa ng `.env` File (Importante!)
1. Sa kaliwang panel ng VS Code (Explorer), gumawa ng bagong file sa loob mismo ng `fibertec-system` folder at pangalanan itong **`.env`** (dapat may tuldok sa unahan, walang ibang pangalan).
2. Kopyahin ang format mula sa `.env.example` at i-paste sa `.env`.
3. **I-message si Kezia** para makuha ang tunay na `.env` values (`DATABASE_URL`, `JWT_SECRET`, `BREVO_API_KEY`, `MAIL_FROM`). Naka-connect na ito sa shared Neon database at Brevo email natin, kaya hindi niyo na kailangang gumawa ng local database sa pgAdmin.
4. I-paste ang values sa `.env` at i-save (`Ctrl + S`).

#### Step 4: Generate HTTPS Cert & Run Server
1. Sa VS Code Terminal, i-type at i-enter:
   ```bash
   npm run cert
   npm start
   ```
2. Buksan sa browser ang **`https://localhost:3000/index.html`** (o **`http://localhost:3000/index.html`**).
   *(Note: Sa unang bukas ng `https://localhost:3000`, magwa-warning ang browser ng "Your connection is not private" dahil self-signed ang local cert. I-click lang ang **Advanced → Proceed to localhost**.)*

---

## Project structure

```text
fibertec-system/
├── public/                  Frontend (ito yung makikita sa browser)
│   ├── index.html           Login
│   ├── admin.html  staff.html  client.html
│   ├── css/
│   │   ├── style.css        shared styles
│   │   └── pages/           login.css, admin.css (admin + staff), client.css
│   ├── js/
│   │   ├── core/            data.js (demo data), common.js (shared helpers)
│   │   ├── shared/          clients.js (admin + staff)
│   │   └── pages/           admin.js, staff.js, client.js
│   └── images/              brand/ (logo), icons/
├── src/                     Backend
│   ├── server.js            entry point (API + frontend + https)
│   ├── db.js  jobs.js  seed.js
│   ├── middleware/          auth.js
│   ├── routes/              auth, client, staff, admin, paymongo
│   └── services/            billing, audit, mailer
├── database/schema.sql      PostgreSQL schema
├── scripts/generate-cert.js gumagawa ng local HTTPS certificate
├── certs/                   (generated, hindi ina-upload sa Git)
├── .env.example             kopyahin bilang .env
└── package.json
```

## Requirements
Node.js v18+, PostgreSQL (Neon Cloud o Local), Git

## Local Offline Setup (Kung Gagamit ng Sariling Local pgAdmin Database)

1. Clone:
   ```bash
   git clone [https://github.com/kreputana9151-ship-it/fibertec-system.git](https://github.com/kreputana9151-ship-it/fibertec-system.git)
   cd fibertec-system
   ```
2. Database: gumawa ng database na `fibertec` sa pgAdmin, tapos i-run ang `database/schema.sql` sa Query Tool.
3. Environment: kopyahin ang `.env.example` papuntang `.env` at ilagay ang sarili mong `DATABASE_URL` (password mo) at `JWT_SECRET` (mahabang random string). Huwag i-commit ang `.env`.
4. Install at seed:
   ```bash
   npm install
   npm run seed
   ```
5. HTTPS certificate (isang beses lang):
   ```bash
   npm run cert
   ```
6. Run:
   ```bash
   npm run dev
   ```
   Buksan ang **https://localhost:3000**. Health check: https://localhost:3000/api/health

Sa unang bukas, magwa-warning ang browser ("Your connection is not private") dahil self-signed ang certificate namin. Para sa local development, okay lang i-proceed ("Advanced" -> "Proceed to localhost"). Para walang warning, gamitin ang [mkcert](https://github.com/FiloSottile/mkcert) at ilagay ang gawa niyang `.pem` files sa `certs/` (`localhost-key.pem` at `localhost.pem`).

## Bakit HTTPS?

Pag walang HTTPS, **plain text** ang biyahe ng data sa pagitan ng browser at server, kasama ang account number, password, at JWT token ng user. Kahit sino sa parehong network ay pwedeng makabasa. Ine-encrypt ito ng HTTPS (TLS).

Dalawang bagay ang kailangan:
- **Certificate + key**: nasa `certs/` (local, galing sa `npm run cert`). Sa actual na deployment, ang hosting (Render, Railway, atbp.) o Let's Encrypt ang nagbibigay.
- **Server na naka-https**: `src/server.js` ang bahala; nagiging https pag may `SSL_KEY_PATH` at `SSL_CERT_PATH` sa `.env`. Alisin ang dalawang yan para bumalik sa plain http.

Kung naka-deploy sa host na may sariling HTTPS, i-set ang `TRUST_PROXY=true` at `FORCE_HTTPS=true` sa environment variables ng host (at huwag nang maglagay ng SSL_* paths).

## Paano kumonekta ang frontend sa API

Magkapareho ang origin ng frontend at API (iisang server), kaya **relative path** ang gamitin, hindi `http://localhost:3000`:

```js
const res = await fetch('/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ loginId, password })
});
```

Para sa protected routes, isama ang token: `headers: { 'Authorization': 'Bearer ' + token }`. Pag naka-https ang page pero `http://` ang tinatawag na API, iba-block yan ng browser (mixed content), kaya laging relative path.

## API endpoints
Lahat JSON, may `Authorization: Bearer <token>` (maliban sa login).

| Who | Method + path | What |
|---|---|---|
| all | POST /api/auth/login | { loginId, password } -> token |
| client | GET /api/client/me | account overview, days left |
| client | GET /api/client/statements, /payments, /notices | last 3 months only |
| client | POST /api/client/payments | submit GCash 13-digit ref (Pending) |
| client | POST /api/client/cancellation | request cancellation |
| staff | GET/POST /api/staff/clients, GET /api/staff/clients.csv | own branch only |
| staff | GET /api/staff/payments?status=Pending | list |
| staff | PATCH /api/staff/payments/:id/verify or /reject | verify GCash ref |
| staff | POST /api/staff/payments/cash | encode cash (issues OR no.) |
| staff | GET/PATCH /api/staff/cancellations | approve / reject |
| admin | GET /api/admin/clients, statements, notices, activity, analytics | all branches, 6 months |
| admin | POST /api/admin/statements/:id/send, /notices/:id/resend | send / resend |
| admin | PATCH /api/admin/clients/:accountNo/status | Active / Terminated (reinstate) |
| admin | POST /api/admin/run-daily | run the daily job by hand (demo) |
| - | /api/paymongo/* | placeholder, disabled until you have keys |

## Business rules implemented
- Account no. = branch code + YY + 4-digit client ID (e.g. 04260042), ito rin ang client login
- Statement 7 days before due date; amount = plan rate + previous balance
- Day after due date -> Grace Period (5 days) + Disconnection Warning -> Under Review -> auto Terminated after 3 days
- Partial payment only on/before due date; after that, full balance
- Client history 3 months (views), admin 6 months, older rows deleted daily by `purge_old_records()`

## Daily Git commands
```bash
git pull
git add .
git commit -m "Describe your changes"
git push
```

## Login accounts and password reset
| Who | Username | Notes |
|---|---|---|
| Client | 8-digit account no. **or** email | registered by branch staff |
| Staff | `bagongilog`, `caniogan`, `palatiw`, `maybungabliss3`, `bliss1`, `nagpayong` | one login per branch, locked to that branch |
| Owner/Admin | `rguerrero` (Ramon Guerrero) | sees all branches |

- Passwords are stored as bcrypt hashes (never plain text). Starting password for the seeded accounts = `SEED_PASSWORD` in `.env`.
- Owner resets anyone's password (client, staff, or own): `POST /api/admin/users/:userId/reset-password {newPassword}` (find the user with `GET /api/admin/users?q=...`). The person must set their own password at next login.
- Clients use **Forgot password?** on the login page to get an email link (valid 30 minutes). Staff/admin ask the owner.
- Already ran the old `schema.sql`? Run `database/migrate_login_update.sql` once, then `npm run seed` is not needed again.

## Custom address (instead of localhost:3000)
1. Add this line to your hosts file, then save (Windows: open Notepad as Administrator, file `C:\Windows\System32\drivers\etc\hosts`; Mac/Linux: `sudo nano /etc/hosts`):
   `127.0.0.1   fibertecitsolutions.test`
2. In `.env` set `APP_HOST=fibertecitsolutions.test` and `PORT=443` (port 443 is the normal https port, so no `:3000` is shown).
3. Run `npm run cert` again (the certificate must carry the new name), then `npm run dev`.
4. Open **https://fibertecitsolutions.test**. On Mac/Linux port 443 needs `sudo`; if you prefer, keep `PORT=3000` and the address will be `https://fibertecitsolutions.test:3000`.

This name works only on computers that have the hosts line. A public address such as `fibertecitsolutions.com` needs a registered domain and hosting.

## Notifications, email and PDF (Render + Neon + Brevo)
1. Neon SQL Editor: run `database/migrate_notifications.sql` once (adds read/unread + notice text).
2. Render > Environment: `BREVO_API_KEY`, `MAIL_FROM_EMAIL` (verified Brevo sender), `MAIL_FROM_NAME`, `APP_URL` (your https://...onrender.com address), `TRUST_PROXY=true`. Then redeploy (`npm install` adds `pdfkit`).
3. Emails are sent for: e-Statement (PDF attached), payment receipt, rejected payment, overdue / grace-period warning. Failures are logged in the Render logs as `[EMAIL FAILED]`.
4. Portal bell: red dot while anything is unread; unread items are highlighted; "Mark all as read".
