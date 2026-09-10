# 인앱 Agent 개발 및 검증

## 경계

기존 `agent/chat`의 텍스트 모드는 유지한다. 업그레이드된 패널은
`agent_mode: true`와 안정적인 `Idempotency-Key`를 보낸다. 같은 요청을
다시 보낼 때 본문과 키를 그대로 유지한다. 모델에 실행·확인·결재·재인증
함수를 제공하지 않는다. 모델의 변경 제안은 업무 데이터가 아닌
`agent_operations`에만 저장된다.

SQLite API는 `/api/v1/agent`, PostgreSQL API는 `/api/v1/pg/agent`를
사용한다. 신규 작업은 `/operations`에서 확인·실행·취소하며 기존
`/actions`의 수명주기를 재해석하지 않는다. PostgreSQL 업무 작업과
실행 영수증은 PostgreSQL에만 저장한다. 기존 PostgreSQL 대화와
개인 공급자 키의 SQLite 연결 범위는 별도로 유지한다.

## 실행 기록

SQLite `agent_runs`는 tenant·organization·actor·key를,
PostgreSQL `public.agent_runs`는 company·actor·key를 고유 범위로 삼는다.
본문 해시가 다른 키 재사용은 충돌이다. 실행권을 먼저 확보한 요청만
대화를 만들고 공급자를 호출한다. 작업 중인 기록과 불완전한 기록은
명시적인 오류이며 성공 응답으로 대체하지 않는다.

최종 응답이 저장된 요청만 재생할 수 있다. 재생 시 현재 권한을 다시
검사하고 공급자에게 같은 제안을 다시 생성하도록 요청하지 않는다.
확인·실행은 화면에서 받은 서버 버전을 요구한다. 실행 키는 응답이
불확실하더라도 바꾸지 않는다. 업무 변경, 도메인 감사, 영수증 저장은
도메인 계층의 동일 저장소 트랜잭션에 속한다.

## 지식 범위와 외부 전송

새 패널의 기본 `knowledge_mode`는 `personal`이다. `company` 모드는
개인 노트·기억·첨부·개인 대화 이력·개인 작업 결과를 사용하지 않는다.
범위는 대화, 실행, 작업과 첨부에 고정되며 변경하려면 별도의 대화를
시작한다. 범위 표시가 없던 기존 대화는 개인 대화로 취급한다.
POST 본문과 GET 쿼리의 `knowledge_mode`는 서버가
`context.knowledgeMode`로 정규화한다.

개인 모드는 클라우드 동의가 아니다. `/knowledge/consent-preview`는
서버가 결정한 실제 공급자·모델과 정확한 자료 ID·판·해시를 보여준다.
처음 동의가 필요한 요청은 실행 기록을 만들기 전에
`CLOUD_CONSENT_REQUIRED`로 거절한다. 사용자가 확인한 뒤 같은 본문과
요청 키에 `cloud_consent`를 추가해 보낼 수 있다. 동의 토큰은 의미상
요청 해시에서 제외하지만 메시지, 첨부와 지식 범위는 제외하지 않는다.
완료된 요청의 재생은 동의를 다시 소비하거나 노트를 다시 만들지 않는다.

업로드는 보호된 `/attachments` API를 사용한다. 한 파일은 최대 1 MB이며
TXT, Markdown, 텍스트 PDF, DOCX의 실제 텍스트를 추출한다. 이미지와 OCR을
지원한다고 표시하지 않는다. 파일 바이트는 공개 정적 경로에 저장하지 않는다.
업로드된 텍스트는 자료이지 지시나 실행 권한이 아니다.

유용한 사용자 사실·결정·요구사항·절차의 자동 정리는 별도 제한된 단계에서
처리한다. 개인 노트 또는 현재 쓰기 권한이 있는 회사 문서에 원문 근거,
등급과 검토 전 표기를 남긴다. PG 회사 문서는 프로젝트 없이도
`workspace.documents`에 저장한다. 기존 `project.documents`는 보존하고
공통 카탈로그로 함께 읽으며 새 프로젝트를 임의로 만들지 않는다. 저장·생략·실패 결과는
`knowledge_saves`로 표시한다. 대화와 정리 단계의 토큰·비용을 함께 기록한다.

