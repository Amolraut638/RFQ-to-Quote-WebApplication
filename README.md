# RFQ-to-Quote Costing Application

Production-quality prototype for an automotive component manufacturer's RFQ-to-Quote workflow.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| Backend | Node.js, Express.js, TypeScript |
| Database | MongoDB Atlas, Mongoose |
| Auth | JWT (httpOnly cookies), bcrypt, RBAC |
| Validation | Zod |
| Financials | decimal.js, MongoDB Decimal128 |
| PDF | PDFKit |
| Tests | Vitest |

## Project Structure

```
rfq-to-quote/
├── server/          Express API, Mongoose models, business logic
├── client/          React + Vite frontend
├── shared/          Shared TypeScript types
├── packages/
│   └── costing-engine/   Pure deterministic costing module (TDD)
├── docs/            Architecture decisions and API reference
└── .env.example     Variable names only — never commit .env
```

## Roles

- **ESTIMATOR** — creates RFQs, prepares costing sheets, submits for approval
- **SALES_HEAD** — approves/rejects quotations, manages rate masters

## Setup

### 1. Prerequisites
- Node.js ≥ 20
- MongoDB Atlas cluster (free tier works)

### 2. Environment
```bash
# Copy the example and fill in real values (never commit .env)
cp .env.example server/.env
cp .env.example client/.env
```

Required variables in `server/.env`:
```
PORT=4000
MONGODB_URI=mongodb+srv://<user>:<pass>@cluster.mongodb.net/rfq-dev
JWT_SECRET=<at-least-32-char-random-string>
JWT_EXPIRES_IN=7d
CLIENT_URL=http://localhost:5173
NODE_ENV=development
BCRYPT_ROUNDS=12
SEED_ESTIMATOR_PASSWORD=<password-for-demo-estimator>
SEED_SALES_PASSWORD=<password-for-demo-sales-head>
```

Required variable in `client/.env`:
```
VITE_API_BASE_URL=http://localhost:4000
```

### 3. Install
```bash
npm install
```

### 4. Seed the database
```bash
npm run seed
```

### 5. Run (both server and client)
```bash
npm run dev
```

Server runs on http://localhost:4000  
Client runs on http://localhost:5173

### 6. Demo credentials
Configured via `SEED_ESTIMATOR_PASSWORD` and `SEED_SALES_PASSWORD` in your `.env`.

| Role | Email |
|------|-------|
| Estimator | estimator@demo.com |
| Sales Head | sales@demo.com |

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | /api/health | — | Health check |
| POST | /api/auth/login | — | Login |
| POST | /api/auth/logout | ✓ | Logout |
| GET | /api/auth/me | ✓ | Current user |
| GET | /api/rfqs | ✓ | List RFQs |
| POST | /api/rfqs | ESTIMATOR | Create RFQ |
| GET | /api/rfqs/:id | ✓ | Get RFQ |

## Engineering Principles

- **Deterministic costing engine** — pure TypeScript module, no DB calls, no async
- **Immutable rate snapshots** — every quotation version preserves the exact rates used
- **Server-side authorization** — roles enforced in middleware, never trusted from client
- **No floating-point for money** — decimal.js throughout, Decimal128 in MongoDB
