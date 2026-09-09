# 회사 Wiki / 문서 AI 클라우드 연결

## 적용 범위

- 공개·내부 회사 자료는 AI 연결 설정의 사용자 OpenRouter 키를 우선 사용하며, 없으면 기존 서버 공용 키를 사용한다. 전역 기본 공급자가 echo여도 설정 키가 우선한다.
- SQLite 키 범위는 tenant/org/user, PG 키 범위는 선택 회사와 기존 auth_identity에 연결된 운영 사용자다. 작업 또는 벡터 캐시에 비밀값을 저장하지 않는다.
- 개인·민감·고기밀 및 알 수 없는 등급은 클라우드 전송 대상이 아니다. 개인 Vault/Wiki는 기존 로컬 정책을 유지한다. 고기밀 문서의 기존 열람 거부도 유지한다.
- PG project.documents는 현재 별도 등급 필드가 없는 기존 내부 회사 문서 계약이다. 이 변경은 등급을 새로 부여하거나 접근 권한을 확대하지 않는다.

## Wiki

- 원본·페이지·카탈로그의 전체 전이 의존성 등급과 최신 권한을 확인한 뒤 공급자를 선택한다.
- OpenRouter 모델 목록의 구조화 출력 지원과 광고된 문맥 한도를 검사한다. 로컬 loaded-context 검증과 클라우드 advertised-context 검증은 출처를 구분해 기록한다.
- 모든 원본 바이트, 입력 manifest, 인용 검증, lease/fence, 명시적 재시도 및 검토·게시 경계를 유지한다. 클라우드 장애를 로컬 echo 성공으로 바꾸지 않는다.
- 요청 모델 별칭과 실제 응답 모델을 구분해서 기록한다. 모델 답변은 사실 검증이 아니라 검토 전 초안이다.
- 기존에 로컬/미설정으로 접수한 작업은 그 설정 snapshot을 유지한다. 새 키를 설정한 뒤 새 작업을 접수하면 클라우드 정책을 적용한다.

## 문서 임베딩

- 채팅 모델을 임베딩 모델로 사용하지 않는다. 별도 명시적 모델 설정과 OpenRouter 임베딩 모델 목록의 capability 확인이 필요하다.
- 임베딩 endpoint의 인덱스·개수·차원·유한수·영벡터를 검증하고 실제 벡터만 cosine 관계에 사용한다.
- 후보는 인가된 동일 회사 문서로 한정하며 개인·민감·고기밀 후보는 클라우드 입력에서 제외한다. 모델 목록 조회 후 본문 전송 직전에 원본 버전·등급·열람 권한을 다시 확인한다.
- 캐시는 회사 및 사용자별로 분리한다. 임베딩 모델 미설정·미지원·입력 한도 초과는 명시적인 사용 불가 결과다. 회사 그래프의 문서 상세에서 이유를 확인하고 다시 분석할 수 있다.
- PG 채팅 RAG 인덱스를 새로 만든 변경은 아니다. 원본 등록/게시 Wiki와 회사 문서 유사도 분석은 별도 기능이다.

## 배포 설정 이름

기존 설정:

- `ORBITFLOW_AI_KEY_ENCRYPTION_KEY`
- `OPENROUTER_API_KEY`
- `OPENROUTER_BASE_URL`
- `ORBITFLOW_EXTERNAL_MODEL`

클라우드 임베딩에 필요한 별도 모델 설정:

- `ORBITFLOW_DOCUMENT_OPENROUTER_EMBEDDING_MODEL`

선택적 Wiki 문맥/출력 한도:

- `WIKI_OPENROUTER_CONTEXT_TOKENS`
- `WIKI_OPENROUTER_OUTPUT_TOKENS`

로컬 전용 자료를 분석하려면 기존 로컬 설정이 별도로 필요하다:

- `WIKI_LOCAL_MODEL_CONFIG`
- `ORBITFLOW_DOCUMENT_EMBEDDING_MODEL`
- `OLLAMA_BASE_URL`

비밀값은 문서·로그·소스·작업 snapshot에 넣지 않는다. DB migration은 추가되지 않았다.

## 검증 경계

회귀 검증은 격리 SQLite, 실제 네이티브 PostgreSQL, 실제 HTTP worker/API, 빌드된 SPA 및 Chrome에서 합성 자료와 루프백 OpenRouter 프로토콜 fixture로 실행한다. 외부 capability 목록 HTTP 200 확인은 인증이나 문서 본문 없이 수행했다. 실제 계정의 과금 추론/키 설치와 운영 배포는 통합 담당자가 수행하며 이 변경의 테스트가 그 결과를 대신하지 않는다.
