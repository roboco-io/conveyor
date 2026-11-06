import "./factory.css";
import { mountAnalytics } from "../analytics/mount";
import { loadImprovements, loadRuns } from "./data";
import { liveIssues, parseEvents } from "./live";
import { loadingPanel, markStale, renderLivePanel } from "./liveView";
import { loadEvents, nextDelayMs, startPolling } from "./poll";
import { el, header, renderDashboard } from "./view";

let livePanel: HTMLElement = loadingPanel();

async function refreshLive(): Promise<number> {
  const now = new Date();
  try {
    const load = await loadEvents(now, fetch.bind(window));
    const next = renderLivePanel(liveIssues(parseEvents(load.text), now), load, now);
    livePanel.replaceWith(next);
    livePanel = next;
    return nextDelayMs(load);
  } catch (error) {
    markStale(livePanel);
    throw error;
  }
}

export async function loadDashboard(root: HTMLElement): Promise<void> {
  root.setAttribute("aria-busy", "true");
  const loading = el("p", "실행 기록을 불러오는 중입니다.", "loading");
  loading.setAttribute("role", "status");
  root.replaceChildren(header(), loading);
  const now = new Date();
  const refresh = () => {
    void loadDashboard(root);
  };
  try {
    const [runs, improvements] = await Promise.all([
      loadRuns(now, fetch.bind(window)),
      loadImprovements(fetch.bind(window)),
    ]);
    renderDashboard(root, runs, improvements, now, refresh, livePanel);
  } catch {
    const alert = el("div", undefined, "load-error");
    alert.setAttribute("role", "alert");
    alert.append(
      el("h2", "기록을 불러오지 못했습니다"),
      el(
        "p",
        "네트워크 연결이나 GitHub 응답을 확인한 뒤 다시 불러오세요. 데이터가 없는 상태와는 다릅니다.",
      ),
    );
    const retry = el("button", "다시 불러오기", "button primary");
    retry.type = "button";
    retry.addEventListener("click", refresh);
    alert.append(retry);
    root.replaceChildren(header(), alert);
  } finally {
    root.setAttribute("aria-busy", "false");
  }
}

const root = document.getElementById("factory");
if (root) {
  void loadDashboard(root);
  startPolling(refreshLive, document);
  mountAnalytics();
}
