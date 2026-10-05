// 목업 로그인의 시연 계정 — 백엔드 없이 세션을 주입해 역할별 화면을 확인한다.
import type { SessionState } from "./session";

export type DemoAccount = {
  id: number;
  name: string;
  email: string;
  title: string;
  roleName: string;
  orgName: string;
  orgType: string;
  note?: string;
};

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { id: 1, name: "김경준", email: "rudwns1536@gmail.com", title: "회장", roleName: "대표/회장", orgName: "남부대 학생회", orgType: "student", note: "오르빗랩 겸직" },
  { id: 2, name: "이서연", email: "seoyeon@example.com", title: "부회장", roleName: "부서장/팀장", orgName: "남부대 학생회", orgType: "student" },
  { id: 3, name: "박준호", email: "junho@example.com", title: "학술부장", roleName: "부서장/팀장", orgName: "남부대 학생회", orgType: "student" },
  { id: 4, name: "정하늘", email: "haneul@example.com", title: "총무", roleName: "총무/회계", orgName: "남부대 학생회", orgType: "student" },
  { id: 5, name: "김민지", email: "minji@example.com", title: "홍보부원", roleName: "일반 구성원", orgName: "남부대 학생회", orgType: "student" },
  { id: 8, name: "최우진", email: "woojin@example.com", title: "일반부원", roleName: "일반 구성원", orgName: "남부대 학생회", orgType: "student" },
  { id: 12, name: "한지우", email: "jiwoo@example.com", title: "감사", roleName: "감사자/열람자", orgName: "남부대 학생회", orgType: "student" },
  { id: 6, name: "이도현", email: "dohyun@example.com", title: "외부 협력자", roleName: "외부 협력자", orgName: "가을 학술제", orgType: "club" },
];

export function sessionForDemo(a: DemoAccount): SessionState {
  return {
    token: `demo-${a.id}`,
    orgId: `org-${a.id}`,
    name: a.name,
    email: a.email,
    mustChangePassword: false,
    organizations: [
      { org_id: `org-${a.id}`, org_name: a.orgName, org_type: a.orgType, roles: [a.roleName] },
    ],
  };
}
