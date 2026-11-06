import { describe, expect, it, vi } from "vitest";
import { judgeCriteria, type JudgeInput } from "../src/stages/verify-judge";

const ORIGIN = "https://sfd-api.example.workers.dev";

type Raw = { criteria: Array<Record<string, unknown>> };

// Swappable producer: fake (pass-through) by default, real T3 schema when SUPERLITE_REAL=1.
async function plan(raw: Raw): Promise<JudgeInput["plan"]> {
  if (process.env.SUPERLITE_REAL === "1") {
    const mod = await import("../src/stages/verify-plan");
    return mod.VerifyPlanSchema.parse(raw);
  }
  return raw as JudgeInput["plan"];
}

const probe = (path: string, extra: Record<string, unknown> = {}) => ({
  index: 0,
  method: "probe",
  path,
  expectStatus: 200,
  bodyIncludes: "topicsCount",
  reason: "목록",
  ...extra,
});

type FetchFn = JudgeInput["fetch"];
function res(status: number, body: string | Uint8Array = "", headers: Record<string, string> = {}) {
  return new Response(body, { status, headers });
}

async function input(raw: Raw, over: Partial<JudgeInput> = {}): Promise<JudgeInput> {
  return {
    plan: await plan(raw),
    criteriaCount: 1,
    apiOrigin: ORIGIN,
    mergedFiles: ["apps/api/test/a.test.ts"],
    requiredChecksOk: true,
    readFile: async () => "it('limit', () => {})",
    fetch: vi.fn(async () => res(200, '{"topicsCount":1}')) as unknown as FetchFn,
    sleep: vi.fn(async () => {}),
    ...over,
  };
}

