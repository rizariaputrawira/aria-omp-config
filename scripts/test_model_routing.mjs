import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import boundary from "../config/agent/extensions/luna-tool-boundary.js";

const roles = {
  Main: { id: "Main", kind: "main", parentId: undefined, session: {} },
  review: { id: "review", kind: "sub", parentId: "Main", session: {}, history: { agent: "security-reviewer" } },
  worker: { id: "worker", kind: "sub", parentId: "Main", session: {}, history: { agent: "task" } },
  parked: { id: "parked", kind: "sub", parentId: "Main", session: null, history: { agent: "task" } },
  other: { id: "other", kind: "sub", parentId: "Elsewhere", session: {}, history: { agent: "task" } },
  all: { id: "all", kind: "sub", parentId: "Main", session: {} },
};
const registry = { get: id => roles[id] };
const builtins = ["read", "write", "grep", "glob", "find", "lsp"].map(name => ({ name, parameters: {}, description: `native ${name}` }));
const wrappers = new Map();
const events = new Map();
let effects = 0;
const api = {
  pi: { AgentRegistry: { global: () => registry }, MAIN_AGENT_ID: "Main" },
  getAllTools: () => builtins.map(tool => {
    const wrapper = wrappers.get(tool.name);
    return wrapper ? { ...tool, sourceInfo: { source: "extension", path: wrapper.sourcePath } } : tool;
  }),
  registerTool: tool => wrappers.set(tool.name, tool),
  on: (name, fn) => events.set(name, fn),
};
const modelByRole = {
  main: ["openai-codex", "gpt-6.1-sol"], task: ["openai-codex", "gpt-6-luna"],
  "security-reviewer": ["openai-codex", "gpt-6-luna"], reviewer: ["openai-codex", "gpt-6-luna"],
  scout: ["openai-codex", "gpt-6-luna"], slow: ["openai-codex", "gpt-6.1-sol"],
  advisor: ["openai-codex", "gpt-6.1-sol"], "sol-executor": ["openai-codex", "gpt-6.1-sol"],
};
function context(role, id = "Main", overrides = {}) {
  const [provider, model] = modelByRole[role] ?? ["openai-codex", "gpt-6-luna"];
  const ref = roles[id];
  const currentModel = { provider, id: model };
  return {
    agent: { kind: ref?.kind, id, name: role, depth: ref?.kind === "main" ? 0 : 1,
      ...(ref?.parentId === undefined ? {} : { parentId: ref.parentId }), ...overrides },
    cwd: process.cwd(), model: currentModel, models: { current: () => currentModel },
    invokeTool: async () => { effects++; return {}; },
  };
}
boundary(api);
const handler = events.get("tool_call");
const startup = events.get("session_start");
await startup({}, context("main"));
async function call(role, id, toolName, input = {}, overrides = {}) {
  return handler({ type: "tool_call", toolCallId: "case", toolName, input }, context(role, id, overrides));
}
async function blocked(role, id, tool, input, overrides) {
  const result = await call(role, id, tool, input, overrides);
  assert.equal(result?.block, true, `${role}/${tool} should block`);
}
async function allowed(role, id, tool, input, overrides) {
  assert.equal(await call(role, id, tool, input, overrides), undefined, `${role}/${tool} should pass the role boundary`);
}
let count = 0;
const check = async (name, fn) => { await fn(); count++; };

