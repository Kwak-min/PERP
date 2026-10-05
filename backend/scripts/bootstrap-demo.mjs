// 데모 부트스트랩: 실제 백엔드에 "남부대 학생회" 조직 + 데모 구성원을 만든다.
// 조직 생성은 검증된 HTTP POST /tenants 를, 구성원은 DB insert() 를 사용한다.
// 멱등: 이미 있으면 건너뛴다. 실행: node scripts/bootstrap-demo.mjs
import { migrate } from "../src/config/migrate.js";
import { db } from "../src/config/db.js";
import { insert, newId, nowIso } from "../src/models/base.js";
import { hashPassword } from "../src/utils/crypto.js";

const BASE = process.env.BASE ?? "http://127.0.0.1:8000/api/v1";
const OWNER = { email: "a@naver.com", password: "aaaaaaaa", name: "김경준" };
const DEMO_PW = "demo1234";

// 추가 데모 구성원 (owner=더미 유저는 별도)
const MEMBERS = [
  { email: "seoyeon@demo.perp", name: "이서연", roles: "chair", title: "부회장" },
  { email: "junho@demo.perp", name: "박준호", roles: "dept_lead", title: "학술부장" },
  { email: "haneul@demo.perp", name: "정하늘", roles: "treasurer", title: "총무" },
  { email: "minji@demo.perp", name: "김민지", roles: "member", title: "홍보부원" },
  { email: "woojin@demo.perp", name: "최우진", roles: "member", title: "일반부원" },
  { email: "jiwoo@demo.perp", name: "한지우", roles: "auditor", title: "감사" },
  { email: "dohyun@demo.perp", name: "이도현", roles: "guest", title: "외부 협력자" },
];

