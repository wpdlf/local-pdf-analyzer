---
template: analysis
feature: session-persistence
date: 2026-06-09
author: jjw
project: local-pdf-analyzer
phase: check
---

# Session Persistence — Gap Analysis (Check)

> **Design**: [session-persistence.design.md](../02-design/features/session-persistence.design.md)
> **Plan**: [session-persistence.plan.md](../01-plan/features/session-persistence.plan.md)
> **PRD**: 없음 (plan-plus 진입)
> **Method**: gap-detector 정적 분석 + vitest 754 통과(런타임 대체)

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | 재오픈 시 재요약·재임베딩 강제 + 클라우드 토큰 재과금 → 작업 연속성 |
| **WHO** | 같은 PDF 반복 분석 학습/연구 사용자, 클라우드 임베딩 사용자 |
| **SUCCESS** | 동일 콘텐츠 재오픈 시 재호출 0 복원, 모델/차원 불일치 안전 무효화, LRU |
| **SCOPE** | In: 세션/인덱스 영속화·해시·LRU·UI / Out: Vision캐싱·멀티문서·암호화·SQLite |

## Match Rate

| 축 | 점수 | 가중 | 근거 |
|----|:---:|:---:|------|
| Structural | 100% | ×0.2 | Design §11.1 NEW 4 + MOD 5 전부 존재, 컴포넌트 2종 실재 |
| Functional | 100% | ×0.4 | FR-01~09 전부 실제 로직(스텁 0). empty-state Minor 해소 후 100% |
| Contract | 100% | ×0.4 | IPC 3-way(Design §4.1 ↔ main ↔ preload ↔ renderer) 완전 일치 |
| **Overall** | **100%** | | **≥90% 달성 (Minor 수정 반영)** |

> 서버 없는 Electron+vitest 프로젝트 → 정적 공식(Structural×0.2 + Functional×0.4 + Contract×0.4). vitest 754 통과(session 신규 +30)가 §8 시나리오 행위 검증 대체.

## Plan Success Criteria

| SC | 상태 | 근거 |
|----|:---:|------|
| 동일 콘텐츠 재오픈 → 요약·Q&A 재호출 없이 복원 | ✅ | use-session.ts restore + replaceSummaryStream/setQaMessages |
| 모델·차원 일치 시 인덱스 재임베딩 없이 복원 | ✅ | checkEmbedModel 일치 시 VectorStore.restore + restoredSession 마커(use-qa skip) |
| 최근목록에서 세션 이어가기 | ✅ | RecentDocuments + file:open-path → handlePdfData → 복원 |
| LRU 자동 정리 | ✅ | session-store.enforceLru(30개/200MB) |
| 모델/차원/콘텐츠 변경 시 캐시 무효화 | ✅ | 해시/schema 불일치 폴백 + 모델 불일치 인덱스 미복원 |

## Gap 목록

**[Minor — 해소됨] RecentDocuments empty-state 문구 미렌더**
- Design §5.4: "Empty state: 목록 비었을 때 안내 문구 (Ko/En)"
- 최초 구현은 빈 목록 시 `return null` 로 안내 문구 미표시 (i18n `recent.empty` dead key).
- **수정**: `RecentDocuments.tsx` 가 영속화 ON + 빈 목록일 때 `recent.empty` 를 렌더하도록 변경 (OFF 시에만 완전 숨김). dead key 해소 + 신규 사용자 기능 발견성 확보 → Functional 100%.

> Critical/Important gap **0건**. 미충족 FR 없음. Minor 1건 해소 완료.

## 의도적 편차 (gap 비계상)
1. **RecentDocuments 원본 부재 badge** — 항목별 사전 존재체크(IPC) 대신 열기 시 `recent.openFail` graceful 배너. 비용 절감 목적, 사전 고지됨.
2. **§8 L1/L2/L3 → vitest 매핑** — Playwright 아닌 단위/행위 테스트. 754 통과로 커버.
3. **shared/session-types.ts 추가** — Design §11.1 외 파일이나 main/renderer 계약 공유로 drift 차단(구조 개선).

## 결론
- **Overall 97% — Definition of Done 충족** (FR-01~09 + 단위테스트 + gap≥90%).
- iterate 불필요. 잔여는 선택적 Minor 1건(empty-state/dead key 동기화).
- 다음: empty-state Minor 처리 후 `/pdca report` 또는 즉시 report.

## Version History
| Version | Date | Changes |
|---------|------|---------|
| 0.1 | 2026-06-09 | gap-detector 분석 (Overall 97%) |
