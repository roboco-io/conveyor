import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectConfig, renderDeploymentUrl } from "../src/config/project";
import { buildDeps } from "../src/main";
import { loadSettings } from "../src/stages/deps";
import { PACKAGE_ROOT, REPO_ROOT, projectDir } from "../src/paths";
import { loadRiskPolicy, tierOf } from "../src/policy/risk";

const OTHER = path.join(PACKAGE_ROOT, "test/fixtures/other-project");
const VALID = readFileSync(path.join(OTHER, ".factory/project.yml"), "utf8");

function projectWith(yml: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "proj-"));
  mkdirSync(path.join(dir, ".factory"));
  writeFileSync(path.join(dir, ".factory/project.yml"), yml);
  return dir;
}

describe("loadProjectConfig", () => {
  it("loads the non-conveyor fixture", () => {
    expect(loadProjectConfig(OTHER)).toEqual({
      name: "other",
      paths: {
        skipFiles: [],
        smokePaths: ["smoke/"],
        migrationsDir: null,
        protected: [".factory/"],
      },
      evidence: {
        suites: [{ suite: "app", filter: "app", dir: "src/" }],
        e2eDir: null,
        testFilePatterns: ["src/**/*.test.ts"],
      },
    });
  });

  it("loads the conveyor config", () => {
    const c = loadProjectConfig(REPO_ROOT);
    expect(c.name).toBe("conveyor");
    expect(c.paths.migrationsDir).toBe("apps/api/migrations/");
    expect(c.evidence.suites.map((s) => s.suite)).toEqual(["api", "web", "factory"]);
    expect(c.deployment?.webUrl).toBe("https://roboco.io/the-software-factory-demo/");
  });

  it("test_rejects_unknown_key", () => {
    expect(() => loadProjectConfig(projectWith(`${VALID}\nsurprise: 1\n`))).toThrow();
    expect(() => loadProjectConfig(projectWith(VALID.replace("skipFiles", "skipfiles")))).toThrow();
    expect(() =>
      loadProjectConfig(projectWith(VALID.replace("{ suite: app,", "{ extra: 1, suite: app,"))),
    ).toThrow();
  });

  it("rejects a missing directory, malformed yaml and missing fields", () => {
    expect(() => loadProjectConfig("/없는/경로")).toThrow();
    expect(() => loadProjectConfig(projectWith("name: [unclosed"))).toThrow();
    expect(() => loadProjectConfig(projectWith("name: x\n"))).toThrow();
  });

  it("rejects paths that escape the repository", () => {
    expect(() => loadProjectConfig(projectWith(VALID.replace("[smoke/]", "[../x]")))).toThrow();
    expect(() => loadProjectConfig(projectWith(VALID.replace("[smoke/]", "[/etc]")))).toThrow();
  });
});

describe("renderDeploymentUrl", () => {
  it("fills known variables", () => {
    expect(
      renderDeploymentUrl("https://sfd-api-pr-{pr}.{workersSubdomain}.workers.dev", {
        workersSubdomain: "roboco",
        pr: 7,
      }),
    ).toBe("https://sfd-api-pr-7.roboco.workers.dev");
    expect(
      renderDeploymentUrl("{webUrl}pr-preview/pr-{pr}/", { webUrl: "https://a.b/", pr: 3 }),
    ).toBe("https://a.b/pr-preview/pr-3/");
  });

  it("test_unknown_template_var_throws", () => {
    expect(() => renderDeploymentUrl("https://{nope}.x", { workersSubdomain: "a" })).toThrow();
    expect(() => renderDeploymentUrl("https://{workersSubdomain}.x", {})).toThrow();
  });

  it("test_pr_must_be_positive_integer", () => {
    for (const pr of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => renderDeploymentUrl("pr-{pr}", { pr })).toThrow();
    }
    expect(() => renderDeploymentUrl("pr-{pr}", {})).toThrow();
  });

  it("rejects a workers subdomain that could change the host", () => {
    expect(() =>
      renderDeploymentUrl("https://a.{workersSubdomain}.workers.dev", {
        workersSubdomain: "evil.com/x",
      }),
    ).toThrow();
  });
});

describe("projectDir", () => {
  it("uses FACTORY_PROJECT_DIR, defaulting to the repository root", () => {
    expect(projectDir({ FACTORY_PROJECT_DIR: "/x" })).toBe("/x");
    expect(projectDir({})).toBe(REPO_ROOT);
    expect(projectDir({ FACTORY_PROJECT_DIR: "" })).toBe(REPO_ROOT);
  });
});

