import { test, expect } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchElectron, cleanupDir } from './helpers';

/**
 * 수식 렌더링의 플랫폼 전제 — **앱이 싣는 Chromium 이 MathML Core 를 실제로 레이아웃하는가**.
 *
 * 왜 유닛 테스트로 부족한가: math-render.test.tsx 는 happy-dom 이라 DOM 트리만 본다. 레이아웃을
 * 하지 않으므로 "`<math>` 엘리먼트가 만들어졌다" 까지만 증명되고, 브라우저가 그것을 그리는가는
 * 증명되지 않는다. 그런데 `output: 'mathml'`(katex.css 와 woff2 폰트 20여 개 ~350KB 를 번들하지
 * 않고 CSP `font-src` 도 열지 않기로 한 결정) 전체가 이 전제 위에 서 있다. 전제가 무너지면
 * 사용자는 폰트 없는 깨진 텍스트를 본다.
 *
 * 판정 신호는 **computed display** 다. MathML Core 를 구현한 브라우저만 `<math>` 에 `math`,
 * `<mfrac>` 에 `block math` 라는 MathML 전용 레이아웃 박스를 부여한다. 미구현 브라우저는
 * 알 수 없는 엘리먼트로 보고 `inline` 을 준다.
 *
 * ※ 높이 비교로 판정하지 말 것(초안에서 그렇게 했다가 오검출): 인라인 수식의 분수는 scriptlevel
 *   축소가 걸려 분자·분모를 쌓고도 **평범한 한 줄보다 낮다**(실측 19.7px vs 21.3px). "쌓였으니
 *   더 높겠지" 라는 직관이 틀린다.
 */
test('Electron 의 Chromium 이 MathML Core 를 레이아웃한다', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'pdf-analyzer-e2e-math-'));
  const r = await launchElectron(userDataDir);
  try {
    const probe = await r.page.evaluate(() => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:0;top:0;font-size:16px;';
      wrap.innerHTML =
        '<math xmlns="http://www.w3.org/1998/Math/MathML"><mfrac>'
        + '<mn>1</mn><mn>2</mn></mfrac></math>';
      document.body.appendChild(wrap);
      const mathEl = wrap.querySelector('math') as HTMLElement;
      const frac = wrap.querySelector('mfrac') as HTMLElement;
      const rect = mathEl.getBoundingClientRect();
      const out = {
        mathNS: mathEl.namespaceURI,
        mathDisplay: getComputedStyle(mathEl).display,
        fracDisplay: getComputedStyle(frac).display,
        width: rect.width,
        height: rect.height,
      };
      wrap.remove();
      return out;
    });

    // 파서가 MathML 네임스페이스로 승격했는가(HTML 내 foreign content 처리)
    expect(probe.mathNS).toBe('http://www.w3.org/1998/Math/MathML');
    // MathML Core 전용 레이아웃 박스 — 미지원이면 'inline'
    expect(probe.mathDisplay).toBe('math');
    expect(probe.fracDisplay).toContain('math');
    // 실제로 지면을 차지한다(0×0 으로 접히지 않았다)
    expect(probe.width).toBeGreaterThan(0);
    expect(probe.height).toBeGreaterThan(0);
  } finally {
    await r.app.close().catch(() => { /* 이미 종료 */ });
    cleanupDir(userDataDir);
  }
});
