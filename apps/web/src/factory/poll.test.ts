import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RAW } from "./data";
import { loadEvents, nextDelayMs, startPolling } from "./poll";

const NOW = new Date("2026-11-06T00:00:00Z");

function res(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(status === 404 ? "nf" : body, { status, headers });
}

describe("loadEvents", () => {
  it("test_month_boundary: reads last and current month and joins them", async () => {
    const f = vi.fn(async (url: RequestInfo | URL, _init?: RequestInit) => {
      const u = String(url);
      return res(200, u.includes("2026-10") ? "A" : "B", { "X-RateLimit-Remaining": "40" });
    });
    const load = await loadEvents(NOW, f as unknown as typeof fetch);
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("events/2026-10.jsonl?ref=factory-data");
    expect(urls[1]).toContain("events/2026-11.jsonl?ref=factory-data");
    expect(load).toEqual({ source: "api", remaining: 40, text: "A\nB" });
    const init = f.mock.calls[0]![1];
    expect(init?.headers).toEqual({ Accept: "application/vnd.github.raw+json" });
  });

  it("treats a missing month (404) as empty", async () => {
    const f = vi.fn(async (url: RequestInfo | URL) =>
      String(url).includes("2026-10") ? res(404) : res(200, "B", { "X-RateLimit-Remaining": "30" }),
    );
    const load = await loadEvents(NOW, f as unknown as typeof fetch);
    expect(load).toEqual({ source: "api", remaining: 30, text: "B" });
  });

  it("falls back to raw on 403", async () => {
    const f = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com")) return res(403);
      return res(200, u.includes("2026-10") ? "A" : "B");
    });
    const load = await loadEvents(NOW, f as unknown as typeof fetch);
    expect(load).toEqual({ source: "raw", remaining: null, text: "A\nB" });
    expect(f.mock.calls.some((c) => String(c[0]) === `${RAW}/events/2026-11.jsonl`)).toBe(true);
  });

  it("falls back to raw when remaining is 5 or less", async () => {
    const f = vi.fn(async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.startsWith("https://api.github.com"))
        return res(200, "X", { "X-RateLimit-Remaining": "5" });
      return res(200, "R");
    });
    const load = await loadEvents(NOW, f as unknown as typeof fetch);
    expect(load.source).toBe("raw");
    expect(load.text).toBe("R\nR");
  });

  it("raw 404 is empty; other raw errors throw", async () => {
    const f404 = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith("https://api.github.com") ? res(403) : res(404),
    );
    expect((await loadEvents(NOW, f404 as unknown as typeof fetch)).text).toBe("");
    const f500 = vi.fn(async (url: RequestInfo | URL) =>
      String(url).startsWith("https://api.github.com") ? res(403) : res(500),
    );
    await expect(loadEvents(NOW, f500 as unknown as typeof fetch)).rejects.toThrow();
  });

  it("throws on non-403 api error", async () => {
    const f = vi.fn(async () => res(500));
    await expect(loadEvents(NOW, f as unknown as typeof fetch)).rejects.toThrow();
  });
});

describe("nextDelayMs", () => {
  it("is 60s for api and 5min for raw", () => {
    expect(nextDelayMs({ source: "api", remaining: 40, text: "" })).toBe(60000);
    expect(nextDelayMs({ source: "raw", remaining: null, text: "" })).toBe(300000);
  });
});

function fakeDoc(state: "visible" | "hidden") {
  const listeners: (() => void)[] = [];
  return {
    visibilityState: state,
    addEventListener: vi.fn((_: string, l: () => void) => listeners.push(l)),
    removeEventListener: vi.fn((_: string, l: () => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    }),
    fire() {
      for (const l of [...listeners]) l();
    },
    listeners,
  };
}

describe("startPolling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs immediately when visible and reschedules by returned delay", async () => {
    const doc = fakeDoc("visible");
    const run = vi.fn(async () => 1000);
    startPolling(run, doc as unknown as Document);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("test_hidden_pauses: no scheduling while hidden", async () => {
    const doc = fakeDoc("hidden");
    const run = vi.fn(async () => 1000);
    startPolling(run, doc as unknown as Document);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).not.toHaveBeenCalled();

    doc.visibilityState = "visible";
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    doc.visibilityState = "hidden";
    doc.fire();
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not reschedule when hidden during an in-flight run", async () => {
    const doc = fakeDoc("visible");
    let resolve!: (n: number) => void;
    const run = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    startPolling(run, doc as unknown as Document);
    doc.visibilityState = "hidden";
    doc.fire();
    resolve(1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("test_visible_runs_once: repeated visible events run once", async () => {
    const doc = fakeDoc("hidden");
    const run = vi.fn(async () => 60000);
    startPolling(run, doc as unknown as Document);
    doc.visibilityState = "visible";
    doc.fire();
    doc.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("test_failure_keeps_previous: rejection retries after 5 minutes", async () => {
    const doc = fakeDoc("visible");
    const run = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(60000);
    startPolling(run, doc as unknown as Document);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(299999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("test_stop_clears_timer", async () => {
    const doc = fakeDoc("visible");
    const run = vi.fn(async () => 1000);
    const stop = startPolling(run, doc as unknown as Document);
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.listeners).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stop during an in-flight run prevents rescheduling", async () => {
    const doc = fakeDoc("visible");
    let resolve!: (n: number) => void;
    const run = vi.fn(() => new Promise<number>((r) => (resolve = r)));
    const stop = startPolling(run, doc as unknown as Document);
    stop();
    resolve(1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
