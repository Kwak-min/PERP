-- =====================================================================
-- PERP perp_db 테스트 데이터 시드 (동아리 시나리오)
-- 재실행 안전: '브랜치스 동아리' 회사가 이미 있으면 통째로 스킵.
-- 비밀번호(공통): test1234  (pbkdf2, 백엔드 crypto.js 형식과 동일)
-- =====================================================================
DO $$
DECLARE
    PW CONSTANT TEXT := 'e21103407b6bb65072973b890ec141c4$b23b2a8a90d0bd20266ddfb9d3deb3fec08d8e0792354cadd3f8150e6f6fadd4';
    v_company BIGINT;
    v_dep_plan BIGINT; v_dep_stage BIGINT; v_dep_edu BIGINT;
    v_pos_pres BIGINT; v_pos_vice BIGINT; v_pos_lead BIGINT; v_pos_member BIGINT;
    v_ws BIGINT;
    v_kim BIGINT; v_lee BIGINT; v_hana BIGINT; v_choi BIGINT; v_park BIGINT;
    v_team_plan BIGINT; v_team_stage BIGINT;
    v_room BIGINT;
    v_period BIGINT; v_acc_cash BIGINT; v_acc_rev BIGINT; v_acc_exp BIGINT;
    v_entry BIGINT;
    v_project BIGINT; v_doc BIGINT; v_minute BIGINT;
    v_vault BIGINT; v_note1 BIGINT; v_note2 BIGINT;
    v_thread BIGINT; v_item BIGINT;
    v_ev BIGINT;
