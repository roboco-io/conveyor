import { describe, expect, it } from "vitest";
import type { LiveIssue } from "./live";
import { markStale, renderLivePanel } from "./liveView";

const now = new Date("2026-11-06T01:00:00Z");
const api = { source: "api", remaining: 40, text: "" } as const;
const issue = (v: Partial<LiveIssue> = {}): LiveIssue => ({
  issue: 7,
  title: "제목",
  state: "in-progress",
  needsHuman: false,
  delayed: false,
  running: "implement",
  rounds: 2,
  stages: [
    { name: "triage", startedAt: "2026-11-06T00:00:00Z", durationMs: 1000 },
    { name: "implement", startedAt: "2026-11-06T00:10:00Z", durationMs: 1000 },
  ],
  latestAt: "2026-11-06T00:30:00Z",
  reason: null,
  runUrl: null,
  verdict: null,
  ...v,
});

describe("live panel", () => {
  it("test_title_is_text", () => {
    const p = renderLivePanel([issue({ title: "<img src=x onerror=1>" })], api, now);
    expect(p.querySelector("img")).toBeNull();
    expect(p.textContent).toContain("<img src=x onerror=1>");
  });

  it("test_empty_state", () => {
    const p = renderLivePanel([], api, now);
    expect(p.textContent).toContain("지금 진행 중인 요청이 없습니다.");
    expect(p.textContent).toContain("사람을 기다리는 요청 0건");
  });

  it("test_raw_notice", () => {
    const raw = renderLivePanel([], { source: "raw", remaining: null, text: "" }, now);
    expect(raw.textContent).toContain("5분");
    expect(renderLivePanel([], api, now).textContent).not.toContain("최대 5분 늦을");
  });

  it("test_links", () => {
    const ok = renderLivePanel(
      [issue({ runUrl: "https://github.com/o/r/actions/runs/1" })],
      api,
      now,
    );
    const hrefs = [...ok.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("https://github.com/roboco-io/the-software-factory-demo/issues/7");
    expect(hrefs).toContain("https://github.com/o/r/actions/runs/1");
    const bad = renderLivePanel([issue({ runUrl: "javascript:alert(1)" })], api, now);
    expect([...bad.querySelectorAll("a")]).toHaveLength(1);
  });

  it("test_verdict_counts", () => {
    const p = renderLivePanel(
      [issue({ verdict: { met: 3, unmet: 1, unverifiable: 2 }, reason: "verify_unmet" })],
      api,
      now,
    );
    expect(p.textContent).toContain("충족 3 · 미충족 1 · 확인 불가 2");
    expect(p.textContent).toContain("수용 기준 미충족");
    expect(p.textContent).toContain("수정 2회");
    expect(p.textContent).toContain("30분 전");
  });

  it("puts human-waiting issues first and counts them", () => {
    const p = renderLivePanel(
      [issue({ issue: 1 }), issue({ issue: 2, state: "needs-human", needsHuman: true })],
      api,
      now,
    );
    expect(p.textContent).toContain("사람을 기다리는 요청 1건");
    expect(p.querySelector(".live-row a")?.textContent).toBe("#2");
    expect(p.textContent).toContain("사람 확인 대기");
  });

  it("markStale keeps content and adds the notice once", () => {
    const p = renderLivePanel([issue()], api, now);
    markStale(p);
    markStale(p);
    expect(p.querySelectorAll(".live-stale")).toHaveLength(1);
    expect(p.querySelector(".live-row")).not.toBeNull();
  });
});
