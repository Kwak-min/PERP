# PERP DB 접속 안내 (팀원용)

PERP 프로젝트 데이터베이스에 접속하는 방법입니다.
DB는 **NCP 서버의 PostgreSQL 18**에 있고, **SSH 터널**로 접속합니다.

> 🔐 **비밀번호 2개(SSH root / DB perpadmin)는 팀 리더가 별도 채널로 전달**합니다.
> 이 문서와 git에는 비밀번호를 적지 마세요.

---

## 1. 접속 정보

**① SSH 터널 (서버 접속 통로)**
| 항목 | 값 |
|---|---|
| Host | `211.188.49.105` |
| Port | `22` |
| User | `root` |
| 인증 | 비밀번호 |
| Password | `[별도 전달]` |

**② 데이터베이스**
| 항목 | 값 |
|---|---|
| Host | `localhost` ← ⚠️ (공인 IP 아님! 터널 기준) |
| Port | `5432` |
| User | `perpadmin` |
| Password | `[별도 전달]` |
| Database | `perp_db` |

---

## 2. DataGrip 설정 순서

1. `+` → Data Source → **PostgreSQL**
2. **`SSH/SSL` 탭**: `SSH 터널 사용` 체크 →
   - 호스트 `211.188.49.105`, 포트 `22`, 사용자 `root`, 인증 유형 `비밀번호`, 비밀번호 입력
3. **`일반` 탭**:
   - 호스트 **`localhost`**, 포트 `5432`
   - 사용자 `perpadmin`, 비밀번호 입력, 데이터베이스 `perp_db`
4. 드라이버 다운로드 뜨면 `Download`
5. **`연결 테스트`** → Succeeded 확인 → OK

> DataGrip이 없으면 **DBeaver(무료)** / **pgAdmin(무료)** 도 동일 정보로 접속 가능.
> (SSH 터널 옵션 + 위 DB 정보 입력)

---

## 3. 자주 겪는 문제

**`Address already in use: bind ... 5432`**
→ 내 PC에 로컬 PostgreSQL이 5432를 쓰고 있어서 터널이 충돌.
- 해결 A: 로컬 PostgreSQL 서비스 정지
- 해결 B: 터널 "로컬 포트"를 `55432` 등 다른 값으로 변경

**`password authentication failed`** → DB(perpadmin) 비밀번호 확인
**SSH 관련 실패** → root 비밀번호 / 22 포트 확인

**호스트 헷갈림**: 공인 IP(`211.188.49.105`)는 **SSH 탭에만**, 일반 탭 호스트는 **`localhost`**.

---

## 4. 스키마 (테이블 구조)

전체 스키마 SQL은 git 리포지토리에 있습니다:
- `db/perp_schema.sql` — 기본 스키마 (9개 스키마 / 48테이블)
- `db/perp_additions_v2.sql` — 과업지시서 확장 (ai/notes/chat + 출석/구글연동/프로젝트 배정)

DB에는 이미 적용 완료 상태입니다. 구조 확인:
```sql
SELECT table_schema, count(*)
FROM information_schema.tables
WHERE table_type='BASE TABLE'
  AND table_schema NOT IN ('pg_catalog','information_schema')
GROUP BY table_schema ORDER BY table_schema;
```

---

## 5. 사용 규칙 (권장)

- **운영 DB `perp_db`은 실데이터용**입니다. 테스트/실험은 신중히.
- 스키마 변경(테이블 추가/수정)은 **팀 리더와 협의 후**, SQL 파일로 git에 남기고 적용.
- 비밀번호는 절대 코드/문서/깃/캡처로 공유하지 말 것.
