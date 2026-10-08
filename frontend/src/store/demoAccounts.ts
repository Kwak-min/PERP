// 목업 로그인의 시연 계정 — 백엔드에 실제로 시드된 계정으로 로그인한다.
// (backend/scripts/bootstrap-demo.mjs 로 생성: 남부대 학생회 조직 + 구성원)
export type DemoAccount = {
  name: string;
  email: string;
  password: string;
  title: string;
  roleName: string;
  orgName: string;
  note?: string;
};

export const DEMO_ACCOUNTS: DemoAccount[] = [
  { name: "김경준", email: "a@naver.com", password: "aaaaaaaa", title: "회장", roleName: "소유자", orgName: "남부대 학생회", note: "모든 권한" },
  { name: "이서연", email: "seoyeon@demo.perp", password: "demo1234", title: "부회장", roleName: "대표/회장", orgName: "남부대 학생회" },
  { name: "박준호", email: "junho@demo.perp", password: "demo1234", title: "학술부장", roleName: "부서장", orgName: "남부대 학생회" },
  { name: "정하늘", email: "haneul@demo.perp", password: "demo1234", title: "총무", roleName: "총무/회계", orgName: "남부대 학생회" },
  { name: "김민지", email: "minji@demo.perp", password: "demo1234", title: "홍보부원", roleName: "일반 구성원", orgName: "남부대 학생회" },
  { name: "최우진", email: "woojin@demo.perp", password: "demo1234", title: "일반부원", roleName: "일반 구성원", orgName: "남부대 학생회" },
  { name: "한지우", email: "jiwoo@demo.perp", password: "demo1234", title: "감사", roleName: "감사/열람자", orgName: "남부대 학생회" },
  { name: "이도현", email: "dohyun@demo.perp", password: "demo1234", title: "외부 협력자", roleName: "게스트", orgName: "남부대 학생회" },
];
