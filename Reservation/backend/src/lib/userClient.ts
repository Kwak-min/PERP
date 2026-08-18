import axios from 'axios';

const USER_SERVICE_URL = process.env.USER_SERVICE_URL || 'http://localhost:3001';

export interface UserInfo {
  email: string;
  name: string;
}

/**
 * userId로 User 서비스에서 사용자 정보를 조회합니다.
 * 실패 시 null 반환 (이메일 발송 스킵 처리용)
 */
export async function getUserById(userId: number): Promise<UserInfo | null> {
  try {
    const res = await axios.get<UserInfo>(`${USER_SERVICE_URL}/api/v1/users/${userId}`, {
      timeout: 3000,
    });
    return res.data;
  } catch (err) {
    console.warn(`[userClient] userId=${userId} 조회 실패, 이메일 발송 스킵:`, (err as Error).message);
    return null;
  }
}
