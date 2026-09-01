# 05. 권한 매트릭스

## 역할 정의 (11)
| 역할 | 주요 책임 | 데이터 범위 |
|---|---|---|
| 플랫폼 최고관리자 | 전체 테넌트·요금제·장애·정책 관리 | 테넌트 원문 데이터는 명시적 지원 승인 없이는 열람 금지 |
| 조직 소유자 | 조직 생성·폐쇄·결제·최고 권한 위임 | 조직 전체 |
| 조직 관리자 | 회원·권한·모듈·연동·보안 설정 | 조직 전체, 결제 제외 가능 |
| 대표/회장 | 조직 현황·승인·정책·보고서 | 전사/전체 조직 |
| 부서장/팀장 | 부서 프로젝트·인력·예산·승인 | 소속 부서 |
| 총무/회계 | 회비·거래·예산·증빙·정산 | 재무 모듈 |
| 인사 담당자 | 구성원·근태·휴가·모집·온보딩 | 인사 모듈 |
| 프로젝트 관리자 | 프로젝트·업무·일정·자원 배정 | 담당 프로젝트 |
| 일반 구성원 | 본인 업무·일정·문서·공지·Agent | 허용된 조직 데이터 |
| 외부 협력자 | 공유된 프로젝트·문서·일정 | 지정 리소스만 |
| 감사자/열람자 | 감사 로그·보고서 읽기 | 읽기 전용 |

## 권한 판정 순서 (서버 필수)
1. 사용자 인증과 세션 유효성 확인
2. `tenant_id`와 membership 상태 확인
3. 역할별 resource/action 권한 확인
4. scope 확인 (org / department / project / self)
5. 필드 민감도와 마스킹 정책 확인
6. 채널별 추가 정책 확인 (AI 요청 / 내보내기 / 외부연동)
7. 결과와 거부 사유를 감사로그에 기록

## 리소스 × 행동 매트릭스
범례: `A` 전체, `D` 소속 부서, `P` 담당 프로젝트, `S` 본인, `R` 읽기전용, `-` 없음, `M` 마스킹 적용

| 리소스 | 소유자 | 조직관리자 | 대표/회장 | 부서장/팀장 | 총무/회계 | 인사담당 | PM | 일반구성원 | 외부협력자 | 감사자 |
|---|---|---|---|---|---|---|---|---|---|---|
| organization.settings | A | A | R | - | - | - | - | - | - | R |
| member.read | A | A | A | D | A(M) | A | P | A(M) | - | R |
| member.write | A | A | - | D | - | A | - | S | - | - |
| role.assign | A | A | - | - | - | - | - | - | - | - |
| department.write | A | A | - | D | - | A | - | - | - | - |
| project.read | A | A | A | D | R | - | P | P | P(공유) | R |
| project.write | A | A | A | D | - | - | P | - | - | - |
| task.read | A | A | A | D | - | - | P | P+S | P(공유) | R |
| task.write | A | A | A | D | - | - | P | S | - | - |
| event.read | A | A | A | D | - | - | P | A(공개)+S | P(공유) | R |
| event.write | A | A | A | D | - | - | P | S | - | - |
| transaction.read | A | A(M) | A | D(요약) | A | - | P(예산) | S | - | R |
| transaction.write | A | - | - | - | A | - | - | - | - | - |
| transaction.confirm | A | - | - | - | A | - | - | - | - | - |
| budget.read | A | A | A | D | A | - | P | - | - | R |
| budget.write | A | - | A | D(요청) | A | - | - | - | - | - |
| dues.read | A | A | A | - | A | - | - | S | - | R |
| dues.write | A | - | - | - | A | - | - | - | - | - |
| settlement.create | A | A | A | D | A | A | P | S | - | - |
| fiscal.close / reopen | A | - | A(승인) | - | A(요청) | - | - | - | - | R |
| asset.read | A | A | A | D | - | - | P | A | - | R |
| asset.write | A | A | - | D | - | - | - | - | - | - |
| reservation.create | A | A | A | D | - | - | P | S | - | - |
| attendance.read | A | A | A | D | - | A | - | S | - | R |
| leave.approve | A | A | A | D | - | A | - | - | - | - |
| recruitment.* | A | A | A | - | - | A | - | - | - | R |
| document.read | A | A | A | D | - | - | P | 권한부여분 | 공유분 | R |
| document.write | A | A | A | D | - | - | P | 권한부여분 | - | - |
| meeting.write | A | A | A | D | - | - | P | 참석자 | - | - |
| handover.read | A | A | A | D | - | A | - | 본인 패키지 | - | R |
| handover.confirm | A | A | - | D | - | A | - | 전·후임 | - | - |
| approval.request | A | A | A | D | A | A | P | S | - | - |
| approval.decide | A | A | A | D | A | A | - | 결재선 지정자 | - | - |
| approval.form.manage | A | A | - | - | - | - | - | - | - | - |
| agent.chat | A | A | A | A | A | A | A | A | 제한 | R |
| agent.memory | S | S | S | S | S | S | S | S | S | S |
| agent.action.execute | 권한 위임 범위 내 | 동일 | 동일 | D | 재무 | 인사 | P | S | - | - |
| agent.policy.manage | A | A | - | - | - | - | - | - | - | - |
| automation.manage | A | A | - | D | - | - | - | - | - | - |
| integration.manage | A | A | - | - | - | - | - | - | - | - |
| analytics.read | A | A | A | D | A(재무) | A(인사) | P | - | - | R |
| audit.read | A | A | R | - | - | - | - | - | - | A |
| audit.export | A | - | - | - | - | - | - | - | - | A |
| retention/export.manage | A | A | - | - | - | - | - | - | - | R |
| billing.manage | A | - | - | - | - | - | - | - | - | - |

플랫폼 최고관리자: 테넌트·요금제·장애·정책만 접근하며, 테넌트 원문 데이터는 명시적 지원 승인(시간제한 티켓) 없이는 열람 금지. 모든 접근은 감사로그에 별도 등급으로 기록.

## 필드 단위 마스킹
| 필드 | 등급 | 마스킹 해제 |
|---|---|---|
| user.phone, address, birth_date | 개인 | 본인, 인사담당, 조직관리자 |
| user.national_id류 | 수집 금지 | - |
| member.emergency_contact | 민감 | 본인, 인사담당 |
| transaction.amount | 내부 | 회계·대표·소유자 (부서장은 소속 부서 범위) |
| dues.payment_detail | 개인 | 본인, 총무 |
| applicant.* | 민감 | 인사담당, 채용 평가자 (보존기간 경과 시 자동 파기) |
| integration.token | 고기밀 | 노출 금지 (참조만) |
| agent_memory.content(sensitivity=high) | 고기밀 | 소유자 본인만 |

## 검증
- 권한 시뮬레이션 API(`POST /permissions/simulate`)로 "이 사용자가 이 리소스에 이 행동을 하면?"을 사전 검증.
- 자동 테스트: 11역할 × 주요 리소스 × 행동 조합의 허용/거부 매트릭스 (TER-004, 금지 케이스 100% 차단).
- 프론트엔드 메뉴 숨김은 UX 보조일 뿐이며, 동일 요청을 API 직접 호출로 재현해 거부되는지 테스트한다.
