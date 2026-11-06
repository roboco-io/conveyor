import { createAdapter } from "./agents/registry";
import { realpathSync } from "node:fs";
import path from "node:path";
import { loadAgentsConfig } from "./config/agents";
import { loadProjectConfig } from "./config/project";
import { REPO_ROOT, projectDir } from "./paths";
import { runProcess } from "./exec/process";
import { createGit } from "./git/port";
import { forbiddenGitHub } from "./github/forbidden";
import { createOctokitPort } from "./github/octokit";
import { loadPostmortemPolicy } from "./policy/postmortem";
import { loadRiskPolicy } from "./policy/risk";
import { createRunStore } from "./runs/store";
import { loadSettings, type StageDeps } from "./stages/deps";
import type { Phase } from "./stages/phased";

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** PR 코드가 있는 FACTORY_WORKDIR 안(또는 그 자체)에서는 프로젝트 설정을 읽지 않는다. */
function assertProjectDirTrusted(env: NodeJS.ProcessEnv, project: string): void {
  if (!env.FACTORY_WORKDIR) return;
  const work = real(env.FACTORY_WORKDIR);
  // 워크플로(triage, verify)는 FACTORY_WORKDIR를 신뢰할 수 있는 runtime 체크아웃(= REPO_ROOT)으로 둔다.
  // 코드와 설정이 같은 신뢰 수준이므로 통과시킨다.
  if (work === real(REPO_ROOT)) return;
  const rel = path.relative(work, real(project));
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
    throw new Error(
      "FACTORY_PROJECT_DIR는 FACTORY_WORKDIR 안에 있을 수 없다(PR 코드가 설정을 바꿀 수 있다)",
    );
}

export function buildDeps(env: NodeJS.ProcessEnv, phase: Phase): StageDeps {
  if (phase === "agent") {
    // agent 단계 프로세스에는 GitHub 토큰이 있으면 안 된다(워크플로 설정 오류를 막는다).
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "FACTORY_TOKEN", "ACTIONS_RUNTIME_TOKEN"]) {
      if (env[key] || process.env[key]) throw new Error(`agent 단계에 ${key}가 있다`);
    }
  }
  const projectRoot = projectDir(env);
  assertProjectDirTrusted(env, projectRoot);
  const project = loadProjectConfig(projectRoot);
  const loaded = loadSettings(env);
  const webUrl = env.WEB_URL || project.deployment?.webUrl || "";
  const settings = phase === "agent" ? { ...loaded, webUrl, token: null } : { ...loaded, webUrl };
  const agents = loadAgentsConfig();
  const gh =
    phase === "agent"
      ? forbiddenGitHub("agent 단계에는 GitHub 토큰이 없다")
      : settings.token
        ? createOctokitPort({
            token: settings.token,
            owner: settings.owner,
            repo: settings.repo,
            excludeRunId: settings.runId,
          })
        : forbiddenGitHub("FACTORY_TOKEN 또는 GITHUB_TOKEN이 없다");
  return {
    gh,
    runs: createRunStore(gh),
    git: createGit(settings.workdir, { name: settings.botLogin, email: settings.botEmail }),
    spawn: runProcess,
    adapterFor: (engine, model) => createAdapter(engine, model, agents, env),
    agents,
    policy: loadRiskPolicy(path.join(projectRoot, ".factory", "risk-policy.yml")),
    project,
    postmortem: loadPostmortemPolicy(),
    settings,
    now: () => new Date(),
    log: (msg) => console.error(msg),
  };
}
