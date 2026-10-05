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

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
  console.log("비밀번호 — 오너(김경준/a@naver.com): aaaaaaaa · 나머지 데모 계정: demo1234");
}

async function resolveTenant(orgId) {
  const row = db().prepare("SELECT tenant_id FROM organization WHERE id = ?").get(orgId);
  return row?.tenant_id;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
