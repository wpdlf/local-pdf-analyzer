import { describe, it, expect, vi } from 'vitest';

// R38 P5 (test coverage): ai-service.ts 순수 헬퍼 — 프롬프트 빌드/분리, MIME 감지, Vision/OCR
// sanitize, 임베딩 모델 탐색. electron 의존(BrowserWindow) 때문에 import 시 모킹만 필요하고
// 이 함수들은 http 를 타지 않는 순수 로직이라 모킹 없이 직접 검증한다.

vi.mock('electron', () => ({
  BrowserWindow: class { static getAllWindows(): unknown[] { return []; } },
}));

import {
  buildPrompt,
  splitPrompt,
  detectMimeType,
  sanitizeVisionResponse,
  sanitizeOcrResponse,
  checkEmbeddingAvailability,
  geminiModelUrl,
  GEMINI_EMBED_MODEL,
} from '../ai-service';

describe('splitPrompt', () => {
  it('구분자(---\\n\\n) 기준으로 system/user 분리', () => {
    expect(splitPrompt('SYS\n\n---\n\nUSER')).toEqual({ system: 'SYS', user: 'USER' });
  });

  it('구분자 없으면 전체가 user, system 빈 문자열', () => {
    expect(splitPrompt('just text')).toEqual({ system: '', user: 'just text' });
  });

  it('본문에 구분자가 또 있어도 첫 번째만 사용 (indexOf)', () => {
    const r = splitPrompt('S\n\n---\n\nbody\n\n---\n\nmore');
    expect(r.system).toBe('S');
    expect(r.user).toBe('body\n\n---\n\nmore');
  });
});

describe('detectMimeType', () => {
  it.each([
    ['/9j/4AAQ', 'image/jpeg'],
    ['iVBORw0KGgo', 'image/png'],
    ['R0lGODlh', 'image/gif'],
    ['UklGRiQ', 'image/webp'],
    ['unknownprefix', 'image/jpeg'], // fallback
  ])('%s → %s', (b64, mime) => {
    expect(detectMimeType(b64)).toBe(mime);
  });
});

describe('sanitizeVisionResponse (인젝션 방어)', () => {
  it('URL 제거', () => {
    expect(sanitizeVisionResponse('보세요 https://evil.com/x 끝')).toBe('보세요 [URL 제거됨] 끝');
  });

  it('코드블록 제거', () => {
    expect(sanitizeVisionResponse('전\n```js\nalert(1)\n```\n후')).toContain('[코드블록 제거됨]');
  });

  it('500자로 절단', () => {
    expect(sanitizeVisionResponse('가'.repeat(600)).length).toBe(500);
  });
});

describe('sanitizeOcrResponse', () => {
  it('URL 제거 (빈 문자열로)', () => {
    expect(sanitizeOcrResponse('text https://x.com more')).toBe('text  more');
  });

  it('4000자로 절단 (Vision 보다 완화)', () => {
    expect(sanitizeOcrResponse('a'.repeat(5000)).length).toBe(4000);
  });
});

describe('checkEmbeddingAvailability (순수 모델 탐색)', () => {
  it('우선순위순 첫 매칭 모델 반환 (prefix 매칭)', async () => {
    const r = await checkEmbeddingAvailability('http://localhost:11434', ['llama3', 'nomic-embed-text:latest']);
    expect(r).toBe('nomic-embed-text:latest');
  });

  it('우선순위: nomic 이 mxbai 보다 먼저', async () => {
    const r = await checkEmbeddingAvailability('x', ['mxbai-embed-large', 'nomic-embed-text']);
    expect(r).toBe('nomic-embed-text');
  });

  it('임베딩 모델 없으면 null', async () => {
    expect(await checkEmbeddingAvailability('x', ['llama3', 'gemma3'])).toBeNull();
  });
});

