import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 8000),
  databaseFile: process.env.ORBITFLOW_DATABASE_FILE ?? "./orbitflow.db",
  sessionTtlSeconds: Number(process.env.ORBITFLOW_SESSION_TTL ?? 86400),
  maxLoginFailures: Number(process.env.ORBITFLOW_MAX_LOGIN_FAILURES ?? 5),
  loginLockSeconds: Number(process.env.ORBITFLOW_LOGIN_LOCK_SECONDS ?? 900),
  corsOrigins: (process.env.ORBITFLOW_CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3000").split(","),
  aiProvider: process.env.ORBITFLOW_AI_PROVIDER ?? "echo",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openrouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434",
  localModel: process.env.ORBITFLOW_LOCAL_MODEL ?? "llama3.1:8b",
  externalModel: process.env.ORBITFLOW_EXTERNAL_MODEL ?? "openai/gpt-4o-mini",
  webhookSecret: process.env.ORBITFLOW_WEBHOOK_SECRET ?? "dev-webhook-secret",
  // perp_db (PostgreSQL) - strangler-fig 데이터 접근 계층
  pg: {
    connectionString: process.env.DATABASE_URL ?? "",
    host: process.env.PG_HOST ?? "127.0.0.1",
    port: Number(process.env.PG_PORT ?? 55432),
    database: process.env.PG_DATABASE ?? "perp_db",
    user: process.env.PG_USER ?? "perpadmin",
    password: process.env.PG_PASSWORD ?? "",
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 5000),
  },
};