describe("judgeCriteria probe", () => {
  it("met-production on 200 with body", async () => {
    const i = await input({ criteria: [probe("/api/topics?limit=1")] });
    expect(await judgeCriteria(i)).toEqual([
      { index: 0, verdict: "met-production", evidence: "GET /api/topics?limit=1 -> 200" },
    ]);
  });

  it("test_rejects_post_and_foreign_host", async () => {
    for (const p of ["https://evil.test/", "//evil.test", "http://evil.test/api/x", "api/x"]) {
      const i = await input({ criteria: [probe(p)] });
      const out = await judgeCriteria(i);
      expect(out[0].verdict).toBe("unverifiable");
      expect(i.fetch).not.toHaveBeenCalled();
    }
  });

  it("test_rejects_traversal", async () => {
    for (const p of [
      "/api/../admin",
      "/api/%2e%2e/x",
      "/api/%2E./x",
      "/api\\x",
      "/api/%5cx",
      "/api/x?u=http://evil.test",
      "/api/x\n",
      "/apix",
    ]) {
      const i = await input({ criteria: [probe(p)] });
      expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
      expect(i.fetch).not.toHaveBeenCalled();
    }
  });

  it("rejects an api origin that is not the fixed host pattern", async () => {
    const i = await input({ criteria: [probe("/api/x")] }, { apiOrigin: "https://evil.test" });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
    expect(i.fetch).not.toHaveBeenCalled();
  });

  it("test_redirect_error and test_no_credentials", async () => {
    const f = vi.fn(async (..._a: unknown[]) => {
      throw new TypeError("redirect");
    });
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
    const [url, opts] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${ORIGIN}/api/x`);
    expect(opts.redirect).toBe("error");
    expect(opts.method).toBe("GET");
    expect(opts.headers).toBeUndefined();
    expect(opts.credentials).toBeUndefined();
    expect(opts.body).toBeUndefined();
  });

  it("a returned 3xx is unverifiable, not unmet", async () => {
    const f = vi.fn(async () => res(302));
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("test_retry_three: success on third try", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n < 3) return res(500);
      return res(200, "topicsCount");
    });
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("met-production");
    expect(f).toHaveBeenCalledTimes(3);
    expect(i.sleep).toHaveBeenCalledTimes(2);
  });

  it("unmet after three non-expected statuses", async () => {
    const f = vi.fn(async () => res(500));
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect(await judgeCriteria(i)).toEqual([
      { index: 0, verdict: "unmet", evidence: "GET /api/x -> 500" },
    ]);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("unmet when body lacks bodyIncludes after three tries", async () => {
    const f = vi.fn(async () => res(200, "nothing"));
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    const out = await judgeCriteria(i);
    expect(out[0].verdict).toBe("unmet");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("network errors on all tries are unverifiable", async () => {
    const f = vi.fn(async () => {
      throw new Error("down");
    });
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("500 then network errors is unverifiable (last attempt got no response)", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n === 1) return res(500);
      throw new Error("down");
    });
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("test_body_cap: over 1 MB is unverifiable", async () => {
    const big = new Uint8Array(1024 * 1024 + 1).fill(97);
    const f = vi.fn(async () => res(200, big));
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("body cap by content-length header", async () => {
    const f = vi.fn(async () => res(200, "topicsCount", { "content-length": "99999999" }));
    const i = await input({ criteria: [probe("/api/x")] }, { fetch: f as unknown as FetchFn });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("probe without bodyIncludes only needs the status", async () => {
    const f = vi.fn(async () => res(404, ""));
    const i = await input(
      { criteria: [probe("/api/x", { expectStatus: 404, bodyIncludes: undefined })] },
      { fetch: f as unknown as FetchFn },
    );
    expect((await judgeCriteria(i))[0].verdict).toBe("met-production");
  });
});

describe("judgeCriteria plan shape", () => {
  it("test_missing_criterion", async () => {
    const i = await input({ criteria: [probe("/api/x")] }, { criteriaCount: 3 });
    const out = await judgeCriteria(i);
    expect(out.map((v) => [v.index, v.verdict])).toEqual([
      [0, "met-production"],
      [1, "unverifiable"],
      [2, "unverifiable"],
    ]);
  });

  it("ignores indexes outside the criteria count", async () => {
    const i = await input({ criteria: [probe("/api/x", { index: 5 })] });
    const out = await judgeCriteria(i);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe("unverifiable");
  });

  it("test_duplicate_index: first wins", async () => {
    const i = await input({
      criteria: [probe("/api/x"), { index: 0, method: "none", reason: "later" }],
    });
    const out = await judgeCriteria(i);
    expect(out).toHaveLength(1);
    expect(out[0].verdict).toBe("met-production");
  });

  it("method none is unverifiable", async () => {
    const i = await input({ criteria: [{ index: 0, method: "none", reason: "로그인 필요" }] });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
    expect(i.fetch).not.toHaveBeenCalled();
  });
});

describe("judgeCriteria test method", () => {
  const t = (over: Record<string, unknown> = {}) => ({
    index: 0,
    method: "test",
    testFile: "apps/api/test/a.test.ts",
    testName: "limit",
    reason: "단위",
    ...over,
  });

  it("met-test", async () => {
    const i = await input({ criteria: [t()] });
    expect(await judgeCriteria(i)).toEqual([
      { index: 0, verdict: "met-test", evidence: "apps/api/test/a.test.ts: limit" },
    ]);
  });

  it("test_test_file_not_merged", async () => {
    const i = await input({ criteria: [t({ testFile: "apps/api/test/other.test.ts" })] });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("rejects traversal in testFile even if listed", async () => {
    const f = "../../etc/passwd";
    const i = await input({ criteria: [t({ testFile: f })] }, { mergedFiles: [f] });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("test_checks_failed", async () => {
    const i = await input({ criteria: [t()] }, { requiredChecksOk: false });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("testName absent from file content", async () => {
    const i = await input({ criteria: [t({ testName: "nope" })] });
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });

  it("readFile failure is unverifiable", async () => {
    const i = await input(
      { criteria: [t()] },
      {
        readFile: async () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect((await judgeCriteria(i))[0].verdict).toBe("unverifiable");
  });
});
