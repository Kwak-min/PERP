# 01. 리포지토리 구조

OrbitFlow는 루트 npm workspace 아래 `backend/`와 `frontend/`를 분리한
Node.js 모노레포다. 이전 `apps/api`와 `apps/web` 트리는 동등 기능 이식 후
삭제했다.

```text
orbitflow/
├─ package.json                    # npm workspaces, 통합 build/test/start
├─ package-lock.json
├─ README.md
├─ backend/
│  ├─ package.json                 # Node.js / Express
│  ├─ .env.example
│  ├─ README.md
│  ├─ src/
│  │  ├─ app.js                    # Express 앱·공통 미들웨어·라우트 등록
│  │  ├─ server.js                 # migration 후 127.0.0.1 listener
│  │  ├─ config/                   # env, DB, schema, RBAC, module/agent 정책
│  │  ├─ controllers/              # HTTP 입력/출력과 권한 경계
│  │  ├─ models/                   # tenant/org scoped persistence helpers
│  │  ├─ routes/                   # /api/v1 route groups
│  │  ├─ middleware/               # auth, tenancy, modules, errors
│  │  ├─ services/                 # audit, approval, AI, RAG, notification
│  │  ├─ utils/
│  │  ├─ validations/
│  │  └─ uploads/
│  └─ tests/                       # node:test real-HTTP integration suites
├─ frontend/
│  ├─ package.json                 # Vite / React / TypeScript
│  ├─ .env.example
│  ├─ vite.config.ts
│  ├─ index.html
│  ├─ public/
│  │  ├─ favicon.ico
│  │  ├─ favicon.svg
│  │  ├─ images/
│  │  └─ icons/
│  ├─ src/
│  │  ├─ App.tsx
│  │  ├─ main.tsx
│  │  ├─ assets/
│  │  ├─ components/{common,ui,layout}/
│  │  ├─ pages/
│  │  ├─ hooks/
│  │  ├─ context/
│  │  ├─ services/                 # typed API/auth boundary
│  │  ├─ utils/
│  │  ├─ routes/                   # React Router + 56-path catalog
│  │  └─ store/                    # persistent session external store
│  └─ scripts/                     # route parity and real-browser E2E
├─ docs/
├─ evals/
├─ infra/
└─ scripts/
   ├─ check_structure.mjs
   ├─ check_deliverables.py
   └─ check_docs_coverage.py
```

## 경계 규칙

- 모든 조직 데이터 접근은 인증된 principal의 `tenant_id`와 `org_id`를 함께
  적용한다. 직접 조회와 목록 모두 교차 조직 데이터를 노출하지 않는다.
- 선택 모듈 route group은 controller 이전에 `requireModule()`을 통과한다.
- 권한 판정은 서버 RBAC가 소유하며 프론트 메뉴 가림은 보안 경계가 아니다.
- 금액은 정수 최소화폐단위로 저장하고 확정 거래만 원장/보고서에 반영한다.
- 외부 AI 호출 전 데이터 등급과 도구 allowlist를 판정한다. 고위험 도구는
  승인과 재인증 후 실행하며 rollback metadata를 저장한다.
- 개인 Vault는 같은 조직 구성원에게도 소유자 전용이다.
- `.env`, SQLite 파일, 빌드 및 QA artifact는 gitignore 대상이다.
