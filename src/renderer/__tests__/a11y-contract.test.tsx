// @vitest-environment happy-dom

/**
 * 접근성 계약의 회귀 넷.
 *
 * ## 왜 이 파일이 필요한가 (a11y 재감사 2026-09-03)
 *
 * v0.31.4~v0.31.6 의 a11y 감사는 H1/M1~M5/L1~L6 을 전부 처리하고 **잔여 0** 으로 닫았다.
 * 그런데 40릴리즈 뒤에 뮤테이션으로 재보니 **고친 것들이 무보호**였다:
 *
 *   H1 에러 배너 `role="alert"`  → 지워도 전량 통과  ← 감사의 **최고 심각도** 항목
 *   M1 notice 배너 `role="status"` → 지워도 전량 통과
 *   L6 PdfViewer `role="region"`   → 지워도 통과
 *   M4 TabBar `aria-current`       → 유일하게 검출됨
 *
 * 고친 것은 맞고 주석도 정확한데 **지키는 장치만 없었다** — 이 저장소가 오늘 하루에만 여러 번
 * 밟은 클래스다(가드가 초록인데 아무것도 안 잡는 것).
 *
 * ## 짜는 방식 — 열거 금지
 *
 * "라이브 리전이어야 하는 배너 목록" 을 손으로 적으면 다섯 번째 배너가 생길 때 빠진다(이 저장소의
 * 최다 결함 클래스 = 형제 누락). 그래서 **소스에서 도출**하는 규칙으로 둔다:
 * 새 배너·새 이모지 문자열이 생겨도 자동으로 이 규칙 아래로 들어온다.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripJsComments } from '../../shared/__tests__/helpers/source-scan';

const ROOT = join(import.meta.dirname, '../../..');
const RENDERER = join(ROOT, 'src/renderer');

/** 렌더러의 소스 파일(테스트 제외)을 모은다. 주석은 걷는다 — 주석의 예시가 규칙을 통과시키면 안 된다. */
function rendererSources(): { path: string; src: string }[] {
  const out: { path: string; src: string }[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__') walk(p);
      } else if (/\.tsx?$/.test(e.name)) {
        out.push({ path: relative(ROOT, p).split('\\').join('/'), src: stripJsComments(readFileSync(p, 'utf8')) });
      }
    }
  })(RENDERER);
  return out;
}

const SOURCES = rendererSources();
const APP = SOURCES.find((f) => f.path.endsWith('src/renderer/App.tsx'))!;

