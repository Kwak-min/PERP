# 홈 자세히 팝업 인계

## 범위와 상태

- 작업 트리: `D:/00_정리파일/PERP-wt/home-detail-popups`
- 브랜치/기준: `newownedfix/home-detail-popups`, `ff3a359`.
- 홈의 구성원·프로젝트·업무·문서 카드와 목록 영역의 자세히 버튼은 실제 API 응답을 보여주는 모달을 연다.
- 선택한 회사/저장소의 API만 사용한다. 구성원은 user_id, 프로젝트/업무는 원본 ID와 별도 상세 URL, 문서는 원본 ID로 본문을 추가 조회한다.
- 검색/10건 페이지는 전체 응답에 적용한다. SQLite 목록에는 `limit=-1`, PG 목록에는 기존 제한 없는 계약을 사용한다.
- 상태: 로딩/빈 목록/검색 결과 없음/403/오류 및 재시도. 회사·세션·권한·범주·문서 변경은 기존 하위 상태를 버리고 요청을 중단한다.
- 이번 재개에서 상속 작업을 보존하고 backdrop mousedown 기본 포커스 이동과 전역 CSS에 의한 모바일 모달 여백 덮어쓰기를 수정했다. 각각 실패하는 브라우저 회귀를 먼저 확인했다.
- 커밋, push, merge, 운영 DB 쓰기 없음. 테스트 쓰기는 격리된 임시 SQLite 및 native PostgreSQL만 사용했다.

## 반영할 정확한 파일

1. `frontend/src/pages/ScreenPage.tsx` (상속된 홈 연결 변경)
2. `frontend/src/components/data/HomeDetailModal.tsx` (상속 구현 + backdrop 포커스 수정)
3. `frontend/src/components/data/homeDetailModel.ts` (상속 구현)
4. `frontend/src/components/data/home-detail-modal.css` (상속 구현 + 전역 CSS보다 구체적인 선택자)
5. `frontend/scripts/home-detail-popups-browser.test.mjs` (상속 브라우저 회귀 + 768px/여백/검색/페이지/본문/재시도 증거)
6. `frontend/scripts/home-detail-model.test.mjs` (새 모델 회귀)
7. `docs/home-detail-popups-handoff.md` (이 문서)

`ScreenPage.tsx`만 기존 tracked 파일의 diff이며 나머지는 새 파일이다. 상속 전 이미 큰 ScreenPage를 이 작업에서 리팩터링하지 않았다. 새 모달은 132 유효 줄, 모델은 44줄, 브라우저 회귀는 222줄이다.

## 검증 명령

모든 명령은 이 작업 트리 루트에서 실행한다. `PG_BIN`은 로컬 PostgreSQL 실행 파일 디렉터리이며 운영 연결 문자열을 전달하지 않는다.

```bash
node scripts/run_deadline_isolated.mjs npm run build
node scripts/run_deadline_isolated.mjs node --test frontend/scripts/home-detail-model.test.mjs
node scripts/run_deadline_isolated.mjs --pg-bin "<PG_BIN>" node --test frontend/scripts/home-detail-popups-browser.test.mjs
node scripts/run_deadline_isolated.mjs npm run test --workspace frontend
node scripts/run_deadline_isolated.mjs node --experimental-strip-types --test frontend/scripts/project-task-model.test.mjs frontend/scripts/screen-table.test.mjs
node scripts/run_deadline_isolated.mjs --pg-bin "<PG_BIN>" npm test
```

사용한 PG_BIN: `C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin`.

## 실행 증거

아래 UUID는 이 트리의 `.omo/evidence/deadline-runs/<UUID>/result.json`, `stdout.log`, `stderr.log`이다.

| 검증 | 결과 | UUID |
|---|---|---|
| backdrop 포커스 red | exit 1, 브라우저 회귀 line 183: false !== true | `53ad5ecb-6b16-4d48-8719-bbee64c34fda` |
| 모바일 여백 red | exit 1, members: modal needs a usable backdrop gutter | `b9bec400-a7ea-41ac-914d-7a2533c77e0b` |
| 최종 tsc + Vite build | exit 0 | `1cbf6551-89c6-4c75-b42b-421a2ef1ceb3` |
| 최종 Chrome 브라우저 | exit 0, 1 시나리오, 102 캡처 | `b7282e11-4607-4c1b-8dcd-82c9d2570c22` |
| 홈 모델 | exit 0, 7 tests | `6063c1c8-6cfe-4544-a0cd-ef4c75f81e4a` |
| 기존 프로젝트/업무·표 모델 | exit 0, 9 tests | `45fb6e6b-2f87-4b64-b0c0-d416ece177cc` |
| frontend gates | exit 0, 63 routes, markdown 10/10 | `65309c88-24f9-4484-846f-db76b121ba1e` |
| 전체 npm test | exit 1, backend 509 중 508 pass / 기존 1 fail | `4286bd30-88a6-4d8c-904f-e7af2f1ecbf7` |

전체 suite의 기존 실패: `backend/tests/pg-integration-security.test.js:84`, `unimplemented PG writes cannot report operational success`, line 88의 `200 !== 501`. 부모가 확인한 `a00205c` baseline의 `/pg/members/home-layout` 실패와 동일하다. 해당 테스트/백엔드는 수정하지 않았다. 첫 전체 실행은 PG_BIN 없이 실행해 native fixture 설정 실패가 추가되었고, 위 최종 전체 실행은 명시적 PG_BIN으로 508/509를 확인했다.

