import { useEffect, useState, useCallback } from 'react';
import { useT } from '../lib/i18n';
import { useAppStore } from '../lib/store';
import { handlePdfData } from '../lib/pdf-parser';
import type { SessionManifestEntry } from '../../shared/session-types';

/**
 * 최근 문서 목록 (session-persistence module-4).
 * Design Ref: §5.3 — manifest 기반 최근 세션 목록. 열기(filePath 재오픈 → 세션 복원) / 삭제.
 * filePath 부재(이동/삭제) 시 graceful — 에러 배너로 안내하고 목록은 유지.
 */
export function RecentDocuments() {
  const tr = useT();
  const persistEnabled = useAppStore((s) => s.settings.persistSessions);
  const [entries, setEntries] = useState<SessionManifestEntry[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.electronAPI.session.list();
      setEntries(Array.isArray(list) ? list : []);
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    if (persistEnabled) void refresh();
  }, [persistEnabled, refresh]);

  const handleOpen = useCallback(async (entry: SessionManifestEntry) => {
    setBusy(entry.docHash);
    try {
      const result = await window.electronAPI.file.openPath(entry.filePath);
      if ('error' in result) {
        useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: tr('recent.openFail') });
        return;
      }
      // handlePdfData 가 파싱 후 setDocument → restoreSessionForDocument 로 세션 복원
      await handlePdfData(result.data, result.name, result.path);
    } catch {
      useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: tr('recent.openFail') });
    } finally {
      setBusy(null);
    }
  }, [tr]);

  const handleDelete = useCallback(async (docHash: string) => {
    try {
      await window.electronAPI.session.delete(docHash);
    } finally {
      void refresh();
    }
  }, [refresh]);

  if (!persistEnabled || entries.length === 0) {
    return null;
  }

  return (
    <div className="w-full max-w-2xl mx-auto mt-6">
      <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 mb-2 px-1">
        {tr('recent.title')}
      </h2>
      <ul className="flex flex-col gap-2">
        {entries.map((e) => (
          <li
            key={e.docHash}
            className="flex items-center justify-between gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700"
          >
            <button
              onClick={() => handleOpen(e)}
              disabled={busy !== null}
              className="flex-1 min-w-0 text-left disabled:opacity-50"
              title={e.filePath}
            >
              <div className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                📄 {e.fileName}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {tr('recent.pages', { count: e.pageCount })}
                {e.chunkCount > 0 && <> · {tr('recent.indexed', { count: e.chunkCount })}</>}
              </div>
            </button>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => handleOpen(e)}
                disabled={busy !== null}
                className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50 transition-colors"
              >
                {busy === e.docHash ? '…' : tr('recent.open')}
              </button>
              <button
                onClick={() => handleDelete(e.docHash)}
                disabled={busy !== null}
                className="p-1.5 text-gray-400 hover:text-red-500 disabled:opacity-50 transition-colors"
                aria-label={tr('recent.delete')}
                title={tr('recent.delete')}
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
