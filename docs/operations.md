<!-- README에서 분리한 설정·운영 안내입니다. -->

# 개발자·운영자 안내

이 문서는 conveyor를 배포하고 운영하는 사람을 위한 안내입니다. 2026-11-08에 GitHub Actions로 만든 이전 팩토리를 이 저장소에서 지웠습니다. 이전 팩토리의 운영 안내(트리아지, 주간 자가 개선, 자동 포스트모템, 데모 리허설)는 태그 [`legacy-factory`의 operations.md](https://github.com/roboco-io/conveyor/blob/legacy-factory/docs/operations.md)에 남아 있습니다.

- 개발 지침: [AGENTS.md](../AGENTS.md)
- 웹: React + Vite, GitHub Pages 배포 — <https://roboco.io/conveyor/>
- API: Hono, Cloudflare Workers + D1 배포 — <https://sfd-api.roboco.workers.dev/api>
- 팩토리: 별도 저장소 [roboco-io/the-software-factory-demo](https://github.com/roboco-io/the-software-factory-demo)의 제어 평면이 GitHub App `roboco-software-factory-control`로 이 저장소를 관리한다. 포털: <https://software-factory-control.roboco.workers.dev/projects/roboco-io/conveyor>

## 팩토리 연결

제어 평면은 운영자가 이슈에 `factory:go` 라벨을 붙이면 실행을 시작한다. 구현과 리뷰는 제어 평면의 샌드박스에서 하고, 브랜치·PR·병합은 GitHub App 토큰으로 한다. 이 저장소에는 팩토리용 워크플로나 봇 비밀 값이 없다.

제어 평면은 기본 브랜치의 [`.factory/policy.yml`](../.factory/policy.yml)만 읽는다. 이 파일은 경로별 위험 등급(T0-T3)과 필수 체크 목록(`requiredChecks`)을 정한다. T3 변경은 운영자가 승인해야 병합된다. 다음 세 곳은 서로 같아야 하며, 하나를 바꾸면 나머지도 함께 바꾼다.

| 위치                                       | 같아야 하는 내용                         |
| ------------------------------------------ | ---------------------------------------- |
| `.factory/policy.yml`의 `requiredChecks`   | `.github/workflows/ci.yml`의 job 이름    |
| ruleset `main-protection`의 필수 상태 체크 | `.factory/policy.yml`의 `requiredChecks` |
| `.github/CODEOWNERS`                       | `.factory/policy.yml`의 T3 경로          |

ruleset은 저장소 설정(Settings > Rules > Rulesets)이라 코드 리뷰로 바뀌지 않는다. `requiredChecks`가 ruleset보다 적으면 제어 평면이 병합을 시도해도 GitHub가 거부한다. CODEOWNERS에 T0-T2 경로가 들어가면 ruleset의 코드 소유자 리뷰 조건 때문에 자동 병합이 막힌다.

## 워크플로

- `ci.yml`: PR과 main push마다 `typecheck`, `lint`, `unit`, `forum-api`, `e2e`, `codeql`, `deps-audit`, `secrets`를 실행한다. 모두 필수 체크다.
- `preview.yml`: 사람이 연 같은 저장소 PR마다 PR 전용 D1·Worker와 웹 프리뷰(`https://roboco.io/conveyor/pr-preview/pr-<번호>/`)를 만들고 E2E와 읽기 전용 스모크를 실행한다. 작성자가 봇인 PR(팩토리가 연 PR)에는 프리뷰를 만들지 않는다. 에이전트가 쓴 코드를 Cloudflare 토큰과 함께 실행하지 않기 위해서다. PR을 닫으면 프리뷰를 지운다.
- `deploy.yml`: main에 병합되면 D1 마이그레이션, API, 웹을 배포하고 읽기 전용 스모크와 빌드 출처 증명(`provenance`)을 실행한다.

저장소 변수 `WEB_URL`(`https://roboco.io/conveyor/`)과 `WORKERS_SUBDOMAIN`(`roboco`)을 쓴다. 저장소 이름이나 Pages 주소가 바뀌면 `WEB_URL`도 바꾼다. 바꾸지 않으면 스모크가 옛 주소에서 404를 받아 실패한다.

## 오류와 피드백

Worker가 처리하지 못한 예외는 `error_events` 테이블에 fingerprint 단위로 모인다. 웹 푸터의 "피드백" 버튼으로 받은 익명 의견은 `feedback` 테이블에 쌓인다. API는 IP 원문을 저장하지 않고 `SHA-256(IP + INTAKE_TOKEN)`만 저장하며, 같은 해시는 10분에 3건까지 받는다.

이전 팩토리는 이 두 테이블을 30분마다 읽어 이슈로 만들었다. 이 예약 수집은 2026-11-08에 멈췄다. 지금은 운영자가 수집 API로 직접 읽고, 필요한 것만 이슈로 옮긴다.

- 읽기: `GET /api/_factory/intake`. 확인하지 않은 오류와 피드백을 반환한다.
- 확인 표시: `POST /api/_factory/intake/ack`. 본문은 `{"errors":[{"fingerprint":"...","lastSeen":"..."}],"feedback":[<id>]}` 형식이다. 읽은 뒤 같은 오류가 다시 나면 그 오류는 다시 목록에 나온다.
- 오류 주입: `POST /api/_factory/intake/probe`. 일부러 예외를 하나 기록한다(응답 500).

세 엔드포인트 모두 `Authorization: Bearer <INTAKE_TOKEN>`이 필요하다. 토큰이 없거나 틀리면 다른 미지 경로와 같은 404를 돌려준다. 토큰이 명령줄이나 셸 기록에 남지 않게 헤더를 파일 디스크립터로 넘긴다.

```bash
curl -sS -H @<(printf 'Authorization: Bearer %s\n' "$(cat ~/.config/sfd-intake-token)") https://sfd-api.roboco.workers.dev/api/_factory/intake
```

## 비밀 값

- `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`: `production`·`preview` environment 시크릿이다. wrangler나 Cloudflare API를 호출하는 단계에만 `env`로 넘긴다. 의존성 설치, 웹 빌드, Playwright 단계는 받지 않는다.
- `INTAKE_TOKEN`: `production` environment 시크릿이 원본이다. `deploy`가 배포마다 Worker secret으로 넣는다. 값을 바꾸려면 시크릿을 바꾸고 `deploy`를 다시 실행한다. 로컬 사본은 `~/.config/sfd-intake-token`(권한 600)에만 둔다. 프리뷰 Worker에는 넣지 않으므로 프리뷰의 수집 엔드포인트는 항상 404다.
- `BOOK_SYNC_TOKEN`: 책 저장소(`roboco-io/the-software-factory`)의 Pages 배포가 `POST /api/book/sync`를 부를 때 쓴다. 원본은 `production` environment 시크릿이고, 같은 값을 책 저장소의 시크릿 `FORUM_SYNC_TOKEN`에 둔다. 값을 바꾸려면 두 시크릿을 함께 바꾸고 `deploy`를 다시 실행한다. 매시 17분 Cron 동기화가 놓친 경우를 보조한다.
- `JWT_SECRET_PREVIEW`: 프리뷰 Worker마다 PR 번호에서 파생한 `JWT_SECRET`을 만드는 데 쓴다.

## 배포 롤백

1. 이전 Worker 버전을 확인한다: `cd apps/api && pnpm exec wrangler deployments list --name sfd-api`
2. 이전 버전으로 되돌린다: `pnpm exec wrangler rollback <version-id> --name sfd-api -m "<사유>"`
3. D1 마이그레이션은 자동으로 되돌리지 않는다. 되돌려야 하면 역방향 마이그레이션을 사람이 새로 작성해 PR로 병합한다.
4. 웹은 문제 커밋을 revert하는 PR을 병합하면 `deploy` 워크플로가 다시 배포한다.

## 보안 검사 대응

- `deps-audit`이 새 권고 때문에 관련 없는 PR을 실패시키면, 먼저 의존성 갱신으로 해결할 수 있는지 본다. 해결할 수 없으면 `pnpm-workspace.yaml`의 `auditConfig.ignoreGhsas`에 권고 번호(GHSA)를 추가하는 PR을 연다. 이 파일은 T3이다. 무시한 이유와 재검토 시점을 PR 본문에 적는다.
- `secrets` 체크가 실패하면 발견된 시크릿을 먼저 발급처에서 폐기하고 새로 발급한 뒤, 이력에서 제거하거나 새 브랜치로 다시 작업한다. 이미 push된 시크릿은 폐기하기 전에는 유출된 것으로 본다. 오탐이면 `.github/gitleaks.toml`의 `[allowlist]`에 경로를 추가한다. 이 파일은 T3이다.
- 단계별 통제와 한계는 [security.md](security.md)에 있다.

## 프리뷰 보안 한계

프리뷰 웹은 프로덕션 웹과 같은 오리진(`https://roboco.io`)에서 서빙된다. 같은 오리진의 JavaScript는 `localStorage`를 읽을 수 있으므로, PR 코드가 다른 경로의 로그인 토큰을 읽을 수 있다. 완화책으로 토큰 키를 API 주소별(`jwt:<API_BASE>`)로 나누고, 프리뷰 Worker마다 별도 `JWT_SECRET`을 쓴다. 그래서 프로덕션 토큰은 프리뷰 API에서 검증되지 않는다. 그러나 프리뷰 JS가 프로덕션 토큰을 읽는 것 자체는 막지 못한다. 사람이 연 같은 저장소 PR만 프리뷰를 만들기 때문에 데모 범위에서 수용한 위험이다.
