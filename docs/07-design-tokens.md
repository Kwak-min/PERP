# 07. 디자인 토큰

## 원문 기준
| 항목 | 상세 기준 |
|---|---|
| 디자인 방향 | 업무도구다운 밀도와 명확성. Notion·Linear 계열의 정돈된 정보 구조에 AI 작업 패널을 결합 |
| Desktop | 1440px 기준, 좌측 내비게이션 248px, 상단바 64px, 본문 최대 1280px, 우측 Agent 패널 420px |
| Tablet | 768~1199px, 내비게이션 접힘, Agent 패널 오버레이 |
| Mobile | 360~767px, 하단 탭 5개(홈·업무·캘린더·알림·Agent), 상세는 단일 열 |
| 색상 | Primary #4F46E5, AI #7C3AED, Success #16A34A, Warning #D97706, Danger #DC2626, Neutral Slate |
| 다크모드 | 배경 #0F1115, Surface #171A21, Border #2A2F3A, 본문 #F3F4F6 |
| 타이포 | Pretendard 또는 Noto Sans KR, 본문 14px/1.5, 제목 24·20·16px, 표 13px |
| 간격 | 4px 기반: 4·8·12·16·24·32px |
| 컴포넌트 | Button, Input, Select, Combobox, DatePicker, DataTable, Kanban, Drawer, Modal, Command, Toast, EmptyState |
| 상태 | 기본·hover·focus·disabled·loading·success·warning·error·empty·permission denied를 모든 주요 컴포넌트에 정의 |
| 접근성 | 키보드 조작, 포커스 표시, 대비 4.5:1, 폼 라벨, 스크린리더 이름, 색상 외 상태 표현 |
| AI 표현 | AI 생성 콘텐츠는 보라색 아이콘·AI 라벨·근거·생성시각·검토상태를 표시 |
| 공통 화면 상태 |  |
| 상태 | 표현 기준 |
| Loading | Skeleton을 사용하고 전체 화면 spinner 남용 금지 |
| Empty | 왜 비어 있는지, 첫 행동 버튼, 샘플/도움말 제공 |
| Error | 문제·원인·재시도·요청ID 제공 |
| Permission denied | 필요 권한과 요청 방법 제공, 데이터 존재 여부는 노출 금지 |
| Unsaved | 페이지 이탈 경고, 자동저장 상태 표시 |
| AI generated | AI 라벨·근거·생성시각·검토상태 표시 |

## 색상 토큰
```css
:root {
  --of-primary: #4F46E5;
  --of-ai: #7C3AED;
  --of-success: #16A34A;
  --of-warning: #D97706;
  --of-danger: #DC2626;

  --of-bg: #FFFFFF;
  --of-surface: #F8FAFC;
  --of-border: #E2E8F0;
  --of-text: #0F172A;
  --of-text-muted: #64748B;
}
[data-theme="dark"] {
  --of-bg: #0F1115;
  --of-surface: #171A21;
  --of-border: #2A2F3A;
  --of-text: #F3F4F6;
  --of-text-muted: #9CA3AF;
}
```

## 타이포 / 간격 / 레이아웃
```css
:root {
  --of-font: "Pretendard", "Noto Sans KR", system-ui, sans-serif;
  --of-text-body: 14px;   --of-leading-body: 1.5;
  --of-text-h1: 24px; --of-text-h2: 20px; --of-text-h3: 16px; --of-text-table: 13px;

  --of-space-1: 4px; --of-space-2: 8px; --of-space-3: 12px;
  --of-space-4: 16px; --of-space-6: 24px; --of-space-8: 32px;

  --of-sidebar-w: 248px;
  --of-topbar-h: 64px;
  --of-content-max: 1280px;
  --of-agent-panel-w: 420px;

  --of-radius-sm: 6px; --of-radius-md: 8px; --of-radius-lg: 12px;
}
```

## 브레이크포인트
| 이름 | 범위 | 동작 |
|---|---|---|
| mobile | 360~767px | 하단 탭 5개(홈·업무·캘린더·알림·Agent), 단일 열 |
| tablet | 768~1199px | 사이드바 접힘(아이콘), Agent 패널 오버레이 |
| desktop | 1200px+ | 사이드바 248px + 본문 1280px + Agent 패널 420px |

## 컴포넌트 상태 (모든 주요 컴포넌트 필수)
`default` `hover` `focus-visible` `disabled` `loading` `skeleton` `empty` `success` `warning` `error` `permission-denied` `offline` `unsaved` `mobile`

| 상태 | 표현 기준 |
|---|---|
| Loading | Skeleton 사용. 전체 화면 spinner 남용 금지 |
| Empty | 왜 비어 있는지 + 첫 행동 버튼 + 샘플/도움말 |
| Error | 문제·원인·재시도·요청ID(`X-Request-Id`) 노출 |
| Permission denied | 필요 권한과 요청 방법 안내. **데이터 존재 여부 노출 금지** |
| Offline | 마지막 동기화 시각 + 재시도 큐 표시 |
| Unsaved | 이탈 경고 + 자동저장 상태 표시 |

## AI 콘텐츠 표기 (필수)
AI 생성 블록은 예외 없이 다음을 렌더한다.
1. AI 라벨(텍스트) 2. AI 아이콘(`--of-ai` 보라) 3. 생성 시각 4. 근거(출처 문서·업무·거래 링크 + 날짜) 5. 검토 상태(미검토/검토됨/승인됨/폐기) 6. 수정 버튼 7. 승인 버튼 8. 폐기 버튼

색상만으로 상태를 표현하지 않는다(아이콘+텍스트 병기).

## 접근성
- 키보드 전 기능 조작, 포커스 링 상시 표시, 대비 4.5:1 이상
- 모든 폼 컨트롤에 라벨, 스크린리더 접근 이름 제공
- 표·칸반·간트는 키보드 대체 조작 경로 제공
