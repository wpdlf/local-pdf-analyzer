/**
 * Error 메시지에서 로컬 절대경로를 홈 기호(`~`) 또는 `<system>` 로 치환.
 *
 * v0.18.5 M4: 이전에는 `C:\\Users\\<u>` · `/Users/<u>` · `/home/<u>` 3 패턴만 커버했다.
 * 패키지된 Electron 앱은 에러 메시지를 fallback UI 로 사용자에게 직접 노출하므로,
 * 다음 경로들이 그대로 새어 나갈 수 있었다:
 *  - Windows 드라이브 일반: `D:\\Projects\\...`, `E:\\...`
 *  - Windows UNC: `\\\\server\\share\\...`
 *  - Linux 시스템: `/etc/...`, `/var/...`, `/usr/...`, `/opt/...`
 *  - macOS 시스템: `/private/var/...`, `/tmp/...`
 *
 * 정책:
 *  - 사용자 홈 경로 (Users/home/<name>) → `~` 치환.
 *  - 시스템 디렉토리 → `<system>` 치환 (어떤 디렉토리인지는 노출하지 않음).
 *  - 그 외 Windows 드라이브 경로 → `<path>` 치환 (사용자 정보 + 프로젝트 구조 숨김).
 *  - UNC 서버/공유명 → `<share>` 치환.
 *
 * v0.18.20 R32 P2: 이전에는 `app-error-boundary.tsx` 안에 있어서 React Component 와 함께
 * export 되었고, store.ts 의 setError 에서 sanitize 하려면 React 트리 전체를 import 해야
 * 했다. 별도 모듈로 분리하여 store.ts (renderer-only, no React) 가 가볍게 import 가능.
 *
 * 순수 함수로 분리한 이유: 커버리지 갭 회귀 방지용 단위 테스트를 가능하게 하기 위함.
 */
export function sanitizeErrorPath(raw: string): string {
  if (!raw) return raw;
  return raw
    // v0.18.5 Round 23 #3: Windows 사용자 홈 — 사용자명 이후 **하위 경로 전체** 도 소비.
    // 이전에는 `C:\Users\alice` 만 `~` 로 바뀌고 `\secrets\api-key.ts` 가 남아 민감
    // 폴더/파일명이 노출됐다. 전체 경로를 `~` 로 일괄 치환해 프로젝트 구조까지 은닉.
    .replace(/[A-Z]:\\Users\\[^\\\s"'<>|?*]+(?:\\[^\s"'<>|?*]+)*/gi, '~')
    // macOS/Linux 사용자 홈 — 동일 정책
    .replace(/\/Users\/[^/\s"'<>|?*]+(?:\/[^\s"'<>|?*]+)*/g, '~')
    .replace(/\/home\/[^/\s"'<>|?*]+(?:\/[^\s"'<>|?*]+)*/g, '~')
    // v0.18.5 Round 23 #2: UNC 공유 — `\\server\share` 뒤의 하위 경로(프로젝트 폴더 등)
    // 도 모두 `<share>` 로 흡수. 이전에는 `\\srv\share\a\b\c` 에서 `\a\b\c` 가 남았다.
    .replace(/\\\\[^\\\s"'<>|?*]+\\[^\\\s"'<>|?*]+(?:\\[^\s"'<>|?*]+)*/g, '<share>')
    // Linux/macOS 시스템 절대경로 (공백 전 까지)
    .replace(/\/(?:etc|var|usr|opt|tmp|private|boot|sys|proc|dev|run|srv|mnt|media)(?:\/[^\s"'<>|?*]*)?/g, '<system>')
    // 남은 Windows 드라이브 절대경로 (일반화) — 사용자 홈·<share> 치환 이후에만 매치.
    // [^\s"'<>|?*]+ 로 한 토큰 경로만 소비 (에러 메시지 끝까지 과잉 매치 방지).
    // v0.18.7 R26-C9 fix: 라인 28 의 Users 패턴은 `gi` flag 인 반면 일반 드라이브 패턴이
    // `g` 만 가져 `c:\Users\…` 처럼 소문자 드라이브 레터로 시작하는 경로(Node 일부 API 가
    // 정규화한 결과) 가 sanitize 되지 않고 노출되던 비대칭 해소.
    .replace(/[A-Z]:\\[^\s"'<>|?*]+/gi, '<path>');
}
