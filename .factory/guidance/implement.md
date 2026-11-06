## 프로젝트 지침

- 버그(type:bug) 이슈의 재현 테스트는 Vitest 파일(`apps/api/test/*.test.ts` 또는 `apps/web/src/**/*.test.tsx`)로 쓴다. Playwright E2E(`apps/web/e2e/`)만 바꾸면 evidence를 통과하지 못한다.
