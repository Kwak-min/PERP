const BASE = "http://127.0.0.1:8000/api/v1";

async function api(method, path, body, tok) {
  const headers = { "Content-Type": "application/json" };
  if (tok) headers["Authorization"] = "Bearer " + tok;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}

const login = await api("POST", "/auth/login", { email: "a@naver.com", password: "aaaaaaaa" });
const tok = login.json.access_token;

const assets = await api("GET", "/assets", null, tok);
console.log("=== ASSETS (status " + assets.status + ") ===");
console.log(JSON.stringify(assets.json, null, 1).slice(0, 3000));

const resv = await api("GET", "/assets/reservations", null, tok);
console.log("=== RESERVATIONS (status " + resv.status + ") ===");
console.log(JSON.stringify(resv.json, null, 1).slice(0, 3000));
