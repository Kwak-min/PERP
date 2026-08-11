# OrbitFlow

작은 조직의 업무, 회계, 문서, 자산, 인사와 개인화 AI Agent를 하나의
운영 흐름으로 연결하는 웹 애플리케이션입니다.

## 고정 기술 스택

- Backend: Node.js 24+, Express 5, SQLite (`node:sqlite`), Zod
- Frontend: Vite 8, React 19, React Router 7, TypeScript strict, Zod
- AI Gateway: OpenRouter, Ollama, deterministic echo adapter
- Browser QA: Playwright with installed stable Chrome

## 저장소

```text
backend/   Express API, SQLite schema/migrations, integration tests
frontend/  Vite/React SPA, 56 route paths, production E2E
docs/      architecture, operations, security, and verification evidence
scripts/   structure and deliverable verification
```

The former `apps/api` FastAPI and `apps/web` Next.js trees were fully migrated
and removed.

## Install and run

```bash
npm install
npm run dev:backend
npm run dev
```

- API: `http://127.0.0.1:8000`
- Vite: `http://127.0.0.1:5173`
- Health: `GET /health`
- Route catalog: `GET /api/v1/routes`

Copy each `.env.example` to `.env`. Provider keys belong only in local/runtime
environment files and must never be committed.

## Verify

```bash
npm test
npm run build
node scripts/check_structure.mjs
python scripts/check_deliverables.py
npm audit
```

See `docs/reports/test-result-report.md` and
`docs/reports/n8-e2e-teardown.md` for current evidence.
