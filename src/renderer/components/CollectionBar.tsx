import { useEffect, useRef, useState } from 'react';
import { useAppStore, isDocSwapPending } from '../lib/store';
import { useT } from '../lib/i18n';
import { resolveMembers } from '../lib/collection';
import { saveCollection } from '../lib/collections-client';
import { generateCollectionSummary } from '../lib/use-collection-summary';
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
  // 교차 요약/저장 버튼 비활성 판정 — 생성/파싱/인덱싱 중에는 차단
  const isQaGenerating = useAppStore((s) => s.isQaGenerating);
  const isGenerating = useAppStore((s) => s.isGenerating);
  const ragIsIndexing = useAppStore((s) => s.ragState.isIndexing);
  // isCollectionBusy: 교차 요약 준비(gather) 단계도 버튼 비활성 — 연타/끼어듦 방지(QA R).
  const isCollectionBusy = useAppStore((s) => s.isCollectionBusy);
  // QA21(B-MED): 문서 교체가 예정된 상태도 차단 — gather 중 교체가 일어나면 isCollectionBusy 가
  // 새 문서로 눌러붙는데(resetSummaryState 가 초기화하지 않는 유일한 생성계 플래그), 새 문서엔
  // QaChat 이 없어 gather 의 유일한 취소 버튼까지 사라진다(취소 불가 정지).
  const docSwapPending = useAppStore(isDocSwapPending);
  const isBusy = isQaGenerating || isGenerating || ragIsIndexing || isCollectionBusy || docSwapPending;

  const [manifest, setManifest] = useState<SessionManifestEntry[]>([]);
  const [saving, setSaving] = useState(false);     // 이름 입력 표시 여부
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const [saveName, setSaveName] = useState('');

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
  // 요약 자격(QA M2): 교차 요약은 텍스트 합성이라 임베딩 동질성 불요 — 'missing'(저장 세션 없음)만
  // 제외하고 no-index/model-mismatch 도 포함한다(검색은 readyCount, 요약은 이 카운트로 게이트).
  const summaryEligibleCount = resolved.filter((r) => r.status !== 'missing').length;

  const statusLabel = (status: ResolvedMember['status']): string => {
    switch (status) {
      case 'model-mismatch': return t('collection.statusModelMismatch');
      case 'no-index': return t('collection.statusNoIndex');
      case 'missing': return t('collection.statusMissing');
      default: return '';
    }
  };

  // 저장 대상 멤버 = 체크된 멤버 + 활성 문서(강제 포함). 컬렉션은 2개 이상일 때만 의미.
  const memberHashesToSave = candidates
    .filter((c) => c.docHash === activeDocHash || collection.memberHashes.includes(c.docHash as string))
    .map((c) => c.docHash as string);
  // 기본 이름은 활성 문서명 우선(없으면 첫 멤버) — 활성 강제 포함 정책과 명명 직관 일치(R47)
  // 저장된 컬렉션에서 연 세트면 그 이름을 기본값으로 — 사용자가 그대로 저장하면 갱신 경로를 탄다
  // (이름을 지우고 새로 쓰면 신규 저장). 그렇지 않으면 종전대로 활성 문서명 우선.
  const defaultName = collection.saved?.name
    ?? activeTab?.fileName
    ?? candidates.find((c) => c.docHash === memberHashesToSave[0])?.fileName
    ?? candidates[0]?.fileName ?? '';

  const handleSave = async (): Promise<void> => {
    const name = saveName.trim();
    if (!name || memberHashesToSave.length < 2) return;
    // 저장된 컬렉션에서 연 세트를 **같은 이름으로** 다시 저장하면 그 항목의 갱신(id 재사용).
    // 이름을 바꿨다면 "다른 이름으로 저장" 의도이므로 id 를 넘기지 않아 신규 항목이 된다.
    const savedRef = collection.saved;
    const reuseId = savedRef && savedRef.name === name ? savedRef.id : undefined;
    const r = await saveCollection({ name, docHashes: memberHashesToSave, ...(reuseId ? { id: reuseId } : {}) });
    if (r.ok) {
      // 신규 저장이었다면 이후 재저장도 갱신이 되도록 방금 발급된 id 로 소속을 기록.
      if (r.id) useAppStore.getState().setSavedCollection({ id: r.id, name });
      // QA23: 갱신은 멤버 목록을 교체하므로(빠진 문서는 컬렉션에서 사라진다) 신규 저장과 구분해
      // 대상과 결과 개수를 알린다 — 의도치 않은 축소를 사용자가 즉시 알아챌 수 있어야 한다.
      useAppStore.getState().setNotice({
        message: reuseId
          ? t('collection.savedUpdate', { name, count: String(memberHashesToSave.length) })
          : t('collection.saved'),
      });
      // QA23(D-MED): 보관 한도 초과로 오래된 컬렉션이 지워졌다면 알린다 — 이전에는 완전 무음이라
      // 사용자는 나중에 목록에서 사라진 것을 발견할 뿐 이유를 알 수 없었다(세션 LRU 와 대칭).
      if (r.evicted && r.evicted.length > 0) {
        useAppStore.getState().setNotice({ message: t('collection.evictedNotice', { names: r.evicted.join(', ') }) });
      }
    } else {
      // 실패는 setError(닫기 전까지 잔존)로 통일 — notice(자동소멸)면 놓치기 쉬움(R47)
      useAppStore.getState().setError({ code: 'COLLECTION_SAVE_FAIL', message: t('collection.saveFail') });
      // QA28(B-Low): 실패했는데도 입력 UI 를 닫고 이름을 지우면 재시도에 재입력이 필요하다 —
      // 입력값·입력 UI 를 유지한다(setSaving(false) 를 await 앞에서 여기로 옮겼다).
      return;
    }
    setSaving(false);
    setSaveName('');
    // QA28(B-Low): 확정 버튼이 언마운트되며 포커스가 <body> 로 유실 — 💾 버튼으로 반환
    // (SettingsPanel.removeTemplate 의 rAF 이관과 동일 패턴).
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => saveButtonRef.current?.focus());
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
          <span className="text-gray-600 dark:text-gray-400">· {t('collection.searchingCount', { count: readyCount })}</span>
        )}
      </label>

      {collection.enabled && (
        <div className="mt-2 space-y-1" role="group" aria-label={t('collection.members')}>
          {candidates.map((tab) => {
            const docHash = tab.docHash as string;
            const status = statusByHash.get(docHash)?.status ?? 'ready';
            // 선택 가능(QA M2): 'missing'(저장 세션 없음)만 불가. no-index/model-mismatch 는
            // 선택 가능 — 검색엔 안 쓰이지만 교차 요약에는 포함된다(collectionRagSearch 가 자체적으로
            // 'ready'만 사용하므로 멤버에 포함돼도 검색 정확도엔 무영향).
            const selectable = status !== 'missing';
            const isActive = docHash === activeDocHash;
            // 활성 문서는 항상 컬렉션에 포함(해제 불가) — resolveCollectionSearch 의 강제 union 과 일치.
            const forced = isActive && selectable;
            const checked = forced || (collection.memberHashes.includes(docHash) && selectable);
            const disabled = !selectable || forced;
            // a11y: 검색 제외/세션 없음 사유·활성 표시를 체크박스 접근명에 묶어 스크린리더가 함께 읽도록.
            const ariaLabel = [tab.fileName,
              isActive ? t('collection.activeBadge') : null,
              status !== 'ready' ? statusLabel(status) : null].filter(Boolean).join(', ');
            return (
              <label
                key={tab.filePath}
                className={`flex items-center gap-2 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'} ${status === 'ready' ? '' : 'opacity-60'}`}
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
                {status !== 'ready' && (
                  <span className="shrink-0 text-amber-600 dark:text-amber-400">{statusLabel(status)}</span>
                )}
              </label>
            );
          })}
          {readyCount === 0 && (
            <p className="text-amber-600 dark:text-amber-400">{t('collection.noneSearchable')}</p>
          )}

          {/* 교차 문서 요약/비교 — 텍스트 보유 멤버 2개 이상일 때(QA M2: 임베딩 동질성 불요) */}
          {summaryEligibleCount >= 2 && (
            <div className="mt-2 flex items-center gap-1">
              <button
                onClick={() => void generateCollectionSummary('unified')}
                disabled={isBusy}
                className="rounded bg-blue-500 px-2 py-1 text-white hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('collection.unified')}
              </button>
              <button
                onClick={() => void generateCollectionSummary('comparison')}
                disabled={isBusy}
                className="rounded border border-blue-500 px-2 py-1 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {t('collection.compare')}
              </button>
            </div>
          )}

          {/* 컬렉션 저장 — 멤버 2개 이상일 때. 이름 입력 인라인 토글. */}
          {saving ? (
            <div className="mt-2 flex items-center gap-1">
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                placeholder={t('collection.saveNamePlaceholder')}
                aria-label={t('collection.saveNamePlaceholder')}
                autoFocus
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSave(); }}
                // 입력 텍스트 색 명시 — 미지정 시 상속 색이 배경(white/gray-900)과 비슷해 글씨가 안 보였다
                className="flex-1 min-w-0 rounded border dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={() => void handleSave()}
                disabled={!saveName.trim()}
                className="shrink-0 rounded bg-blue-500 px-2 py-1 text-white disabled:opacity-50"
              >
                {t('collection.saveConfirm')}
              </button>
              <button
                onClick={() => { setSaving(false); setSaveName(''); }}
                className="shrink-0 rounded px-2 py-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300"
              >
                {t('collection.saveCancel')}
              </button>
            </div>
          ) : (
            <button
              ref={saveButtonRef}
              onClick={() => { setSaveName(defaultName); setSaving(true); }}
              disabled={memberHashesToSave.length < 2}
              className="mt-2 rounded px-2 py-1 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              💾 {t('collection.save')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
