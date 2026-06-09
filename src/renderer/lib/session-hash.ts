/**
 * 세션 식별용 콘텐츠 해시.
 *
 * Design Ref: §2.2 / Plan 결정: 문서 식별 = 콘텐츠 해시 기준.
 * 파싱된 extractedText 의 SHA-256 hex 를 docHash 로 사용한다 — 파일 이동/이름변경에도
 * 같은 내용이면 동일 해시로 캐시를 재사용하고, 내용이 바뀌면 자동으로 다른 해시가 되어
 * stale 세션 복원을 차단한다(캐시 무효화의 1차 키).
 *
 * crypto.subtle 은 secure context(Electron 렌더러는 충족)에서 사용 가능.
 */
export async function hashDocumentText(extractedText: string): Promise<string> {
  const bytes = new TextEncoder().encode(extractedText);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return bufferToHex(digest);
}

/** ArrayBuffer → lowercase hex 문자열 */
export function bufferToHex(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    // noUncheckedIndexedAccess: 루프 인덱스가 length 내부임이 보장됨
    hex += view[i]!.toString(16).padStart(2, '0');
  }
  return hex;
}
