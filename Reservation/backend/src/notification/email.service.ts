import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';
import { getUserById } from '../lib/userClient';

const transporter = nodemailer.createTransport({
  host: process.env.MAIL_HOST || 'smtp.gmail.com',
  port: Number(process.env.MAIL_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const FROM = process.env.MAIL_FROM || 'no-reply@room.erp';
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

// 템플릿 로더 (컴파일 결과 캐싱)
const templateCache: Record<string, HandlebarsTemplateDelegate> = {};

function loadTemplate(name: string): HandlebarsTemplateDelegate {
  if (templateCache[name]) return templateCache[name];
  const filePath = path.join(__dirname, 'templates', `${name}.hbs`);
  const source = fs.readFileSync(filePath, 'utf-8');
  templateCache[name] = Handlebars.compile(source);
  return templateCache[name];
}

async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({ from: FROM, to, subject, html });
  console.log(`[EMAIL] 발송 완료 → ${to} | ${subject}`);
}

// ── 공개 API ──────────────────────────────────────────────────────────────────

export const emailService = {
  // 1. 예약 확정 (예약자)
  sendReservationConfirmed: async (reservation: {
    id: number; title: string; startTime: Date; endTime: Date; userId: number;
    space: { name: string };
  }) => {
    const user = await getUserById(reservation.userId);
    if (!user) {
      console.warn(`[EMAIL] 예약 확정 스킵 - userId=${reservation.userId} 조회 실패`);
      return;
    }
    const html = loadTemplate('reservation-confirmed')({
      userName: user.name,
      title: reservation.title,
      spaceName: reservation.space.name,
      startTime: reservation.startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      endTime: reservation.endTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    });
    await sendMail(user.email, `[예약 확정] ${reservation.title}`, html);
  },

  // 2. 참석자 초대
  sendAttendeeInvite: async (attendee: {
    id: number; name: string; email: string;
    inviteToken: string;
    reservation: { title: string; startTime: Date; endTime: Date; space: { name: string } };
  }) => {
    const acceptUrl  = `${BASE_URL}/api/v1/attendees/${attendee.inviteToken}/respond?accept=true`;
    const declineUrl = `${BASE_URL}/api/v1/attendees/${attendee.inviteToken}/respond?accept=false`;

    const html = loadTemplate('attendee-invite')({
      attendeeName: attendee.name,
      title: attendee.reservation.title,
      spaceName: attendee.reservation.space.name,
      startTime: attendee.reservation.startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      endTime: attendee.reservation.endTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      acceptUrl,
      declineUrl,
    });
    await sendMail(attendee.email, `[회의 초대] ${attendee.reservation.title}`, html);
  },

  // 3. 참석자 응답 알림 (예약자에게)
  sendAttendeeResponse: async (attendee: {
    name: string; status: string;
    reservation: { id: number; title: string; userId: number };
  }) => {
    const user = await getUserById(attendee.reservation.userId);
    if (!user) {
      console.warn(`[EMAIL] 참석자 응답 알림 스킵 - userId=${attendee.reservation.userId} 조회 실패`);
      return;
    }
    const isAccepted = attendee.status === 'ACCEPTED';
    const statusText = isAccepted ? '수락' : '거절';
    const html = loadTemplate('attendee-response')({
      hostName: user.name,
      attendeeName: attendee.name,
      title: attendee.reservation.title,
      statusText,
      statusClass: isAccepted ? 'accepted' : 'declined',
      statusEmoji: isAccepted ? '✅' : '❌',
    });
    await sendMail(user.email, `[참석 ${statusText}] ${attendee.name}님이 '${attendee.reservation.title}' 미팅을 ${statusText}했습니다.`, html);
  },

  // 4. 예약 취소 (참석자 전원)
  sendReservationCancelled: async (reservation: {
    title: string; startTime: Date; space: { name: string };
    attendees: { email: string; name: string }[];
  }) => {
    if (reservation.attendees.length === 0) return;

    const html = loadTemplate('reservation-cancelled')({
      title: reservation.title,
      spaceName: reservation.space.name,
      startTime: reservation.startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    });

    await Promise.allSettled(
      reservation.attendees.map((a) =>
        sendMail(a.email, `[예약 취소] ${reservation.title}`, html),
      ),
    );
  },

  // 5. 리마인더 (30분 전)
  sendReminder: async (reservation: {
    title: string; startTime: Date; space: { name: string };
    attendees: { email: string }[];
  }) => {
    if (reservation.attendees.length === 0) return;

    const html = loadTemplate('reminder')({
      title: reservation.title,
      spaceName: reservation.space.name,
      startTime: reservation.startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
    });

    await Promise.allSettled(
      reservation.attendees.map((a) =>
        sendMail(a.email, `[30분 후 회의] ${reservation.title}`, html),
      ),
    );
  },

  // 6. 대기 등록 확인
  sendWaitlistConfirmed: async (entry: {
    userId: number;
    title: string;
    startTime: Date;
    endTime: Date;
    space: { name: string };
  }, position: number) => {
    const user = await getUserById(entry.userId);
    if (!user) return;
    const html = loadTemplate('waitlist-confirmed')({
      userName: user.name,
      title: entry.title,
      spaceName: entry.space.name,
      startTime: entry.startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      endTime: entry.endTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      position,
    });
    await sendMail(user.email, `[대기 등록] ${entry.title} (${position}번 대기)`, html);
  },

  // 7. 대기 승격 알림 (예약으로 자동 전환됨)
  sendWaitlistPromoted: async (
    reservation: { id: number; userId: number; title: string; startTime: Date; endTime: Date; space: { name: string } },
    _origin: { id: number },
  ) => {
    const user = await getUserById(reservation.userId);
    if (!user) return;
    const html = loadTemplate('waitlist-promoted')({
      userName: user.name,
      title: reservation.title,
      spaceName: reservation.space.name,
      startTime: reservation.startTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      endTime: reservation.endTime.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }),
      reservationId: reservation.id,
    });
    await sendMail(user.email, `[예약 확정] 대기하신 회의실이 확보되었습니다 — ${reservation.title}`, html);
  },
};
