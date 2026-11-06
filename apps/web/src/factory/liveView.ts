import type { LiveIssue } from "./live";
import type { EventLoad } from "./poll";
import { el } from "./view";

const REPO = "https://github.com/roboco-io/the-software-factory-demo";
const STATES: Record<string, string> = {
  "needs-human": "사람 확인 대기",
  "in-progress": "구현 중",
  "in-review": "검토 중",
  merged: "병합됨, 배포 대기",
  verifying: "배포 후 검증 중",
  deployed: "배포 완료",
};
const STAGES: Record<string, string> = {
  triage: "요청 정리",
  implement: "구현",
  review: "검토",
  fix: "수정",
  verify: "검증",
};
const REASONS: Record<string, string> = {
  verify_unmet: "수용 기준 미충족",
  verify_failed: "검증 실행 실패",
  verify_stuck: "검증이 1시간 넘게 끝나지 않음",
  risk_t2: "사람 승인 필요(T2)",
  risk_t3: "사람 승인 필요(T3)",
  permission_denied: "실행 권한 없음",
};

function elapsed(fromTs: string, now: Date): string {
  const min = Math.floor(Math.max(0, now.getTime() - Date.parse(fromTs)) / 60_000);
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}시간 ${min % 60}분 전` : `${Math.floor(h / 24)}일 전`;
}

function row(issue: LiveIssue, now: Date): HTMLElement {
  const li = el("li", undefined, `live-row${issue.needsHuman ? " human" : ""}`);
  const head = el("div", undefined, "live-head");
  const a = el("a", `#${issue.issue}`);
  a.href = `${REPO}/issues/${issue.issue}`;
  head.append(a, el("strong", issue.title ?? "(제목 없음)", "live-title"));
  head.append(el("span", STATES[issue.state] ?? issue.state, "live-state"));
  if (issue.delayed) head.append(el("span", "지연", "live-delay"));
  li.append(head);

  const flow = el("ol", undefined, "live-flow");
  flow.setAttribute("aria-label", "단계 흐름");
  for (const s of issue.stages) {
    const item = el("li", STAGES[s.name] ?? s.name);
    if (issue.running === s.name) item.className = "current";
    flow.append(item);
  }
  if (issue.stages.length) li.append(flow);

  const meta = el("p", undefined, "live-meta");
  const parts = [`마지막 변화 ${elapsed(issue.latestAt, now)}`, `수정 ${issue.rounds}회`];
  if (issue.reason) parts.push(`사유: ${REASONS[issue.reason] ?? issue.reason}`);
  if (issue.verdict) {
    const v = issue.verdict;
    parts.push(`검증 충족 ${v.met} · 미충족 ${v.unmet} · 확인 불가 ${v.unverifiable}`);
  }
  meta.append(parts.join(" · "));
  if (issue.runUrl && issue.runUrl.startsWith("https://github.com/")) {
    meta.append(" · ");
    const run = el("a", "실행 보기");
    run.href = issue.runUrl;
    meta.append(run);
  }
  li.append(meta);
  return li;
}

export function renderLivePanel(issues: LiveIssue[], load: EventLoad, now: Date): HTMLElement {
  const s = el("section", undefined, "panel live-panel");
  s.setAttribute("aria-labelledby", "live-title-h");
  s.dataset.live = "true";
  const h = el("h2", "지금 진행 중인 요청");
  h.id = "live-title-h";
  s.append(h);
  const waiting = issues.filter((i) => i.needsHuman).length;
  s.append(
    el(
      "p",
      `사람을 기다리는 요청 ${waiting}건 · 진행 중 ${issues.length}건`,
      waiting ? "live-count human" : "live-count",
    ),
  );
  s.append(
    el(
      "p",
      load.source === "raw"
        ? "GitHub 요청 한도가 부족해 5분 간격으로 갱신합니다. 최대 5분 늦을 수 있습니다."
        : "1분마다 갱신합니다. 탭이 숨겨지면 멈춥니다.",
      "note live-source",
    ),
  );
  if (!issues.length) {
    s.append(el("p", "지금 진행 중인 요청이 없습니다.", "empty"));
    return s;
  }
  const sorted = [...issues].sort((a, b) => Number(b.needsHuman) - Number(a.needsHuman));
  const list = el("ul", undefined, "live-list");
  for (const i of sorted) list.append(row(i, now));
  s.append(list);
  return s;
}

export function loadingPanel(): HTMLElement {
  const s = el("section", undefined, "panel live-panel");
  s.dataset.live = "true";
  const p = el("p", "진행 상황을 불러오는 중입니다.", "loading");
  p.setAttribute("role", "status");
  s.append(el("h2", "지금 진행 중인 요청"), p);
  return s;
}

export function markStale(panel: HTMLElement): void {
  if (panel.querySelector(".live-stale")) return;
  const p = el(
    "p",
    "갱신에 실패했습니다. 이전 내용을 보여 주며 5분 뒤 다시 시도합니다.",
    "live-stale",
  );
  p.setAttribute("role", "status");
  panel.querySelector("h2")?.after(p);
}
