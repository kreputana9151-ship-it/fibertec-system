# FiberTec API (Node + Express + PostgreSQL)

## Setup
1. Create DB `fibertec` in pgAdmin, run `fibertec_schema_postgres.sql` in the Query Tool.
2. `cp .env.example .env` and fill in DATABASE_URL and JWT_SECRET.
3. `npm install`
4. `npm run seed`   (gives admin01 and staff01-06 real passwords)
5. `npm run dev`    -> http://localhost:3000/api/health

## Endpoints (all JSON, send `Authorization: Bearer <token>`)
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

## Rules implemented
- Account no. = branch code + YY + 4-digit client ID (e.g. 04260042), used as client login
- Statement 7 days before due date; amount = plan rate + previous balance
- Day after due date -> Grace Period (5 days) + Disconnection Warning -> Under Review -> auto Terminated after 3 days
- Partial payment only on/before due date; after that, full balance
- Client history 3 months (views), admin 6 months, older rows deleted daily by purge_old_records()
