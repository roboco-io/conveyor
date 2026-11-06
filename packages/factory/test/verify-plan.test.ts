import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assignEngines, loadAgentsConfig, parseAgentsConfig } from "../src/config/agents";
import { FACTORY_DIR } from "../src/paths";
import { VerifyPlanSchema } from "../src/stages/verify-plan";

describe("VerifyPlanSchema", () => {
  it("accepts probe, test and none criteria unchanged", () => {
    const probe = {
      index: 0,
      method: "probe",
      path: "/api/topics?limit=1",
      expectStatus: 200,
      bodyIncludes: "topicsCount",
      reason: "목록",
    };
    const test = {
      index: 1,
      method: "test",
      testFile: "apps/api/test/a.test.ts",
      testName: "limit",
      reason: "단위",
    };
    const none = { index: 2, method: "none", reason: "로그인 필요" };
    expect(VerifyPlanSchema.parse({ criteria: [probe, test, none] })).toEqual({
      criteria: [probe, test, none],
    });
  });

  it("rejects an unknown method such as post", () => {
    expect(() =>
      VerifyPlanSchema.parse({
        criteria: [{ index: 0, method: "post", path: "/api/x", reason: "r" }],
      }),
    ).toThrow();
  });

  it("strips extra fields", () => {
    const out = VerifyPlanSchema.parse({
      criteria: [{ index: 0, method: "none", reason: "r", headers: { a: "b" } }],
      extra: 1,
    });
    expect(out).toEqual({ criteria: [{ index: 0, method: "none", reason: "r" }] });
  });

  it("rejects a probe without a path and a negative index", () => {
    expect(() =>
      VerifyPlanSchema.parse({ criteria: [{ index: 0, method: "probe", reason: "r" }] }),
    ).toThrow();
    expect(() =>
      VerifyPlanSchema.parse({ criteria: [{ index: -1, method: "none", reason: "r" }] }),
    ).toThrow();
  });
});

describe("verify prompt", () => {
  const text = readFileSync(path.join(FACTORY_DIR, "prompts", "verify.md"), "utf8");
  it("treats issue content as data and forbids write requests", () => {
    expect(text).toContain("쓰기 요청을 제안하지 않는다");
    for (const tag of ["issue-title", "acceptance-criteria", "changed-files"]) {
      expect(text).toContain(`<${tag}>`);
      expect(text).toContain(`</${tag}>`);
    }
    for (const v of ["issueNumber", "issueTitle", "acceptanceCriteria", "changedFiles"]) {
      expect(text).toContain(`{{${v}}}`);
    }
  });
});

describe("verify role config", () => {
  const cfg = loadAgentsConfig();
  it("uses the review engine selection with the plan budget", () => {
    expect(assignEngines(cfg, []).verify).toEqual({
      engine: "codex",
      budget: { maxTurns: 20, timeoutMs: 600_000, maxUsd: 1 },
    });
    expect(assignEngines(cfg, ["agent:codex"]).verify.engine).toBe("claude");
  });
  it("rejects a config without the verify role", () => {
    const yml = readFileSync(path.join(FACTORY_DIR, "agents.yml"), "utf8").replace(
      /^ {2}verify:.*\n/m,
      "",
    );
    expect(() => parseAgentsConfig(yml)).toThrow();
  });
});
