import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGuidance, projectPromptVars, renderPrompt } from "../src/agents/prompt";
import { loadProjectConfig } from "../src/config/project";
import { planSuites } from "../src/policy/evidence";
import { classifyFiles, loadRiskPolicy } from "../src/policy/risk";
import { FACTORY_DIR, REPO_ROOT } from "../src/paths";

const OTHER = path.join(__dirname, "fixtures", "other-project");

// 런타임(src)과 공통 프롬프트에 남으면 안 되는 conveyor 고유 값.
const BANNED = [
  "apps/",
  "tests/forum",
  "sfd-api",
  "sfd-prod",
  "conveyor",
  "roboco-io",
  "the-software-factory-demo",
  "forum-api",
  "skip.txt",
];

// 예외는 "상대 경로|값" 키마다 근거를 적는다. 근거 없는 예외는 허용하지 않는다.
const ALLOWED: Record<string, string> = {
  "packages/factory/src/stages/deps.ts|roboco-io":
    "GITHUB_REPOSITORY가 없을 때 쓰는 저장소 기본값이다. 1단계는 동작 불변이라 유지하고, 2단계에서 설정으로 옮긴다.",
  "packages/factory/src/stages/deps.ts|the-software-factory-demo":
    "위 저장소 기본값의 repo 이름이다. 같은 이유로 유지한다.",
  "packages/factory/src/policy/risk.ts|tests/forum": "주석의 예시 경로다. 실행 동작에 쓰지 않는다.",
  "packages/factory/src/policy/risk.ts|skip.txt": "위와 같은 주석이다.",
  "packages/factory/src/report/metrics.ts|apps/":
    "대시보드 복사본 위치를 가리키는 주석이다. 실행 동작에 쓰지 않는다.",
  "packages/factory/src/stages/risk.ts|skip.txt":
    "F21 방어 설명 주석이다. 실제 경로는 project.paths.skipFiles에서 온다.",
  "packages/factory/src/stages/gate.ts|skip.txt": "위와 같은 설명 주석이다.",
  "packages/factory/src/stages/fix.ts|forum-api":
    "수정 에이전트에게 주는 지시 문장 안의 conveyor 계약 스위트 스크립트 이름이다. 실행 동작이 아닌 안내 문구이며, 설정으로 옮길지는 조정자 판단이 필요하다.",
};

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

describe("no-project-literals", () => {
  it("keeps conveyor values out of the runtime and common prompts unless allowed with a reason", () => {
    const files = [
      ...walk(path.join(REPO_ROOT, "packages/factory/src")),
      ...walk(path.join(FACTORY_DIR, "prompts")),
    ];
    const found = new Set<string>();
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join("/");
      const text = readFileSync(file, "utf8");
      for (const term of BANNED) if (text.includes(term)) found.add(`${rel}|${term}`);
    }
    expect([...found].filter((k) => !(k in ALLOWED)).sort()).toEqual([]);
    // 사라진 리터럴의 예외가 남아 있으면 허용 목록이 낡은 것이다.
    expect(
      Object.keys(ALLOWED)
        .filter((k) => !found.has(k))
        .sort(),
    ).toEqual([]);
    for (const [key, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, key).toBeGreaterThan(10);
    }
  });

  it("works end to end for another project without conveyor values", () => {
    const project = loadProjectConfig(OTHER);
    const policy = loadRiskPolicy(path.join(OTHER, ".factory", "risk-policy.yml"));

    expect(classifyFiles([".factory/project.yml"], policy).tier).toBe("T3");
    expect(classifyFiles(["README.md"], policy).tier).toBe("T0");
    expect(classifyFiles(["src/a.ts"], policy).tier).toBe("T1");

    const plan = planSuites(["src/a.test.ts"], project.evidence);
    expect(plan.runs.map((r) => r.suite)).toEqual(["app"]);
    expect(plan.unsupported).toEqual([]);

    expect(loadGuidance("triage", OTHER)).toBe("");
    const vars = projectPromptVars("implement", project, OTHER);
    const rendered = renderPrompt("지침:{{guidance}}\n보호:{{protectedPaths}}", vars);
    expect(rendered).toContain(".factory/");
    for (const term of ["apps/", "tests/forum", "conveyor", "sfd-api"]) {
      expect(rendered).not.toContain(term);
    }
  });
});
