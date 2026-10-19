#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const REPOSITORY = "can1357/oh-my-pi";
const API = `https://api.github.com/repos/${REPOSITORY}`;
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const sourceRecordPath = resolve(repoRoot, "config/agent/omp-compatibility.yml");
const installedRecordPath = resolve(scriptDir, "../omp-compatibility.yml");
const sourceMode = existsSync(sourceRecordPath);
const recordPath = sourceMode ? sourceRecordPath : installedRecordPath;
const agentDir = sourceMode ? resolve(repoRoot, "config/agent") : resolve(scriptDir, "..");
const configPath = resolve(agentDir, "config.yml");

export const HARD_CRITICAL_PATHS = [
  "packages/coding-agent/src/main.ts",
  "packages/coding-agent/src/system-prompt.ts",
  "packages/coding-agent/src/capability/system-prompt.ts",
  "packages/coding-agent/src/config.ts",
  "packages/coding-agent/src/config/model-resolver.ts",
  "packages/coding-agent/src/config/model-settings.ts",
  "packages/coding-agent/src/session/settings.ts",
  "packages/coding-agent/src/task/settings.ts",
  "packages/coding-agent/src/task/index.ts",
  "packages/coding-agent/src/task/structured-subagent.ts",
  "packages/coding-agent/src/task/executor.ts",
  "packages/coding-agent/src/task/spawn-policy.ts",
  "packages/coding-agent/src/sdk.ts",
  "packages/coding-agent/src/modes/rpc/rpc-subagents.ts",
  "packages/coding-agent/src/modes/rpc/rpc-types.ts",
  "packages/coding-agent/src/modes/rpc/rpc-mode.ts",
  "packages/coding-agent/src/tools/output-schema-validator.ts",
  "packages/coding-agent/src/tools/yield.ts",
  "packages/coding-agent/src/plan-mode/settings.ts",
  "packages/coding-agent/src/plan-mode/plan-handoff.ts",
  "packages/coding-agent/src/prompts/system/system-prompt.md",
  "packages/coding-agent/src/prompts/system/project-prompt.md",
];

export const WATCHED_PATHS = [
  "packages/coding-agent/src/extensibility/extensions/types.ts",
  "packages/coding-agent/src/extensibility/extensions/runner.ts",
  "packages/coding-agent/src/config/registry.ts",
  "packages/coding-agent/src/config/config-file.ts",
  "packages/coding-agent/src/tools/approval.ts",
  "packages/coding-agent/src/tools/bash.ts",
  "packages/coding-agent/src/capability/skill.ts",
  "packages/coding-agent/src/extensibility/skills.ts",
];

const ALL_PATHS = [...HARD_CRITICAL_PATHS, ...WATCHED_PATHS];

export function parseArgs(args) {
  const parsed = { candidate: undefined, inspectMain: false };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--candidate" && args[index + 1]) parsed.candidate = args[++index];
    else if (args[index] === "--inspect-main") parsed.inspectMain = true;
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  if (parsed.candidate && parsed.candidate !== "latest" && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(parsed.candidate)) throw new Error("--candidate must be an OMP version such as 18.8.7, or latest");
  return parsed;
}

