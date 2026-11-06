import type { VerifyPlan } from "./verify-plan";

export type Verdict = "met-production" | "met-test" | "unmet" | "unverifiable";

export interface CriterionVerdict {
  index: number;
  verdict: Verdict;
  evidence: string;
}

export interface JudgeInput {
  plan: VerifyPlan;
  criteriaCount: number;
  apiOrigin: string;
  mergedFiles: string[];
  requiredChecksOk: boolean;
  readFile: (path: string) => Promise<string>;
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [30_000, 60_000];
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_BODY_BYTES = 1024 * 1024;
const ORIGIN_PATTERN = /^https:\/\/sfd-api\.[a-z0-9-]+\.workers\.dev$/;

type Criterion = VerifyPlan["criteria"][number];

const unverifiable = (index: number, evidence: string): CriterionVerdict => ({
  index,
  verdict: "unverifiable",
  evidence,
});

/** Returns the request URL only when the path is a safe /api/ path on the fixed origin. */
function safeUrl(path: string | undefined, apiOrigin: string): URL | null {
  if (!path || !ORIGIN_PATTERN.test(apiOrigin) || !path.startsWith("/api/")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f\\]/.test(path)) return null;
  const lower = path.toLowerCase();
  if (lower.includes("..") || lower.includes("%2e") || lower.includes("%5c")) return null;
  if (lower.includes("://") || lower.includes("%00")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decoded.includes("..") || decoded.includes("\\") || decoded.includes("://")) return null;
  let url: URL;
  try {
    url = new URL(path, apiOrigin);
  } catch {
    return null;
  }
  if (url.origin !== apiOrigin || !url.pathname.startsWith("/api/")) return null;
  return url;
}

function safeRepoPath(p: string | undefined): p is string {
  if (!p || p.startsWith("/") || p.includes("\\") || p.includes("\0")) return false;
  return !p.split("/").some((seg) => seg === ".." || seg === "." || seg === "");
}

/** Reads the body up to the cap. Returns null when the body is larger than the cap. */
async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function judgeProbe(c: Criterion, input: JudgeInput): Promise<CriterionVerdict> {
  const url = safeUrl(c.path, input.apiOrigin);
  if (!url || !c.path) return unverifiable(c.index, "확인 경로가 안전하지 않음");
  const label = `GET ${c.path}`;
  const expected = c.expectStatus ?? 200;
  // "unmet" only when the last attempt received a response that did not match.
  let lastMismatch: string | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await input.sleep(RETRY_DELAYS_MS[attempt - 1] ?? 60_000);
    lastMismatch = null;
    try {
      const response = await input.fetch(url.href, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status >= 300 && response.status < 400) {
        return unverifiable(c.index, `${label} -> 리다이렉트 ${response.status}`);
      }
      if (response.status !== expected) {
        lastMismatch = `${label} -> ${response.status}`;
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const text = await readCapped(response);
      if (text === null) return unverifiable(c.index, `${label} -> 본문이 1 MB 초과`);
      if (c.bodyIncludes && !text.includes(c.bodyIncludes)) {
        lastMismatch = `${label} -> ${response.status}, 기대한 본문 없음`;
        continue;
      }
      return { index: c.index, verdict: "met-production", evidence: `${label} -> ${response.status}` };
    } catch {
      // network, timeout or redirect error: no response was judged
    }
  }
  if (lastMismatch) return { index: c.index, verdict: "unmet", evidence: lastMismatch };
  return unverifiable(c.index, `${label} -> 응답을 받지 못함`);
}

async function judgeTest(c: Criterion, input: JudgeInput): Promise<CriterionVerdict> {
  if (!safeRepoPath(c.testFile) || !c.testName) {
    return unverifiable(c.index, "테스트 근거가 올바르지 않음");
  }
  if (!input.mergedFiles.includes(c.testFile)) {
    return unverifiable(c.index, `${c.testFile}: 병합된 파일이 아님`);
  }
  if (!input.requiredChecksOk) return unverifiable(c.index, "필수 체크가 통과하지 않음");
  let content: string;
  try {
    content = await input.readFile(c.testFile);
  } catch {
    return unverifiable(c.index, `${c.testFile}: 파일을 읽지 못함`);
  }
  if (!content.includes(c.testName)) {
    return unverifiable(c.index, `${c.testFile}: 테스트 이름 없음`);
  }
  return { index: c.index, verdict: "met-test", evidence: `${c.testFile}: ${c.testName}` };
}

export async function judgeCriteria(input: JudgeInput): Promise<CriterionVerdict[]> {
  const byIndex = new Map<number, Criterion>();
  for (const c of input.plan.criteria) {
    if (c.index >= 0 && c.index < input.criteriaCount && !byIndex.has(c.index)) {
      byIndex.set(c.index, c);
    }
  }
  const out: CriterionVerdict[] = [];
  for (let i = 0; i < input.criteriaCount; i++) {
    const c = byIndex.get(i);
    if (!c) out.push(unverifiable(i, "계획에 확인 방법 없음"));
    else if (c.method === "probe") out.push(await judgeProbe(c, input));
    else if (c.method === "test") out.push(await judgeTest(c, input));
    else out.push(unverifiable(i, "확인 방법 없음"));
  }
  return out;
}
