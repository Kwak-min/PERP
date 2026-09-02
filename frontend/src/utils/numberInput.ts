/**
 * 숫자 입력란은 <input type="number"> 대신 text+inputMode="numeric"으로 두고 이 유틸로 직접
 * 문자열을 다룬다. 그래야 기본값 "0"을 백스페이스로 지워 빈칸으로 만들 수 있고(브라우저가
 * 자동으로 "0"을 되살리지 않음), 동시에 "0"을 안 지우고 그냥 이어 칠 때는 "014" 같은 선행
 * 0도 남지 않는다.
 */

/** 입력값에서 숫자만 남기고, 값이 있을 때는 선행 0을 정리한다. 완전히 지운 상태("")는 그대로 유지한다. */
export function digitsOnly(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits === "") return "";
  const stripped = digits.replace(/^0+/, "");
  return stripped === "" ? "0" : stripped;
}

/** 저장 시점에 문자열을 실제 숫자로 변환한다. 빈 문자열은 0으로 취급한다. */
export function toNonNegativeInt(value: string, max?: number): number {
  const parsed = value === "" ? 0 : Number(value);
  return max !== undefined ? Math.min(parsed, max) : parsed;
}
