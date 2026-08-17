import { db } from "./db.js";
import { migrate } from "./migrate.js";
import { newId, nowIso } from "../models/base.js";
import { hashPassword } from "../utils/crypto.js";

const DUMMY_USER = {
  email: "a@naver.com",
  name: "더미 사용자",
  password: "aaaaaaaa",
};

export function seed() {
  migrate();

  const existing = db().prepare("SELECT id FROM app_user WHERE email = ?").get(DUMMY_USER.email);
  if (existing) return { dummyUserCreated: false };

  db()
    .prepare(
      `INSERT INTO app_user (id, email, name, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      DUMMY_USER.email,
      DUMMY_USER.name,
      hashPassword(DUMMY_USER.password),
      nowIso(),
    );

  return { dummyUserCreated: true };
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, "/")}`).href) {
  const result = seed();
  console.log(result.dummyUserCreated ? "seeded dummy user: a@naver.com" : "dummy user already exists: a@naver.com");
}
