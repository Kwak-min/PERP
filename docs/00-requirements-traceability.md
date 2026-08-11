# 00. 요구사항 추적표 (Requirements Traceability Matrix)

원본: `소규모조직_ERP_운영OS_개인화AI_Agent_전체요구사항정의서.xlsx` / `전체과업지시서.docx`
총 69건 (SFR 30, SIR 8, PER 7, DAR 9, TER 10, SER 5). 축소·삭제 없음.

구현 모듈: M1 설계문서 / M2 공통플랫폼 / M3 운영모듈 / M4 재무·자원·인사 / M5 AI Agent / M6 자동화·연동·분석

| ID | 분류 | 명칭 | 우선순위 | 수용기준 | 연결화면 | API | 엔터티 | 구현모듈 |
|---|---|---|---|---|---|---|---|---|
| SFR-001 | SFR | 멀티테넌트 조직 관리 | Must | 두 조직에 가입한 사용자가 전환할 수 있고 A조직 요청으로 B조직 데이터가 반환되지 않는다. | ONB-001,COM-001 | /tenants | Tenant,Organization | M2 |
| SFR-002 | SFR | 조직 유형별 템플릿 | Must | 동아리 선택 시 회비·활동·임원 용어가, 기업 선택 시 부서·근태·회계 용어가 적용된다. | ONB-001,ORG-001 | /tenants/templates | Organization | M2 |
| SFR-003 | SFR | 회원·초대·상태 관리 | Must | 초대 만료·중복·회수·재발송과 탈퇴 즉시 세션·권한 회수가 동작한다. | ORG-002 | /members | User,Membership | M2 |
| SFR-004 | SFR | 역할·권한 관리 | Must | 일반 회원은 전체 회계 내역을 볼 수 없고 총무는 회계 범위 내에서만 수정 가능하다. | ORG-004 | /permissions | Role,Permission | M2 |
| SFR-005 | SFR | 개인 대시보드 | Must | 서로 다른 역할 계정에서 표시 카드와 데이터가 다르며 카드 순서가 재로그인 후 유지된다. | DASH-001 | /dashboard/me | Task,Event,Approval | M2 |
| SFR-006 | SFR | 조직 대시보드 | Should | KPI에서 원천 목록으로 드릴다운되고 산식·갱신시각이 표시된다. | DASH-002 | /dashboard/org | 다중 엔터티 | M6 |
| SFR-007 | SFR | 프로젝트 관리 | Must | 프로젝트 생성부터 완료·보관까지 상태전이가 기록되고 참여자 권한이 적용된다. | PRJ-001,PRJ-002 | /projects | Project | M3 |
| SFR-008 | SFR | 업무 관리 | Must | 필수 완료조건과 의존성이 충족되지 않으면 완료가 차단되고 변경 이력이 남는다. | TSK-001~005 | /tasks | Task | M3 |
| SFR-009 | SFR | 통합 캘린더 | Must | 개인과 조직 일정을 필터링할 수 있고 중복 일정 생성 시 경고한다. | CAL-001,CAL-002 | /calendar | Event,Reservation | M3 |
| SFR-010 | SFR | 거래·회계 관리 | Must | 거래 합계와 원장·보고서가 일치하고 마감기간 수정은 재오픈 승인 없이는 불가하다. | FIN-001,FIN-002,FIN-006 | /finance/transactions | Transaction | M4 |
| SFR-011 | SFR | 예산 관리 | Must | 승인 예산 대비 거래 반영 집행률이 자동 계산되고 초과 시 정책대로 차단/경고된다. | FIN-003 | /finance/budgets | Budget,Transaction | M4 |
| SFR-012 | SFR | 회비·청구 관리 | Should | 회원별 납부 상태와 기간 합계가 정확하고 일반 회원은 본인 내역만 본다. | FIN-004 | /finance/dues | Dues,Membership | M4 |
| SFR-013 | SFR | 정산·증빙 관리 | Must | OCR 값은 원본과 함께 검토되며 승인 전 회계원장에 확정 반영되지 않는다. | FIN-005 | /finance/settlements | Transaction,Approval | M4 |
| SFR-014 | SFR | 자산·재고 관리 | Should | 자산별 현재상태와 전체 이력이 일치하고 재고 임계치 알림이 발생한다. | AST-001,AST-002 | /assets | Asset | M4 |
| SFR-015 | SFR | 자원 예약 | Should | 같은 자원·시간의 확정 예약이 중복 생성되지 않는다. | AST-003 | /assets/reservations | Reservation,Event | M4 |
| SFR-016 | SFR | 인사·활동 관리 | Should | 조직 유형별 용어가 적용되고 필드별 개인정보 공개범위를 준수한다. | HR-001~004 | /hr | Membership,Attendance,Leave | M4 |
| SFR-017 | SFR | 문서·지식 관리 | Must | 자동저장·버전 복원과 권한 기반 검색이 동작한다. | DOC-001,DOC-002 | /documents | Document,FileObject | M3 |
| SFR-018 | SFR | 회의록·후속업무 | Must | 원문 근거와 생성 항목을 확인한 뒤 선택한 후속업무만 생성된다. | DOC-003 | /documents/meetings | Meeting,Task | M3 |
| SFR-019 | SFR | 인수인계 관리 | Must | 민감정보가 자동 제외되고 필수 체크 완료 전 인계 완료가 불가하다. | HND-001 | /handover | Handover | M3 |
| SFR-020 | SFR | 전자결재 | Must | 결재선 규칙에 따라 다음 단계가 결정되고 모든 결정이 감사로그에 남는다. | APR-001,APR-002 | /approvals | Approval | M3 |
| SFR-021 | SFR | 개인화 AI 대화 | Must | 동일 질문도 권한·역할에 따라 답변이 다르고 근거 없는 답변은 불확실성을 표시한다. | AI-001 | /agent/chat | AIConversation | M5 |
| SFR-022 | SFR | AI 개인 브리핑 | Must | 브리핑 항목은 원천 데이터와 연결되고 사용자 피드백이 다음 정렬에 반영된다. | AI-002 | /agent/brief | Task,Event,Approval | M5 |
| SFR-023 | SFR | AI 기억·옵시디언형 개인화 | Must | 사용자 삭제가 즉시 검색·응답에서 제외되고 민감정보는 정책에 따라 기억 저장이 거부된다. | AI-003 | /agent/memory | AgentMemory | M5 |
| SFR-024 | SFR | AI 도구 실행 | Must | 무승인 고위험 실행이 불가하고 실행 전후값·승인자·결과가 기록된다. | AI-004 | /agent/actions | AgentAction | M5 |
| SFR-025 | SFR | AI 모델 라우팅 | Must | 기밀 데이터는 정책상 외부 모델 전송이 차단되고 장애 시 허용된 대체 모델로 전환된다. | ADM-003 | /admin/ai-policy | AgentProfile | M5 |
| SFR-026 | SFR | 자동화 빌더 | Should | 게시 전 샌드박스 테스트가 가능하고 실패 단계부터 재시도할 수 있다. | AUT-001,AUT-002 | /automations | Workflow | M6 |
| SFR-027 | SFR | 알림·구독 | Must | 동일 이벤트 중복 알림이 방지되고 링크가 권한 검증 후 대상 화면으로 이동한다. | NOT-001 | /notifications | Notification | M2 |
| SFR-028 | SFR | 분석·보고서 | Should | 보고서에 산식·기준시점·갱신시각이 표시되고 원천 합계와 일치한다. | ANL-001 | /analytics | 다중 엔터티 | M6 |
| SFR-029 | SFR | 감사로그 | Must | 일반 관리자가 로그를 수정·삭제할 수 없고 검색·내보내기 권한이 분리된다. | ADM-002 | /admin/audit | AuditEvent | M2 |
| SFR-030 | SFR | 데이터 내보내기·삭제 | Must | 비동기 작업 상태·실패 사유·만료 다운로드가 제공되고 삭제 후 재검색되지 않는다. | ADM-004 | /admin/data | 전 엔터티 | M2 |
| SIR-001 | SIR | Google Calendar 양방향 연동 | Must | 중복 이벤트가 생성되지 않고 충돌 정책·연결해제 후 데이터 처리 정책이 적용된다. | CAL-001,INT-001 | /integrations/google-calendar | Integration,Event | M6 |
| SIR-002 | SIR | Microsoft Calendar 연동 | Should | 공급자별 차이가 도메인 모델에 노출되지 않는다. | CAL-001,INT-001 | /integrations/microsoft | Integration,Event | M6 |
| SIR-003 | SIR | 메신저 연동 | Should | 채널별 연결테스트·권한범위·실패재시도가 제공된다. | INT-001 | /integrations/messaging | Integration,Notification | M6 |
| SIR-004 | SIR | 파일 저장소 연동 | Should | 접근권한 없는 파일은 검색·AI 인덱싱에서 제외된다. | DOC-001,INT-001 | /integrations/storage | FileObject | M6 |
| SIR-005 | SIR | OpenRouter API 연동 | Must | 모델별 사용량·비용·지연·요청ID가 기록되고 키가 클라이언트에 노출되지 않는다. | AI-001,ADM-003 | /agent/providers | AIConversation | M5 |
| SIR-006 | SIR | 로컬 LLM 연동 | Must | 로컬 엔드포인트 장애가 표시되고 외부 폴백 여부는 정책을 따른다. | ADM-003 | /agent/providers/local | Integration | M5 |
| SIR-007 | SIR | 공개 REST API | Should | OpenAPI 문서와 샘플, 오류코드, 샌드박스가 제공된다. | INT-001 | /api/v1 | 전 엔터티 | M6 |
| SIR-008 | SIR | Webhook | Should | 서명검증 샘플과 지수 백오프·dead letter가 제공된다. | INT-001 | /webhooks | Workflow | M6 |
| PER-001 | PER | 일반 API 응답 | Must | 운영 유사 부하에서 기준을 충족하고 초과 API 목록을 제출한다. | - | 전 API | - | M2 |
| PER-002 | PER | AI 스트리밍 응답 | Must | 모델·질문유형별 TTFT·총지연을 측정한다. | AI-001 | /agent/chat | - | M5 |
| PER-003 | PER | 검색 성능 | Must | 권한 필터 포함 부하테스트 결과를 제출한다. | COM-001,DOC-001 | /search | - | M2 |
| PER-004 | PER | 동시 사용자 | Should | 부하 시나리오·자원 사용량·병목을 문서화한다. | - | - | - | M6 |
| PER-005 | PER | 가용성 | Must | 가용성 산식·제외조건·월간 리포트를 제공한다. | - | - | - | M6 |
| PER-006 | PER | 대용량 내보내기 | Should | 웹 요청 타임아웃 없이 작업이 완료되고 권한이 재검증된다. | ANL-001,ADM-004 | /exports | - | M6 |
| PER-007 | PER | 백업·복구 | Must | 최근 복구훈련에서 목표 충족 증적을 제출한다. | ADM-004 | - | - | M2 |
| DAR-001 | DAR | 테넌트 데이터 격리 | Must | 자동화된 cross-tenant 침투 테스트가 100% 차단된다. | - | - | 전 엔터티 | M2 |
| DAR-002 | DAR | 표준 코드·용어 사전 | Should | 용어 변경 전후에도 과거 데이터 조회·보고가 가능하다. | ORG-001 | /data-dictionary | Organization | M2 |
| DAR-003 | DAR | 데이터 품질 규칙 | Must | 오류 행·사유·수정방법을 파일로 제공하고 오류 데이터는 확정 저장하지 않는다. | ORG-002,FIN-002 | /imports | 전 엔터티 | M2 |
| DAR-004 | DAR | 개인정보 분류 | Must | 민감 필드가 권한·내보내기·로그·AI 요청에서 동일하게 통제된다. | ADM-003,ADM-004 | /data-policy | 전 엔터티 | M2 |
| DAR-005 | DAR | 문서 색인 | Must | 권한이 철회된 문서가 신규 AI 답변에 인용되지 않는다. | DOC-001,AI-001 | /search/index | Document | M5 |
| DAR-006 | DAR | AI 기억 데이터 | Must | 수정·삭제·전체 초기화가 가능하고 삭제 후 응답에서 사용되지 않는다. | AI-003 | /agent/memory | AgentMemory | M5 |
| DAR-007 | DAR | 감사 데이터 불변성 | Must | 무결성 검증 보고서로 누락·변조 여부를 확인할 수 있다. | ADM-002 | /admin/audit | AuditEvent | M2 |
| DAR-008 | DAR | 보존·삭제 | Must | 보존 정책 실행 결과와 예외 사유가 감사 로그에 남는다. | ADM-004 | /admin/retention | 전 엔터티 | M2 |
| DAR-009 | DAR | 가져오기·마이그레이션 | Should | 실패한 가져오기가 부분 확정되지 않으며 재실행 가능하다. | ORG-002,FIN-002,AST-001 | /imports | 전 엔터티 | M4 |
| TER-001 | TER | 기능 단위테스트 | Must | 핵심 모듈 라인 커버리지 80% 이상과 주요 분기 테스트를 제출한다. | - | - | - | M2 |
| TER-002 | TER | API 통합테스트 | Must | Must 요구사항 API 시나리오 100% 자동화한다. | - | 전 API | - | M2 |
| TER-003 | TER | E2E 사용자 여정 | Must | 브라우저 3종에서 핵심 여정이 통과한다. | 전 화면 | - | - | M3 |
| TER-004 | TER | 권한·테넌트 테스트 | Must | 금지 케이스 100% 차단, 우회 취약점 0건이다. | 전 화면 | 전 API | - | M2 |
| TER-005 | TER | AI 정답·근거 평가 | Must | 종합 정확도 85% 이상, 근거 제시 95% 이상, 권한 위반 0건이다. | AI-001~005 | /agent | - | M5 |
| TER-006 | TER | AI 도구 안전성 | Must | 고위험 무승인 실행 0건, 중복 실행 0건이다. | AI-004 | /agent/actions | - | M5 |
| TER-007 | TER | 성능·부하 테스트 | Must | PER 기준 충족 또는 병목·개선계획이 승인된다. | - | - | - | M6 |
| TER-008 | TER | 백업·복구 테스트 | Must | RPO/RTO 충족과 데이터 정합성 검증 결과를 제출한다. | - | - | - | M2 |
| TER-009 | TER | 사용성·접근성 테스트 | Should | 핵심 과업 성공률 85% 이상, 중대 접근성 오류 0건이다. | 전 화면 | - | - | M3 |
| TER-010 | TER | 회귀·배포 게이트 | Must | 게이트 실패 시 운영 배포가 차단된다. | - | - | - | M2 |
| SER-001 | SER | 인증·세션 보안 | Must | 탈퇴·비밀번호 변경·관리자 회수 후 기존 세션이 무효화된다. | AUTH-001 | /auth | User | M2 |
| SER-002 | SER | 암호화·비밀관리 | Must | 저장소·백업·전송 구간의 암호화 설정 증적을 제출한다. | - | - | - | M2 |
| SER-003 | SER | 파일 보안 | Must | 악성 테스트 파일이 다운로드·색인되지 않는다. | DOC-001 | /files | FileObject | M3 |
| SER-004 | SER | 프롬프트 인젝션 방어 | Must | 악성 문서가 권한확대·비밀노출·임의도구 실행을 유발하지 않는다. | AI-001,AI-004 | /agent | - | M5 |
| SER-005 | SER | 보안 감사 | Must | 중대·높음 취약점은 운영 배포 전 해결한다. | - | - | - | M6 |

## 우선순위 집계

- Must: 52건 → 100% 구현 필수
- Should: 17건 → 90% 이상 구현 필수

## 모듈별 배분

| 모듈 | 요구사항 수 |
|---|---|
| M2 | 24 |
| M3 | 10 |
| M4 | 8 |
| M5 | 13 |
| M6 | 14 |

## 검수 규칙

- 각 요구사항은 화면·API·DB 마이그레이션·권한검증·감사로그·테스트 증적이 모두 존재해야 '구현 완료'다.
- 기능 시연만으로는 완료로 인정하지 않는다 (원문 00_요약 시트 문서사용원칙).
- 본 추적표의 ID는 `scripts/check_docs_coverage.py`가 원본에서 파싱해 전수 대조한다.