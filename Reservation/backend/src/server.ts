import 'dotenv/config';
import app from './app';
import { prisma } from './lib/prisma';
import { startReminderScheduler } from './notification/reminder.scheduler';

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

async function main() {
  // DB 연결 확인
  await prisma.$connect();
  console.log('✅ Database connected');

  // 리마인더 스케줄러 시작
  startReminderScheduler();
  console.log('✅ Reminder scheduler started');

  app.listen(PORT, HOST, () => {
    const baseUrl = `http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT}`;
    console.log(`🚀 Server running on ${baseUrl}`);
    console.log(`📄 Swagger UI: ${baseUrl}/api-docs`);
  });
}

main().catch(async (err) => {
  console.error('❌ Server startup failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  console.log('Server shut down gracefully');
  process.exit(0);
});
