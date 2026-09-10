// randomUUID와 달리 getRandomValues는 비보안 HTTP 환경에서도 사용할 수 있다.
export function createRequestKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (byte, index) => {
    if (index === 6) byte = (byte & 0x0f) | 0x40;
    if (index === 8) byte = (byte & 0x3f) | 0x80;
    return byte.toString(16).padStart(2, '0');
  }).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
