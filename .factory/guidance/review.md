## 프로젝트 지침

API 오류 응답은 반드시 `apps/api/src/lib/errors.ts`의 헬퍼(`ApiError`와 그 헬퍼 함수)로 만든다. 라우트에서 `c.json({ errors: ... })`를 직접 반환하면 category `error-format`의 major 지적이다.
