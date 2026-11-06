import type { TimedResult } from "../agents/budget";
import { scrubEnv } from "../agents/env";
import { renderDeploymentUrl, type ProjectConfig } from "../config/project";
import { runChecks, type ChecksOutcome } from "../exec/checks";
import { classifyFiles, type RiskResult, type Tier } from "../policy/risk";
import type { Settings, StageDeps } from "./deps";

export interface ChangeInspection {
  files: string[];
  risk: RiskResult;
  forbidden: string[];
}

export async function inspectChanges(
  deps: StageDeps,
  base = "origin/main",
): Promise<ChangeInspection> {
  const files = await deps.git.filesAgainst(base);
  const risk = classifyFiles(files, deps.policy);
  return { files, risk, forbidden: risk.files.filter((f) => f.tier === "T3").map((f) => f.file) };
}

// 검사 명령은 에이전트가 쓴 코드를 실행한다. 엔진 키와 토큰을 모두 지운 env로 돌린다.
export function checkWorkdir(deps: StageDeps): Promise<ChecksOutcome> {
  return runChecks(deps.spawn, deps.settings.workdir, scrubEnv(deps.settings.env));
}

export function commitType(labels: string[]): "feat" | "fix" | "docs" {
  if (labels.includes("type:bug")) return "fix";
  if (labels.includes("type:docs")) return "docs";
  return "feat";
}

export function previewText(
  settings: Settings,
  pr: number,
  tier: Tier,
  project: ProjectConfig,
): string {
  if (tier === "T2" || tier === "T3") {
    return "봇 PR이 T2 이상 경로를 바꿨으므로 프리뷰를 만들지 않는다(사람 승인 전에 에이전트 코드가 Cloudflare 토큰과 함께 실행되지 않게 하기 위해서다).";
  }
  // 배포 설정이나 웹 주소가 없으면 깨진 주소 대신 프리뷰가 없다고 알린다.
  const d = project.deployment;
  if (!d || settings.webUrl.trim() === "") {
    return "프리뷰 없음: 이 프로젝트에는 프리뷰 배포 주소(deployment, webUrl)가 설정되어 있지 않다.";
  }
  const vars = { workersSubdomain: settings.workersSubdomain, webUrl: settings.webUrl, pr };
  return `웹 ${renderDeploymentUrl(d.previewWeb, vars)} , API ${renderDeploymentUrl(d.previewApi, vars)}/api/health (preview 워크플로가 배포를 마친 뒤 열린다)`;
}

export function sumRuns(results: TimedResult[]): {
  turns: number;
  durationMs: number;
  costUsd?: number;
} {
  const turns = results.reduce((a, r) => a + r.turns, 0);
  const durationMs = results.reduce((a, r) => a + r.durationMs, 0);
  const costs = results.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
  return costs.length > 0
    ? { turns, durationMs, costUsd: costs.reduce((a, c) => a + c, 0) }
    : { turns, durationMs };
}