LSP 도구를 변경 파일마다 호출했지만 typescript-language-server와 biome 실행 파일이 없어 LSP 진단은 미검증이다. 대신 tsc 빌드, JS 구문 검사, 실제 브라우저 CSS/DOM 검증을 실행했다. Vite의 500KB 이상 chunk 경고는 그대로 남아 있다. Lighthouse/독립 이중 visual oracle는 이 child에서 실행하지 않았다(위임 도구 없음). 부모의 독립 리뷰 대상이다.

## 실제 브라우저 증거

- `.omo/evidence/home-detail-popups/browser.json`: `passed: true`, `errors: []`, 102 surfaces, 요청 경로, Chrome 버전, PG 엔진, cleanup 결과.
- Chrome `152.0.7977.83`, PostgreSQL `18.6`, native Windows temporary cluster.
- SQLite/PG 각각 375, 768, 1280 x 900.
- 각 조합의 17 상태: members, projects-page-2, search-empty, projects, tasks, documents, document-body, overview, empty, forbidden, error, retry-ready, loading, stale-category, stale-item, members-denied, scope-empty.
- PNG: `.omo/evidence/home-detail-popups/{sqlite|pg}-<state>-<width>.png`.
- 전체 육안 검토용 시트: 같은 디렉터리의 `review-{sqlite|pg}-{375|768|1280}.png`. 102개 원본의 PNG signature와 900px 높이/요청 너비를 검사했다. 시트 전체 및 모바일 구성원/문서 본문, 데스크톱 프로젝트, 태블릿 현황 원본을 직접 열어 검토했다.
- 문서 외부회사/비공개 원본은 HTTP 404, 목록에는 외부 sentinel이 없다. 서버 메뉴 권한을 실제로 제거했을 때 HTTP 403이며 UI는 구성원 목록 요청을 보내지 않는다.
- 오류/빈 상태/403 경계 일부는 실제 서버 요청 후 Playwright에서 응답을 변환한다. 정상 데이터/권한 제거/회사 격리는 실제 DB/API다.
- 105개 프로젝트 전체 검색과 페이지 간 ID 비중복, 검색 0건, 두 문서의 실제 본문, 재시도 복구, Escape/Shift+Tab/backdrop 포커스, storage 회사 전환과 요청 abort를 검사했다.
- 모든 캡처에 문서 가로 overflow 없음, 모달 viewport 내 포함 및 최소 12px 여백. 좁은 화면의 표는 기존 table-wrap에서 가로 스크롤하며 전체 값은 선택 항목 상세에도 표시된다.

## 통합 주의사항 및 가정

1. 부모의 `a00205c`와 이 트리 기준 사이에서 `ScreenPage.tsx`, projects/model.ts, useWorkspaceAccess.tsx, backend menu-permissions.js는 동일하다(git diff 확인). 기존 tracked 파일에는 이 트리의 **diff만** 적용한다. 다른 트리 전체 파일/의존성 링크를 덮어쓰지 않는다.
2. 프로젝트와 업무 팝업은 별도 범주/목록/원본 URL (`/projects/:id`, `/tasks/:id`)다. 이 변경은 navigation catalog, registry, ProjectTaskScreen, 메뉴 권한 코드를 수정하지 않는다.
3. **별도 통합 작업 필요:** 실제 `a00205c`/resume-integration-0909의 catalog는 여전히 PRJ-001 `프로젝트/업무` nav:true, TSK-001 nav 없음이며 서버 `/tasks` 권한도 `menu.projects`다. 프로젝트·업무를 별도 메뉴로 유지하라는 최신 결정은 이 baseline에 아직 반영되어 있지 않다. 이 팝업 인계가 그 결정을 구현했다고 주장하지 않는다. 메뉴 분리 track이 서버를 `menu.tasks`로 바꾸면 `homeCategories`의 tasks.menu 및 브라우저 제한 역할 fixture도 함께 맞춰야 한다. 현재 팝업은 서버 계약에 맞는 `menu.projects`를 사용한다.
4. 홈은 부서 branch가 아니라 선택 회사 범위라는 기존 집계 계약을 따른다. 상세 목록은 기존 서버의 tenant/org/role/document visibility 범위를 더 좁히거나 넓히지 않는다.
5. 홈 집계와 목록은 삭제/활성/문서 공개 범위에 따라 수가 다를 수 있으므로 현황에 차이의 이유를 표시한다. 예: SQLite fixture의 집계 3문서, 조회 가능 목록 2문서. 비공개 본문은 노출하지 않는다.
6. 새로운 backend route, DB migration, 패키지 추가 없음. `npm test`의 frontend 기본 gate는 새 `.test.mjs`를 자동 실행하지 않으므로 위 홈 모델/브라우저 명령을 통합 검증에서 명시 실행한다.
7. 이 트리의 node_modules는 상속된 approval-person-labels 트리 링크다. 링크는 변경하지 않았고 통합물에 포함하지 않는다. 깨끗한 npm ci를 수행한 부모 통합 트리에서 재검증해야 한다.
