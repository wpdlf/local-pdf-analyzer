/**
 * Main/Preload/Renderer 공유 상수.
 *
 * 주의: 이 파일은 Node.js / Browser 양쪽에서 import 되므로 어떤 런타임 API도
 * 참조하지 않아야 함 (fs/electron/window 금지). 순수 값과 타입만 포함.
 *
 * 존재 이유: 동일 값이 여러 파일에 하드코딩되어 한쪽만 수정 시 검증 로직이
 * 불일치하여 우회가 발생하는 drift 버그를 방지. 단일 source of truth.
 */

/** PDF 업로드 최대 크기 (bytes). Main 의 drop/open 검증, Renderer 의 업로더 가드에 공유. */
export const MAX_PDF_SIZE_BYTES = 100 * 1024 * 1024; // 100MB