describe('a11y H1 — 실패는 즉시 통지된다 (role="alert")', () => {
  it('App 의 에러 배너가 assertive 라이브 리전이다', () => {
    // 모든 작업 실패의 단일 채널이므로 polite 로는 부족하다(사용자가 다음 조작을 하기 전에
    // 알아야 한다). 감사 H1 의 대상이자, 재감사에서 무보호로 드러난 자리다.
    expect(APP, 'App.tsx 를 찾지 못했다 — 이 가드가 무력화된 상태다').toBeDefined();
    const errorBanner = /\{error && \([\s\S]{0,200}?<div[^>]*>/.exec(APP.src)?.[0] ?? '';
    expect(errorBanner, '에러 배너 블록을 추출하지 못했다').not.toBe('');
    expect(errorBanner, 'H1: 에러 배너가 role="alert" 를 잃었다 — 실패가 조용해진다')
      .toContain('role="alert"');
  });
});

describe('a11y M1 — 동적 통지는 라이브 리전이다 (role="status")', () => {
  /**
   * 배너를 열거하지 않는다. 대신 **닫기 버튼이 달린 상단 배너**(= 사용자에게 무언가를 알리는
   * 블록)라는 형태로 도출한다. `mb-4 p-3 bg-...-50` 은 이 앱의 배너 관용구다.
   */
  it('상단 배너는 전부 alert 또는 status 다', () => {
    const banners = [...APP.src.matchAll(/<div[^>]*className="mb-4 p-3 bg-[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(banners.length, '배너를 한 건도 찾지 못했다 — 이 가드가 무력화된 상태다')
      .toBeGreaterThanOrEqual(2);
    const silent = banners.filter((b) => !/role="(alert|status)"/.test(b));
    expect(silent, `라이브 리전이 아닌 배너:\n  ${silent.join('\n  ')}`).toEqual([]);
  });
});

describe('a11y — 동적 상태 표시는 통지된다', () => {
  it('StatusBar 의 프로바이더 상태가 라이브 리전이다', () => {
    // 설정에서 Ollama 를 재시작하거나 프로바이더를 바꾸면 값이 바뀌는데, 재감사 시점에는
    // ARIA 가 하나도 없어 그 변화가 아무에게도 통지되지 않았다.
    const sb = SOURCES.find((f) => f.path.endsWith('components/StatusBar.tsx'))!;
    expect(sb, 'StatusBar.tsx 를 찾지 못했다').toBeDefined();
    expect(sb.src, 'StatusBar 가 라이브 리전을 잃었다 — 상태 변화가 조용해진다')
      .toMatch(/role="status"/);
  });
});

describe('a11y — 접근성 이름에 장식 기호가 섞이지 않는다', () => {
  /**
   * 이모지를 품은 i18n 값이 `aria-label` 로 쓰이면 리더가 "클립 이모지 요약 결과" 처럼 읽는다.
   * 재감사에서 `viewer.result`(📎 요약 결과) 1건이 실제로 그렇게 쓰이고 있었다.
   *
   * 키 목록을 적지 않고 **i18n 에서 도출**한다 — 새 이모지 문자열이 생겨도 자동 편입된다.
   */
  const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;

  const emojiKeys = (() => {
    // 주석을 걷고 읽는다 — 주석에 적힌 예시 문구가 도출 집합에 섞이면 규칙이 흐려진다
    // (source-scan 의 메타 가드가 강제하는 규칙이기도 하다).
    const i18n = stripJsComments(readFileSync(join(ROOT, 'src/renderer/lib/i18n.ts'), 'utf8'));
    const keys = new Set<string>();
    for (const m of i18n.matchAll(/'([\w.]+)':\s*\{\s*ko:\s*'([^']*)'/g)) {
      if (EMOJI.test(m[2]!)) keys.add(m[1]!);
    }
    return keys;
  })();

  it('이모지를 품은 문구를 도출한다 (도출이 비면 아래 규칙이 공허해진다)', () => {
    expect(emojiKeys.size, '이모지 문구를 한 건도 찾지 못했다 — 이 가드가 무력화된 상태다')
      .toBeGreaterThanOrEqual(10);
  });

  it('그 문구들이 aria-label 로 쓰이지 않는다', () => {
    const offenders: string[] = [];
    for (const { path, src } of SOURCES) {
      src.split('\n').forEach((line, i) => {
        const m = /aria-label=\{tr?\('([\w.]+)'\)\}/.exec(line);
        if (m && emojiKeys.has(m[1]!)) offenders.push(`${path}:${i + 1} → ${m[1]}`);
      });
    }
    expect(offenders, `접근성 이름에 장식 기호가 들어간다:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});

describe('a11y — 장식 아이콘은 차폐된다', () => {
  /**
   * 같은 정보가 옆 텍스트에 있는 아이콘은 리더가 읽을 이유가 없다. QA31 이 복사 토스트
   * (`✓ 복사됨`)에서 고친 패턴인데, 재감사에서 StatusBar·QaChat·App·PdfViewer 에 형제가
   * 남아 있었다.
   *
   * JSX **본문**에 직접 놓인 이모지만 본다 — i18n 문자열 안의 이모지는 버튼 내용이고,
   * 그쪽은 aria-label 이 접근성 이름을 대체하므로 무해하다(위 규칙이 그것을 따로 지킨다).
   */
  const DECOR = /[\u{2705}\u{274C}\u{26A0}\u{FE0F}\u{2713}\u{2714}]/u;

  /**
   * ⚠️ 아래 규칙의 사각: 이모지가 **문자열 인자**로 헬퍼에 넘어가면(`icon('✅')`) 문자열을
   * 걷어내는 과정에서 보이지 않는다 — 실제로 StatusBar 수정이 그 형태라 뮤테이션을 통과시켰다.
   * 그 자리는 기제를 직접 못박는다.
   */
  it('StatusBar 의 상태 아이콘 헬퍼가 aria-hidden 을 붙인다', () => {
    const sb = SOURCES.find((f) => f.path.endsWith('components/StatusBar.tsx'))!;
    const helper = /const icon = [^;]+;/.exec(sb.src)?.[0] ?? '';
    expect(helper, 'StatusBar 의 아이콘 헬퍼를 찾지 못했다 — 이 가드가 무력화된 상태다').not.toBe('');
    expect(helper, '상태 아이콘이 차폐를 잃었다 — 리더가 "체크 표시" 를 먼저 읽는다')
      .toContain('aria-hidden');
  });

  it('JSX 본문의 상태 아이콘에는 aria-hidden 이 붙어 있다', () => {
    const offenders: string[] = [];
    for (const { path, src } of SOURCES) {
      src.split('\n').forEach((line, i) => {
        // 문자열 리터럴(i18n 정의·주석 제거 후 남은 코드) 안의 이모지는 대상이 아니다.
        const withoutStrings = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
        if (!DECOR.test(withoutStrings)) return;
        if (/aria-hidden/.test(line)) return;
        offenders.push(`${path}:${i + 1} → ${line.trim().slice(0, 80)}`);
      });
    }
    expect(offenders, `차폐되지 않은 장식 아이콘:\n  ${offenders.join('\n  ')}`).toEqual([]);
  });
});