async function api(path, { method = "GET", token, orgId, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(orgId ? { "X-Org-Id": orgId } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return json;
}

async function main() {
  migrate();

  // 1) 오너(더미 유저) 로그인 + 이름 보정
  const login = await api("/auth/login", {
    method: "POST",
    body: { email: OWNER.email, password: OWNER.password },
  });
  const token = login.access_token;
  const ownerId = login.user.id;
  db().prepare("UPDATE app_user SET name = ? WHERE id = ?").run(OWNER.name, ownerId);

  // 2) 조직 확보 (없으면 생성)
  const me = await api("/auth/me", { token });
  let org = me.organizations[0];
  if (!org) {
    const created = await api("/tenants", {
      method: "POST",
      token,
      body: {
        name: "남부대 학생회",
        type: "student_council",
        currency: "KRW",
        fiscal_year_start: 3,
      },
    });
    org = { org_id: created.org_id, tenant_id: created.tenant_id };
    console.log(`created org: ${created.name} (${created.org_id})`);
  } else {
    console.log(`org already exists: ${org.org_name} (${org.org_id})`);
  }
  const tenantId = org.tenant_id ?? (await resolveTenant(org.org_id));
  const orgId = org.org_id;

  // 3) 데모 구성원 생성 (app_user + membership 직접 insert)
  let added = 0;
  for (const m of MEMBERS) {
    const email = m.email.toLowerCase();
    let user = db().prepare("SELECT * FROM app_user WHERE email = ?").get(email);
    if (!user) {
      user = insert("app_user", {
        id: newId(),
        email,
        name: m.name,
        password_hash: hashPassword(DEMO_PW),
        must_change_password: 0,
        created_at: nowIso(),
      });
    }
    const existing = db()
      .prepare("SELECT id FROM membership WHERE tenant_id = ? AND org_id = ? AND user_id = ?")
      .get(tenantId, orgId, user.id);
    if (!existing) {
      insert("membership", {
        tenant_id: tenantId,
        user_id: user.id,
        org_id: orgId,
        roles: m.roles,
        status: "active",
        title: m.title,
        joined_at: nowIso(),
        created_by: ownerId,
      });
      added += 1;
    }
  }
  console.log(`demo members ensured: ${MEMBERS.length} (newly added memberships: ${added})`);

  // 4) 데모 업무 데이터 (프로젝트 + 업무) — API 사용, 멱등(이름 기준)
  await seedWork(token, orgId);

  // 5) 데모 재무 데이터 (계정 + 거래 + 예산 + 청구)
  await seedFinance(token, orgId);

  console.log("비밀번호 — 오너(김경준/a@naver.com): aaaaaaaa · 나머지 데모 계정: demo1234");
}

const ACCOUNTS = [
  { code: "4200", name: "후원금", kind: "income" },
  { code: "5200", name: "물품·비품", kind: "expense" },
  { code: "5300", name: "인쇄·홍보", kind: "expense" },
  { code: "5400", name: "다과·식비", kind: "expense" },
];
const TXS = [
  { kind: "income", account: "학생회비", amount: 1_200_000, occurred_on: "2026-09-12", memo: "9월 정기 회비", confirm: true },
  { kind: "income", account: "후원금", amount: 500_000, occurred_on: "2026-09-06", memo: "동문회 학술제 후원", confirm: true },
  { kind: "expense", account: "행사비", amount: 450_000, occurred_on: "2026-09-10", memo: "정기총회 대관료", confirm: true },
  { kind: "expense", account: "인쇄·홍보", amount: 180_000, occurred_on: "2026-09-08", memo: "학술제 포스터 인쇄", confirm: true },
  { kind: "expense", account: "다과·식비", amount: 62_000, occurred_on: "2026-09-05", memo: "회의 다과", confirm: false },
  { kind: "expense", account: "물품·비품", amount: 88_000, occurred_on: "2026-09-03", memo: "행사 소모품", confirm: false },
];
const BUDGETS = [
  { name: "행사비", account: "행사비", amount: 5_000_000 },
  { name: "인쇄·홍보", account: "인쇄·홍보", amount: 1_500_000 },
  { name: "다과·식비", account: "다과·식비", amount: 1_200_000 },
];

async function seedFinance(token, orgId) {
  const opt = (body, method = "POST") => ({ method, token, orgId, body });
  // 계정 확보
  let accounts = (await api("/finance/accounts", { token, orgId })).items ?? [];
  const accByName = new Map(accounts.map((a) => [a.name, a.id]));
  let newA = 0;
  for (const a of ACCOUNTS) {
    if (accByName.has(a.name)) continue;
    const created = await api("/finance/accounts", opt(a));
    accByName.set(a.name, created.id ?? created.account?.id);
    newA += 1;
  }
  // 재조회(id 확보)
  accounts = (await api("/finance/accounts", { token, orgId })).items ?? [];
  for (const a of accounts) accByName.set(a.name, a.id);

  // 거래 (+확정)
  const existingTx = (await api("/finance/transactions", { token, orgId })).items ?? [];
  const txMemos = new Set(existingTx.map((t) => t.memo));
  let newT = 0;
  for (const t of TXS) {
    if (txMemos.has(t.memo)) continue;
    const created = await api(
      "/finance/transactions",
      opt({
        kind: t.kind,
        amount_minor: t.amount,
        occurred_on: t.occurred_on,
        account_id: accByName.get(t.account) ?? null,
        memo: t.memo,
      }),
    );
    const txId = created.id ?? created.transaction?.id;
    if (t.confirm && txId) {
      await api(`/finance/transactions/${txId}/confirm`, opt({}));
    }
    newT += 1;
  }

  // 예산
  const existingB = (await api("/finance/budgets", { token, orgId })).items ?? [];
  const bNames = new Set(existingB.map((b) => b.name));
  let newB = 0;
  for (const b of BUDGETS) {
    if (bNames.has(b.name)) continue;
    await api(
      "/finance/budgets",
      opt({ name: b.name, amount_minor: b.amount, account_id: accByName.get(b.account) ?? null }),
    );
    newB += 1;
  }

  // 지출 거래를 같은 이름(계정=예산) 예산에 연결 → 집행률 반영
  const accById = new Map(accounts.map((a) => [a.id, a.name]));
  const budgets = (await api("/finance/budgets", { token, orgId })).items ?? [];
  const budgetByName = new Map(budgets.map((b) => [b.name, b]));
  const txs = (await api("/finance/transactions", { token, orgId })).items ?? [];
  let linked = 0;
  for (const t of txs) {
    if (t.kind !== "expense" || t.budget_id) continue;
    const budget = budgetByName.get(accById.get(t.account_id));
    if (!budget) continue;
    try {
      await api(
        `/finance/transactions/${t.id}`,
        opt({ budget_id: budget.id, version: t.version }, "PATCH"),
      );
      linked += 1;
    } catch {
      /* 확정 거래는 수정 불가일 수 있음 — 무시 */
    }
  }

  console.log(
    `demo finance ensured: accounts +${newA}, transactions +${newT}, budgets +${newB}, linked ${linked}`,
  );
}

const PROJECTS = [
  { name: "2026 정기총회", description: "상반기 결산 보고와 임원 선출을 위한 정기총회 준비", start_date: "2026-08-20", end_date: "2026-09-30", budget_amount: 1_500_000 },
  { name: "가을 학술제", description: "학과 학술 세미나와 부스 운영 행사", start_date: "2026-09-01", end_date: "2026-10-15", budget_amount: 3_200_000 },
  { name: "회계 운영", description: "분기 회계 마감과 예산 집행 관리", start_date: "2026-07-01", end_date: "2026-12-31", budget_amount: 800_000 },
  { name: "조직 운영", description: "부원 관리와 정기 회의 운영", start_date: "2026-09-01", end_date: "2026-11-30", budget_amount: 500_000 },
];

const TASKS = [
  { title: "정기총회 준비 자료 취합", project: "2026 정기총회", assignee: "이서연", priority: "high", due_at: "2026-09-10" },
  { title: "학술 세미나 연사 섭외", project: "가을 학술제", assignee: "박준호", priority: "high", due_at: "2026-09-18" },
  { title: "홍보 포스터 시안 검토", project: "가을 학술제", assignee: "김민지", priority: "normal", due_at: "2026-09-16" },
  { title: "예산 집행 내역 정리", project: "회계 운영", assignee: "정하늘", priority: "normal", due_at: "2026-09-20" },
  { title: "신입 부원 오리엔테이션 자료", project: "조직 운영", assignee: "최우진", priority: "low", due_at: "2026-09-25" },
  { title: "동아리방 비품 재고 점검", project: "조직 운영", assignee: "정하늘", priority: "normal", due_at: "2026-09-14" },
  { title: "학술제 부스 배치도 확정", project: "가을 학술제", assignee: "박준호", priority: "high", due_at: "2026-09-15" },
];

async function seedWork(token, orgId) {
  const members = (await api("/members", { token, orgId })).items ?? [];
  const uid = (name) => members.find((m) => m.name === name)?.user_id ?? null;

  const existing = (await api("/projects", { token, orgId })).items ?? [];
  const byName = new Map(existing.map((p) => [p.name, p.id]));
  let newP = 0;
  for (const p of PROJECTS) {
    if (byName.has(p.name)) continue;
    const created = await api("/projects", { method: "POST", token, orgId, body: p });
    byName.set(p.name, created.id);
    newP += 1;
  }

  const existingTasks = (await api("/tasks", { token, orgId })).items ?? [];
  const taskTitles = new Set(existingTasks.map((t) => t.title));
  let newT = 0;
  for (const t of TASKS) {
    if (taskTitles.has(t.title)) continue;
    await api("/tasks", {
      method: "POST",
      token,
      orgId,
      body: {
        title: t.title,
        project_id: byName.get(t.project) ?? null,
        assignee_id: uid(t.assignee),
        priority: t.priority,
        due_at: t.due_at,
      },
    });
    newT += 1;
  }
  console.log(`demo work ensured: projects +${newP}, tasks +${newT}`);
}

async function resolveTenant(orgId) {
  const row = db().prepare("SELECT tenant_id FROM organization WHERE id = ?").get(orgId);
  return row?.tenant_id;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
