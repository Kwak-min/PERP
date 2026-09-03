-- =====================================================================
-- PERP perp_db 테스트 데이터: 20인 규모 중소기업 (OrbitFlow 주식회사)
-- 재실행 안전: 회사 존재 시 통째로 스킵.
-- 공통 비밀번호: test1234 (pbkdf2, 백엔드 crypto.js 형식)
-- =====================================================================
DO $$
DECLARE
    PW CONSTANT TEXT := 'e21103407b6bb65072973b890ec141c4$b23b2a8a90d0bd20266ddfb9d3deb3fec08d8e0792354cadd3f8150e6f6fadd4';
    CO CONSTANT TEXT := 'OrbitFlow 주식회사';
    v_company BIGINT;
    v_rep BIGINT; v_dev_lead BIGINT; v_sales_lead BIGINT;
    v_ws BIGINT;
    v_period BIGINT; v_cash BIGINT; v_rev BIGINT; v_sal BIGINT; v_office BIGINT;
    v_room_all BIGINT; v_room_dev BIGINT; v_room_sales BIGINT;
    v_prj_erp BIGINT; v_prj_web BIGINT; v_prj_brand BIGINT;
    v_post1 BIGINT; v_post2 BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM org.companies WHERE name = CO) THEN
        RAISE NOTICE '이미 시드됨: % 존재 -> 스킵', CO; RETURN;
    END IF;

    -- 1) 회사 / 부서 / 직급 / 워크스페이스
    INSERT INTO org.companies(name, biz_reg_no, ceo_name, address)
      VALUES (CO, '220-88-12345', '김대표', '서울시 강남구 테헤란로 123') RETURNING id INTO v_company;

    INSERT INTO org.departments(company_id, name, code) VALUES
      (v_company,'경영지원팀','MGMT'),(v_company,'개발팀','DEV'),
      (v_company,'디자인팀','DESIGN'),(v_company,'영업팀','SALES');

    INSERT INTO org.positions(company_id, name, rank_level) VALUES
      (v_company,'대표',50),(v_company,'이사',40),(v_company,'팀장',20),(v_company,'사원',10);

    INSERT INTO org.workspaces(company_id, name, kind) VALUES (v_company,'OrbitFlow 워크스페이스','general') RETURNING id INTO v_ws;

    -- 2) 사용자 20명 (부서/직급 이름으로 해석해 FK 연결)
    INSERT INTO auth.users(company_id, department_id, position_id, email, name, phone, password_hash, approval_status, is_admin, approved_at)
    SELECT v_company,
           (SELECT id FROM org.departments WHERE company_id=v_company AND name=v.dept),
           (SELECT id FROM org.positions   WHERE company_id=v_company AND name=v.pos),
           v.email, v.nm, v.phone, PW,
           v.st::common.approval_status, v.adm,
           CASE WHEN v.st='approved' THEN now() ELSE NULL END
    FROM (VALUES
      ('emp01@orbitflow.dev','김대표','경영지원팀','대표', true, 'approved','010-2000-0001'),
      ('emp02@orbitflow.dev','이이사','경영지원팀','이사', false,'approved','010-2000-0002'),
      ('emp03@orbitflow.dev','문지원','경영지원팀','팀장', false,'approved','010-2000-0003'),
      ('emp04@orbitflow.dev','박총무','경영지원팀','사원', false,'approved','010-2000-0004'),
      ('emp05@orbitflow.dev','이재무','경영지원팀','사원', false,'approved','010-2000-0005'),
      ('emp06@orbitflow.dev','정개발','개발팀','팀장',    false,'approved','010-2000-0006'),
      ('emp07@orbitflow.dev','최코딩','개발팀','사원',    false,'approved','010-2000-0007'),
      ('emp08@orbitflow.dev','한서버','개발팀','사원',    false,'approved','010-2000-0008'),
      ('emp09@orbitflow.dev','오프론','개발팀','사원',    false,'approved','010-2000-0009'),
      ('emp10@orbitflow.dev','신디비','개발팀','사원',    false,'approved','010-2000-0010'),
      ('emp11@orbitflow.dev','권알고','개발팀','사원',    false,'approved','010-2000-0011'),
      ('emp12@orbitflow.dev','강디자','디자인팀','팀장',  false,'approved','010-2000-0012'),
      ('emp13@orbitflow.dev','윤그래','디자인팀','사원',  false,'approved','010-2000-0013'),
      ('emp14@orbitflow.dev','임유아','디자인팀','사원',  false,'approved','010-2000-0014'),
      ('emp15@orbitflow.dev','조영업','영업팀','팀장',    false,'approved','010-2000-0015'),
      ('emp16@orbitflow.dev','배세일','영업팀','사원',    false,'approved','010-2000-0016'),
      ('emp17@orbitflow.dev','서고객','영업팀','사원',    false,'approved','010-2000-0017'),
      ('emp18@orbitflow.dev','남계약','영업팀','사원',    false,'approved','010-2000-0018'),
      ('emp19@orbitflow.dev','홍영업','영업팀','사원',    false,'approved','010-2000-0019'),
      ('emp20@orbitflow.dev','유고객','영업팀','사원',    false,'pending', '010-2000-0020')
    ) AS v(email,nm,dept,pos,adm,st,phone);

    SELECT id INTO v_rep        FROM auth.users WHERE company_id=v_company AND email='emp01@orbitflow.dev';
    SELECT id INTO v_dev_lead   FROM auth.users WHERE company_id=v_company AND email='emp06@orbitflow.dev';
    SELECT id INTO v_sales_lead FROM auth.users WHERE company_id=v_company AND email='emp15@orbitflow.dev';

    -- 3) 팀(부서별 1개) + 팀원 + 부서장
    INSERT INTO org.teams(company_id, department_id, name, leader_id)
    SELECT v_company, d.id, replace(d.name,'팀','')||' 팀',
           (SELECT u.id FROM auth.users u JOIN org.positions p ON p.id=u.position_id
             WHERE u.company_id=v_company AND u.department_id=d.id AND p.name='팀장' LIMIT 1)
    FROM org.departments d WHERE d.company_id=v_company;

    INSERT INTO org.team_members(team_id, user_id, team_role)
    SELECT t.id, u.id, CASE WHEN t.leader_id=u.id THEN 'leader' ELSE 'member' END
    FROM org.teams t JOIN auth.users u ON u.company_id=v_company AND u.department_id=t.department_id
    WHERE t.company_id=v_company;

    UPDATE org.departments d SET manager_id =
      (SELECT t.leader_id FROM org.teams t WHERE t.company_id=v_company AND t.department_id=d.id LIMIT 1)
    WHERE d.company_id=v_company;

    -- 승인 대기자(유고객) 승인요청
    INSERT INTO org.approval_requests(company_id, request_type, requester_id, target_user_id, payload, status)
    SELECT v_company,'user_signup',u.id,u.id,'{"desired_department":"영업팀","desired_position":"사원"}'::jsonb,'pending'
    FROM auth.users u WHERE u.company_id=v_company AND u.email='emp20@orbitflow.dev';

    -- 4) 캘린더: 팀별 주간회의(4팀 x 4주) + 전사 이벤트
    INSERT INTO calendar.events(company_id, owner_id, title, starts_at, ends_at, scope, department_id, team_id)
    SELECT v_company, t.leader_id, t.name||' 주간회의',
           (wk + time '10:00') AT TIME ZONE 'Asia/Seoul', (wk + time '11:00') AT TIME ZONE 'Asia/Seoul',
           'team', t.department_id, t.id
    FROM org.teams t
    CROSS JOIN generate_series(date '2026-08-03', date '2026-08-24', interval '7 day') g(wk)
    WHERE t.company_id=v_company;

    INSERT INTO calendar.events(company_id, owner_id, title, description, location, starts_at, ends_at, all_day, scope) VALUES
      (v_company, v_rep, '전사 월간회의', '8월 전사 회의', '대회의실',
        (date '2026-08-14' + time '15:00') AT TIME ZONE 'Asia/Seoul', (date '2026-08-14' + time '16:30') AT TIME ZONE 'Asia/Seoul', false, 'company'),
      (v_company, v_rep, '창립기념일', '휴무', NULL,
        (date '2026-08-20') AT TIME ZONE 'Asia/Seoul', (date '2026-08-21') AT TIME ZONE 'Asia/Seoul', true, 'company'),
      (v_company, v_dev_lead, 'ERP 스프린트 데모', '2주 스프린트 결과 데모', '개발실',
        (date '2026-08-22' + time '14:00') AT TIME ZONE 'Asia/Seoul', (date '2026-08-22' + time '15:00') AT TIME ZONE 'Asia/Seoul', false, 'department');

    -- 5) 채팅: 전체/개발/영업 방 + 메시지(AI 포함)
    INSERT INTO chat.rooms(company_id, name, is_group, created_by) VALUES (v_company,'전체 공지방',true,v_rep) RETURNING id INTO v_room_all;
    INSERT INTO chat.rooms(company_id, name, is_group, created_by) VALUES (v_company,'개발팀',true,v_dev_lead) RETURNING id INTO v_room_dev;
    INSERT INTO chat.rooms(company_id, name, is_group, created_by) VALUES (v_company,'영업팀',true,v_sales_lead) RETURNING id INTO v_room_sales;

    INSERT INTO chat.room_members(room_id, user_id, last_read_at)
      SELECT v_room_all, u.id, now() FROM auth.users u WHERE u.company_id=v_company AND u.approval_status='approved';
    INSERT INTO chat.room_members(room_id, user_id, last_read_at)
      SELECT v_room_dev, u.id, now() FROM auth.users u JOIN org.departments d ON d.id=u.department_id
       WHERE u.company_id=v_company AND d.name='개발팀';
    INSERT INTO chat.room_members(room_id, user_id, last_read_at)
      SELECT v_room_sales, u.id, now() FROM auth.users u JOIN org.departments d ON d.id=u.department_id
       WHERE u.company_id=v_company AND d.name='영업팀';

    INSERT INTO chat.messages(room_id, sender_id, content) VALUES
      (v_room_all, v_rep, '이번 주 전사 회의는 8/14 15시 대회의실입니다.'),
      (v_room_dev, v_dev_lead, '스프린트 데모 8/22 14시. PR 금요일까지 머지 부탁해요.'),
      (v_room_dev, (SELECT id FROM auth.users WHERE company_id=v_company AND email='emp07@orbitflow.dev'), '로그인 API 리뷰 반영 완료했습니다.'),
      (v_room_sales, v_sales_lead, '이번 달 목표 대비 82% 달성. 마지막 주 스퍼트!');
    INSERT INTO chat.messages(room_id, sender_id, is_ai, content) VALUES
      (v_room_dev, NULL, true, '[AI] 이번 스프린트 미완료 이슈 3건: 로그인 API, 알림 배치, 캘린더 동기화.');

    -- 6) HR: 근태(최근 5영업일 x 전 직원) + 연차잔여 + 연차신청 + 급여(8월)
    INSERT INTO hr.attendances(company_id, user_id, work_date, check_in_at, check_out_at, source)
    SELECT v_company, u.id, d::date,
           (d + time '09:00') AT TIME ZONE 'Asia/Seoul' + make_interval(mins => (random()*20)::int),
           (d + time '18:00') AT TIME ZONE 'Asia/Seoul' + make_interval(mins => (random()*40)::int),
           'button'
    FROM auth.users u
    CROSS JOIN generate_series(date '2026-08-17', date '2026-08-21', interval '1 day') g(d)
    WHERE u.company_id=v_company AND u.approval_status='approved' AND extract(isodow FROM d) < 6;

    INSERT INTO hr.leave_balances(company_id, user_id, year, total_days, used_days)
    SELECT v_company, u.id, 2026, 15, (random()*5)::numeric(4,1)
    FROM auth.users u WHERE u.company_id=v_company AND u.approval_status='approved';

    INSERT INTO hr.leave_requests(company_id, user_id, leave_type, starts_on, ends_on, days, reason, status, approver_id, decided_at)
    SELECT v_company, u.id, '연차', DATE '2026-08-28', DATE '2026-08-28', 1, '개인 사유',
           'approved', v_rep, now()
    FROM auth.users u WHERE u.company_id=v_company AND u.email='emp08@orbitflow.dev';
    INSERT INTO hr.leave_requests(company_id, user_id, leave_type, starts_on, ends_on, days, reason, status)
    SELECT v_company, u.id, '반차', DATE '2026-08-25', DATE '2026-08-25', 0.5, '병원',
           'pending'
    FROM auth.users u WHERE u.company_id=v_company AND u.email='emp13@orbitflow.dev';

    INSERT INTO hr.payrolls(company_id, user_id, pay_year, pay_month, base_salary, allowances, deductions, net_pay, paid_at)
    SELECT v_company, u.id, 2026, 8,
           b.base, 200000, round(b.base*0.091,2), b.base + 200000 - round(b.base*0.091,2),
           (date '2026-08-25' + time '10:00') AT TIME ZONE 'Asia/Seoul'
    FROM auth.users u
    JOIN org.positions p ON p.id=u.position_id
    CROSS JOIN LATERAL (SELECT (2000000 + p.rank_level*40000)::numeric(18,2) AS base) b
    WHERE u.company_id=v_company AND u.approval_status='approved';

    -- 채용(빈 모듈 채우기)
    INSERT INTO hr.job_postings(company_id, department_id, title, description, headcount, status)
      VALUES (v_company,(SELECT id FROM org.departments WHERE company_id=v_company AND name='개발팀'),'백엔드 개발자','Node.js/PostgreSQL',2,'open') RETURNING id INTO v_post1;
    INSERT INTO hr.job_postings(company_id, department_id, title, description, headcount, status)
      VALUES (v_company,(SELECT id FROM org.departments WHERE company_id=v_company AND name='디자인팀'),'UX 디자이너','Figma',1,'open') RETURNING id INTO v_post2;
    INSERT INTO hr.applicants(posting_id, name, email, phone, stage) VALUES
      (v_post1,'지원자A','appA@mail.dev','010-3000-0001','applied'),
      (v_post1,'지원자B','appB@mail.dev','010-3000-0002','interview'),
      (v_post1,'지원자C','appC@mail.dev','010-3000-0003','applied'),
      (v_post2,'지원자D','appD@mail.dev','010-3000-0004','offer');

    -- 7) 회계: 회계기간 + 계정 + 월별 매출/급여 전표(1~8월)
    INSERT INTO accounting.fiscal_periods(company_id, name, starts_on, ends_on)
      VALUES (v_company,'2026 회계연도',DATE '2026-01-01',DATE '2026-12-31') RETURNING id INTO v_period;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'1000','현금','asset')    RETURNING id INTO v_cash;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'4000','용역매출','revenue') RETURNING id INTO v_rev;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'5100','급여','expense')   RETURNING id INTO v_sal;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'5200','사무비','expense') RETURNING id INTO v_office;

    -- 매출 전표(월말)
    INSERT INTO accounting.journal_entries(company_id, period_id, entry_date, memo, created_by, posted)
    SELECT v_company, v_period, (m + interval '1 month' - interval '1 day')::date, '매출-'||to_char(m,'YYYY-MM'), v_rep, true
    FROM generate_series(date '2026-01-01', date '2026-08-01', interval '1 month') g(m);
    -- 급여 전표(25일)
    INSERT INTO accounting.journal_entries(company_id, period_id, entry_date, memo, created_by, posted)
    SELECT v_company, v_period, (m + interval '24 day')::date, '급여-'||to_char(m,'YYYY-MM'), v_rep, true
    FROM generate_series(date '2026-01-01', date '2026-08-01', interval '1 month') g(m);

    -- 매출 라인: 현금 차변 / 용역매출 대변 (월 3천만)
    INSERT INTO accounting.journal_lines(entry_id, account_id, debit, credit, description)
    SELECT je.id, v_cash, 30000000, 0, '매출 입금' FROM accounting.journal_entries je WHERE je.company_id=v_company AND je.memo LIKE '매출-%';
    INSERT INTO accounting.journal_lines(entry_id, account_id, debit, credit, description)
    SELECT je.id, v_rev, 0, 30000000, '용역 매출' FROM accounting.journal_entries je WHERE je.company_id=v_company AND je.memo LIKE '매출-%';
    -- 급여 라인: 급여 차변 / 현금 대변 (월 5.5천만)
    INSERT INTO accounting.journal_lines(entry_id, account_id, debit, credit, description)
    SELECT je.id, v_sal, 55000000, 0, '급여 지급' FROM accounting.journal_entries je WHERE je.company_id=v_company AND je.memo LIKE '급여-%';
    INSERT INTO accounting.journal_lines(entry_id, account_id, debit, credit, description)
    SELECT je.id, v_cash, 0, 55000000, '급여 이체' FROM accounting.journal_entries je WHERE je.company_id=v_company AND je.memo LIKE '급여-%';

    -- 세무신고(빈 모듈)
    INSERT INTO accounting.tax_filings(company_id, period_id, tax_type, amount, due_date, status)
      VALUES (v_company, v_period, '부가세', 12000000, DATE '2026-07-25', 'filed');

    -- 8) 프로젝트 3개 + 멤버/배정/문서/회의록
    INSERT INTO project.projects(company_id, department_id, team_id, name, description, status, starts_on, ends_on, lead_id)
    VALUES
      (v_company,(SELECT id FROM org.departments WHERE company_id=v_company AND name='개발팀'),
       (SELECT id FROM org.teams WHERE company_id=v_company AND name LIKE '개발%' LIMIT 1),
       'ERP 구축','사내 ERP/운영OS 구축','active',DATE '2026-06-01',DATE '2026-12-31',v_dev_lead)
      RETURNING id INTO v_prj_erp;
    INSERT INTO project.projects(company_id, department_id, team_id, name, description, status, starts_on, lead_id)
    VALUES (v_company,(SELECT id FROM org.departments WHERE company_id=v_company AND name='개발팀'),NULL,
            '홈페이지 리뉴얼','회사 웹사이트 리뉴얼','active',DATE '2026-08-01',v_dev_lead) RETURNING id INTO v_prj_web;
    INSERT INTO project.projects(company_id, department_id, team_id, name, description, status, starts_on, ends_on, lead_id)
    VALUES (v_company,(SELECT id FROM org.departments WHERE company_id=v_company AND name='디자인팀'),NULL,
            '브랜드 개편','CI/BI 개편','completed',DATE '2026-03-01',DATE '2026-05-31',
            (SELECT id FROM auth.users WHERE company_id=v_company AND email='emp12@orbitflow.dev')) RETURNING id INTO v_prj_brand;

    -- ERP 프로젝트 멤버 = 개발팀 전원
    INSERT INTO project.project_members(project_id, user_id, role)
    SELECT v_prj_erp, u.id, CASE WHEN u.id=v_dev_lead THEN 'lead' ELSE 'member' END
    FROM auth.users u JOIN org.departments d ON d.id=u.department_id
    WHERE u.company_id=v_company AND d.name='개발팀';

    INSERT INTO project.assignments(project_id, user_id, role, allocation_pct, started_on, ended_on)
    SELECT v_prj_erp, u.id, CASE WHEN u.id=v_dev_lead THEN 'lead' ELSE 'member' END,
           CASE WHEN u.id=v_dev_lead THEN 50 ELSE 100 END, DATE '2026-06-01', NULL
    FROM auth.users u JOIN org.departments d ON d.id=u.department_id
    WHERE u.company_id=v_company AND d.name='개발팀';

    INSERT INTO project.documents(project_id, title, content_md, author_id)
    VALUES (v_prj_erp,'ERP 요구사항 정리', E'# ERP 요구사항\n- 캘린더/회계/HR/채팅\n- AI Agent 연동\n', v_dev_lead);

    INSERT INTO project.meeting_minutes(project_id, company_id, title, meeting_at, location, content_md, author_id)
    VALUES (v_prj_erp, v_company, 'ERP 킥오프', (date '2026-06-02' + time '10:00') AT TIME ZONE 'Asia/Seoul', '개발실',
            E'## 킥오프\n- 스택 확정: Node/React/PostgreSQL\n- 스프린트 2주\n',
            (SELECT id FROM auth.users WHERE company_id=v_company AND email='emp07@orbitflow.dev'));

    -- 자원(회의실) + 예약(비겹침)
    INSERT INTO project.spaces(company_id, name, capacity, location) VALUES
      (v_company,'대회의실',20,'5F'),(v_company,'소회의실',6,'5F');
    INSERT INTO project.space_reservations(space_id, reserved_by, project_id, title, starts_at, ends_at)
    SELECT s.id, v_dev_lead, v_prj_erp, 'ERP 데모',
           (date '2026-08-22' + time '14:00') AT TIME ZONE 'Asia/Seoul', (date '2026-08-22' + time '15:00') AT TIME ZONE 'Asia/Seoul'
    FROM project.spaces s WHERE s.company_id=v_company AND s.name='대회의실';

    -- 9) 공지
    INSERT INTO notice.notices(company_id, author_id, title, body, is_official, visibility, pinned) VALUES
      (v_company, v_rep, '[사규] 8월 근무 안내', '하계 유연근무 시행', true,'company',true),
      (v_company,(SELECT u.id FROM org.departments d JOIN auth.users u ON u.id=d.manager_id WHERE d.company_id=v_company AND d.name='경영지원팀' LIMIT 1),
        '복지포인트 신청 안내','8/31까지 신청', false,'company',false);

    -- 10) 노트(옵시디언형): 대표/개발팀장/디자인팀장 볼트
    INSERT INTO notes.vaults(owner_id, name)
    SELECT u.id, 'My Vault' FROM auth.users u
     WHERE u.company_id=v_company AND u.email IN ('emp01@orbitflow.dev','emp06@orbitflow.dev','emp12@orbitflow.dev');
    INSERT INTO notes.notes(vault_id, folder_path, title, content_md)
    SELECT vv.id,'/', '개인 메모', E'# 메모\n- 할 일 정리\n'
    FROM notes.vaults vv JOIN auth.users u ON u.id=vv.owner_id WHERE u.company_id=v_company;

    -- 11) AI LLM 설정
    INSERT INTO ai.llm_configs(company_id, name, provider, model, is_local, is_default, params) VALUES
      (v_company,'OpenRouter GPT-4o-mini','openrouter','openai/gpt-4o-mini',false,true,'{"temperature":0.3}'::jsonb);
    INSERT INTO ai.llm_configs(company_id, name, provider, model, endpoint, is_local, params) VALUES
      (v_company,'로컬 Llama3','local','llama3','http://localhost:11434',true,'{"temperature":0.2}'::jsonb);

    -- 12) 파일 메타(빈 모듈) + 구글 연동
    INSERT INTO files.objects(company_id, uploader_id, original_name, extension, mime_type, size_bytes, storage_bucket, storage_key) VALUES
      (v_company, v_rep,'사규.pdf','pdf','application/pdf',204800,'orbitflow','docs/policy.pdf'),
      (v_company, v_dev_lead,'ERD.png','png','image/png',512000,'orbitflow','docs/erd.png');
    INSERT INTO calendar.external_accounts(user_id, provider, account_email)
    SELECT u.id,'google', u.email FROM auth.users u WHERE u.company_id=v_company AND u.email IN ('emp01@orbitflow.dev','emp06@orbitflow.dev');

    -- 13) 보고 스레드 + 알림
    INSERT INTO report.threads(company_id, title, created_by)
      SELECT v_company,'개발팀 주간보고', v_dev_lead;
    INSERT INTO report.items(thread_id, seq, sender_id, action, body)
      SELECT t.id,1,v_dev_lead,'submit','스프린트 3 완료율 82%, 이슈 3건 이월'
      FROM report.threads t WHERE t.company_id=v_company AND t.title='개발팀 주간보고';
    INSERT INTO report.recipients(item_id, user_id)
      SELECT i.id, v_rep FROM report.items i JOIN report.threads t ON t.id=i.thread_id WHERE t.company_id=v_company;
    INSERT INTO report.notifications(user_id, kind, title, body)
      VALUES (v_rep,'report','새 주간보고','정개발님이 개발팀 주간보고를 제출했습니다.');

    RAISE NOTICE '20인 기업 시드 완료: company_id=%', v_company;
END $$;
