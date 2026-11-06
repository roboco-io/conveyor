import { describe, expect, it } from "vitest";
import {
  VERIFYING_MARKER,
  finishVerified,
  runDeployFailed,
  runDeployed,
} from "../src/stages/deploy";
import { makeTestDeps } from "./helpers";

describe("deploy result", () => {
  it("moves merged issues from Factory-Issue trailers to verifying and dispatches verify without closing", async () => {
    const h = makeTestDeps();
    const merged = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    const other = h.gh.addIssue({ title: "b", labels: ["factory:in-review"] });
    h.gh.commitMessages.set(
      "abc1234",
      `feat: a (#9)\n\nFactory-Issue: #${merged.number}\nFactory-Issue: #${other.number}`,
    );
    expect(await runDeployed(h.deps, { sha: "abc1234" })).toEqual([merged.number]);
    const after = await h.gh.getIssue(merged.number);
    expect(after.labels).toEqual(["factory:verifying"]);
    expect(after.state).toBe("open");
    expect((await h.gh.getIssue(other.number)).labels).toEqual(["factory:in-review"]);
    expect(h.gh.dispatches).toEqual([
      {
        file: "factory-verify.yml",
        inputs: { issue: String(merged.number), sha: "abc1234" },
      },
    ]);
    const comments = (await h.gh.listComments(merged.number)).map((c) => c.body);
    expect(
      comments.some((b) => b.includes(VERIFYING_MARKER("abc1234", h.deps.now().toISOString()))),
    ).toBe(true);
  });

  it("does not dispatch verify again when the same sha marker exists", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${i.number}`);
    await runDeployed(h.deps, { sha: "abc1234" });
    await runDeployed(h.deps, { sha: "abc1234" });
    expect(h.gh.dispatches.filter((d) => d.file === "factory-verify.yml")).toHaveLength(1);
    const markers = (await h.gh.listComments(i.number)).filter((c) =>
      c.body.includes("factory:verifying sha=abc1234"),
    );
    expect(markers).toHaveLength(1);
    expect((await h.gh.getIssue(i.number)).labels).toEqual(["factory:verifying"]);
  });

  it("ignores a same-sha marker written by a user", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:verifying"] });
    h.gh.addComment(i.number, "mallory", VERIFYING_MARKER("abc1234", "2026-10-12T00:00:00.000Z"));
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${i.number}`);
    await runDeployed(h.deps, { sha: "abc1234" });
    expect(h.gh.dispatches).toHaveLength(1);
  });

  it.each([
    ["shadow", ["factory:deployed"], "closed"],
    ["enforce", ["factory:needs-human", "source:verify"], "open"],
  ] as const)("cleans up in %s mode when the verify dispatch fails", async (mode, labels, st) => {
    const h = makeTestDeps({ settings: { verifyMode: mode } });
    const i = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${i.number}`);
    h.gh.dispatchWorkflow = async () => {
      throw new Error("boom");
    };
    await runDeployed(h.deps, { sha: "abc1234" });
    const after = await h.gh.getIssue(i.number);
    expect([...after.labels].sort()).toEqual([...labels].sort());
    expect(after.state).toBe(st);
  });

  it("re-dispatches a verifying issue whose marker is for another sha", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:verifying"] });
    await h.gh.comment(i.number, VERIFYING_MARKER("old", "2026-10-12T00:00:00.000Z"));
    h.gh.commitMessages.set("new1234", `x\n\nFactory-Issue: #${i.number}`);
    await runDeployed(h.deps, { sha: "new1234" });
    expect(h.gh.dispatches).toHaveLength(1);
  });

  it("also deploys still-merged issues from earlier main commits whose deploy run was superseded", async () => {
    const h = makeTestDeps();
    const skipped = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    const old = h.gh.addIssue({ title: "b", labels: ["factory:deployed"] });
    const newer = h.gh.addIssue({ title: "c", labels: ["factory:merged"] });
    const head = h.gh.addIssue({ title: "d", labels: ["factory:merged"] });
    // main history, newest first: newer(after the deployed sha), head(deployed), skipped, old
    const commit = (sha: string, issue: number, date: string) => {
      h.gh.commitMessages.set(sha, `x\n\nFactory-Issue: #${issue}`);
      h.gh.commits.push({ sha, message: `x\n\nFactory-Issue: #${issue}`, date });
    };
    commit("s4", newer.number, "2026-10-12T02:00:00Z");
    commit("s3", head.number, "2026-10-12T01:00:00Z");
    commit("s2", skipped.number, "2026-10-12T00:59:00Z");
    commit("s1", old.number, "2026-10-11T00:00:00Z");

    expect(await runDeployed(h.deps, { sha: "s3" })).toEqual([head.number, skipped.number]);
    expect((await h.gh.getIssue(skipped.number)).labels).toEqual(["factory:verifying"]);
    expect((await h.gh.getIssue(skipped.number)).state).toBe("open");
    expect(h.gh.dispatches.map((d) => d.inputs.sha)).toEqual(["s3", "s3"]);
    // a commit after the deployed sha is not part of this deploy
    expect((await h.gh.getIssue(newer.number)).labels).toEqual(["factory:merged"]);
  });

  it("falls back to the deployed commit only when it is not in recent main history", async () => {
    const h = makeTestDeps();
    const a = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    const b = h.gh.addIssue({ title: "b", labels: ["factory:merged"] });
    h.gh.commitMessages.set("zz", `x\n\nFactory-Issue: #${a.number}`);
    h.gh.commits.push({
      sha: "s1",
      message: `x\n\nFactory-Issue: #${b.number}`,
      date: "2026-10-11T00:00:00Z",
    });
    expect(await runDeployed(h.deps, { sha: "zz" })).toEqual([a.number]);
    expect((await h.gh.getIssue(b.number)).labels).toEqual(["factory:merged"]);
  });

  it("closes an issue that a crashed run left deployed but open", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:deployed"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${i.number}`);
    await runDeployed(h.deps, { sha: "abc1234" });
    expect((await h.gh.getIssue(i.number)).state).toBe("closed");
    await runDeployed(h.deps, { sha: "abc1234" });
    expect((await h.gh.getIssue(i.number)).labels).toEqual(["factory:deployed"]);
  });

  it("returns merged issues to a human with source:deploy when deploy or smoke failed", async () => {
    const h = makeTestDeps();
    const merged = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${merged.number}`);
    expect(await runDeployFailed(h.deps, { sha: "abc1234" })).toEqual([merged.number]);
    const after = await h.gh.getIssue(merged.number);
    expect(after.labels.sort()).toEqual(["factory:needs-human", "source:deploy"]);
    expect((await h.gh.listComments(merged.number))[0]?.body).toContain("롤백");
  });
});

describe("finishVerified", () => {
  it("moves verifying to deployed, closes the issue and returns true", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:verifying"] });
    expect(await finishVerified(h.deps, i.number, "abc1234")).toBe(true);
    const after = await h.gh.getIssue(i.number);
    expect(after.labels).toEqual(["factory:deployed"]);
    expect(after.state).toBe("closed");
    expect((await h.deps.runs.since(new Date(0)))[0]).toMatchObject({ role: "deploy", ok: true });
  });

  it("returns false and changes nothing when the issue is not verifying", async () => {
    const h = makeTestDeps();
    const i = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    expect(await finishVerified(h.deps, i.number, "abc1234")).toBe(false);
    const after = await h.gh.getIssue(i.number);
    expect(after.labels).toEqual(["factory:merged"]);
    expect(after.state).toBe("open");
  });
});

describe("VERIFYING_MARKER", () => {
  it("renders sha and ts", () => {
    expect(VERIFYING_MARKER("abc", "2026-11-06T00:00:00.000Z")).toBe(
      "<!-- factory:verifying sha=abc ts=2026-11-06T00:00:00.000Z -->",
    );
  });
});

describe("revert deploy", () => {
  it("comments on the incident, dispatches one full smoke and leaves the incident open", async () => {
    const h = makeTestDeps();
    const incident = h.gh.addIssue({ title: "스모크 실패", labels: ["factory:needs-human"] });
    h.gh.commitMessages.set(
      "rev1234",
      `Revert "feat: x" (#9)\n\nFactory-Revert: #${incident.number}`,
    );
    expect(await runDeployed(h.deps, { sha: "rev1234" })).toEqual([]);
    expect(h.gh.dispatches).toEqual([{ file: "factory-smoke.yml", inputs: {} }]);
    const after = await h.gh.getIssue(incident.number);
    expect(after.state).toBe("open");
    expect(after.labels).toEqual(["factory:needs-human"]);
    expect((await h.gh.listComments(incident.number)).map((c) => c.body)).toEqual([
      expect.stringContaining("되돌리기"),
    ]);
  });

  it("comments and dispatches the smoke once when the same deploy runs again", async () => {
    const h = makeTestDeps();
    const incident = h.gh.addIssue({ title: "스모크 실패" });
    h.gh.commitMessages.set("rev1234", `Revert "x" (#9)\n\nFactory-Revert: #${incident.number}`);
    await runDeployed(h.deps, { sha: "rev1234" });
    await runDeployed(h.deps, { sha: "rev1234" });
    expect(h.gh.dispatches).toHaveLength(1);
    expect(await h.gh.listComments(incident.number)).toHaveLength(1);
  });

  it("does not dispatch a smoke for an ordinary deploy", async () => {
    const h = makeTestDeps();
    const issue = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    h.gh.commitMessages.set("abc1234", `x\n\nFactory-Issue: #${issue.number}`);
    await runDeployed(h.deps, { sha: "abc1234" });
    expect(h.gh.dispatches.map((d) => d.file)).toEqual(["factory-verify.yml"]);
  });
});

describe("deploy failure postmortem trigger", () => {
  it("requests a deploy postmortem for each moved issue", async () => {
    const h = makeTestDeps();
    const a = h.gh.addIssue({ title: "a", labels: ["factory:merged"] });
    h.gh.commitMessages.set("abc1234", `feat: a (#9)\n\nFactory-Issue: #${a.number}`);
    await runDeployFailed(h.deps, { sha: "abc1234" });
    expect(h.gh.dispatches.filter((d) => d.inputs.kind === "deploy")).toEqual([
      {
        file: "factory-postmortem.yml",
        inputs: { issue: String(a.number), kind: "deploy", event: "detected" },
      },
    ]);
  });
});
