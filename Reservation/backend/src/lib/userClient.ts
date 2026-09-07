// 예약 서비스는 ERP의 불투명 사용자 식별자를 별도 사용자 API의 숫자 ID로 변환하지 않는다.
// 예약자 연락처가 principal 계약에 추가되기 전까지 예약자 대상 알림은 명시적으로 비활성화한다.
export interface UserInfo {
  readonly email: string;
  readonly name: string;
}

export async function getUserById(_legacyUserId: number): Promise<UserInfo | null> {
  return null;
}
