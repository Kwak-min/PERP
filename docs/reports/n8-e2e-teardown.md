# N8 E2E and teardown receipt

Final release run (UTC): 2026-08-10T02:13:43Z

## Production-surface E2E

- Backend: Node.js / Express 5.2.1 on `127.0.0.1:8111`
- Frontend: Vite 8.2.1 production preview on `127.0.0.1:4173`
- Browser: installed stable Chrome via Playwright 1.62.1
- Result: `E2E GREEN`
- Flow: signup -> custom organization -> module disabled 403 -> module enable 200
  -> task create -> draft transaction -> Agent approval gate 409 -> approval
  -> re-authenticated execution 200 -> rollback 200 -> Vault notes/graph
  -> logout -> login -> authenticated desktop/mobile surfaces
- Responsive checks: 1280x900, 768x900, and 375x812; mobile horizontal overflow `0`
- State captures: success, loading, error, permission denied, and empty
- Browser console/page errors: `0`

Visual evidence (runtime artifacts, intentionally gitignored):

- `frontend/.artifacts/visual-qa/login-1280.png`
- `frontend/.artifacts/visual-qa/dashboard-1280.png`
- `frontend/.artifacts/visual-qa/dashboard-768.png`
- `frontend/.artifacts/visual-qa/loading-768.png`
- `frontend/.artifacts/visual-qa/error-768.png`
- `frontend/.artifacts/visual-qa/permission-768.png`
- `frontend/.artifacts/visual-qa/empty-768.png`
- `frontend/.artifacts/visual-qa/tasks-375.png`

## Teardown

Listeners before teardown:

- Express `:8111`: PID `11340`
- Vite preview `:4173`: PID `12708`

Verification after teardown:

- Express `:8111` listeners: `0`
- Vite preview `:4173` listeners: `0`
- Temporary QA database/WAL/SHM/log files: `0`
- Intentional screenshot evidence files retained: `8`

## Supplemental offline-auth check

After the auth-copy fix, Vite preview ran alone while the backend listener count
was `0`. A real stable-Chrome login submission rendered
`서버에 일시적인 문제가 발생했습니다.` and contained none of
`Failed to fetch`, `TypeError`, `NetworkError`, or `fetch failed`.
`frontend/.artifacts/visual-qa/login-offline-768.png` is retained as the ninth
screenshot. The preview was terminated afterward; `:4173` listeners and its
supplemental log files both returned to `0`.