function validateConfig(config) {
  const roles = config?.modelRoles;
  const expected = {
    default: "openai-codex/gpt-6.1-sol:medium", plan: "openai-codex/gpt-6.1-sol:medium",
    smol: "openai-codex/gpt-6-luna:medium", routine: "openai-codex/gpt-6-luna:medium",
    task: "openai-codex/gpt-6-luna:medium", executor: "openai-codex/gpt-6.1-sol:medium",
    slow: "openai-codex/gpt-6.1-sol:medium", advisor: "openai-codex/gpt-6.1-sol:high",
  };
  for (const [role, selector] of Object.entries(expected)) {
    if (roles?.[role] !== selector) throw new Error(`required model role ${role} is ${String(roles?.[role])}, expected ${selector}`);
  }
  if (config?.task?.structured !== undefined && typeof config.task.structured !== "boolean") throw new Error("task.structured must be boolean when configured");
  if (config?.advisor?.enabled !== false) throw new Error("global advisor must be disabled");
  if (config?.task?.eager !== "default") throw new Error("task.eager must remain default to preserve zero-worker behavior");
  if (config?.task?.maxConcurrency !== 3 || config?.task?.maxRecursionDepth !== 1) throw new Error("task concurrency/depth differs from the required Candidate C bounds");
  if (config?.prewalk?.enabled !== false || config?.task?.prewalk !== false) throw new Error("prewalk must remain disabled");
  if (config?.retry?.modelFallback !== false || config?.retry?.usageAwareFallback !== false || Object.keys(config?.retry?.fallbackChains ?? {}).length !== 0) throw new Error("model fallback must remain disabled");
  const overrides = { scout: "@smol", routine: "@routine", task: "@task", reviewer: "@task", "security-reviewer": "@task", slow: "@slow", "sol-executor": "@executor", advisor: "@advisor" };
  for (const [name, selector] of Object.entries(overrides)) if (config?.task?.agentModelOverrides?.[name] !== selector) throw new Error(`agent model override ${name} differs from ${selector}`);
  if (config?.task?.agentAdvisor?.advisor !== "off") throw new Error("advisor agent must remain disabled");
}

function validateRecord(record) {
  if (record?.schema !== 1 || record.project !== "omp-docflow") throw new Error("unsupported OMP compatibility record");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.source_reviewed?.omp_version ?? "")) throw new Error("source_reviewed.omp_version is missing or invalid");
  if (!/^[0-9a-f]{40}$/i.test(record.source_reviewed?.revision ?? "")) throw new Error("source_reviewed.revision must be a full Git commit");
  if (!/^[0-9a-f]{64}$/i.test(record.consultation_append_sha256 ?? "")) throw new Error("consultation_append_sha256 must fingerprint the managed APPEND_SYSTEM.md text");
  const capabilities = ["model-roles", "agent-model-overrides", "task-dispatch", "plan-mode", "prompt-customization", "tool-call-extension"];
  if (!capabilities.every(capability => record.required_capabilities?.includes(capability))) throw new Error("required_capabilities omits a Candidate C dependency");
  const behavior = ["sol-director", "sol-executor", "plan-mode-sol-director"];
  if (!behavior.every(invariant => record.critical_behavior?.includes(invariant))) throw new Error("critical_behavior omits a managed Sol-director invariant");
  const expectedRoles = { default: "sol-medium", plan: "sol-medium", slow: "sol-medium", executor: "sol-medium", advisor: "sol-high" };
  for (const [role, value] of Object.entries(expectedRoles)) if (record.candidate_c?.[role] !== value) throw new Error(`compatibility record Candidate C ${role} must be ${value}`);
}
const REQUIRED_CURRENT_GATES = ["director_luna_sol_core", "targeted_messaging_uri", "fresh_init_final_input_registration_model_role", "approval_reviewer_authority", "option_b_security_review", "independent_acceptance", "plan_boundary"];
export const PLAN_DEFER_EVIDENCE = "docs/verification.md#plan-boundary-user-deferral--2026-10-18";
export function missingCurrentGates(assessment) {
  const planDeferred = assessment?.gates?.plan_boundary === "DEFERRED_UNAVAILABLE" &&
    assessment?.plan_defer_evidence === PLAN_DEFER_EVIDENCE;
  return REQUIRED_CURRENT_GATES.filter(gate => gate === "plan_boundary" && planDeferred ? false : assessment?.gates?.[gate] !== "PASS");
}

export const ESCALATION_PAYLOAD_PATHS = [
  "AGENTS.md",
  "APPEND_SYSTEM.md",
  "PERSONALITY.md",
  "agents/advisor.md",
  "agents/reviewer.md",
  "agents/routine.md",
  "agents/scout.md",
  "agents/security-reviewer.md",
  "agents/slow.md",
  "agents/sol-executor.md",
  "agents/task.md",
  "config.yml",
  "extensions/luna-tool-boundary.js",
  "skills/docs-engineering/references/security.md",
].sort();


