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
};
