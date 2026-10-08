import cron from 'node-cron';
import { prisma } from '../lib/prisma';
import { emailService } from './email.service';

export function startReminderScheduler() {
  // 매 분 실행 — 지금으로부터 30~31분 후 시작하는 예약 조회
  cron.schedule('* * * * *', async () => {
    const now = new Date();
    const from = new Date(now.getTime() + 30 * 60 * 1000);
    const to   = new Date(now.getTime() + 31 * 60 * 1000);

    try {
      const reservations = await prisma.reservation.findMany({
        where: {
          tenantId: { not: null },
          orgId: { not: null },
          ownerId: { not: null },
          status: 'CONFIRMED',
          startTime: { gte: from, lt: to },
        },
        include: { space: true, attendees: true },
      });

      for (const reservation of reservations) {
        console.log(`[SCHEDULER] 리마인더 발송 - reservationId=${reservation.id}`);
        emailService.sendReminder(reservation).catch(console.error);
      }
    } catch (err) {
      console.error('[SCHEDULER] 리마인더 스케줄러 오류:', err);
    }
  });

  console.log('✅ Reminder scheduler running (every minute)');
}