await check("Sol main admits only coordination tools and the supported wrapper", async () => {
  for (const tool of ["task", "wait", "ask", "todo"]) await allowed("main", "Main", tool);
  for (const tool of ["bash", "edit", "lsp", "web_search", "mcp__server_tool", "custom_tool"])
    await blocked("main", "Main", tool, {});
  await allowed("main", "Main", "read", { path: "agent://review" });
  await blocked("main", "Main", "read", { path: "README.md" });
});
await check("main coordination reads require exact scoped URI and actual registered direct child", async () => {
  for (const path of ["local://release-plan.md", "local://release-plan.md:2-4", "agent://review", "agent://parked", "history://review"])
    await allowed("main", "Main", "read", { path });
  for (const path of ["README.md", "https://example.test", "ssh://host/a", "agent://other", "agent://review/../secret",
    "agent://review/%2e%2e/secret", "agent://reviewed", "agent://review?x", "agent://review\n", "history://other",
    "history://current/full", "local://../plan.md", "local://plan.md/../secret", "proc://job", "mcp://server"])
    await blocked("main", "Main", "read", { path });
});
await check("messages reject reserved broadcast, malformed variants and nonchildren", async () => {
  for (const path of ["agent://review", "agent://parked"]) await allowed("main", "Main", "write", { path, content: "Findings" });
  for (const path of ["agent://all", "agent://ALL", "agent://other", "agent://missing", "agent://review/child", "agent://review/../x",
    "agent://review%2fother", "agent://review?to=other", "agent://review\n", "agent://Review"])
    await blocked("main", "Main", "write", { path, content: "message" });
});
await check("final native arguments fail before any effect", async () => {
  const main = context("main");
  for (const [tool, params] of [["write", { path: "README.md", content: "mutate" }],
    ["write", { path: "agent://all", content: "broadcast" }], ["read", { path: "agent://review/../secret" }]]) {
    await assert.rejects(wrappers.get(tool).execute("c", params, undefined, undefined, main), /managed role boundary/);
  }
  assert.equal(effects, 0, "denied final arguments must not invoke the native tool");
});
await check("wrong role, identity, model and parent relationship fail closed", async () => {
  await blocked("task", "worker", "read", { path: "src/auth.ts" }, { parentId: "not-worker" });
  await blocked("main", "Main", "bash", {}, { kind: "sub" });
  const mismatched = await handler({ type: "tool_call", toolCallId: "case", toolName: "read", input: { path: "x" } },
    { ...context("main"), models: { current: () => ({ provider: "other", id: "gpt-6.1-sol" }) } });
  assert.equal(mismatched?.block, true);
  const missing = await handler({ type: "tool_call", toolCallId: "case", toolName: "read", input: {} }, { agent: { kind: "main" } });
  assert.equal(missing?.block, true);
});
await check("late same-name tool replacement fails source metadata guard", async () => {
  const original = wrappers.get("read").sourcePath;
  wrappers.get("read").sourcePath = "/tmp/foreign-extension.js";
  try {
    await blocked("main", "Main", "read", { path: "agent://review" });
  } finally {
    wrappers.get("read").sourcePath = original;
  }
});
await check("read-only specialist roles cannot use ambient mutating tools", async () => {
  await blocked("slow", "worker", "write", { path: "source.ts", content: "x" });
  await blocked("scout", "worker", "task", {});
  await blocked("reviewer", "worker", "lsp", { action: "rename", file: "README.md" });
  await blocked("advisor", "worker", "read", { path: "README.md" });
});
await check("security reviewer source paths and native actions are bounded", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sol-path-boundary-"));
  const root = path.join(parent, "root");
  try {
    await mkdir(root);
    await writeFile(path.join(root, "source.md"), "source");
    await writeFile(path.join(root, "source.md:2"), "literal alias");
    await writeFile(path.join(root, "clean.md"), "source");
    await writeFile(path.join(root, "bad;name"), "fixture");
    await writeFile(path.join(root, "bad,name"), "fixture");
    await writeFile(path.join(root, "$name"), "fixture");
    const localCall = (tool, input) => handler({ type: "tool_call", toolCallId: "path", toolName: tool, input },
      { ...context("security-reviewer", "review"), cwd: root });
    for (const [tool, input] of [["read", { path: "source.md" }], ["read", { path: "clean.md:2" }],
      ["grep", { pattern: "source", path: "clean.md:raw" }], ["read", { path: "clean.md:raw" }],
      ["glob", { path: "*.md" }], ["ast_grep", { pat: "const $X = $Y", path: "clean.md" }],
      ["lsp", { action: "hover", file: "clean.md", line: 1 }]])
      assert.equal((await localCall(tool, input))?.block, undefined);
    for (const [tool, input] of [["read", { path: "source.md:2" }], ["read", { path: "bad;name" }],
      ["read", { path: "bad,name" }], ["read", { path: "$name" }], ["lsp", { action: "hover", file: "clean.md:2" }]])
      assert.equal((await localCall(tool, input))?.block, true);
  for (const [tool, input] of [["write", { path: "x", content: "x" }], ["edit", {}], ["bash", {}], ["task", {}],
    ["find", { query: "source", path: "README.md" }], ["web_search", {}], ["mcp__server_read", {}], ["custom_tool", {}], ["lsp", { action: "rename" }],
    ["read", { path: "skill://agent-guidance/../../README.md" }], ["read", { path: "https://example.test" }],
    ["read", { path: "issue:/123" }], ["read", { path: "agent.db" }], ["read", { path: "auth.json" }],
    ["read", { path: "tokens" }], ["read", { path: "README.md\n" }], ["read", { path: "file:///etc/passwd" }],
    ["read", { path: ".env" }], ["read", { path: ".ssh/id_rsa" }], ["read", { path: "~/.config/auth/token" }],
    ["grep", { pattern: "secret", path: ".aws/credentials" }], ["glob", { path: "config/**/*.md" }],
    ["read", { path: null }], ["grep", { path: [] }]])
    await blocked("security-reviewer", "review", tool, input);
  assert.equal(effects, 0);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
await check("security reviewer rejects a canonical symlink escape", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "sol-boundary-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside");
  try {
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "source.md"), "outside source");
    await symlink(outside, path.join(root, "escape"), "dir");
    const result = await handler({ type: "tool_call", toolCallId: "symlink", toolName: "read", input: { path: "escape/source.md" } },
      { ...context("security-reviewer", "review"), cwd: root });
    assert.equal(result?.block, true);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
console.log(`Managed role-boundary behavior: ${count} policy and final-argument cases; native runtime admission/approval still requires disposable-session checks.`);
