import { describe, expect, it } from "vitest";
import { liveIssues, parseEvents, recentDone, type FactoryEvent } from "./live";

const NOW = new Date("2026-11-06T12:00:00.000Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const st = (
  issue: number,
  min: number,
  to: string,
  from?: string,
  extra: Partial<FactoryEvent> = {},
): FactoryEvent => ({
  ts: ago(min),
  issue,
  kind: "state",
  to,
  ...(from ? { from } : {}),
  ...extra,
});
const start = (issue: number, min: number, role: string): FactoryEvent => ({
  ts: ago(min),
  issue,
  kind: "start",
  role,
});

describe("liveIssues", () => {
  it("test_sort_human_first: needs-human, delayed, then newest", () => {
    const events = [
      st(1, 5, "in-progress"),
      st(2, 100, "in-progress"),
      start(2, 90, "implement"),
      st(3, 50, "needs-human", "in-review", { reason: "verify_unmet" }),
      st(4, 1, "in-progress"),
    ];
    expect(liveIssues(events, NOW).map((i) => i.issue)).toEqual([3, 2, 4, 1]);
  });

  it("test_excludes_closed: deployed goes to recentDone", () => {
    const events = [
      st(1, 30, "verifying", "merged"),
      st(1, 20, "deployed", "verifying", { title: "done one" }),
      st(2, 10, "deployed", "verifying"),
      st(3, 5, "in-review"),
    ];
    expect(liveIssues(events, NOW).map((i) => i.issue)).toEqual([3]);
    expect(recentDone(events, NOW, 10).map((i) => i.issue)).toEqual([2, 1]);
    expect(recentDone(events, NOW, 1).map((i) => i.issue)).toEqual([2]);
  });

  it("test_future_ts_ignored", () => {
    const events = [
      st(1, 5, "in-review"),
      { ...st(1, 0, "deployed"), ts: "2026-11-07T00:00:00.000Z" },
    ];
    const r = liveIssues(events, NOW);
    expect(r).toHaveLength(1);
    expect(r[0].state).toBe("in-review");
  });

  it("test_round_count: in-review to in-progress", () => {
    const events = [
      st(1, 90, "in-progress"),
      st(1, 80, "in-review", "in-progress"),
      st(1, 70, "in-progress", "in-review"),
      st(1, 60, "in-review", "in-progress"),
      st(1, 50, "in-progress", "in-review"),
    ];
    expect(liveIssues(events, NOW)[0].rounds).toBe(2);
  });

  it("test_delay_limits", () => {
    const limits: [string, number][] = [
      ["triage", 5],
      ["implement", 30],
      ["fix", 20],
      ["review", 15],
      ["verify", 10],
    ];
    for (const [role, lim] of limits) {
      const over = liveIssues([st(1, lim + 5, "in-progress"), start(1, lim + 1, role)], NOW)[0];
      expect(over.running).toBe(role);
      expect(over.delayed).toBe(true);
      const under = liveIssues([st(1, lim + 5, "in-progress"), start(1, lim - 1, role)], NOW)[0];
      expect(under.delayed).toBe(false);
    }
  });

  it("running ends when a later state event arrives; stages get durations", () => {
    const events = [
      st(1, 40, "in-progress"),
      start(1, 39, "implement"),
      st(1, 20, "in-review", "in-progress", { runUrl: "https://github.com/a/b/actions/runs/1" }),
    ];
    const i = liveIssues(events, NOW)[0];
    expect(i.running).toBeNull();
    expect(i.delayed).toBe(false);
    expect(i.stages).toEqual([{ name: "implement", startedAt: ago(39), durationMs: 19 * 60_000 }]);
    expect(i.runUrl).toBe("https://github.com/a/b/actions/runs/1");
  });

  it("needs-human flags, reason, verdict, title", () => {
    const events: FactoryEvent[] = [
      st(7, 30, "verifying", "merged", { title: "T" }),
      { ts: ago(20), issue: 7, kind: "verify", verdict: { met: 1, unmet: 2, unverifiable: 0 } },
      st(7, 10, "needs-human", "verifying", { reason: "verify_unmet" }),
    ];
    const i = liveIssues(events, NOW)[0];
    expect(i).toMatchObject({
      issue: 7,
      title: "T",
      state: "needs-human",
      needsHuman: true,
      delayed: false,
      reason: "verify_unmet",
      verdict: { met: 1, unmet: 2, unverifiable: 0 },
      latestAt: ago(10),
    });
  });

  it("encoding: title stays raw text; non-github runUrl dropped", () => {
    const t = "<img src=x onerror=1>";
    const events = parseEvents(
      JSON.stringify({
        ts: ago(1),
        issue: 1,
        kind: "state",
        to: "in-review",
        title: t,
        runUrl: "javascript:alert(1)",
      }),
    );
    const i = liveIssues(events, NOW)[0];
    expect(i.title).toBe(t);
    expect(i.runUrl).toBeNull();
  });
});

describe("parseEvents", () => {
  it("test_broken_lines_ignored", () => {
    const text = [
      '{"ts":"2026-11-06T00:00:00Z","issue":7,"kind":"state","to":"merged"}',
      "bad",
      "",
      "null",
      "[1]",
      '{"ts":"nope","issue":7,"kind":"state"}',
      '{"ts":"2026-11-06T00:00:00Z","issue":"7","kind":"state"}',
      '{"ts":"2026-11-06T00:00:00Z","issue":7,"kind":"other"}',
      '{"ts":"2026-11-06T00:00:00Z","issue":7,"kind":"verify","verdict":{"met":"x"}}',
    ].join("\n");
    const r = parseEvents(text);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ issue: 7, to: "merged" });
    expect(r[1].verdict).toBeUndefined();
  });
});
