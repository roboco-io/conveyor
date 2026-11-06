import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, type ProjectConfig } from "../src/config/project";
import type { ChangedFile } from "../src/github/port";
import { PACKAGE_ROOT, REPO_ROOT } from "../src/paths";
import { isTestFile, planSuites } from "../src/policy/evidence";
import { renderPrBody, type PrReport } from "../src/report/pr";
import type { Settings } from "../src/stages/deps";
import { migrationFiles } from "../src/stages/postmortem";
import { skipEntryFiles } from "../src/stages/risk";
import { previewText } from "../src/stages/worktree";

const settings = {
  webUrl: "https://roboco.io/the-software-factory-demo/",
  workersSubdomain: "roboco",
} as Settings;

// Swappable producer: an inline fake of the conveyor config by default, the real loader when SUPERLITE_REAL=1.
function conveyor(): ProjectConfig {
  if (process.env.SUPERLITE_REAL === "1") return loadProjectConfig(REPO_ROOT);
  return {
    name: "conveyor",
    deployment: {
      apiOrigin: "https://sfd-api.{workersSubdomain}.workers.dev",
      webUrl: "https://roboco.io/the-software-factory-demo/",
      previewWeb: "{webUrl}pr-preview/pr-{pr}/",
      previewApi: "https://sfd-api-pr-{pr}.{workersSubdomain}.workers.dev",
    },
    paths: {
      skipFiles: ["tests/forum/skip.txt"],
      smokePaths: ["tests/smoke/", "apps/web/e2e-smoke/"],
      migrationsDir: "apps/api/migrations/",
      protected: [".factory/"],
    },
    evidence: {
      testFilePatterns: ["apps/*/test/**", "**/*.test.ts", "**/*.test.tsx", "apps/web/e2e/**"],
      suites: [
        { suite: "api", filter: "api", dir: "apps/api/" },
        { suite: "web", filter: "web", dir: "apps/web/" },
        { suite: "factory", filter: "factory", dir: "packages/factory/" },
      ],
      e2eDir: "apps/web/e2e/",
    },
  };
}
const other = (): ProjectConfig =>
  loadProjectConfig(path.join(PACKAGE_ROOT, "test", "fixtures", "other-project"));

describe("planSuites with project evidence", () => {
  it("test_other_project_evidence: plans suites from the other project's config", () => {
    const e = other().evidence;
    expect(planSuites(["src/a.test.ts", "src/b.test.ts", "lib/x.test.ts"], e)).toEqual({
      runs: [{ suite: "app", filter: "app", targets: ["a.test.ts", "b.test.ts"] }],
      unsupported: ["lib/x.test.ts"],
    });
    expect(isTestFile("src/a.test.ts", e)).toBe(true);
    expect(isTestFile("apps/api/test/a.test.ts", e)).toBe(false);
  });

  it("keeps the conveyor plan", () => {
    const e = conveyor().evidence;
    expect(
      planSuites(["apps/api/test/a.test.ts", "apps/web/e2e/s.spec.ts", "tools/x.test.ts"], e),
    ).toEqual({
      runs: [{ suite: "api", filter: "api", targets: ["test/a.test.ts"] }],
      unsupported: ["apps/web/e2e/s.spec.ts", "tools/x.test.ts"],
    });
  });

  it("marks files under a configured e2eDir unsupported, and has no e2e rule when null", () => {
    const e = { ...other().evidence, e2eDir: "e2e/" };
    expect(planSuites(["e2e/a.test.ts"], e)).toEqual({ runs: [], unsupported: ["e2e/a.test.ts"] });
    expect(planSuites(["e2e/a.test.ts"], other().evidence).unsupported).toEqual(["e2e/a.test.ts"]);
  });

  it("still rejects unsafe paths", () => {
    expect(isTestFile("src/-x/a.test.ts", other().evidence)).toBe(false);
  });
});

const file = (over: Partial<ChangedFile> & { filename: string }): ChangedFile =>
  ({ additions: [], additionCount: 0, ...over }) as ChangedFile;

describe("skip guard from config", () => {
  it("test_skip_guard_from_config: blocks added lines to configured skip files", () => {
    const skip = conveyor().paths.skipFiles;
    const f = file({ filename: "tests/forum/skip.txt", additions: ["x"], additionCount: 1 });
    expect(skipEntryFiles([f], skip)).toEqual(["tests/forum/skip.txt"]);
    expect(skipEntryFiles([file({ filename: "tests/forum/skip.txt" })], skip)).toEqual([]);
  });

  it("test_empty_skip_files_no_guard", () => {
    const f = file({ filename: "tests/forum/skip.txt", additions: ["x"], additionCount: 1 });
    expect(skipEntryFiles([f], other().paths.skipFiles)).toEqual([]);
  });
});

describe("migrations", () => {
  it("filters by migrationsDir", () => {
    expect(
      migrationFiles(["apps/api/migrations/0001.sql", "a.ts"], "apps/api/migrations/"),
    ).toEqual(["apps/api/migrations/0001.sql"]);
  });

  it("test_null_migrations_no_revert_block: null dir skips the check", () => {
    expect(migrationFiles(["apps/api/migrations/0001.sql"], null)).toEqual([]);
  });
});

describe("previewText", () => {
  it("renders conveyor preview URLs from config", () => {
    expect(previewText(settings, 7, "T1", conveyor())).toBe(
      "웹 https://roboco.io/the-software-factory-demo/pr-preview/pr-7/ , API https://sfd-api-pr-7.roboco.workers.dev/api/health (preview 워크플로가 배포를 마친 뒤 열린다)",
    );
  });

  it("returns a no-preview result, not a broken URL, when webUrl is empty or deployment is absent", () => {
    const empty = previewText({ ...settings, webUrl: "" }, 7, "T1", conveyor());
    expect(empty).toContain("프리뷰 없음");
    expect(empty).not.toContain("http");
    expect(previewText(settings, 7, "T1", other())).toContain("프리뷰 없음");
  });

  it("keeps the T2/T3 refusal text", () => {
    expect(previewText(settings, 7, "T3", conveyor())).toContain("프리뷰를 만들지 않는다");
  });
});

describe("PR report required checks text", () => {
  const base = (): PrReport => ({
    meta: { issue: 7, role: "implement", implementEngine: "claude", implementModel: "m", round: 0 },
    summary: "s",
    issueTitle: "t",
    acceptanceCriteria: [],
    checks: [],
    preview: "p",
    risks: [],
    risk: { tier: "T1", files: [] },
    run: { engine: "claude", model: "m", turns: 1, durationMs: 1000 },
  });

  it("test_required_checks_text_from_policy", () => {
    const body = renderPrBody({ ...base(), requiredChecks: ["unit", "lint"] });
    expect(body).toContain("필수 CI 체크(unit, lint)");
    expect(body).toContain(".factory/risk-policy.yml");
    expect(body).not.toContain("forum-api");
  });
});
