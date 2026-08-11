import { access } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const required = [
  "package.json",
  "README.md",
  "backend/.env.example",
  "backend/package.json",
  "backend/README.md",
  "backend/src/app.js",
  "backend/src/server.js",
  "backend/src/config",
  "backend/src/controllers",
  "backend/src/models",
  "backend/src/routes",
  "backend/src/middleware",
  "backend/src/services",
  "backend/src/utils",
  "backend/src/validations",
  "backend/src/uploads",
  "frontend/.env.example",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "frontend/public/images",
  "frontend/public/icons",
  "frontend/public/favicon.ico",
  "frontend/src/App.tsx",
  "frontend/src/main.tsx",
  "frontend/src/assets",
  "frontend/src/components/common",
  "frontend/src/components/ui",
  "frontend/src/components/layout",
  "frontend/src/pages",
  "frontend/src/hooks",
  "frontend/src/context",
  "frontend/src/services",
  "frontend/src/utils",
  "frontend/src/routes",
  "frontend/src/store",
];

async function exists(relative) {
  try {
    await access(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
}

const missing = [];
for (const relative of required) {
  if (!(await exists(relative))) missing.push(relative);
}
const forbidden = [];
for (const relative of ["apps", "apps/api", "apps/web"]) {
  if (await exists(relative)) forbidden.push(relative);
}

console.log(`REQUIRED ${required.length}`);
console.log(`MISSING ${missing.length}${missing.length ? `: ${missing.join(", ")}` : ""}`);
console.log(`FORBIDDEN ${forbidden.length}${forbidden.length ? `: ${forbidden.join(", ")}` : ""}`);

if (missing.length || forbidden.length) process.exitCode = 1;