export function escalationPayloadHash(agentDir) {
  const entries = ESCALATION_PAYLOAD_PATHS.map(relativePath => {
    const bytes = readFileSync(join(agentDir, relativePath));
    return [relativePath, createHash("sha256").update(bytes).digest("hex")];
  });
  return createHash("sha256").update(JSON.stringify(entries), "utf8").digest("hex");
}

export function classify({ version, record, config, payloadSha256, hardCriticalChanges = [], watchedChanges = [], promptMode = "unknown" }) {
  try { validateRecord(record); validateConfig(config); }
  catch (error) { return { status: "INCOMPATIBLE", mode: "unknown", reason: error.message, hardCriticalChanges, watchedChanges }; }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) return { status: "NOT VERIFIED", mode: promptMode, reason: "OMP version is unknown or not a released semantic version", hardCriticalChanges, watchedChanges };
  if (config?.task?.structured === true) return { status: "REVIEW REQUIRED", mode: promptMode, reason: "structured task results require session-specific strict-schema verification", hardCriticalChanges, watchedChanges };
  if (hardCriticalChanges.length) return { status: "REVIEW REQUIRED", mode: promptMode, reason: "a hard-critical OMP contract changed; review or runtime evidence is required for those surfaces", hardCriticalChanges, watchedChanges };
  if (watchedChanges.length) return { status: "REVIEW REQUIRED", mode: promptMode, reason: "only watched OMP surfaces changed; run focused checks for those surfaces, with no implied routing-architecture invalidation", hardCriticalChanges, watchedChanges };
  if (promptMode === "unknown" || promptMode === "incompatible") return { status: "REVIEW REQUIRED", mode: promptMode, reason: "the effective prompt does not establish the managed Candidate C append and native prompt", hardCriticalChanges, watchedChanges };
  const assessment = record.current_assessment;
  const planDeferred = assessment?.gates?.plan_boundary === "DEFERRED_UNAVAILABLE" &&
    assessment?.plan_defer_evidence === PLAN_DEFER_EVIDENCE;
  const missingGates = missingCurrentGates(assessment);
  if (version !== record.source_reviewed.omp_version || assessment?.omp_version !== version || assessment?.revision !== record.source_reviewed.revision || assessment?.status !== "VERIFIED" || !/^\d{4}-\d{2}-\d{2}$/.test(assessment?.date ?? "") || assessment?.mode !== promptMode || !assessment?.evidence || missingGates.length) {
    const reason = missingGates.length
      ? `current candidate assessment is missing gates: ${missingGates.join(", ")}${planDeferred ? "; Plan boundary explicitly excluded and untested by user disposition" : ""}`
      : "no complete current candidate assessment matches this OMP source, version and prompt mode";
    return { status: "NOT VERIFIED", mode: promptMode, reason, hardCriticalChanges, watchedChanges };
  }
  if (!/^[0-9a-f]{64}$/.test(payloadSha256 ?? "") || assessment.payload_sha256 !== payloadSha256) return { status: "NOT VERIFIED", mode: promptMode, reason: `current assessment does not match the complete escalation payload fingerprint${planDeferred ? "; Plan boundary remains excluded and untested" : ""}`, hardCriticalChanges, watchedChanges };
  return { status: "VERIFIED", mode: promptMode, reason: planDeferred ? "verified with user-authorized Plan boundary excluded and untested; this is not full Plan support" : "current candidate assessment, required safeguards, source and payload match", hardCriticalChanges, watchedChanges };
}

