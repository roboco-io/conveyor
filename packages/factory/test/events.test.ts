import { describe, expect, it } from "vitest";
import { appendEvent, eventsPath, type FactoryEvent } from "../src/runs/events";
import { InMemoryGitHub } from "../src/github/memory";

const ev: FactoryEvent = {
  ts: "2026-11-06T00:00:00.000Z",
  issue: 7,
  kind: "state",
  from: "merged",
  to: "verifying",
};

describe("appendEvent", () => {
  it("appends one line to events/YYYY-MM.jsonl on factory-data", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    await appendEvent(gh, ev);
    await appendEvent(gh, { ...ev, issue: 8 });
    expect(eventsPath(ev.ts)).toBe("events/2026-11.jsonl");
    const f = await gh.readFile("factory-data", "events/2026-11.jsonl");
    const lines = f!.content.trim().split("\n");
    expect(lines.map((l) => JSON.parse(l).issue)).toEqual([7, 8]);
  });

  it("test_conflict_retries_then_swallows: resolves after 4 conflicts", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    await appendEvent(gh, ev);
    gh.injectConflicts = 4;
    await expect(appendEvent(gh, { ...ev, issue: 9 })).resolves.toBeUndefined();
    const f = await gh.readFile("factory-data", "events/2026-11.jsonl");
    expect(f!.content).not.toContain('"issue":9');
  });

  it("retries a transient conflict and writes", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    await appendEvent(gh, ev);
    gh.injectConflicts = 2;
    await appendEvent(gh, { ...ev, issue: 9 });
    const f = await gh.readFile("factory-data", "events/2026-11.jsonl");
    expect(f!.content).toContain('"issue":9');
  });

  it("swallows non-conflict errors too", async () => {
    const gh = new InMemoryGitHub({ botLogin: "bot" });
    gh.readFile = async () => {
      throw new Error("boom");
    };
    await expect(appendEvent(gh, ev)).resolves.toBeUndefined();
  });
});
