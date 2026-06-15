import { useEffect, useState, useCallback, useRef } from 'react';
import { useT } from '../lib/i18n';
import { useAppStore } from '../lib/store';
import { listCollections, deleteCollection } from '../lib/collections-client';
import { openCollection } from '../lib/tabs';
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
  const [busy, setBusy] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const refresh = useCallback(async () => {
    const list = await listCollections();
    if (mountedRef.current) setItems(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => {
    if (persistEnabled) void refresh();
  }, [persistEnabled, refresh]);

  const handleOpen = useCallback(async (c: SavedCollection) => {
    setBusy(c.id);
    try {
      const { opened, total } = await openCollection(c.docHashes);
      if (opened === 0) {
        useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: tr('collection.openFail') });
      } else if (opened < total) {
        // 부분 복원 — 안내(컬렉션 항목은 유지). 성공 멤버는 이미 탭으로 열렸으므로 notice 채널 사용.
        useAppStore.getState().setNotice({ message: tr('collection.partialOpen', { opened, total }) });
      }
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }, [tr]);

  const handleDelete = useCallback(async (id: string) => {
    await deleteCollection(id);
    void refresh();
  }, [refresh]);

  if (!persistEnabled || items.length === 0) {
    return null; // 컬렉션이 없으면 노출하지 않음(최근 문서와 달리 빈 안내는 생략 — 발견성은 저장 버튼이 담당)
  }

  return (
    <div className="w-full max-w-2xl mx-auto mt-6">
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2 px-1">
        {tr('collection.savedTitle')}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map((c) => (
          <li
            key={c.id}
            className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <button
              onClick={() => handleOpen(c)}
              disabled={busy !== null}
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
                disabled={busy !== null}
                className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {busy === c.id ? '…' : tr('collection.open')}
              </button>
              <button
                onClick={() => handleDelete(c.id)}
                disabled={busy !== null}
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
