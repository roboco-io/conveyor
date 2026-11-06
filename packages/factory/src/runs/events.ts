import { BranchNotFoundError, ConflictError, type GitHubPort } from "../github/port";
import { DATA_BRANCH, MAX_APPEND_ATTEMPTS } from "./store";

// factory-data 브랜치 events/YYYY-MM.jsonl의 한 줄. reason에는 고정 코드만 쓴다.
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

export function eventsPath(ts: string): string {
  return `events/${new Date(ts).toISOString().slice(0, 7)}.jsonl`;
}

// 이벤트 기록은 표시용이다. 어떤 실패도 호출자에게 던지지 않는다.
export async function appendEvent(gh: GitHubPort, event: FactoryEvent): Promise<void> {
  try {
    const file = eventsPath(event.ts);
    let created = false;
    for (let attempt = 1; ; attempt++) {
      const cur = await gh.readFile(DATA_BRANCH, file);
      const prev = cur?.content ?? "";
      const prefix = prev.length > 0 && !prev.endsWith("\n") ? `${prev}\n` : prev;
      try {
        await gh.writeFile(
          DATA_BRANCH,
          file,
          `${prefix}${JSON.stringify(event)}\n`,
          cur?.sha ?? null,
          `event: ${event.kind} #${event.issue}`,
        );
        return;
      } catch (e) {
        if (e instanceof BranchNotFoundError && !created) {
          created = true;
          await gh.createOrphanBranch(
            DATA_BRANCH,
            { "README.md": "factory run records\n" },
            "init factory-data",
          );
          attempt--;
          continue;
        }
        if (!(e instanceof ConflictError) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
      }
    }
  } catch {
    // 기록 실패는 상태 전환을 막지 않는다. 화면의 기록만 빠진다.
  }
}