export function resolvePromptDiscovery({ cwd, agentDir, home = homedir(), enabledProviders = [], disabledProviders = [], env = process.env, exists = existsSync, readText = path => readFileSync(path, "utf8"), appendHash, nativeUserConfigDir }) {
  const foreignEnabled = new Set((Array.isArray(enabledProviders) ? enabledProviders : []).map(value => String(value).toLowerCase()));
  if (env.CLAUDE_CONFIG_DIR) foreignEnabled.add("claude");
  for (const provider of Array.isArray(disabledProviders) ? disabledProviders : []) foreignEnabled.delete(String(provider).toLowerCase());
  const nativeConfigName = ".omp";
  const nativeUserDir = nativeUserConfigDir ?? agentDir;
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const projectBases = [nativeConfigName, ".claude", ".codex", ".gemini"].map(name => ({ name, path: resolve(cwd, name) }));
  const userBases = [{ name: nativeConfigName, path: nativeUserDir }];
  if (foreignEnabled.has("claude")) userBases.push({ name: ".claude", path: resolve(cwd, claudeDir || join(home, ".claude")) });
  if (foreignEnabled.has("codex")) userBases.push({ name: ".codex", path: resolve(home, ".codex") });
  if (foreignEnabled.has("gemini")) userBases.push({ name: ".gemini", path: resolve(home, ".gemini") });
  const findIn = (bases, filename) => bases.map(base => join(base.path, filename)).find(exists);
  const projectAppend = findIn(projectBases, "APPEND_SYSTEM.md");
  const userAppend = findIn(userBases, "APPEND_SYSTEM.md");
  const effectiveAppend = projectAppend ?? userAppend;
  const overrideNames = ["SYSTEM.md", "SYSTEM_TEMPLATE.md"];
  const projectOverrideBases = [];
  let ancestor = resolve(cwd);
  while (true) {
    for (const name of [nativeConfigName, ".agent", ".agents"]) projectOverrideBases.push({ name, path: join(ancestor, name) });
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  for (const base of projectBases.filter(item => item.name !== nativeConfigName)) projectOverrideBases.unshift(base);
  const projectOverrides = projectOverrideBases.flatMap(base => overrideNames.filter(filename => exists(join(base.path, filename))).map(filename => join(base.path, filename)));
  const userOverrideDirs = [...new Set(userBases.map(base => base.path))];
  const userOverrides = userOverrideDirs.flatMap(base => overrideNames.filter(filename => exists(join(base, filename))).map(filename => join(base, filename)));
  const overrides = [...projectOverrides, ...userOverrides];
  const managedAppendPath = join(nativeUserDir, "APPEND_SYSTEM.md");
  const isManaged = effectiveAppend === managedAppendPath && exists(effectiveAppend);
  const hash = isManaged ? createHash("sha256").update(readText(effectiveAppend)).digest("hex") : "";
  let mode = "unknown";
  if (overrides.length) mode = "incompatible";
  else if (isManaged && hash === appendHash) mode = "known-patched";
  else if (!effectiveAppend) mode = "native-compatible";
  return { mode, effectiveAppend, appendHash: hash, managedAppendPath, projectAppend, userAppend, overrides, reason: projectAppend ? "project-level APPEND_SYSTEM.md takes precedence over the managed user append" : effectiveAppend && !isManaged ? "a non-managed user APPEND_SYSTEM.md is effective" : overrides.length ? "a discovered SYSTEM.md or SYSTEM_TEMPLATE.md replaces the stock native instruction block" : "" };
}

export async function compareTrackedSources(baseRevision, candidateRevision, paths = ALL_PATHS, fetchImpl = fetch) {
  const changed = [];
  for (const path of paths) {
    const [baseResponse, candidateResponse] = await Promise.all([
      fetchImpl(`https://raw.githubusercontent.com/${REPOSITORY}/${baseRevision}/${path}`),
      fetchImpl(`https://raw.githubusercontent.com/${REPOSITORY}/${candidateRevision}/${path}`),
    ]);
    if (!baseResponse.ok || !candidateResponse.ok) throw new Error(`cannot compare tracked source ${path} (baseline ${baseResponse.status}, candidate ${candidateResponse.status})`);
    const [baseBytes, candidateBytes] = await Promise.all([baseResponse.arrayBuffer(), candidateResponse.arrayBuffer()]);
    if (!Buffer.from(baseBytes).equals(Buffer.from(candidateBytes))) changed.push(path);
  }
  return { hardCriticalChanges: changed.filter(path => HARD_CRITICAL_PATHS.includes(path)), watchedChanges: changed.filter(path => WATCHED_PATHS.includes(path)) };
}

async function resolveCommit(version) {
  const ref = version === "main" ? "main" : `v${version}`;
  const response = await fetch(`${API}/commits/${encodeURIComponent(ref)}`, { headers: { accept: "application/vnd.github+json", "user-agent": "omp-docflow-compat-check" } });
  if (!response.ok) throw new Error(`official OMP ref lookup failed (${response.status})`);
  const commit = await response.json();
  if (!/^[0-9a-f]{40}$/i.test(commit.sha ?? "")) throw new Error("official OMP ref did not resolve to a commit");
  return commit.sha;
}

function loadYaml(path) {
  if (!existsSync(path)) throw new Error(`required file is missing: ${path}`);
  const parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`expected YAML mapping: ${path}`);
  return parsed;
}

