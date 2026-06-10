# Archive Index - 2026-06

| Feature | Archived Date | Match Rate | Iterations | Duration | Path |
|---------|:------------:|:----------:|:----------:|:--------:|------|
| session-persistence | 2026-06-10 | 100% | 0 | 06-09~06-10 (plan-plus→릴리즈 v0.19.0) | `session-persistence/` |

## session-persistence

문서 세션 영속화 + RAG 인덱스 캐싱. 동일 콘텐츠 PDF 재오픈 시 요약·Q&A·검색 인덱스를
재요약·재임베딩 없이 복원. plan-plus → design(Option C) → do(4 모듈) → check(100%) →
report → v0.18.27 출시 → R41 QA(High 1 + Important 5 수정) → v0.19.0 안정화 마일스톤.

- 저장: 콘텐츠 해시(SHA-256) 키, 요약·Q&A JSON + 임베딩 Float32 바이너리 블롭, userData/sessions, LRU(30개/200MB)
- 보안: docHash `/^[a-f0-9]{64}$/` traversal 가드, file:open-path 보안 가드, 네이티브 의존성 0
- 후속 후보: 멀티 문서 / 코퍼스 Q&A (본 토대 위 확장), Vision 결과 캐싱
