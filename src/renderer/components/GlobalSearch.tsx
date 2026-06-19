import { useState, useCallback, type ReactNode } from 'react';
import { useT } from '../lib/i18n';
import { useAppStore } from '../lib/store';
import { handlePdfData } from '../lib/pdf-parser';
import { searchSessionsSemantic } from '../lib/semantic-search';
import type { GlobalSearchResult } from '../../shared/session-types';

/**
 * 전체 문서 검색 (cross-session search) — 저장된 모든 세션을 가로질러 검색.
 * 두 모드: 키워드(정확한 문자열, main 의 session:search)와 의미(임베딩 코사인, searchSessionsSemantic).
 * 결과 클릭 시 RecentDocuments 와 동일하게 openPath → handlePdfData(세션 복원)로 연다.
 * persistSessions OFF 면 검색 대상이 없으므로 숨김.
 */

type SearchMode = 'keyword' | 'semantic';

/** 스니펫 내 query 를 대소문자 무관 하이라이트 (<mark>). 의미 검색은 질의어가 없을 수 있어 그대로 통과. */
function highlight(text: string, query: string): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const ql = q.toLowerCase();
  const lower = text.toLowerCase();
  const parts: ReactNode[] = [];
  let i = 0;
  let key = 0;
  let idx = lower.indexOf(ql);
  while (idx !== -1) {
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} className="bg-yellow-200 dark:bg-yellow-600/50 text-inherit rounded px-0.5">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    i = idx + q.length;
    idx = lower.indexOf(ql, i);
  }
  if (i < text.length) parts.push(text.slice(i));
  return parts;
}

export function GlobalSearch() {
  const tr = useT();
  const persistEnabled = useAppStore((s) => s.settings.persistSessions);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<SearchMode>('keyword');
  const [results, setResults] = useState<GlobalSearchResult[] | null>(null); // null = 아직 검색 전
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [lastQuery, setLastQuery] = useState('');
  const [lastMode, setLastMode] = useState<SearchMode>('keyword');
  const [note, setNote] = useState<string | null>(null); // no-embed-model / embed-failed / 제외 안내

  const handleSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2 || searching) return;
    setSearching(true);
    setLastQuery(q);
    setLastMode(mode);
    setNote(null);
    try {
      if (mode === 'semantic') {
        const out = await searchSessionsSemantic(q);
        if (out.status === 'no-embed-model') { setResults([]); setNote(tr('search.noEmbedModel')); return; }
        if (out.status === 'embed-failed') { setResults([]); setNote(tr('search.embedFailed')); return; }
        setResults(out.results);
        if (out.excludedCount > 0) setNote(tr('search.excluded', { count: out.excludedCount }));
      } else {
        const r = await window.electronAPI.session.search(q);
        setResults(Array.isArray(r) ? r : []);
      }
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [query, searching, mode, tr]);

  const handleOpen = useCallback(async (r: GlobalSearchResult) => {
    setBusy(r.docHash);
    try {
      const result = await window.electronAPI.file.openPath(r.filePath);
      if ('error' in result) {
        useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: tr('recent.openFail') });
        return;
      }
      await handlePdfData(result.data, result.name, result.path);
    } catch {
      useAppStore.getState().setError({ code: 'PDF_PARSE_FAIL', message: tr('recent.openFail') });
    } finally {
      setBusy(null);
    }
  }, [tr]);

  if (!persistEnabled) return null;

  const modeBtn = (m: SearchMode, label: string) => (
    <button
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={`px-2.5 py-1 text-xs rounded transition-colors ${
        mode === m
          ? 'bg-blue-500 text-white'
          : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="w-full max-w-2xl mx-auto mt-6">
      <div className="flex items-center gap-1 mb-1.5">
        <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-gray-100 dark:bg-gray-800" role="group" aria-label={tr('search.modeLabel')}>
          {modeBtn('keyword', tr('search.modeKeyword'))}
          {modeBtn('semantic', tr('search.modeSemantic'))}
        </div>
        <span className="text-[11px] text-gray-400 dark:text-gray-500 ml-1 hidden sm:inline">{tr('search.modeHint')}</span>
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSearch(); }}
          placeholder={tr('search.placeholder')}
          aria-label={tr('search.title')}
          className="flex-1 min-w-0 px-3 py-2 text-sm border rounded-lg dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-400"
        />
        <button
          onClick={() => void handleSearch()}
          disabled={searching || query.trim().length < 2}
          className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed shrink-0 transition-colors"
        >
          {searching ? tr('search.searching') : tr('search.button')}
        </button>
      </div>

      {note && (
        <p className="mt-2 px-1 text-xs text-amber-600 dark:text-amber-400">{note}</p>
      )}

      {results !== null && (
        results.length === 0 ? (
          !note && (
            <p className="text-xs text-gray-400 dark:text-gray-500 px-1 py-3">
              {tr('search.noResults', { query: lastQuery })}
            </p>
          )
        ) : (
          <ul className="flex flex-col gap-2 mt-3">
            {results.map((r) => (
              <li key={r.docHash}>
                <button
                  onClick={() => void handleOpen(r)}
                  disabled={busy !== null}
                  title={r.filePath}
                  className="w-full text-left px-4 py-3 bg-gray-50 dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-600 disabled:opacity-50 transition-colors"
                >
                  <div className="flex items-center gap-2 truncate text-sm font-medium text-gray-800 dark:text-gray-100">
                    <span className="truncate">📄 {r.fileName}</span>
                    {r.inSummary && (
                      <span className="shrink-0 px-1.5 py-0.5 text-[10px] bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 rounded">
                        {tr('search.inSummary')}
                      </span>
                    )}
                    {busy === r.docHash && <span className="shrink-0 text-gray-400">…</span>}
                  </div>
                  {r.snippets.map((s, i) => {
                    // 키워드: page=0 = 요약 발췌 fallback. 의미: page=0 = 페이지 메타 없는 청크(라벨 생략).
                    const label = s.page > 0
                      ? tr('search.page', { page: s.page })
                      : (lastMode === 'keyword' ? tr('search.summaryLabel') : null);
                    return (
                      <div key={i} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {label && <span className="text-gray-400 dark:text-gray-500 mr-1">{label}</span>}
                        {highlight(s.text, lastQuery)}
                      </div>
                    );
                  })}
                </button>
              </li>
            ))}
          </ul>
        )
      )}
    </div>
  );
}
