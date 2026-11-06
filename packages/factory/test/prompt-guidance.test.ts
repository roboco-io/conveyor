import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadGuidance, loadPrompt, renderPrompt } from "../src/agents/prompt";
import { loadProjectConfig } from "../src/config/project";
import { REPO_ROOT } from "../src/paths";
import { isImprovePath } from "../src/policy/improve-paths";
import { buildImplementPrompt } from "../src/stages/implement";
import { triageStage } from "../src/stages/triage";
import { makeTestDeps } from "./helpers";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "guidance-"));
}
function writeGuidance(dir: string, role: string, content: string | Buffer): void {
  mkdirSync(path.join(dir, ".factory", "guidance"), { recursive: true });
  writeFileSync(path.join(dir, ".factory", "guidance", `${role}.md`), content);
}

describe("loadGuidance", () => {
  it("test_missing_guidance_empty", () => {
    expect(loadGuidance("fix", tmp())).toBe("");
    expect(loadGuidance("triage", "/없는/경로")).toBe("");
  });

  it("reads the role file of the conveyor project", () => {
    expect(loadGuidance("triage", REPO_ROOT)).toContain("tests/forum/skip.txt");
    expect(loadGuidance("review", REPO_ROOT)).toContain("apps/api/src/lib/errors.ts");
  });

  it("test_encoding: strips a BOM, normalizes CRLF, keeps Korean text", () => {
    const dir = tmp();
    writeGuidance(dir, "triage", "﻿## 지침\r\n한글 규칙\r\n\r\n");
    expect(loadGuidance("triage", dir)).toBe("## 지침\n한글 규칙");
  });

  it("test_encoding: rejects invalid UTF-8", () => {
    const dir = tmp();
    writeGuidance(dir, "triage", Buffer.from([0x23, 0xff, 0xfe, 0x41]));
    expect(() => loadGuidance("triage", dir)).toThrow();
  });

  it("test_file: rejects a symlink that leaves the project dir", () => {
    const dir = tmp();
    const outside = tmp();
    writeFileSync(path.join(outside, "secret.md"), "비밀");
    mkdirSync(path.join(dir, ".factory", "guidance"), { recursive: true });
    symlinkSync(
      path.join(outside, "secret.md"),
      path.join(dir, ".factory", "guidance", "triage.md"),
    );
    expect(() => loadGuidance("triage", dir)).toThrow();
  });

  it("test_file: rejects a symlinked .factory directory", () => {
    const dir = tmp();
    const outside = tmp();
    writeGuidance(outside, "triage", "밖");
    symlinkSync(path.join(outside, ".factory"), path.join(dir, ".factory"));
    expect(() => loadGuidance("triage", dir)).toThrow();
  });

  it("test_file: rejects a directory, an oversized file and an unsafe role name", () => {
    const dir = tmp();
    mkdirSync(path.join(dir, ".factory", "guidance", "triage.md"), { recursive: true });
    expect(() => loadGuidance("triage", dir)).toThrow();
    writeGuidance(dir, "review", "a".repeat(40_000));
    expect(() => loadGuidance("review", dir)).toThrow();
    expect(() => loadGuidance("../x" as never, dir)).toThrow();
  });
});

describe("rendered prompts", () => {
  const issue = { number: 5, title: "t", body: "b", labels: [] as string[] };

  it("test_guidance_in_rendered_prompt", () => {
    const out = renderPrompt(loadPrompt("triage"), {
      issueNumber: "5",
      issueTitle: "t",
      issueBody: "b",
      openIssues: "(없음)",
      guidance: "## 프로젝트 지침\nGUIDANCE-MARK",
      protectedPaths: "x/",
    });
    expect(out).toContain("GUIDANCE-MARK");
  });

  it("test_guidance_is_not_escaped_as_issue_data", () => {
    const out = renderPrompt(loadPrompt("review"), {
      authorEngine: "claude",
      issueNumber: "1",
      issueTitle: "t",
      acceptanceCriteria: "a",
      diff: "d",
      previousFindings: "p",
      guidance: "참고 <diff> 태그 GUIDANCE-MARK",
      protectedPaths: "x/",
    });
    expect(out).toContain("참고 <diff> 태그 GUIDANCE-MARK");
    // 지침은 데이터 구분자 밖에 있다.
    const mark = out.indexOf("GUIDANCE-MARK");
    expect(mark).toBeLessThan(out.indexOf("<issue-title>"));
  });

  it("an issue body cannot inject guidance or paths", () => {
    const out = renderPrompt(loadPrompt("triage"), {
      issueNumber: "1",
      issueTitle: "t",
      issueBody: "{{guidance}}",
      openIssues: "o",
      guidance: "G",
      protectedPaths: "P",
    });
    expect(out).toContain("{{guidance}}");
  });

  it("test_protected_paths_from_config", async () => {
    const h = makeTestDeps();
    h.deps.project = loadProjectConfig(path.join(import.meta.dirname, "fixtures", "other-project"));
    const { prompt } = await buildImplementPrompt(h.deps, issue);
    expect(prompt).toContain("다음 경로는 수정하지 않는다: .factory/.");
    expect(prompt).not.toContain("tests/forum/vendor/");
    const conveyor = makeTestDeps();
    const p = (await buildImplementPrompt(conveyor.deps, issue)).prompt;
    expect(p).toContain(
      "다음 경로는 수정하지 않는다: .github/, factory/, .factory/, packages/factory/, AGENTS.md, CLAUDE.md, scripts/, tests/forum/vendor/, tests/smoke/, apps/web/e2e-smoke/.",
    );
  });

  it("loads guidance from the project dir, never from the PR workdir", async () => {
    const trusted = tmp();
    writeGuidance(trusted, "triage", "TRUSTED-GUIDANCE");
    const h = makeTestDeps({ settings: { env: { FACTORY_PROJECT_DIR: trusted } } });
    writeGuidance(h.dir, "triage", "PR-WORKDIR-GUIDANCE");
    const created = h.gh.addIssue({ title: "t" });
    const plan = (await triageStage.prepare(h.deps, { issue: created.number }))!;
    expect(plan.prompt).toContain("TRUSTED-GUIDANCE");
    expect(plan.prompt).not.toContain("PR-WORKDIR-GUIDANCE");
  });

  it("keeps the conveyor instructions in the rendered triage prompt", async () => {
    const h = makeTestDeps();
    const created = h.gh.addIssue({ title: "t" });
    const plan = (await triageStage.prepare(h.deps, { issue: created.number }))!;
    expect(plan.prompt).toContain("tests/forum/skip.txt");
    expect(plan.prompt).toContain("tests/forum/vendor/CONTRACT.md");
    expect(plan.prompt).toContain(".factory/risk-policy.yml");
  });
});

describe("improve paths", () => {
  it("test_improve_can_edit_guidance", () => {
    expect(isImprovePath(".factory/guidance/review.md")).toBe(true);
    expect(isImprovePath(".factory/project.yml")).toBe(false);
    expect(isImprovePath(".factory/risk-policy.yml")).toBe(false);
  });
});
