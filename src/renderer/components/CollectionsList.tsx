import { useEffect, useState, useCallback, useRef } from 'react';
import { useT } from '../lib/i18n';
import { useAppStore } from '../lib/store';
import { listCollections, deleteCollection, touchCollection } from '../lib/collections-client';
import { openCollection, isTabSwitchBlocked } from '../lib/tabs';
import type { SavedCollection } from '../../shared/collection-types';

/**
 * 저장된 컬렉션 목록 (multi-doc Phase 3 / module-2).
 * 업로드 화면(문서 없음)에서 RecentDocuments 옆에 노출. 열기(멤버 docHash → 탭 세트 복원) / 삭제.
 * 멤버 일부 세션 부재 시 부분 복원 + 안내(컬렉션 항목은 유지). 영속화 OFF 시 숨김.
 */
export function CollectionsList() {
  const tr = useT();
  const persistEnabled = useAppStore((s) => s.settings.persistSessions);
  const [items, setItems] = useState<SavedCollection[]>([]);
  // QA23(D-LOW): 목록을 **불러오지 못한 것**과 **정말 없는 것**을 구분한다. 이전에는 둘 다 빈
  // 배열이라 일시 I/O 오류 한 번에 "저장된 컬렉션이 없습니다"를 단정적으로 보여줬다.
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const mountedRef = useRef(true);
  // StrictMode(dev) 더블 마운트 가드: 재마운트 시 true 로 리셋하지 않으면 첫 언마운트가 false 로
  // 만든 뒤 refresh 결과를 가드가 버려 목록이 빈 채로 남는다(dev 한정 — production 은 단일 마운트).
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const list = await listCollections();
    if (!mountedRef.current) return;
    if (list === null) {
      // 읽기 실패 — 기존 목록을 지우지 않는다(방금까지 보이던 항목이 사라지면 더 혼란스럽다).
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setItems(list);
  }, []);

  useEffect(() => {
    if (persistEnabled) void refresh();
  }, [persistEnabled, refresh]);

  const handleOpen = useCallback(async (c: SavedCollection) => {
    // 생성/파싱 중이면 탭 세트 교체가 진행 중 작업과 충돌 — 안내 후 중단(switchToTab 등과 동일 가드)
    if (isTabSwitchBlocked()) {
      useAppStore.getState().setNotice({ message: tr('collection.busy') });
      return;
    }
    setBusy(c.id);
    try {
      const { opened, total } = await openCollection(c.docHashes);
      // 최근 사용 표시 — fire-and-forget(열기를 지연시키지 않는다). 부분 복원도 "사용" 으로 친다.
      // 하나도 열리지 않았으면 갱신하지 않는다: 실패한 열기로 LRU 순서를 바꿀 이유가 없다.
      if (opened > 0) void touchCollection(c.id);
      if (opened === 0) {
        useAppStore.getState().setError({ code: 'COLLECTION_OPEN_FAIL', message: tr('collection.openFail') });
      } else if (opened === total) {
        // 복원된 탭 세트의 출처를 기록 — 같은 이름으로 재저장하면 신규 항목이 아니라 이 id 의
        // 갱신이 된다(동명 누적·무관 컬렉션 LRU 축출 방지).
        //
        // QA23(D-MED, 회수 불가): **부분 복원에서는 기록하지 않는다.** 멤버 세션이 LRU 축출·손상
        // 으로 일부 사라진 상태인데 소속을 기록하면, 프리필된 이름 그대로 저장했을 때 복원되지
        // 못한 멤버가 컬렉션에서 영구 삭제된다(그 문서를 다시 열어 세션이 살아나도 복구 안 됨).
        // 부분 복원 상태는 "이 컬렉션을 편집 중" 이 아니므로, 저장하면 새 컬렉션이 된다(무손실).
        useAppStore.getState().setSavedCollection({ id: c.id, name: c.name });
      }
      if (opened > 0 && opened < total) {
        // 부분 복원 — 안내(컬렉션 항목은 유지). 성공 멤버는 이미 탭으로 열렸으므로 notice 채널 사용.
        useAppStore.getState().setNotice({ message: tr('collection.partialOpen', { opened, total }) });
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [tr]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteCollection(id);
    // 삭제된 항목이 지금 열려 있는 세트의 출처였다면 소속을 끊는다 — 이후 저장은 신규 항목이어야 한다.
    if (useAppStore.getState().collection.saved?.id === id) {
      useAppStore.getState().setSavedCollection(null);
    }
    void refresh();
  }, [refresh]);

  if (!persistEnabled) return null;

  // QA24(A-L3): 실패 고지를 **목록 유무와 무관하게** 렌더한다. 종전에는 이 블록이
  // `items.length === 0` 안에만 있어서, 이미 목록이 떠 있는 상태의 refresh 실패(삭제 직후
  // 재조회가 EBUSY 등)는 **사유도 재시도도 없이** 방금 지운 항목이 남은 stale 목록으로 보였다
  // (클릭하면 열기 실패). "기존 목록을 지우지 않는다" 는 정책 자체는 옳고 고지만 빠졌던 것.
  // RecentDocuments 가 같은 계약을 목록 유무와 무관하게 적용하므로 형제 비대칭도 함께 닫는다.
  const failureNotice = loadFailed ? (
    <div className="flex items-center gap-2 px-1 py-2">
      <p role="alert" className="text-xs text-amber-700 dark:text-amber-400">{tr('collection.loadFailed')}</p>
      <button
        type="button"
        onClick={() => { void refresh(); }}
        className="text-xs underline text-blue-600 dark:text-blue-400"
      >
        {tr('common.retry')}
      </button>
    </div>
  ) : null;

  // 발견성(R47 UX): 컬렉션이 없을 때도 한 줄 안내로 기능 존재/생성 방법을 알린다.
  // QA23(D-LOW): 단 **불러오지 못한 경우**는 "없음"으로 단정하지 않는다 — 사용자가 전량 소실로
  // 읽는다(collections.json 은 유일 사본). 사유와 재시도를 준다.
  if (items.length === 0) {
    return (
      <div className="w-full max-w-2xl mx-auto mt-6">
        <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2 px-1">
          {tr('collection.savedTitle')}
        </h2>
        {failureNotice ?? (
          <p className="text-xs text-gray-600 dark:text-gray-400 px-1 py-2">{tr('collection.savedEmptyHint')}</p>
        )}
      </div>
    );
  }

  return (
    <div className="w-full max-w-2xl mx-auto mt-6">
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2 px-1">
        {tr('collection.savedTitle')}
      </h2>
      {failureNotice}
      <ul className="flex flex-col gap-2">
        {items.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <button
              onClick={() => handleOpen(c)}
              disabled={busy === c.id}
              className="flex-1 min-w-0 text-left disabled:opacity-50"
            >
              <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                📚 {c.name}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {tr('collection.docCount', { count: c.docHashes.length })}
              </div>
            </button>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => handleOpen(c)}
                disabled={busy === c.id}
                className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {busy === c.id ? '…' : tr('collection.open')}
              </button>
              <button
                onClick={() => handleDelete(c.id)}
                disabled={busy === c.id}
                className="p-1.5 text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors"
                aria-label={tr('collection.delete')}
                title={tr('collection.delete')}
              >
                🗑
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
