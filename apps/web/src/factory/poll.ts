import { RAW, recentMonths } from "./data";

export type EventLoad = { source: "api" | "raw"; remaining: number | null; text: string };

const API = "https://api.github.com/repos/roboco-io/the-software-factory-demo/contents";
const LOW_REMAINING = 5;
const API_DELAY_MS = 60_000;
const RAW_DELAY_MS = 300_000;

// 읽기 한 번이 한 달 파일의 404를 만나면 그 달은 비어 있는 것으로 본다.
async function readRaw(now: Date, f: typeof fetch): Promise<string> {
  const parts: string[] = [];
  for (const month of recentMonths(now, 2)) {
    const res = await f(`${RAW}/events/${month}.jsonl`);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`events/${month}.jsonl: HTTP ${res.status}`);
    parts.push(await res.text());
  }
  return parts.join("\n");
}

export async function loadEvents(now: Date, f: typeof fetch): Promise<EventLoad> {
  const parts: string[] = [];
  let remaining: number | null = null;
  let useRaw = false;
  for (const month of recentMonths(now, 2)) {
    const res = await f(`${API}/events/${month}.jsonl?ref=factory-data`, {
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    if (res.status === 403) {
      useRaw = true;
      break;
    }
    const header = res.headers.get("X-RateLimit-Remaining");
    const n = header === null ? Number.NaN : Number(header);
    if (Number.isFinite(n)) remaining = remaining === null ? n : Math.min(remaining, n);
    if (res.status === 404) continue;
    if (!res.ok) throw new Error(`events/${month}.jsonl: HTTP ${res.status}`);
    parts.push(await res.text());
  }
  if (useRaw || (remaining !== null && remaining <= LOW_REMAINING)) {
    return { source: "raw", remaining: null, text: await readRaw(now, f) };
  }
  return { source: "api", remaining, text: parts.join("\n") };
}

export function nextDelayMs(load: EventLoad): number {
  return load.source === "api" ? API_DELAY_MS : RAW_DELAY_MS;
}

// run이 돌려준 시간(ms) 뒤에 다시 실행한다. 숨겨진 탭에서는 예약하지 않고, 실패하면 5분 뒤 다시 시도한다.
export function startPolling(run: () => Promise<number>, doc: Document): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let stopped = false;

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const schedule = (ms: number) => {
    clear();
    if (stopped || doc.visibilityState !== "visible") return;
    timer = setTimeout(tick, ms);
  };
  async function tick() {
    timer = undefined;
    if (stopped || running || doc.visibilityState !== "visible") return;
    running = true;
    let next = RAW_DELAY_MS;
    try {
      next = await run();
    } catch {
      next = RAW_DELAY_MS;
    } finally {
      running = false;
    }
    schedule(next);
  }
  const onVisibility = () => {
    if (doc.visibilityState === "visible") {
      clear();
      void tick();
    } else {
      clear();
    }
  };

  doc.addEventListener("visibilitychange", onVisibility);
  void tick();
  return () => {
    stopped = true;
    clear();
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