BEGIN
    IF EXISTS (SELECT 1 FROM org.companies WHERE name = '브랜치스 동아리') THEN
        RAISE NOTICE '이미 시드됨: 브랜치스 동아리 존재 -> 스킵';
        RETURN;
    END IF;

    -- 1) 회사
    INSERT INTO org.companies(name, ceo_name, address)
    VALUES ('브랜치스 동아리', '김회장', '학생회관 201호')
    RETURNING id INTO v_company;

    -- 2) 부서
    INSERT INTO org.departments(company_id, name, code) VALUES (v_company,'기획팀','PLAN') RETURNING id INTO v_dep_plan;
    INSERT INTO org.departments(company_id, name, code) VALUES (v_company,'무대팀','STAGE') RETURNING id INTO v_dep_stage;
    INSERT INTO org.departments(company_id, name, code) VALUES (v_company,'교육팀','EDU')  RETURNING id INTO v_dep_edu;

    -- 3) 직급 (rank_level 클수록 상위)
    INSERT INTO org.positions(company_id, name, rank_level) VALUES (v_company,'회장',40)  RETURNING id INTO v_pos_pres;
    INSERT INTO org.positions(company_id, name, rank_level) VALUES (v_company,'부회장',30) RETURNING id INTO v_pos_vice;
    INSERT INTO org.positions(company_id, name, rank_level) VALUES (v_company,'팀장',20)  RETURNING id INTO v_pos_lead;
    INSERT INTO org.positions(company_id, name, rank_level) VALUES (v_company,'부원',10)  RETURNING id INTO v_pos_member;

    -- 4) 워크스페이스
    INSERT INTO org.workspaces(company_id, name, kind) VALUES (v_company,'브랜치스 워크스페이스','general') RETURNING id INTO v_ws;

    -- 5) 사용자 (공통 pw: test1234, 전원 승인/활성)
    INSERT INTO auth.users(company_id, department_id, position_id, email, name, phone, password_hash, approval_status, is_admin, approved_at)
      VALUES (v_company, v_dep_plan,  v_pos_pres,   'chair@club.dev',     '김회장', '010-1000-0001', PW, 'approved', true,  now()) RETURNING id INTO v_kim;
    INSERT INTO auth.users(company_id, department_id, position_id, email, name, phone, password_hash, approval_status, approved_by, approved_at)
      VALUES (v_company, v_dep_stage, v_pos_lead,   'lead@club.dev',      '이팀장', '010-1000-0002', PW, 'approved', v_kim, now()) RETURNING id INTO v_lee;
    INSERT INTO auth.users(company_id, department_id, position_id, email, name, phone, password_hash, approval_status, approved_by, approved_at)
      VALUES (v_company, v_dep_plan,  v_pos_member, 'hana@club.dev',      '정하나', '010-1000-0003', PW, 'approved', v_kim, now()) RETURNING id INTO v_hana;
    INSERT INTO auth.users(company_id, department_id, position_id, email, name, phone, password_hash, approval_status, approved_by, approved_at)
      VALUES (v_company, v_dep_edu,   v_pos_member, 'member@club.dev',    '최회원', '010-1000-0004', PW, 'approved', v_kim, now()) RETURNING id INTO v_choi;
    -- 박총무: 승인 대기(관리자 승인 화면 테스트용)
    INSERT INTO auth.users(company_id, department_id, position_id, email, name, phone, password_hash, approval_status)
      VALUES (v_company, v_dep_plan,  v_pos_vice,   'treasurer@club.dev', '박총무', '010-1000-0005', PW, 'pending') RETURNING id INTO v_park;

    -- 부서장 지정
    UPDATE org.departments SET manager_id = v_kim  WHERE id = v_dep_plan;
    UPDATE org.departments SET manager_id = v_lee  WHERE id = v_dep_stage;
    UPDATE org.departments SET manager_id = v_choi WHERE id = v_dep_edu;

    -- 6) 팀 + 팀원
    INSERT INTO org.teams(company_id, department_id, name, leader_id) VALUES (v_company, v_dep_plan,  '공연기획팀', v_kim) RETURNING id INTO v_team_plan;
    INSERT INTO org.teams(company_id, department_id, name, leader_id) VALUES (v_company, v_dep_stage, '무대운영팀', v_lee) RETURNING id INTO v_team_stage;
    INSERT INTO org.team_members(team_id, user_id, team_role) VALUES
      (v_team_plan, v_kim,'leader'), (v_team_plan, v_hana,'member'), (v_team_plan, v_park,'member'),
      (v_team_stage, v_lee,'leader'), (v_team_stage, v_choi,'member');

    -- 7) 관리자 승인요청 (박총무 가입 승인 대기)
    INSERT INTO org.approval_requests(company_id, request_type, requester_id, target_user_id, payload, status)
      VALUES (v_company, 'user_signup', v_park, v_park, '{"desired_department":"기획팀","desired_position":"부회장"}'::jsonb, 'pending');

    -- 8) 캘린더 이벤트 (CAL-001 시나리오 일부)
    INSERT INTO calendar.events(company_id, owner_id, title, description, location, starts_at, ends_at, scope, department_id, team_id)
      VALUES (v_company, v_kim, '운영 회의', '주간 운영 회의', '동아리방 A', '2026-08-24 19:00+09','2026-08-24 20:00+09','team', v_dep_plan, v_team_plan) RETURNING id INTO v_ev;
    INSERT INTO calendar.event_participants(event_id, user_id, response) VALUES (v_ev, v_kim,'accepted'),(v_ev, v_hana,'invited'),(v_ev, v_park,'invited');
    INSERT INTO calendar.events(company_id, owner_id, title, description, location, starts_at, ends_at, scope)
      VALUES (v_company, v_kim, '정기공연 리허설', '봄 정기공연 리허설', '학생회관 대강당', '2026-08-26 18:00+09','2026-08-26 21:00+09','company');
    INSERT INTO calendar.events(company_id, owner_id, title, description, location, starts_at, ends_at, scope)
      VALUES (v_company, v_kim, '봄 정기공연 본공연', '본공연', '학생회관 대강당', '2026-08-30 17:00+09','2026-08-30 21:00+09','company');
    INSERT INTO calendar.events(company_id, owner_id, title, description, location, starts_at, ends_at, scope)
      VALUES (v_company, v_choi, '신입 설명회', '신입 대상 설명회', '세미나실 B', '2026-08-28 19:00+09','2026-08-28 20:30+09','company');

    -- 9) 채팅방 + 메시지 (+AI)
    INSERT INTO chat.rooms(company_id, name, is_group, created_by) VALUES (v_company, '공연준비 단톡방', true, v_kim) RETURNING id INTO v_room;
    INSERT INTO chat.room_members(room_id, user_id, last_read_at) VALUES
      (v_room, v_kim, now()),(v_room, v_lee, now()),(v_room, v_hana, now()),(v_room, v_choi, now());
    INSERT INTO chat.messages(room_id, sender_id, content) VALUES
      (v_room, v_kim,  '이번 주 리허설 8/26 18시 대강당입니다. 다들 참고해주세요.'),
      (v_room, v_lee,  '무대팀 장비 세팅은 17시부터 시작할게요.'),
      (v_room, v_hana, '기획팀 큐시트 오늘 중으로 공유드리겠습니다.');
    INSERT INTO chat.messages(room_id, sender_id, is_ai, content) VALUES
      (v_room, NULL, true, '[AI 요약] 리허설: 8/26 18:00 대강당 · 장비 세팅 17:00(무대팀) · 큐시트 공유 예정(기획팀).');

    -- 10) 출석/근태
    INSERT INTO hr.attendances(company_id, user_id, work_date, check_in_at, check_out_at) VALUES
      (v_company, v_kim,  DATE '2026-08-22', '2026-08-22 09:02+09','2026-08-22 18:10+09'),
      (v_company, v_hana, DATE '2026-08-22', '2026-08-22 09:15+09', NULL);
    INSERT INTO hr.leave_balances(company_id, user_id, year, total_days, used_days) VALUES
      (v_company, v_kim, 2026, 15, 2), (v_company, v_hana, 2026, 15, 0);
    INSERT INTO hr.leave_requests(company_id, user_id, leave_type, starts_on, ends_on, days, reason, status)
      VALUES (v_company, v_hana, '연차', DATE '2026-09-01', DATE '2026-09-01', 1, '개인 사유', 'pending');

    -- 11) 회계: 회계기간 + 계정 + 분개(회비수입 / 행사비지출)
    INSERT INTO accounting.fiscal_periods(company_id, name, starts_on, ends_on)
      VALUES (v_company, '2026 회계연도', DATE '2026-01-01', DATE '2026-12-31') RETURNING id INTO v_period;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'1000','현금','asset')    RETURNING id INTO v_acc_cash;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'4000','회비수입','revenue') RETURNING id INTO v_acc_rev;
    INSERT INTO accounting.accounts(company_id, code, name, account_type) VALUES (v_company,'5000','행사비','expense')  RETURNING id INTO v_acc_exp;
    -- 수입 전표: 현금 2,300,000 차변 / 회비수입 2,300,000 대변
    INSERT INTO accounting.journal_entries(company_id, period_id, entry_date, memo, created_by, posted)
      VALUES (v_company, v_period, DATE '2026-03-02', '3월 회비 수입', v_park, true) RETURNING id INTO v_entry;
    INSERT INTO accounting.journal_lines(entry_id, account_id, debit, credit, description) VALUES
      (v_entry, v_acc_cash, 2300000, 0, '회비 입금'),
      (v_entry, v_acc_rev,  0, 2300000, '3월 회비');
    -- 지출 전표: 행사비 1,150,000 차변 / 현금 1,150,000 대변
    INSERT INTO accounting.journal_entries(company_id, period_id, entry_date, memo, created_by, posted)
      VALUES (v_company, v_period, DATE '2026-03-14', '정기공연 행사비', v_park, true) RETURNING id INTO v_entry;
    INSERT INTO accounting.journal_lines(entry_id, account_id, debit, credit, description) VALUES
      (v_entry, v_acc_exp,  1150000, 0, '대관/장비'),
      (v_entry, v_acc_cash, 0, 1150000, '행사비 지출');

    -- 12) 프로젝트 + 멤버 + 문서(md) + 회의록 + 배정
    INSERT INTO project.projects(company_id, department_id, team_id, name, description, status, starts_on, ends_on, lead_id)
      VALUES (v_company, v_dep_plan, v_team_plan, '봄 정기공연', '2026 봄 정기공연 기획/운영', 'active', DATE '2026-02-01', DATE '2026-03-31', v_kim) RETURNING id INTO v_project;
    INSERT INTO project.project_members(project_id, user_id, role) VALUES
      (v_project, v_kim,'lead'),(v_project, v_lee,'member'),(v_project, v_hana,'member'),(v_project, v_choi,'member');
    INSERT INTO project.documents(project_id, title, content_md, author_id)
      VALUES (v_project, '공연 기획서', E'# 봄 정기공연 기획서\n\n- 일시: 2026-03-20 17:00\n- 장소: 학생회관 대강당\n- 예산: 2,300,000원\n', v_kim) RETURNING id INTO v_doc;
    INSERT INTO project.meeting_minutes(project_id, company_id, title, meeting_at, location, content_md, author_id)
      VALUES (v_project, v_company, '1차 기획 회의록', '2026-02-10 19:00+09', '동아리방 A', E'## 결정사항\n- 대관 확정\n- SNS 홍보 시작\n', v_hana) RETURNING id INTO v_minute;
    INSERT INTO project.meeting_attendees(minute_id, user_id) VALUES (v_minute, v_kim),(v_minute, v_hana),(v_minute, v_lee);
    INSERT INTO project.assignments(project_id, user_id, role, allocation_pct, started_on, ended_on) VALUES
      (v_project, v_kim,  'lead',   100, DATE '2026-02-01', NULL),
      (v_project, v_hana, 'member', 60,  DATE '2026-02-01', NULL),
      (v_project, v_lee,  'member', 40,  DATE '2026-02-05', DATE '2026-03-25');

    -- 13) 공지
    INSERT INTO notice.notices(company_id, author_id, title, body, is_official, visibility, pinned)
      VALUES (v_company, v_kim, '[중요] 봄 정기공연 총동원령', '3/20 본공연, 전원 참석 바랍니다.', true, 'company', true);

    -- 14) 노트(옵시디언형)
    INSERT INTO notes.vaults(owner_id, name) VALUES (v_kim, 'My Vault') RETURNING id INTO v_vault;
    INSERT INTO notes.notes(vault_id, folder_path, title, content_md)
      VALUES (v_vault, '/공연', '큐시트 초안', E'# 큐시트\n[[무대 배치]] 참고\n') RETURNING id INTO v_note1;
    INSERT INTO notes.notes(vault_id, folder_path, title, content_md)
      VALUES (v_vault, '/공연', '무대 배치', E'# 무대 배치\n- 좌: 음향\n- 우: 조명\n') RETURNING id INTO v_note2;
    INSERT INTO notes.links(from_note_id, to_note_id) VALUES (v_note1, v_note2);

    -- 15) AI LLM 설정 (외부 OpenRouter 기본 + 로컬)
    INSERT INTO ai.llm_configs(company_id, name, provider, model, is_local, is_default, params)
      VALUES (v_company, 'OpenRouter GPT-4o-mini', 'openrouter', 'openai/gpt-4o-mini', false, true, '{"temperature":0.3}'::jsonb);
    INSERT INTO ai.llm_configs(company_id, name, provider, model, endpoint, is_local, params)
      VALUES (v_company, '로컬 Llama3', 'local', 'llama3', 'http://localhost:11434', true, '{"temperature":0.2}'::jsonb);

    -- 16) 보고 스레드(선택)
    INSERT INTO report.threads(company_id, title, created_by) VALUES (v_company, '주간 업무보고', v_kim) RETURNING id INTO v_thread;
    INSERT INTO report.items(thread_id, seq, sender_id, action, body) VALUES (v_thread, 1, v_hana, 'submit', '기획팀 주간: 큐시트 초안 완료, 홍보물 검수 진행') RETURNING id INTO v_item;
    INSERT INTO report.recipients(item_id, user_id) VALUES (v_item, v_kim);
    INSERT INTO report.notifications(user_id, kind, title, body) VALUES (v_kim, 'report', '새 업무보고', '정하나님이 주간 보고를 제출했습니다.');

    RAISE NOTICE '시드 완료: company_id=%', v_company;
END $$;
