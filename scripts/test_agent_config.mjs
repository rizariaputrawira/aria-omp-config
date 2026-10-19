import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const configPath = "config/agent/config.yml";
const agentDir = "config/agent/agents";
const roles = {
  scout: "smol", routine: "routine", task: "task", reviewer: "task",
  "security-reviewer": "task", slow: "slow", "sol-executor": "executor", advisor: "advisor",
};
function parseYaml(text, path) {
  try {
    const parsed = Bun.YAML.parse(text);
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed), "expected YAML mapping");
    return parsed;
  } catch (error) { throw new Error(`${path}: ${error.message}`); }
}
function frontmatter(text, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  assert.ok(match, `${path}: missing/malformed frontmatter`);
  return parseYaml(match[1], path);
}
function validate(config, definitions, mutateFrontmatter = () => {}) {
  for (const role of ["default", "plan"]) {
    assert.equal(config.modelRoles?.[role], "openai-codex/gpt-6.1-sol:medium", `${configPath}: ${role} selector`);
  }
  assert.equal(config.modelRoles?.tiny, "openai-codex/gpt-6-luna:low", `${configPath}: preserve tiny selector`);
  assert.equal(config.defaultThinkingLevel, "medium", `${configPath}: default thinking level`);
  assert.ok(config.task?.structured === undefined || config.task.structured === false, `${configPath}: task.structured remains opt-in`);
  assert.equal(config.task?.eager, "default", `${configPath}: no proactive execution delegation`);
  assert.equal(config.task?.maxConcurrency, 3, `${configPath}: max concurrency`);
  assert.equal(config.task?.enableEffort, false, `${configPath}: per-task effort disabled`);
  assert.equal(config.task?.isolation?.enabled, false, `${configPath}: task isolation disabled`);
  const disabledAgents = config.task?.disabledAgents ?? [];
  assert.ok(Array.isArray(disabledAgents), `${configPath}: disabled agents list`);
  assert.ok(disabledAgents.every(name => typeof name === "string"), `${configPath}: disabled agents are strings`);
  assert.ok(!disabledAgents.includes("slow"), `${configPath}: slow consultation available`);
  assert.equal(config.task?.maxRecursionDepth, 1, `${configPath}: max recursion depth`);
  assert.equal(config.task?.showResolvedModelBadge, true, `${configPath}: resolved model badge`);
  assert.equal(config.tools?.approvalMode, "yolo", `${configPath}: ordinary approval mode`);
  assert.equal(config.task?.prewalk, false, `${configPath}: task prewalk`);
  assert.equal(config.retry?.enabled, true, `${configPath}: retry enabled`);
  assert.equal(config.retry?.maxRetries, 1, `${configPath}: retry count`);
  assert.equal(config.retry?.modelFallback, false, `${configPath}: model fallback`);
  assert.equal(config.retry?.usageAwareFallback, false, `${configPath}: usage-aware fallback`);
  assert.deepEqual(config.retry?.fallbackChains, {}, `${configPath}: fallback chains`);
  assert.equal(config.advisor?.enabled, false, `${configPath}: advisor disabled`);
  for (const tier of ["openai", "subagent", "advisor"]) {
    assert.equal(config.tier?.[tier], "none", `${configPath}: ${tier} service tier`);
  }
  assert.equal(config.prewalk?.enabled, false, `${configPath}: global prewalk disabled`);
  for (const name of Object.keys(roles)) {
    assert.equal(config.task?.agentPrewalk?.[name], "off", `${configPath}: ${name} prewalk`);
    assert.equal(config.task?.agentAdvisor?.[name], "off", `${configPath}: ${name} advisor`);
    assert.equal(config.task?.agentServiceTierOverrides?.[name], "none", `${configPath}: ${name} service tier`);
  }
  assert.equal(config.eval?.py, false, `${configPath}: Python eval disabled by default`);
  assert.equal(config.eval?.js, false, `${configPath}: JavaScript eval disabled by default`);
  assert.equal(config.tools?.approval?.eval, "prompt", `${configPath}: opt-in eval safety policy`);
  for (const key of ["enabled", "ultrathink", "orchestrate", "workflow", "jevify"]) {
    const value = config.magicKeywords?.[key];
    assert.ok(value === undefined || value === true, `${configPath}: native keyword ${key} available`);
  }
  for (const tool of ["read", "grep", "glob", "edit", "write", "bash", "lsp", "task", "wait", "todo", "web_search"]) {
    const policy = config.tools?.approval?.[tool];
    assert.ok(policy === undefined || policy === "allow", `${configPath}: ordinary ${tool} approval`);
  }
  // Static wildcard contract for the configured command strings, not a shell parser
  // or installed OMP runtime proof. Native handler smoke is recorded separately.
  const policyFor = (command) => config.bash.patterns.find(({ match }) => {
    const expression = match.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${expression}$`).test(command);
  })?.approval ?? "allow";
  for (const command of [
    "printf harmless", "bun test", "python3 scripts/test_install.py",
    "git status --short", "git diff --stat", "git commit -m fix",
    "git push origin main", "git push --follow-tags origin main",
    "git push --atomic origin main",
  ]) assert.equal(policyFor(command), "allow", `${configPath}: ordinary command ${command}`);
  for (const command of [
    "git push -f origin main", "git push origin main -f", "git push -fv origin main",
    "git -C fixture push --force origin main", "git push --force-with-lease origin main",
    "git reset --hard HEAD", "git clean -fd", "git clean -df", "git clean --force",
  ]) assert.equal(policyFor(command), "prompt", `${configPath}: protected Git command ${command}`);
  for (const command of [
    "rm -rf fixture", "rm -fr fixture", "rm -Rf fixture", "rm -fR fixture",
    "rm -r -f fixture", "rm -f -r fixture", "rm -R -f fixture", "rm -f -R fixture",
    "rm --recursive --force fixture", "rm --force --recursive fixture",
    "printf harmless && rm -rf fixture", "git push -f origin main; rm -rf fixture",
    "git reset --hard HEAD && rm -rf /tmp/fixture",
  ]) assert.equal(policyFor(command), "deny", `${configPath}: protected removal ${command}`);
  const names = new Set();
  for (const [path, text] of definitions) {
    const data = frontmatter(text, path);
    mutateFrontmatter(path, data);
    assert.ok(Object.hasOwn(roles, data.name), `${path}: unmapped agent ${data.name}`);
    assert.ok(!names.has(data.name), `${path}: duplicate agent ${data.name}`);
    names.add(data.name);
    const alias = `@${roles[data.name]}`;
    assert.deepEqual(Array.isArray(data.model) ? data.model : [data.model], [alias], `${path}: model alias`);
    const expectedEffort = data.name === "advisor" ? "high" : "medium";
    assert.equal(data.thinkingLevel ?? config.defaultThinkingLevel, expectedEffort, `${path}: thinking level`);
    assert.equal(config.task?.agentModelOverrides?.[data.name], alias, `${configPath}: ${data.name} override`);
    const model = ["slow", "advisor", "sol-executor"].includes(data.name) ? "gpt-6.1-sol" : "gpt-6-luna";
    assert.equal(config.modelRoles?.[roles[data.name]], `openai-codex/${model}:${expectedEffort}`, `${configPath}: ${roles[data.name]} selector`);
    assert.deepEqual(data.spawns, [], `${path}: nested spawning disabled`);
    if (data.name === "security-reviewer") {
      const allowedTools = new Set(["read", "grep", "glob", "lsp", "yield"]);
      const requiredTools = ["read", "grep", "glob", "lsp", "yield"];
      assert.ok(Array.isArray(data.tools), `${path}: security-reviewer tools must be a list`);
      assert.ok(requiredTools.every(tool => data.tools.includes(tool)), `${path}: scoped discovery fallback admission`);
      assert.ok(data.tools.every(tool => allowedTools.has(tool)), `${path}: security-reviewer read-only admission`);
    }
    if (data.name === "slow") {
      const allowedTools = new Set(["read", "find", "grep", "glob", "web_search", "yield"]);
      const requiredTools = ["read", "grep", "glob", "web_search"];
      assert.ok(Array.isArray(data.tools), `${path}: slow tools must be a list`);
      assert.ok(requiredTools.every(tool => data.tools.includes(tool)), `${path}: slow required read-only admission`);
      assert.ok(data.tools.every(tool => allowedTools.has(tool)), `${path}: slow read-only admission`);
    }
  }
  for (const name of Object.keys(roles)) assert.ok(names.has(name), `${agentDir}/${name}.md: missing definition`);
  assert.deepEqual(Object.keys(config.task.agentModelOverrides).sort(), Object.keys(roles).sort(), `${configPath}: managed override names`);
}
const config = parseYaml(readFileSync(configPath, "utf8"), configPath);
const definitions = readdirSync(agentDir).filter((name) => name.endsWith(".md"))
  .map((name) => [`${agentDir}/${name}`, readFileSync(`${agentDir}/${name}`, "utf8")]);
assert.equal(config.task.structured, undefined, "managed default leaves task.structured unset");
validate(config, definitions);
const unstructured = structuredClone(config);
unstructured.task.structured = false;
validate(unstructured, definitions);
function rejects(name, mutate, expected, mutateFrontmatter) {
  const cfg = structuredClone(config);
  const defs = definitions.map(([path, text]) => [path, text]);
  mutate(cfg, defs);
  assert.throws(() => validate(cfg, defs, mutateFrontmatter), expected, name);
}
rejects("missing definition", (_, defs) => defs.splice(defs.findIndex(([path]) => path.endsWith("/slow.md")), 1), /slow\.md: missing/);
rejects("malformed frontmatter", (_, defs) => { defs[0][1] = "---\nname: [\n---\n"; }, /config\/agent\/agents\//);
rejects("per-task effort exposed", (cfg) => { cfg.task.enableEffort = true; }, /per-task effort disabled/);
rejects("task isolation enabled", (cfg) => { cfg.task.isolation.enabled = true; }, /task isolation disabled/);
rejects("slow disabled by name", (cfg) => { cfg.task.disabledAgents = "slow"; }, /disabled agents list/);
rejects("slow disabled by list", (cfg) => { cfg.task.disabledAgents = ["slow"]; }, /slow consultation available/);
rejects("non-string disabled agent", (cfg) => { cfg.task.disabledAgents = [42]; }, /disabled agents are strings/);
const unrelatedDisabledAgent = structuredClone(config);
unrelatedDisabledAgent.task.disabledAgents = ["unrelated-agent"];
validate(unrelatedDisabledAgent, definitions);
rejects("duplicate definition", (_, defs) => defs.push(defs[0]), /duplicate agent/);
rejects("unmapped definition", (_, defs) => defs.push([`${agentDir}/unknown.md`, "---\nname: unknown\n---\n"]), /unknown\.md: unmapped/);
for (const name of ["slow", "advisor"]) {
  rejects(`${name} alias`, (cfg) => { cfg.task.agentModelOverrides[name] = "@task"; }, new RegExp(`${name} override`));
  rejects(`${name} effort`, () => {}, /thinking level/, (path, data) => {
    if (path.endsWith(`/${name}.md`)) data.thinkingLevel = name === "advisor" ? "medium" : "high";
  });
  rejects(`${name} concrete selector`, (cfg) => { cfg.modelRoles[name] = "openai-codex/gpt-6-luna:medium"; }, new RegExp(`${name} selector`));
}
rejects("slow writable tool admitted", () => {}, /slow read-only admission/, (path, data) => {
  if (path.endsWith("/slow.md")) data.tools.push("write");
});
rejects("security-reviewer broad read tool admitted", () => {}, /security-reviewer read-only admission/, (path, data) => {
  if (path.endsWith("/security-reviewer.md")) data.tools.push("find");
});
rejects("slow spawning enabled", () => {}, /nested spawning disabled/, (path, data) => {
  if (path.endsWith("/slow.md")) data.spawns = ["task"];
});
rejects("structured task mode is not managed default", (cfg) => { cfg.task.structured = true; }, /task\.structured/);
rejects("Luna default", (cfg) => { cfg.modelRoles.default = "openai-codex/gpt-6-luna:medium"; }, /default selector/);
rejects("high default", (cfg) => { cfg.modelRoles.default = "openai-codex/gpt-6.1-sol:high"; }, /default selector/);
rejects("Luna plan", (cfg) => { cfg.modelRoles.plan = "openai-codex/gpt-6-luna:medium"; }, /plan selector/);
rejects("retry disabled", (cfg) => { cfg.retry.enabled = false; }, /retry enabled/);
rejects("retry count", (cfg) => { cfg.retry.maxRetries = 2; }, /retry count/);
rejects("model fallback enabled", (cfg) => { cfg.retry.modelFallback = true; }, /model fallback/);
rejects("usage fallback enabled", (cfg) => { cfg.retry.usageAwareFallback = true; }, /usage-aware fallback/);
rejects("fallback chains populated", (cfg) => { cfg.retry.fallbackChains = { default: ["other"] }; }, /fallback chains/);
rejects("advisor enabled", (cfg) => { cfg.advisor.enabled = true; }, /advisor disabled/);
rejects("global prewalk enabled", (cfg) => { cfg.prewalk.enabled = true; }, /global prewalk disabled/);
for (const tier of ["openai", "subagent", "advisor"]) {
  rejects(`${tier} service tier enabled`, (cfg) => { cfg.tier[tier] = "priority"; }, new RegExp(`${tier} service tier`));
}
rejects("task prewalk enabled", (cfg) => { cfg.task.prewalk = true; }, /task prewalk/);
for (const name of Object.keys(roles)) {
  rejects(`${name} prewalk enabled`, (cfg) => { cfg.task.agentPrewalk[name] = "on"; }, new RegExp(`${name} prewalk`));
  rejects(`${name} advisor enabled`, (cfg) => { cfg.task.agentAdvisor[name] = "on"; }, new RegExp(`${name} advisor`));
  rejects(`${name} service tier enabled`, (cfg) => { cfg.task.agentServiceTierOverrides[name] = "priority"; }, new RegExp(`${name} service tier`));
}
rejects("nested delegation", (cfg) => { cfg.task.maxRecursionDepth = 2; }, /max recursion depth/);
rejects("excess concurrency", (cfg) => { cfg.task.maxConcurrency = 4; }, /max concurrency/);
rejects("ordinary approval mode", (cfg) => { cfg.tools.approvalMode = "write"; }, /ordinary approval mode/);
rejects("Python eval exposed", (cfg) => { cfg.eval.py = true; }, /Python eval disabled/);
rejects("JavaScript eval exposed", (cfg) => { cfg.eval.js = true; }, /JavaScript eval disabled/);
rejects("eval escape unprompted", (cfg) => { cfg.tools.approval.eval = "allow"; }, /opt-in eval safety policy/);
for (const key of ["enabled", "ultrathink", "orchestrate", "workflow", "jevify"]) {
  const enabled = structuredClone(config);
  enabled.magicKeywords = { ...enabled.magicKeywords, [key]: true };
  validate(enabled, definitions);
  rejects(`native keyword ${key} disabled`, (cfg) => {
    cfg.magicKeywords = { ...cfg.magicKeywords, [key]: false };
  }, new RegExp(`native keyword ${key} available`));
}
rejects("ordinary tool prompted", (cfg) => { cfg.tools.approval.bash = "prompt"; }, /ordinary bash approval/);
rejects("force push unprotected", (cfg) => {
  cfg.bash.patterns = cfg.bash.patterns.filter(rule => !rule.match.includes("push"));
}, /protected Git command/);
rejects("recursive removal unprotected", (cfg) => {
  cfg.bash.patterns = cfg.bash.patterns.filter(rule => rule.approval !== "deny");
}, /protected removal/);
rejects("prompt masks removal deny", (cfg) => {
  cfg.bash.patterns.sort((a, b) => (a.approval === "prompt" ? -1 : 1) - (b.approval === "prompt" ? -1 : 1));
}, /protected removal/);
console.log("Agent configuration contract: Sol-medium default/Plan model routing; Luna-medium workers plus Sol-medium slow and executor; bounded concurrency/depth, managed role overrides, read-only specialist admission, retry/fallback and native approval agree. Model selectors are separate from authorization; static configuration is not dispatch or installed runtime proof.");
