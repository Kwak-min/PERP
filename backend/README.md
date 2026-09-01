# OrbitFlow Backend

Node.js 24+ and Express 5 API for OrbitFlow.

## Run

```bash
npm install
npm run migrate
npm run dev
```

The API listens on `127.0.0.1:8000` by default.

- Health: `GET /health`
- Route catalog: `GET /api/v1/routes`
- API prefix: `/api/v1`

Copy `.env.example` to `.env` and set environment-specific values. Never commit
real provider keys or other credentials.

## Verify

```bash
npm test
```

The 20-test suite uses isolated temporary SQLite databases and covers tenant isolation,
RBAC, module gating, finance consistency, AI approval/rollback, onboarding,
assets/HR, automations, integrations, analytics, imports, and Vault ownership.
