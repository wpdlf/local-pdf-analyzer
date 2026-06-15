import { useEffect, useState } from 'react';
import { useAppStore } from '../lib/store';
import { useT } from '../lib/i18n';
import { resolveMembers } from '../lib/collection';
import type { SessionManifestEntry } from '../../shared/session-types';
import type { ResolvedMember } from '../types';

/**
 * 다중 문서 컬렉션 Q&A 바 (multi-doc Phase 2, module-2).
 * 열린 문서가 2개 이상일 때만 노출. 컬렉션 모드 토글 + 멤버 선택 체크박스 + 상태 배지.
 * 멤버 동질성(임베딩 모델/차원)은 resolveMembers 로 판정해 검색 불가 멤버를 사유와 함께 비활성화.
 */
export function CollectionBar() {
  const t = useT();
  const openTabs = useAppStore((s) => s.openTabs);
  const documentPath = useAppStore((s) => s.document?.filePath ?? null);
  const collection = useAppStore((s) => s.collection);
  // ragState 변화(인덱스 빌드/모델 변경) 시 멤버 상태 배지를 재계산하기 위해 구독
  const ragModel = useAppStore((s) => s.ragState.model);
  const ragChunkCount = useAppStore((s) => s.ragState.chunkCount);
  const setCollectionEnabled = useAppStore((s) => s.setCollectionEnabled);
  const setCollectionMembers = useAppStore((s) => s.setCollectionMembers);
  const toggleCollectionMember = useAppStore((s) => s.toggleCollectionMember);

  const [manifest, setManifest] = useState<SessionManifestEntry[]>([]);

  // docHash 가 기록된 탭만 컬렉션 멤버 후보 (전환·세션 복원 흐름이 docHash 를 채움)
  const candidates = openTabs.filter((tb) => tb.docHash);
  const activeTab = openTabs.find((tb) => tb.filePath === documentPath);
  const activeDocHash = activeTab?.docHash;

  // 컬렉션 모드 진입 시 매니페스트 로드(멤버 상태 배지용). 비활성화 시 비움.
  useEffect(() => {
    if (!collection.enabled) return;
    let cancelled = false;
    window.electronAPI.session.list?.()
      .then((entries) => { if (!cancelled) setManifest(entries ?? []); })
      .catch(() => { if (!cancelled) setManifest([]); });
    return () => { cancelled = true; };
  }, [collection.enabled, ragChunkCount]);

  if (candidates.length < 2) return null; // 단일 문서면 컬렉션 UI 불필요

  const handleToggleMode = (enabled: boolean) => {
    setCollectionEnabled(enabled);
    // 켜는 순간 후보 전체를 기본 선택(상태가 ready 가 아닌 멤버는 검색에서 자연 제외)
    if (enabled) {
      setCollectionMembers(candidates.map((c) => c.docHash as string));
    }
  };

  // 멤버 상태 판정 — 활성 문서의 (모델,차원) 기준. 활성 인덱스 차원은 store 에서 직접 읽음.
  const activeDim = useAppStore.getState().ragIndex.dimension;
  const resolved: ResolvedMember[] = (collection.enabled && activeDocHash)
    ? resolveMembers(
        candidates.map((c) => c.docHash as string),
        { docHash: activeDocHash, model: ragModel, dim: activeDim },
        manifest,
        openTabs,
      )
    : [];
  const statusByHash = new Map(resolved.map((r) => [r.docHash, r]));
  const readyCount = resolved.filter((r) => r.status === 'ready').length;

  const statusLabel = (status: ResolvedMember['status']): string => {
    switch (status) {
      case 'model-mismatch': return t('collection.statusModelMismatch');
      case 'no-index': return t('collection.statusNoIndex');
      case 'missing': return t('collection.statusMissing');
      default: return '';
    }
  };

  return (
    <div className="px-4 py-2 border-b dark:border-gray-700 bg-gray-50/60 dark:bg-gray-800/40 text-xs">
      <label className="flex items-center gap-2 cursor-pointer select-none" title={t('collection.toggleHint')}>
        <input
          type="checkbox"
          checked={collection.enabled}
          onChange={(e) => handleToggleMode(e.target.checked)}
          className="accent-blue-500"
        />
        <span className="font-medium text-gray-700 dark:text-gray-200">{t('collection.toggle')}</span>
        {collection.enabled && (
          <span className="text-gray-400">· {t('collection.searchingCount', { count: readyCount })}</span>
        )}
      </label>

      {collection.enabled && (
        <div className="mt-2 space-y-1" role="group" aria-label={t('collection.members')}>
          {candidates.map((tab) => {
            const docHash = tab.docHash as string;
            const status = statusByHash.get(docHash)?.status ?? 'ready';
            const selectable = status === 'ready';
            const isActive = docHash === activeDocHash;
            // 활성 문서는 항상 검색에 포함(해제 불가) — resolveCollectionSearch 의 강제 union 과 일치.
            const forced = isActive && selectable;
            const checked = forced || (collection.memberHashes.includes(docHash) && selectable);
            const disabled = !selectable || forced;
            // a11y: 비활성 사유/활성 표시를 체크박스 접근명에 묶어 스크린리더가 함께 읽도록.
            const ariaLabel = [tab.fileName,
              isActive ? t('collection.activeBadge') : null,
              !selectable ? statusLabel(status) : null].filter(Boolean).join(', ');
            return (
              <label
                key={tab.filePath}
                className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${selectable ? '' : 'opacity-60'}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleCollectionMember(docHash)}
                  aria-label={ariaLabel}
                  className="accent-blue-500"
                />
                <span className="truncate text-gray-700 dark:text-gray-300">📄 {tab.fileName}</span>
                {isActive && (
                  <span className="shrink-0 rounded bg-blue-100 dark:bg-blue-900/50 text-blue-600 dark:text-blue-300 px-1">
                    {t('collection.activeBadge')}
                  </span>
                )}
                {!selectable && (
                  <span className="shrink-0 text-amber-600 dark:text-amber-400">{statusLabel(status)}</span>
                )}
              </label>
            );
          })}
          {readyCount === 0 && (
            <p className="text-amber-600 dark:text-amber-400">{t('collection.noneSearchable')}</p>
          )}
        </div>
      )}
    </div>
  );
}