function setting(key) {
  const result = spawnSync("omp", ["config", "get", key], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot read effective OMP setting ${key}: ${result.stderr.trim()}`);
  const output = result.stdout.trim();
  try { return JSON.parse(output); } catch { return output; }
}

function installedVersion() {
  const result = spawnSync("omp", ["--version"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`cannot read installed OMP version: ${result.stderr.trim()}`);
  const match = /omp\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(result.stdout);
  if (!match) throw new Error(`unrecognized OMP version output: ${result.stdout.trim()}`);
  return match[1];
}

function effectiveConfig() {
  const keys = ["modelRoles", "task.structured", "task.eager", "task.maxConcurrency", "task.maxRecursionDepth", "advisor.enabled", "task.prewalk", "task.agentModelOverrides", "task.agentAdvisor", "modelRoleStorage", "prewalk.enabled", "retry.modelFallback", "retry.usageAwareFallback", "retry.fallbackChains", "enabledProviders", "disabledProviders"];
  const values = Object.fromEntries(keys.map(key => [key, setting(key)]));
  return {
    modelRoles: values.modelRoles,
    task: { structured: values["task.structured"], eager: values["task.eager"], maxConcurrency: values["task.maxConcurrency"], maxRecursionDepth: values["task.maxRecursionDepth"], prewalk: values["task.prewalk"], agentModelOverrides: values["task.agentModelOverrides"], agentAdvisor: values["task.agentAdvisor"] },
    advisor: { enabled: values["advisor.enabled"] },
    modelRoleStorage: values.modelRoleStorage,
    prewalk: { enabled: values["prewalk.enabled"] },
    retry: { modelFallback: values["retry.modelFallback"], usageAwareFallback: values["retry.usageAwareFallback"], fallbackChains: values["retry.fallbackChains"] },
    enabledProviders: values.enabledProviders ?? [],
    disabledProviders: values.disabledProviders ?? [],
  };
}

async function main() {
  let args, record, managedConfig;
  try { args = parseArgs(process.argv.slice(2)); record = loadYaml(recordPath); managedConfig = loadYaml(configPath); validateConfig(managedConfig); validateRecord(record); }
  catch (error) { console.error(`OMP compatibility: INCOMPATIBLE\n${error.message}`); process.exitCode = 1; return; }
  let version, config;
  try {
    if (args.candidate === "latest") {
      const response = await fetch(`${API}/releases/latest`, { headers: { "user-agent": "omp-docflow-compat-check" } });
      if (!response.ok) throw new Error(`official latest-release lookup failed (${response.status})`);
      const release = await response.json();
      version = release.tag_name?.replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("official latest release did not provide a version tag");
    } else version = args.candidate ?? installedVersion();
    config = sourceMode ? managedConfig : effectiveConfig();
    if (!sourceMode) {
      const result = spawnSync("omp", ["config", "path"], { encoding: "utf8" });
      if (result.status !== 0 || resolve(result.stdout.trim()) !== agentDir) throw new Error(`checker is outside the effective OMP agent directory (${result.stdout.trim()})`);
    }
    validateConfig(config);
  } catch (error) { console.log(`OMP compatibility: NOT VERIFIED\n${error.message}`); process.exitCode = 2; return; }

  let payloadSha256;
  try { payloadSha256 = escalationPayloadHash(agentDir); }
  catch (error) { console.log(`OMP compatibility: NOT VERIFIED\n${error.message}`); process.exitCode = 2; return; }

  const prompt = resolvePromptDiscovery({ cwd: process.cwd(), agentDir, enabledProviders: config.enabledProviders, disabledProviders: config.disabledProviders, appendHash: record.consultation_append_sha256, nativeUserConfigDir: sourceMode ? agentDir : undefined });
  console.log(`Managed append file: ${prompt.managedAppendPath}`);
  console.log(`Invocation-level CLI prompt flags: not observable to this detached checker; explicit OMP prompt flags override discovered files.`);
  console.log(`Model roles: ${JSON.stringify(config.modelRoles)}`);
  console.log(`task.structured=${config.task.structured ?? false}; task.eager=${config.task.eager}; maxConcurrency=${config.task.maxConcurrency}; maxRecursionDepth=${config.task.maxRecursionDepth}; advisor.enabled=${config.advisor.enabled}`);
  console.log(`Escalation payload SHA-256: ${payloadSha256}`);
  console.log(`modelFallback=${config.retry.modelFallback}; usageAwareFallback=${config.retry.usageAwareFallback}; fallbackChains=${JSON.stringify(config.retry.fallbackChains)}`);
  const baseline = record.source_reviewed;
  let hardCriticalChanges = [];
  let watchedChanges = [];
  let candidateRevision;
  try {
    if (args.candidate || version !== baseline.omp_version) {
      candidateRevision = await resolveCommit(version);
      if (candidateRevision !== baseline.revision) ({ hardCriticalChanges, watchedChanges } = await compareTrackedSources(baseline.revision, candidateRevision));
    }
  } catch (error) { console.log(`OMP compatibility: NOT VERIFIED\n${error.message}`); process.exitCode = 2; return; }
  const result = classify({ version, record, config, payloadSha256, hardCriticalChanges, watchedChanges, promptMode: prompt.mode });
  let mainChanges;
  if (args.inspectMain) {
    try {
      const mainRevision = await resolveCommit("main");
      mainChanges = { revision: mainRevision, ...await compareTrackedSources(baseline.revision, mainRevision) };
    } catch (error) { console.log(`Upstream main comparison: NOT VERIFIED (${error.message})`); }
  }
  console.log(`Candidate C prompt: ${result.mode}`);
  console.log(`Effective append: ${prompt.effectiveAppend ?? "none"}`);
  if (prompt.reason) console.log(`Prompt discovery: ${prompt.reason}`);
  if (prompt.overrides.length) console.log(`Prompt overrides: ${prompt.overrides.join(", ")}`);
  console.log(`OMP compatibility: ${result.status}`);
  console.log(`Version: ${version}`);
  console.log(`Source baseline: ${baseline.omp_version} (${baseline.revision})`);
  if (candidateRevision) console.log(`Candidate revision: ${candidateRevision}`);
  if (result.hardCriticalChanges.length) console.log(`Changed hard-critical surfaces:\n${result.hardCriticalChanges.map(path => `- ${path}`).join("\n")}`);
  if (result.watchedChanges.length) console.log(`Changed watched surfaces (focused checks only):\n${result.watchedChanges.map(path => `- ${path}`).join("\n")}`);
  if (mainChanges) {
    console.log(`Unreleased upstream main: ${mainChanges.revision}`);
    console.log(`Main hard-critical changes: ${mainChanges.hardCriticalChanges.length ? mainChanges.hardCriticalChanges.join(", ") : "none"}`);
    console.log(`Main watched changes: ${mainChanges.watchedChanges.length ? mainChanges.watchedChanges.join(", ") : "none"}`);
    console.log("Upstream main is early-warning evidence only and is not an adoption target.");
  }
  console.log(result.reason);
  if (result.status === "INCOMPATIBLE") process.exitCode = 1;
  else if (result.status !== "VERIFIED") process.exitCode = 2;
}

if (import.meta.main) await main();
