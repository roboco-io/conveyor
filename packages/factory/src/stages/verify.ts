import { z } from "zod";
import { runStructured, type TimedResult } from "../agents/budget";
import { loadPrompt, renderPrompt } from "../agents/prompt";
import type { Budget, EngineName } from "../agents/types";
import { assignEngines, resolveModel } from "../config/agents";
import { renderDeploymentUrl } from "../config/project";
import { findTriage } from "../report/comments";
import { parsePrMeta } from "../report/pr";
import { cell } from "../report/text";
import { appendEvent } from "../runs/events";
import {
  TimedResultSchema,
  agentRecord,
  crashRecord,
  failureText,
  moveTo,
  readState,
  record,
  runLink,
  stepRecord,
} from "./common";
import type { StageDeps } from "./deps";
import { finishVerified } from "./deploy";
import { flattenFiles, summarizeChecks } from "./gate";
import type { PhasedStage } from "./phased";
import { judgeCriteria, type CriterionVerdict, type Verdict } from "./verify-judge";
import { VerifyPlanSchema, type VerifyPlan } from "./verify-plan";

const MAX_CRITERIA = 50;
const SHA_PATTERN = /^[0-9a-f]{7,40}$/;

// 프로덕션 확인에 쓰는 네트워크 입구. 테스트가 바꿔 끼운다.
export const verifyIo = {
  fetch: ((input: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch,
  sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

export interface VerifyRunPlan {
  issue: number;
  sha: string;
  engine: EngineName;
  model: string;
  budget: Budget;
  prompt: string;
  criteria: string[];
  mergedFiles: string[];
  requiredChecksOk: boolean;
  apiOrigin: string;
}

export interface VerifyOutcome {
  result: TimedResult;
  plan: VerifyPlan | null;
}

const OutcomeSchema = z.object({ result: TimedResultSchema, plan: VerifyPlanSchema.nullable() });

// 프로덕션 API 주소는 신뢰하는 프로젝트 설정에서만 렌더링한다. 배포 설정이 없으면 null이다.
function apiOriginFor(deps: StageDeps): string | null {
  const d = deps.project.deployment;
  return d
    ? renderDeploymentUrl(d.apiOrigin, { workersSubdomain: deps.settings.workersSubdomain })
    : null;
}

const tableMarker = (sha: string): string => `<!-- factory:verdict-table sha=${sha} -->`;
const VERDICT_TEXT: Record<Verdict, string> = {
  "met-production": "충족(프로덕션)",
  "met-test": "충족(테스트로 확인)",
  unmet: "미충족",
  unverifiable: "확인 불가",
};

// 마커는 봇이 쓴 코멘트만 인정한다. 사람이나 이슈 본문이 위조한 마커로 검증을 건너뛰지 못하게 한다.
function botBodies(comments: { author: string; body: string }[], bot: string): string[] {
  return comments.filter((c) => c.author === bot).map((c) => c.body);
}
const hasTable = (bodies: string[], sha: string): boolean =>
  bodies.some((b) => b.includes(tableMarker(sha)));

function describeMethod(c: VerifyPlan["criteria"][number] | undefined): string {
  if (!c) return "없음";
  if (c.method === "probe") {
    const parts = [`GET ${c.path}`, `기대 ${c.expectStatus ?? 200}`];
    if (c.bodyIncludes) parts.push(`본문에 "${c.bodyIncludes}"`);
    return parts.join(", ");
  }
  if (c.method === "test") return `테스트 ${c.testFile}: ${c.testName}`;
  return `없음: ${c.reason}`;
}

export function renderVerdictTable(
  sha: string,
  criteria: string[],
  plan: VerifyPlan,
  verdicts: CriterionVerdict[],
): string {
  const byIndex = new Map<number, VerifyPlan["criteria"][number]>();
  for (const c of plan.criteria) if (!byIndex.has(c.index)) byIndex.set(c.index, c);
  const rows = verdicts.map(
    (v) =>
      `| ${v.index + 1} | ${cell(criteria[v.index] ?? "")} | ${cell(describeMethod(byIndex.get(v.index)))} | ${VERDICT_TEXT[v.verdict]} | ${cell(v.evidence)} |`,
  );
  return [
    `### 수용 기준 확인 결과 (커밋 \`${sha.slice(0, 7)}\`)`,
    "",
    "| # | 수용 기준 | 확인 방법 | 판정 | 근거 |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "<sub>확인 방법은 에이전트가 제안하고, 판정은 프로그램이 한다. 미충족은 프로덕션 확인이 실패한 경우에만 나온다.</sub>",
    tableMarker(sha),
  ].join("\n");
}

function count(verdicts: CriterionVerdict[]): { met: number; unmet: number; unverifiable: number } {
  return {
    met: verdicts.filter((v) => v.verdict === "met-production" || v.verdict === "met-test").length,
    unmet: verdicts.filter((v) => v.verdict === "unmet").length,
    unverifiable: verdicts.filter((v) => v.verdict === "unverifiable").length,
  };
}

// 이미 실행 기록을 남긴 계획. publish 도중 예외가 나도 crashed()가 같은 런을 다시 세지 않게 한다.
const RECORDED = new WeakSet<VerifyRunPlan>();

async function recordOnce(deps: StageDeps, plan: VerifyRunPlan, out: VerifyOutcome): Promise<void> {
  if (RECORDED.has(plan)) return;
  RECORDED.add(plan);
  const result: TimedResult =
    out.result.ok && out.plan === null
      ? { ...out.result, ok: false, failureReason: "invalid_output" }
      : out.result;
  await record(deps, agentRecord("verify", plan.engine, plan.model, result, plan.issue, null, 0));
}

async function event(
  deps: StageDeps,
  issue: number,
  title: string,
  extra: { reason?: string; verdict?: { met: number; unmet: number; unverifiable: number } },
): Promise<void> {
  await appendEvent(deps.gh, {
    ts: deps.now().toISOString(),
    issue,
    kind: "verify",
    title,
    ...extra,
    ...(deps.settings.runUrl ? { runUrl: deps.settings.runUrl } : {}),
  });
}

// 에이전트가 확인 방법을 내지 못했을 때. shadow는 닫고, enforce는 사람에게 넘긴다.
async function handleFailure(
  deps: StageDeps,
  plan: { issue: number; sha: string },
  why: string,
): Promise<void> {
  const { issue: info } = await readState(deps.gh, plan.issue);
  await deps.gh.comment(
    plan.issue,
    [
      `수용 기준 확인 에이전트가 확인 방법을 내지 못했다(${why}). 판정하지 않았다.${runLink(deps.settings)}`,
      tableMarker(plan.sha),
    ].join("\n"),
  );
  await event(deps, plan.issue, info.title, { reason: "verify_failed" });
  if (deps.settings.verifyMode === "enforce") {
    const moved = await moveTo(
      deps,
      plan.issue,
      "needs-human",
      "verify",
      `수용 기준을 확인하지 못했다. 사람이 확인한 뒤 수용하려면 \`@factory accept\`를 남긴다.${runLink(deps.settings)}`,
    );
    if (!moved) return;
    await deps.gh.addLabels(plan.issue, ["source:verify"]);
    await record(deps, stepRecord("deploy", plan.issue, null, false, "verify_failed"));
    return;
  }
  await finishVerified(deps, plan.issue, plan.sha);
}

export const verifyStage: PhasedStage<
  { issue: number; sha: string },
  VerifyRunPlan,
  VerifyOutcome
> = {
  name: "verify",
  async prepare(deps, { issue, sha }) {
    if (!SHA_PATTERN.test(sha)) return null;
    const { issue: info, state } = await readState(deps.gh, issue);
    if (info.isPullRequest || info.state !== "open" || state !== "verifying") return null;
    const comments = await deps.gh.listComments(issue);
    const bodies = botBodies(comments, deps.settings.botLogin);
    // deploy 단계가 남긴 마커가 있는 sha만 확인한다. 이미 판정한 sha도 다시 확인하지 않는다.
    if (!bodies.some((b) => b.includes(`<!-- factory:verifying sha=${sha} ts=`))) return null;
    if (hasTable(bodies, sha)) return null;
    const criteria = (findTriage(comments, deps.settings.botLogin)?.acceptanceCriteria ?? []).slice(
      0,
      MAX_CRITERIA,
    );
    if (criteria.length === 0) {
      await deps.gh.comment(
        issue,
        [
          `트리아지 수용 기준이 없어 확인할 기준 없음으로 닫는다(커밋 \`${sha.slice(0, 7)}\`).${runLink(deps.settings)}`,
          tableMarker(sha),
        ].join("\n"),
      );
      await event(deps, issue, info.title, { verdict: { met: 0, unmet: 0, unverifiable: 0 } });
      await finishVerified(deps, issue, sha);
      return null;
    }
    // 병합 PR은 커밋 제목 끝의 (#N)로 찾는다. 이 이슈의 PR이 아니면 변경 파일과 체크를 인정하지 않는다.
    let mergedFiles: string[] = [];
    let requiredChecksOk = false;
    try {
      const subject = (await deps.gh.getCommitMessage(sha)).split("\n")[0] ?? "";
      const prNumber = Number(/\(#(\d+)\)\s*$/.exec(subject)?.[1]);
      if (Number.isInteger(prNumber) && prNumber > 0) {
        const pull = await deps.gh.getPull(prNumber);
        if (parsePrMeta(pull.body)?.issue === issue) {
          mergedFiles = flattenFiles(await deps.gh.listPullFiles(prNumber));
          const runs = await deps.gh.listCheckRuns(pull.headSha);
          requiredChecksOk = summarizeChecks(runs, deps.policy.requiredChecks).state === "pass";
        }
      }
    } catch (e) {
      deps.log(`verify: could not read the merged PR for #${issue}: ${String(e)}`);
    }
    const role = assignEngines(deps.agents, info.labels).verify;
    const model = resolveModel(deps.agents, role.engine, deps.settings.env);
    const prompt = renderPrompt(loadPrompt("verify"), {
      issueNumber: String(issue),
      issueTitle: info.title,
      acceptanceCriteria: criteria.map((c, i) => `${i}. ${c}`).join("\n"),
      changedFiles: mergedFiles.length > 0 ? mergedFiles.map((f) => `- ${f}`).join("\n") : "(없음)",
    });
    return {
      issue,
      sha,
      engine: role.engine,
      model,
      budget: role.budget,
      prompt,
      criteria,
      mergedFiles,
      requiredChecksOk,
      apiOrigin: apiOriginFor(deps) ?? "",
    };
  },

  async agent(deps, plan) {
    const { result, value } = await runStructured(
      deps.adapterFor(plan.engine, plan.model),
      {
        role: "verify",
        prompt: plan.prompt,
        cwd: deps.settings.workdir,
        readOnly: true,
        budget: plan.budget,
      },
      VerifyPlanSchema,
    );
    return { result, plan: value };
  },

  parseOutcome(raw) {
    return OutcomeSchema.parse(raw) as VerifyOutcome;
  },

  async publish(deps, plan, out) {
    await recordOnce(deps, plan, out);
    const { issue: info, state } = await readState(deps.gh, plan.issue);
    if (state !== "verifying") {
      deps.log(`verify: #${plan.issue} is ${state}; skipping publish`);
      return;
    }
    const bodies = botBodies(await deps.gh.listComments(plan.issue), deps.settings.botLogin);
    if (hasTable(bodies, plan.sha)) {
      deps.log(`verify: #${plan.issue} already has a verdict for ${plan.sha}`);
      return;
    }
    if (!out.result.ok || out.plan === null) {
      await handleFailure(deps, plan, failureText(out.result.failureReason ?? "invalid_output"));
      return;
    }
    const verdicts = await judgeCriteria({
      plan: out.plan,
      criteriaCount: plan.criteria.length,
      apiOrigin: plan.apiOrigin,
      expectedApiOrigin: apiOriginFor(deps),
      mergedFiles: plan.mergedFiles,
      requiredChecksOk: plan.requiredChecksOk,
      readFile: async (p) => {
        const file = await deps.gh.readFile(plan.sha, p);
        if (!file) throw new Error(`${p} not found`);
        return file.content;
      },
      fetch: verifyIo.fetch,
      sleep: verifyIo.sleep,
    });
    const verdict = count(verdicts);
    await deps.gh.comment(
      plan.issue,
      renderVerdictTable(plan.sha, plan.criteria, out.plan, verdicts),
    );
    await event(deps, plan.issue, info.title, {
      verdict,
      ...(verdict.unmet > 0 ? { reason: "verify_unmet" } : {}),
    });
    if (verdict.unmet > 0 && deps.settings.verifyMode === "enforce") {
      const moved = await moveTo(
        deps,
        plan.issue,
        "needs-human",
        "verify",
        `수용 기준 ${verdict.unmet}개가 프로덕션에서 충족되지 않았다. 판정표를 확인한다. 문제가 없다고 판단하면 \`@factory accept\`를 남긴다.${runLink(deps.settings)}`,
      );
      if (!moved) return;
      await deps.gh.addLabels(plan.issue, ["source:verify"]);
      await record(deps, stepRecord("deploy", plan.issue, null, false, "verify_unmet"));
      return;
    }
    await finishVerified(deps, plan.issue, plan.sha);
  },

  async crashed(deps, plan) {
    if (!RECORDED.has(plan)) {
      RECORDED.add(plan);
      await record(deps, crashRecord("verify", plan));
    }
    const { state } = await readState(deps.gh, plan.issue);
    if (state !== "verifying") return;
    const bodies = botBodies(await deps.gh.listComments(plan.issue), deps.settings.botLogin);
    if (hasTable(bodies, plan.sha)) return;
    await handleFailure(deps, plan, "비정상 종료");
  },
};
