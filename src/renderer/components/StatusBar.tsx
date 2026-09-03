import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { PROVIDER_LABELS } from '../types';

export function StatusBar() {
  const ollamaStatus = useAppStore((s) => s.ollamaStatus);
  const settings = useAppStore((s) => s.settings);
  const t = useT();

  // a11y 재감사(2026-09-03): 아이콘은 **장식**이다 — 같은 정보가 바로 옆 텍스트에 있으므로
  // 리더가 "체크 표시" 를 앞에 읽으면 소음만 된다. QA31 이 복사 토스트(`✓ 복사됨`)에서 고친
  // 것과 같은 패턴인데 이쪽은 형제 누락으로 남아 있었다.
  const providerStatus = () => {
    const icon = (glyph: string) => <span aria-hidden="true">{glyph}</span>;
    if (settings.provider === 'ollama') {
      if (ollamaStatus.running) {
        return <span className="text-green-600 dark:text-green-400">{icon('✅')} {t('status.running')} ({settings.model})</span>;
      } else if (ollamaStatus.installed) {
        return <span className="text-yellow-600 dark:text-yellow-400">{icon('⚠️')} {t('status.stopped')}</span>;
      }
      return <span className="text-red-600 dark:text-red-400">{icon('❌')} {t('status.notInstalled')}</span>;
    }
    return <span className="text-green-600 dark:text-green-400">{icon('✅')} {settings.model}</span>;
  };

  // R43 I-1: 3-provider ternary 가 gemini 를 'OpenAI' 로 표시하던 결함 — 단일 출처 맵 사용
  const providerLabel = PROVIDER_LABELS[settings.provider];

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-gray-100 dark:bg-gray-800 text-sm">
      {/* a11y 재감사(2026-09-03): 이 영역은 **동적 상태**다 — 설정에서 Ollama 를 재시작하거나
          프로바이더를 바꾸면 값이 바뀌는데, 라이브 리전이 아니라 그 변화가 아무에게도 통지되지
          않았다. `polite`: 사용자가 하던 일을 끊을 만한 정보가 아니다(실패는 별도 alert 배너가 있다). */}
      <div className="flex items-center gap-2" role="status">
        <span className="text-gray-700 dark:text-gray-300">{providerLabel}:</span>
        {providerStatus()}
      </div>
      <div className="flex items-center gap-3">
        {settings.provider === 'ollama' && ollamaStatus.version && (
          <span className="text-gray-600 dark:text-gray-400 text-xs">{ollamaStatus.version}</span>
        )}
        <span className="text-gray-600 dark:text-gray-400 text-xs">copyright 2026. JJW.</span>
      </div>
    </div>
  );
}
