import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { classify, compareTrackedSources, escalationPayloadHash, ESCALATION_PAYLOAD_PATHS, HARD_CRITICAL_PATHS, WATCHED_PATHS, missingCurrentGates, PLAN_DEFER_EVIDENCE, resolvePromptDiscovery } from "./check-omp-compat.mjs";

const config = Bun.YAML.parse(readFileSync("config/agent/config.yml", "utf8"));
const record = Bun.YAML.parse(readFileSync("config/agent/omp-compatibility.yml", "utf8"));
const managedAgentDir = "config/agent";
const managedAppend = readFileSync(join(managedAgentDir, "APPEND_SYSTEM.md"), "utf8");
const managedHash = createHash("sha256").update(managedAppend).digest("hex");
const payloadRoot = mkdtempSync(join(tmpdir(), "omp-compat-payload-"));
const copiedAgentDir = join(payloadRoot, "agent");
try {
  for (const relativePath of ESCALATION_PAYLOAD_PATHS) {
    const target = join(copiedAgentDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(managedAgentDir, relativePath)));
  }
  const payloadSha256 = escalationPayloadHash(copiedAgentDir);
  assert.match(payloadSha256, /^[0-9a-f]{64}$/);
  assert.equal(payloadSha256, escalationPayloadHash(copiedAgentDir), "unchanged payload copies reproduce the fingerprint");
  const verifiedRecord = structuredClone(record);
  verifiedRecord.source_reviewed.omp_version = "18.8.9";
  verifiedRecord.current_assessment = {
    omp_version: "18.8.9",
    revision: verifiedRecord.source_reviewed.revision,
    date: "2026-10-18",
    mode: "known-patched",
    status: "VERIFIED",
    evidence: "fixture",
    payload_sha256: payloadSha256,
    gates: Object.fromEntries(["director_luna_sol_core", "targeted_messaging_uri", "fresh_init_final_input_registration_model_role", "approval_reviewer_authority", "option_b_security_review", "independent_acceptance", "plan_boundary"].map(gate => [gate, "PASS"])),
  };
  const good = (patch = {}) => classify({ version: "18.8.9", record: verifiedRecord, config, payloadSha256, promptMode: "known-patched", ...patch });
  assert.deepEqual(missingCurrentGates(verifiedRecord.current_assessment), []);
  assert.equal(good().status, "VERIFIED", "all current gates and current assessment pass");
  for (const gate of Object.keys(verifiedRecord.current_assessment.gates)) {
    const incomplete = structuredClone(verifiedRecord);
    incomplete.current_assessment.gates[gate] = "NOT VERIFIED";
    assert.equal(classify({ version: "18.8.9", record: incomplete, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED", `${gate} is mandatory`);
  }
  const deferredPlan = structuredClone(verifiedRecord);
  deferredPlan.current_assessment.gates.plan_boundary = "DEFERRED_UNAVAILABLE";
  deferredPlan.current_assessment.plan_defer_evidence = PLAN_DEFER_EVIDENCE;
  assert.deepEqual(missingCurrentGates(deferredPlan.current_assessment), [], "only the explicitly documented Plan deferral can be excluded");
  const deferredPlanResult = classify({ version: "18.8.9", record: deferredPlan, config, payloadSha256, promptMode: "known-patched" });
  assert.equal(deferredPlanResult.status, "VERIFIED");
  assert.match(deferredPlanResult.reason, /Plan boundary excluded and untested/);
  const noPlanEvidence = structuredClone(deferredPlan);
  delete noPlanEvidence.current_assessment.plan_defer_evidence;
  assert.equal(classify({ version: "18.8.9", record: noPlanEvidence, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED");
  const wrongPlanEvidence = structuredClone(deferredPlan);
  wrongPlanEvidence.current_assessment.plan_defer_evidence = "docs/verification.md#unrelated";
  assert.equal(classify({ version: "18.8.9", record: wrongPlanEvidence, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED");
  const partialPlan = structuredClone(verifiedRecord);
  partialPlan.current_assessment.gates.plan_boundary = "PARTIAL";
  partialPlan.current_assessment.plan_defer_evidence = PLAN_DEFER_EVIDENCE;
  assert.equal(classify({ version: "18.8.9", record: partialPlan, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED", "PARTIAL is not an authorized deferral");
  const deferredOtherGate = structuredClone(deferredPlan);
  deferredOtherGate.current_assessment.gates.option_b_security_review = "DEFERRED_UNAVAILABLE";
  assert.equal(classify({ version: "18.8.9", record: deferredOtherGate, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED");
  assert.equal(classify({ version: "18.10.3", record: verifiedRecord, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED", "assessment cannot cross versions");
  assert.equal(classify({ version: "unknown", record: verifiedRecord, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED");
  assert.equal(classify({ version: "18.8.9", record: { ...verifiedRecord, last_verified: null }, config, payloadSha256, promptMode: "known-patched" }).status, "VERIFIED", "historical receipt is not an active Sol-verification dependency");
  for (const [field, value] of [["status", "NOT VERIFIED"], ["date", undefined], ["mode", undefined]]) {
    const incomplete = structuredClone(verifiedRecord);
    if (value === undefined) delete incomplete.current_assessment[field];
    else incomplete.current_assessment[field] = value;
    assert.equal(classify({ version: "18.8.9", record: incomplete, config, payloadSha256, promptMode: "known-patched" }).status, "NOT VERIFIED", `current assessment ${field} is required`);
  }
  assert.equal(good({ hardCriticalChanges: [HARD_CRITICAL_PATHS[0]] }).status, "REVIEW REQUIRED");
  const watched = good({ watchedChanges: [WATCHED_PATHS[0]] });
  assert.equal(watched.status, "REVIEW REQUIRED");
  assert.match(watched.reason, /no implied routing-architecture invalidation/);
  assert.equal(good({ promptMode: "unknown" }).status, "REVIEW REQUIRED");
  assert.equal(good({ payloadSha256: "0".repeat(64) }).status, "NOT VERIFIED");
  const structured = structuredClone(config);
  structured.task.structured = true;
  assert.equal(good({ config: structured }).status, "REVIEW REQUIRED", "structured mode requires session-specific strict-schema evidence");
  const malformedStructured = structuredClone(config);
  malformedStructured.task.structured = "false";
  assert.equal(good({ config: malformedStructured }).status, "INCOMPATIBLE", "non-boolean structured setting is rejected");

  const changedAgentDir = join(payloadRoot, "changed");
  for (const relativePath of ESCALATION_PAYLOAD_PATHS) {
    const target = join(changedAgentDir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(join(managedAgentDir, relativePath)));
  }
  writeFileSync(join(changedAgentDir, "agents/slow.md"), `${readFileSync(join(changedAgentDir, "agents/slow.md"), "utf8")}\\n`);
  const changedHash = escalationPayloadHash(changedAgentDir);
  assert.notEqual(changedHash, payloadSha256, "relevant role bytes change the aggregate payload fingerprint");
  assert.equal(good({ payloadSha256: changedHash }).status, "NOT VERIFIED", "stale receipt rejected after a real payload byte change");
  rmSync(join(changedAgentDir, "agents/slow.md"));
  assert.throws(() => escalationPayloadHash(changedAgentDir), /ENOENT/, "missing required payload input fails explicitly");
} finally {
  rmSync(payloadRoot, { recursive: true, force: true });
}
const root = mkdtempSync(join(tmpdir(), "omp-prompt-discovery-"));
try {
  const cwd = join(root, "work");
  const agentDir = join(root, "home", ".omp", "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  const globalPath = join(agentDir, "APPEND_SYSTEM.md");
  writeFileSync(globalPath, managedAppend);
  const global = resolvePromptDiscovery({ cwd, agentDir, home: join(root, "home"), enabledProviders: [], disabledProviders: [], env: {}, appendHash: managedHash });
  assert.equal(global.mode, "known-patched", "global Candidate C append is effective and recognized");
  assert.equal(global.effectiveAppend, globalPath);

  mkdirSync(join(cwd, ".omp"), { recursive: true });
  const projectAppend = join(cwd, ".omp", "APPEND_SYSTEM.md");
  writeFileSync(projectAppend, "project append");
  const shadowed = resolvePromptDiscovery({ cwd, agentDir, home: join(root, "home"), enabledProviders: [], disabledProviders: [], env: {}, appendHash: managedHash });
  assert.equal(shadowed.mode, "unknown", "project append shadows the managed global clarification");
  assert.equal(shadowed.effectiveAppend, projectAppend);
  assert.match(shadowed.reason, /project-level/);
  rmSync(projectAppend);

  for (const name of ["SYSTEM.md", "SYSTEM_TEMPLATE.md"]) {
    const override = join(cwd, ".omp", name);
    writeFileSync(override, "native prompt override");
    const result = resolvePromptDiscovery({ cwd, agentDir, home: join(root, "home"), enabledProviders: [], disabledProviders: [], env: {}, appendHash: managedHash });
    assert.equal(result.mode, "incompatible", `${name} overrides stock native prompt`);
    assert.ok(result.overrides.includes(override));
    rmSync(override);
  }

  const claudeAppend = join(root, "home", ".claude", "APPEND_SYSTEM.md");
  mkdirSync(join(root, "home", ".claude"), { recursive: true });
  writeFileSync(claudeAppend, "foreign user append");
  rmSync(globalPath);
  const enabledClaude = resolvePromptDiscovery({ cwd, agentDir, home: join(root, "home"), enabledProviders: ["claude"], disabledProviders: [], env: {}, appendHash: managedHash });
  assert.equal(enabledClaude.effectiveAppend, claudeAppend, "enabled foreign user providers participate in native discovery");
  const disabledClaude = resolvePromptDiscovery({ cwd, agentDir, home: join(root, "home"), enabledProviders: ["claude"], disabledProviders: ["claude"], env: {}, appendHash: managedHash });
  assert.equal(disabledClaude.mode, "native-compatible", "disabled foreign providers are excluded from user discovery");

  writeFileSync(globalPath, "unknown append");
  const unknownHash = resolvePromptDiscovery({ cwd, agentDir, home: join(root, "home"), enabledProviders: [], disabledProviders: [], env: {}, appendHash: managedHash });
  assert.equal(unknownHash.mode, "unknown", "unrecognized append hash never passes");
} finally {
  rmSync(root, { recursive: true, force: true });
}

const sameCalls = [];
const unchanged = await compareTrackedSources("base", "candidate", [HARD_CRITICAL_PATHS[0]], async url => {
  sameCalls.push(url);
  return new Response("same exact upstream source");
});
assert.deepEqual(unchanged, { hardCriticalChanges: [], watchedChanges: [] });
assert.equal(sameCalls.length, 2, "exact tracked file comparison fetches only baseline/candidate file content");
assert.ok(sameCalls.every(url => url.includes("raw.githubusercontent.com") && !url.includes("/compare/")), "GitHub compare endpoint and its changed-file truncation are not required");

const changedHard = await compareTrackedSources("base", "candidate", [HARD_CRITICAL_PATHS[0]], async url => new Response(url.includes("/base/") ? "old" : "new"));
assert.deepEqual(changedHard.hardCriticalChanges, [HARD_CRITICAL_PATHS[0]]);
const changedWatched = await compareTrackedSources("base", "candidate", [WATCHED_PATHS[0]], async url => new Response(url.includes("/base/") ? "old" : "new"));
assert.deepEqual(changedWatched.watchedChanges, [WATCHED_PATHS[0]]);

console.log("OMP compatibility tests passed: exact prompt precedence/hash detection; config and receipt drift; source-level hard/watched classification; targeted raw-source comparison without GitHub compare API/truncation.");
