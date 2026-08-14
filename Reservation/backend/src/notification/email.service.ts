import nodemailer from 'nodemailer';
import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';

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
  // TODO: 타팀 User 테이블 연동 후 예약자 이메일 직접 조회
  sendReservationConfirmed: async (reservation: {
    id: number; title: string; startTime: Date; endTime: Date;
    space: { name: string };
  }) => {
    console.log(`[EMAIL] 예약 확정 - reservationId=${reservation.id}, title=${reservation.title}`);
    // 연동 완료 후 아래 주석 해제:
    // const html = loadTemplate('reservation-confirmed')({ ...reservation });
    // await sendMail(userEmail, `[예약 확정] ${reservation.title}`, html);
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
  // TODO: 타팀 User 테이블 연동 후 예약자 이메일 조회
  sendAttendeeResponse: async (attendee: {
    name: string; status: string;
    reservation: { id: number; title: string };
  }) => {
    console.log(
      `[EMAIL] 참석자 응답 - name=${attendee.name}, status=${attendee.status}, reservationId=${attendee.reservation.id}`,
    );
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
};