describe("buildDeps project config", () => {
  it("test_rejects_workdir_as_project_dir", () => {
    const work = mkdtempSync(path.join(tmpdir(), "work-"));
    expect(() => buildDeps({ FACTORY_WORKDIR: work, FACTORY_PROJECT_DIR: work }, "agent")).toThrow(
      /FACTORY_WORKDIR/,
    );
    const inner = path.join(work, "sub");
    mkdirSync(path.join(inner, ".factory"), { recursive: true });
    writeFileSync(path.join(inner, ".factory/project.yml"), VALID);
    expect(() => buildDeps({ FACTORY_WORKDIR: work, FACTORY_PROJECT_DIR: inner }, "agent")).toThrow(
      /FACTORY_WORKDIR/,
    );
    expect(() =>
      buildDeps(
        { FACTORY_WORKDIR: work, FACTORY_PROJECT_DIR: path.join(inner, "..", "sub") },
        "agent",
      ),
    ).toThrow(/FACTORY_WORKDIR/);
  });

  it("accepts FACTORY_WORKDIR equal to REPO_ROOT (trusted runtime checkout), also via symlink", () => {
    expect(buildDeps({ FACTORY_WORKDIR: REPO_ROOT }, "agent").project.name).toBe("conveyor");
    const link = path.join(mkdtempSync(path.join(tmpdir(), "lnk-")), "runtime");
    symlinkSync(REPO_ROOT, link);
    expect(buildDeps({ FACTORY_WORKDIR: link }, "agent").project.name).toBe("conveyor");
    expect(
      buildDeps({ FACTORY_WORKDIR: REPO_ROOT, FACTORY_PROJECT_DIR: link }, "agent").project.name,
    ).toBe("conveyor");
  });

  it("rejects a project dir that reaches FACTORY_WORKDIR through a symlink", () => {
    const work = mkdtempSync(path.join(tmpdir(), "work-"));
    mkdirSync(path.join(work, ".factory"));
    writeFileSync(path.join(work, ".factory/project.yml"), VALID);
    const link = path.join(mkdtempSync(path.join(tmpdir(), "lnk-")), "p");
    symlinkSync(work, link);
    expect(() => buildDeps({ FACTORY_WORKDIR: work, FACTORY_PROJECT_DIR: link }, "agent")).toThrow(
      /FACTORY_WORKDIR/,
    );
    const linkedWork = path.join(mkdtempSync(path.join(tmpdir(), "lnk-")), "w");
    symlinkSync(work, linkedWork);
    expect(() =>
      buildDeps({ FACTORY_WORKDIR: linkedWork, FACTORY_PROJECT_DIR: work }, "agent"),
    ).toThrow(/FACTORY_WORKDIR/);
  });

  it("still rejects an explicit project dir under a non-runtime workdir even when it is REPO_ROOT-like", () => {
    const work = mkdtempSync(path.join(tmpdir(), "work-"));
    expect(() =>
      buildDeps({ FACTORY_WORKDIR: work, FACTORY_PROJECT_DIR: work }, "agent"),
    ).toThrow();
  });

  it("does not fall back to the conveyor web URL", () => {
    expect(loadSettings({}).webUrl).toBe("");
    expect(buildDeps({ FACTORY_PROJECT_DIR: OTHER }, "agent").settings.webUrl).toBe("");
  });

  it("test_agent_phase_loads_config", () => {
    const deps = buildDeps({ FACTORY_PROJECT_DIR: OTHER }, "agent");
    expect(deps.settings.token).toBeNull();
    expect(deps.project.name).toBe("other");
    expect(deps.policy.requiredChecks).toEqual(["unit"]);
  });

  it("uses the config webUrl unless WEB_URL is set", () => {
    expect(buildDeps({}, "agent").settings.webUrl).toBe(
      "https://roboco.io/the-software-factory-demo/",
    );
    expect(buildDeps({ WEB_URL: "https://w.example/" }, "agent").settings.webUrl).toBe(
      "https://w.example/",
    );
  });

  it("fails on a broken project config instead of using defaults", () => {
    expect(() => buildDeps({ FACTORY_PROJECT_DIR: "/없는/경로" }, "agent")).toThrow();
  });
});

describe("policy", () => {
  it("test_policy_t3_includes_dot_factory", () => {
    const policy = loadRiskPolicy();
    for (const f of [".factory/project.yml", ".factory/guidance/triage.md", ".FACTORY/x"]) {
      expect(tierOf(f, policy).tier, f).toBe("T3");
    }
  });
});
