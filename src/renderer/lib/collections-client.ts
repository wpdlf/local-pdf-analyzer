import type { SavedCollection } from '../../shared/collection-types';

/**
 * 컬렉션 영속화 IPC 래퍼 (multi-doc Phase 3 / module-1) — session-client 와 동일한 best-effort 패턴.
 * 모든 호출은 실패해도 throw 하지 않고 안전 기본값으로 수렴(목록은 빈 배열, 저장/삭제는 ok:false).
 */
export function listCollections(): Promise<SavedCollection[]> {
  return window.electronAPI.collections.list().catch(() => [] as SavedCollection[]);
}

export function saveCollection(
  input: { id?: string; name: string; docHashes: string[] },
): Promise<{ ok: boolean; id?: string }> {
  return window.electronAPI.collections.save(input).catch(() => ({ ok: false }));
}

export function deleteCollection(id: string): Promise<{ ok: boolean }> {
  return window.electronAPI.collections.delete(id).catch(() => ({ ok: false }));
}