describe('geminiModelUrl (path 주입 차단)', () => {
  it('정상 모델명 → v1beta models 경로 + 메서드', () => {
    expect(geminiModelUrl('gemini-3.5-flash', 'generateContent', false))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
  });

  it('SSE 모드는 ?alt=sse 쿼리 부착', () => {
    expect(geminiModelUrl('gemini-3.5-flash', 'streamGenerateContent', true))
      .toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse');
  });

  it("모델명의 '/' 는 인코딩 — path segment 주입 차단 (MODEL_NAME_RE 가 '/' 허용하므로 필수)", () => {
    const url = geminiModelUrl('evil/../../v1/other', 'generateContent', false);
    expect(url).not.toContain('/evil/');
    expect(url).toContain('evil%2F..%2F..%2Fv1%2Fother');
  });

  it('GEMINI_EMBED_MODEL 상수는 batchEmbedContents 경로와 결합 가능', () => {
    expect(geminiModelUrl(GEMINI_EMBED_MODEL, 'batchEmbedContents', false))
      .toContain(`/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`);
  });
});

describe('buildPrompt', () => {
  it('full 타입 한국어 — 템플릿 + 인용 규칙 주입 + 본문 포함', () => {
    const p = buildPrompt('본문내용', 'full', 'ko');
    expect(p).toContain('PDF 문서 분석');
    expect(p).toContain('인용 규칙'); // CITATION_RULES.ko 주입
    expect(p).toContain('본문내용');
    // 인용 규칙은 system 섹션(구분자 앞)에 위치
    expect(p.indexOf('인용 규칙')).toBeLessThan(p.indexOf('---\n\n'));
  });

  it('keywords 타입 — 인용 규칙 미주입 (테이블 포맷)', () => {
    const p = buildPrompt('본문', 'keywords', 'ko');
    expect(p).not.toContain('인용 규칙');
    expect(p).toContain('키워드');
  });

  it.each([
    ['en', 'expert PDF document analyst'],
    ['ja', 'PDF文書'],
    ['zh', 'PDF文档'],
    ['auto', 'same language as the source'],
  ])('언어 %s 템플릿 선택', (lang, marker) => {
    expect(buildPrompt('x', 'full', lang)).toContain(marker);
  });

  it('알 수 없는 언어 → ko fallback', () => {
    expect(buildPrompt('x', 'full', 'fr')).toContain('한국어');
  });

  it('language 미지정 → ko 기본', () => {
    expect(buildPrompt('x', 'qa')).toContain('한국어');
  });

  it('qa/chapter 타입도 인용 규칙 주입', () => {
    expect(buildPrompt('x', 'qa', 'en')).toContain('Citation rule');
    expect(buildPrompt('x', 'chapter', 'en')).toContain('Citation rule');
  });

  // 커스텀 요약 템플릿(QA10 후속 기능): 사용자 프롬프트를 system, 문서 텍스트를 user 섹션으로 구성하고
  // 인용 규칙을 주입해 페이지 인용이 동작하며 splitPrompt 규약과 호환되는지.
  it('custom 타입 — 사용자 프롬프트 + 인용 규칙 + 본문(system/user 분리)', () => {
    const p = buildPrompt('문서본문', 'custom', 'ko', '액션 아이템을 뽑아줘');
    expect(p).toContain('액션 아이템을 뽑아줘'); // 사용자 프롬프트(system)
    expect(p).toContain('인용 규칙');            // CITATION_RULES.ko 주입
    const { system, user } = splitPrompt(p);
    expect(system).toContain('액션 아이템을 뽑아줘');
    expect(user).toBe('문서본문');
  });

  it('custom 타입 — customPrompt 가 없거나 공백이면 throw', () => {
    expect(() => buildPrompt('본문', 'custom', 'ko', '')).toThrow();
    expect(() => buildPrompt('본문', 'custom', 'ko', '   ')).toThrow();
    expect(() => buildPrompt('본문', 'custom', 'ko')).toThrow();
  });
});
