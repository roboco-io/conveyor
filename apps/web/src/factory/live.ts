export interface FactoryEvent {
  ts: string;
  issue: number;
  kind: "state" | "start" | "verify";
  title?: string;
  from?: string;
  to?: string;
  role?: string;
  reason?: string;
  runUrl?: string;
  verdict?: { met: number; unmet: number; unverifiable: number };
}

export interface LiveStage {
  name: string;
  startedAt: string;
  durationMs: number;
}

export interface LiveIssue {
  issue: number;
  title: string | null;
  state: string;
  needsHuman: boolean;
  delayed: boolean;
  running: string | null;
  rounds: number;
  stages: LiveStage[];
  latestAt: string;
  reason: string | null;
  runUrl: string | null;
  verdict: { met: number; unmet: number; unverifiable: number } | null;
}

// factory/agents.yml timeoutMin 값을 옮겨 적은 지연 기준(분).
const DELAY_MIN: Record<string, number> = {
  triage: 5,
  implement: 30,
  fix: 20,
  review: 15,
  verify: 10,
};
const KINDS = new Set(["state", "start", "verify"]);
const RUN_URL_PREFIX = "https://github.com/";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseEvent(raw: unknown): FactoryEvent | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const ts = str(o.ts);
  if (ts === undefined || Number.isNaN(Date.parse(ts))) return null;
  if (typeof o.issue !== "number" || !Number.isInteger(o.issue) || o.issue <= 0) return null;
  if (typeof o.kind !== "string" || !KINDS.has(o.kind)) return null;
  const e: FactoryEvent = { ts, issue: o.issue, kind: o.kind as FactoryEvent["kind"] };
  for (const k of ["title", "from", "to", "role", "reason"] as const) {
    const v = str(o[k]);
    if (v !== undefined) e[k] = v;
  }
  const url = str(o.runUrl);
  if (url !== undefined && url.startsWith(RUN_URL_PREFIX)) e.runUrl = url;
  const v = o.verdict as Record<string, unknown> | null | undefined;
  if (v && typeof v === "object" && count(v.met) && count(v.unmet) && count(v.unverifiable)) {
    e.verdict = { met: v.met, unmet: v.unmet, unverifiable: v.unverifiable };
  }
  return e;
}

export function parseEvents(text: string): FactoryEvent[] {
  const out: FactoryEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = parseEvent(JSON.parse(line));
      if (e) out.push(e);
    } catch {
      // 깨진 줄은 무시한다.
    }
  }
  return out;
}

function build(list: FactoryEvent[], now: Date): LiveIssue {
  const t = (e: FactoryEvent) => Date.parse(e.ts);
  let state = "";
  let lastStateTs = -Infinity;
  let rounds = 0;
  let title: string | null = null;
  let reason: string | null = null;
  let runUrl: string | null = null;
  let verdict: LiveIssue["verdict"] = null;
  const starts: FactoryEvent[] = [];
  for (const e of list) {
    if (e.title) title = e.title;
    if (e.kind === "state") {
      state = e.to ?? state;
      lastStateTs = t(e);
      reason = e.reason ?? null;
      if (e.from === "in-review" && e.to === "in-progress") rounds++;
    } else if (e.reason) reason = e.reason;
    if (e.runUrl) runUrl = e.runUrl;
    if (e.verdict) verdict = e.verdict;
    if (e.kind === "start" && e.role) starts.push(e);
  }
  const stages: LiveStage[] = starts.map((s) => {
    const next = list.find(
      (e) => t(e) > t(s) && (e.kind === "state" || (e.kind === "start" && e.role)),
    );
    const end = next ? t(next) : now.getTime();
    return { name: s.role as string, startedAt: s.ts, durationMs: Math.max(0, end - t(s)) };
  });
  const last = starts[starts.length - 1];
  const active = state !== "needs-human" && state !== "deployed";
  const running = last && active && t(last) >= lastStateTs ? (last.role as string) : null;
  const limit = running ? DELAY_MIN[running] : undefined;
  const delayed = limit !== undefined && now.getTime() - t(last) > limit * 60_000;
  return {
    issue: list[0].issue,
    title,
    state,
    needsHuman: state === "needs-human",
    delayed,
    running,
    rounds,
    stages,
    latestAt: list[list.length - 1].ts,
    reason,
    runUrl,
    verdict,
  };
}

function group(events: FactoryEvent[], now: Date): LiveIssue[] {
  const by = new Map<number, FactoryEvent[]>();
  const sorted = events
    .filter((e) => t(e) <= now.getTime())
    .map((e, i) => ({ e, i }))
    .sort((a, b) => t(a.e) - t(b.e) || a.i - b.i);
  for (const { e } of sorted) {
    const l = by.get(e.issue);
    if (l) l.push(e);
    else by.set(e.issue, [e]);
  }
  return [...by.values()].map((l) => build(l, now)).filter((i) => i.state !== "");
}

function t(e: FactoryEvent): number {
  return Date.parse(e.ts);
}

export function liveIssues(events: FactoryEvent[], now: Date): LiveIssue[] {
  return group(events, now)
    .filter((i) => i.state !== "deployed")
    .sort(
      (a, b) =>
        Number(b.needsHuman) - Number(a.needsHuman) ||
        Number(b.delayed) - Number(a.delayed) ||
        Date.parse(b.latestAt) - Date.parse(a.latestAt),
    );
}

export function recentDone(events: FactoryEvent[], now: Date, limit: number): LiveIssue[] {
  return group(events, now)
    .filter((i) => i.state === "deployed")
    .sort((a, b) => Date.parse(b.latestAt) - Date.parse(a.latestAt))
    .slice(0, Math.max(0, limit));
}