## 보호된 조회 결과

서버는 설정된 로컬 공급자의 `/v1/models`에서 실제 모델을 확인한다.
로컬 처리가 없으면 신뢰된 `protectedResultPolicy: "ui_only"`를 사용한다.
이 값은 HTTP나 모델 입력으로 받지 않는다.

공급자 루프는 도메인이 만든 안전한 `provider_receipt`만 모델에 전달하고
원본을 보지 않았음을 명시한다. 보호된 조회 원본은 별도의
`protected_results`로 앱 화면에 표시하며 전체 ActionView도 앱에만 보관한다.
전체 자료 등급 `classification`과 실제 모델에 전달한 내용의 등급
`content_classification`을 분리한다. 보호된 결과를 대화 이력 JSON에서
모델 입력으로 다시 꺼내지 않는다. 감춰진 결과를 외부 모델로 정리하거나
확인한 사실처럼 자동 저장하지 않는다.

이미 민감·기밀·알 수 없는 등급인 사용자 입력이나 이력은 이 경로로
등급을 낮추지 않는다. 실제 로컬 처리가 없다면 명시적으로 실패한다.

## 공급자와 비밀 입력

`runAgent`는 서버가 만든 `context.request`와 인증 주체를 사용한다.
`completeTurnForUser` 콜백은 기존 개인 키·공유 키·로컬 정책을 따른다.
모델이 전달한 ID로 인증 문맥을 만들지 않는다. 입력·이력·도구 결과의
등급은 매 공급자 호출 전에 다시 검사하고 더 낮은 등급으로 바꾸지 않는다.
재인증 비밀번호는 실행 요청에만 포함하며 대화·모델·감사·파서 로그에
보관하지 않는다.

상대 날짜 계획에는 서버의 현재 시각, `Asia/Seoul` 업무 시간대와 해당
날짜를 명시한다. 전체 작업에는 하나의 취소 신호와 제한 시간이 적용된다.
비보안 HTTP에서도 요청 키가 생성되도록 브라우저는 공유
`createRequestKey()`를 사용하며 불확실한 실행의 재시도 키는 유지한다.

## 로컬 검증

검증은 `scripts/run_deadline_isolated.mjs`에서 실행한다. 이 실행기는
기존 `.env`와 원격 DB 설정을 사용하지 않고 새 임시 SQLite 및 loopback
네트워크를 사용한다. 네이티브 PostgreSQL 검증에는 다음 경로를 명시한다.
PG 추가 스키마의 공통 순서는 `agent-pg-migrations.js`의 v22·v23·v24 목록에
등록되어 있다. 기존 기본 스키마와 v21을 적용한 검토된 대상에서는
`node backend/src/config/agent-pg-migrations.js`로 적용할 수 있다.
SQLite 부팅은 기존 경로에서 v22·v23을 등록하고 PG 전용 v24를 흉내 내지 않는다.

```powershell
node scripts/run_deadline_isolated.mjs --pg-bin "C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin" node backend/tests/inapp-agent-native.integration.mjs
node scripts/run_deadline_isolated.mjs node --test backend/tests/inapp-agent-cloud.test.js backend/tests/inapp-agent-knowledge-http.test.js
node scripts/run_deadline_isolated.mjs npm run build
node scripts/run_deadline_isolated.mjs --pg-bin "C:/Users/A/AppData/Local/PERP-test-runtimes/postgresql-18.6-3/pgsql/bin" node backend/tests/inapp-agent-native.integration.mjs --cloud-only --browser
```

OpenAI 호환 loopback 공급자가 실제 도구 호출과 관찰 이후 응답을 주고받는다.
고정 대기 시간 대신 요청·응답·서버 이벤트를 구독한다. 실제 유료 공급자,
운영 DB, 운영 비밀키는 이 검증에 사용하지 않는다.
브라우저 검증은 `http://inapp-agent.test`를 loopback으로만 해석하며
`isSecureContext === false`를 확인한 실제 Chrome에서 375·768·1280 픽셀을
검사한다. localhost의 예외적인 보안 문맥으로 HTTP 문제를 가리지 않는다.
