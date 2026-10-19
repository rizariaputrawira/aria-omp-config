import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODEL_BY_ROLE = Object.freeze({ main: "openai-codex/gpt-6.1-sol", scout: "openai-codex/gpt-6-luna", routine: "openai-codex/gpt-6-luna", task: "openai-codex/gpt-6-luna", reviewer: "openai-codex/gpt-6-luna", "security-reviewer": "openai-codex/gpt-6-luna", slow: "openai-codex/gpt-6.1-sol", advisor: "openai-codex/gpt-6.1-sol", "sol-executor": "openai-codex/gpt-6.1-sol" });
const MAIN_COORDINATION = new Set(["task", "wait", "ask", "todo"]);
const SIMPLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const PATH_SEGMENT = /^(?:[A-Za-z0-9_-]+|\d+)$/;
const PLAN_URI = /^local:\/\/[a-z0-9]+(?:-[a-z0-9]+)*-plan\.md(?::\d+(?:-\d+)?)?$/;
const HISTORY_DIRECT = /^history:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)(?::\d+(?:-\d+)?)?$/;
const DIRECT_MESSAGE = /^agent:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)$/;
const DIRECT_READ = /^agent:\/\/([A-Za-z0-9][A-Za-z0-9.-]*)(?:\/((?:[A-Za-z0-9_-]+|\d+)(?:\/(?:[A-Za-z0-9_-]+|\d+))*))?(?::\d+(?:-\d+)?)?$/;
const READONLY_ROLE_TOOLS = Object.freeze({
  scout: new Set(["read", "find", "grep", "glob", "web_search", "yield"]),
  slow: new Set(["read", "find", "grep", "glob", "web_search", "yield"]),
  reviewer: new Set(["read", "find", "grep", "glob", "web_search", "ast_grep", "lsp", "yield"]),
  advisor: new Set(["yield"]),
});
const REVIEWER_TOOLS = new Set(["read", "grep", "glob", "ast_grep", "yield"]);
const SAFE_LSP_ACTIONS = new Set(["diagnostics", "definition", "references", "hover", "symbols", "type_definition", "implementation", "status", "capabilities"]);
const FORBIDDEN_READ_PATH = /(?:^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|\.ssh|\.aws|\.config|id_rsa|id_ed25519|.*\.pem|.*\.key|agent\.db|auth\.json|tokens?)(?:\/|$)/i;
const SOURCE_PATH = fileURLToPath(import.meta.url);

function blocked(reason) { return { block: true, reason: `managed role boundary: ${reason}` }; }
function denied(reason) { throw new Error(`managed role boundary: ${reason}`); }
function modelIdentity(ctx) {
  const model = ctx?.models?.current?.() ?? ctx?.model;
  return model && typeof model.provider === "string" && typeof model.id === "string" ? `${model.provider}/${model.id}` : "";
}
function validIdentity(agent) {
  if (!agent || !["main", "sub"].includes(agent.kind) || typeof agent.id !== "string" || /[\r\n]/.test(agent.id) || !SIMPLE_ID.test(agent.id) ||
      typeof agent.name !== "string" || /[\r\n]/.test(agent.name) || !Object.hasOwn(MODEL_BY_ROLE, agent.name) || !Number.isInteger(agent.depth) || agent.depth < 0) return false;
  if (agent.kind === "main") return agent.name === "main" && agent.depth === 0 && (agent.parentId === undefined || agent.parentId === null || agent.parentId === "");
  return agent.name !== "main" && typeof agent.parentId === "string" && !/[\r\n]/.test(agent.parentId) && SIMPLE_ID.test(agent.parentId) && agent.parentId !== agent.id;
}
function registered(registry, id) { return typeof registry?.get === "function" ? registry.get(id) : undefined; }
function validCurrentAgent(agent, registry, mainId) {
  if (!validIdentity(agent)) return false;
  const ref = registered(registry, agent.id);
  return !!ref && ref.id === agent.id && ref.kind === agent.kind && ref.parentId === agent.parentId && !!ref.session &&
    (agent.kind !== "main" ? agent.depth === 1 && agent.parentId === mainId : agent.id === mainId && ref.parentId == null);
}
function directChild(registry, parentId, targetId) {
  if (typeof targetId !== "string" || targetId === "all" || /[\r\n]/.test(targetId) || !SIMPLE_ID.test(targetId)) return false;
  const ref = registered(registry, targetId);
  return !!ref && ref.id === targetId && ref.kind === "sub" && ref.parentId === parentId;
}
function mainRead(input, registry, parentId) {
  const pathValue = typeof input?.path === "string" && !/[\r\n]/.test(input.path) ? input.path : "";
  if (PLAN_URI.test(pathValue)) return true;
  const history = HISTORY_DIRECT.exec(pathValue);
  if (history && directChild(registry, parentId, history[1])) return true;
  const match = DIRECT_READ.exec(pathValue);
  return !!match && directChild(registry, parentId, match[1]) && (!match[2] || match[2].split("/").every(segment => PATH_SEGMENT.test(segment)));
}
function validSkillUri(value) {
  if (typeof value !== "string" || /[\r\n]/.test(value) || !/^skill:\/\/[a-z0-9-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)) return false;
  return value.slice("skill://".length).split("/").every(segment => segment !== "." && segment !== "..");
}
function safeLexicalPath(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[\r\n?;,:$~'"`%#!\\]/.test(value) && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) &&
    !value.split(/[/:]/).includes("..") && !FORBIDDEN_READ_PATH.test(value);
}
function readSelector(value) {
  return /^(.*?)(?::(?:\d+(?:-\d+)?|\d+\+\d+|raw|conflicts))$/.exec(value);
}
async function safeCanonicalFile(value, cwd, allowSelector = false) {
  const selector = allowSelector && typeof value === "string" ? readSelector(value) : null;
  const sourcePath = selector ? selector[1] : value;
  if (!safeLexicalPath(sourcePath) || /[*?\[\]{}]/.test(sourcePath)) return false;
  try {
    if (selector) {
      try { await lstat(path.resolve(cwd, value)); return false; }
      catch (error) { if (error?.code !== "ENOENT") return false; }
    }
    const base = await realpath(cwd);
    const resolved = await realpath(path.resolve(cwd, sourcePath));
    const rel = path.relative(base, resolved);
    return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) &&
      !FORBIDDEN_READ_PATH.test(resolved) && (await stat(resolved)).isFile();
  } catch { return false; }
}
async function safeSearchPattern(value, cwd) {
  if (!safeLexicalPath(value) || value.startsWith("/") || value === "." || /[,;]/.test(value)) return false;
  const wildcard = value.search(/[*?\[\]{}]/);
  if (wildcard >= 0 && value.slice(wildcard).includes("/")) return false;
  const prefix = (wildcard < 0 ? value : value.slice(0, wildcard)).replace(/\/$/, "") || ".";
  try {
    const base = await realpath(cwd);
    const resolved = await realpath(path.resolve(cwd, prefix));
    const rel = path.relative(base, resolved);
    return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) && !FORBIDDEN_READ_PATH.test(resolved);
  } catch { return false; }
}
async function securityReviewerAllows(event, ctx) {
  const input = event.input && typeof event.input === "object" ? event.input : {};
  if (event.toolName === "read") return validSkillUri(input.path) || await safeCanonicalFile(input.path, ctx?.cwd, true);
  if (event.toolName === "grep") return input.gitignore !== false && await safeCanonicalFile(input.path, ctx?.cwd, true);
  if (event.toolName === "glob") return await safeSearchPattern(input.path, ctx?.cwd);
  if (event.toolName === "ast_grep") return await safeCanonicalFile(input.path, ctx?.cwd);
  if (event.toolName === "lsp") {
    if (typeof input.action !== "string" || !SAFE_LSP_ACTIONS.has(input.action) ||
        Object.values(input).some(value => typeof value === "string" && /[\r\n]|^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value))) return false;
    const file = input.file;
    if (file !== undefined && !(await safeCanonicalFile(file, ctx?.cwd))) return false;
    return true;
  }
  return REVIEWER_TOOLS.has(event.toolName);
}
function sourceGuard(pi, toolName) {
  const info = pi?.getAllTools?.().find(tool => tool.name === toolName);
  return info?.sourceInfo?.source === "extension" && info.sourceInfo.path === SOURCE_PATH;
}
function permitsFinalInput(agent, toolName, input, registry) {
  if (agent.kind === "main" && toolName === "read") return mainRead(input, registry, agent.id);
  if (agent.kind === "main" && toolName === "write") {
    const match = DIRECT_MESSAGE.exec(typeof input?.path === "string" && !/[\r\n]/.test(input.path) ? input.path : "");
    return !!match && typeof input.content === "string" && input.content.trim().length > 0 && directChild(registry, agent.id, match[1]);
  }
  return false;
}
export default function lunaToolBoundary(pi) {
  const registry = pi?.pi?.AgentRegistry?.global?.();
  const mainId = pi?.pi?.MAIN_AGENT_ID;
  pi.on("session_start", (_event, ctx) => {
    const agent = ctx?.agent;
    if (!validCurrentAgent(agent, registry, mainId) || agent.kind !== "main" ||
        modelIdentity(ctx) !== MODEL_BY_ROLE.main || typeof pi.registerTool !== "function") return;
    for (const name of ["read", "write"]) {
      const native = pi.getAllTools?.().find(tool => tool.name === name);
      if (!native?.parameters || native.sourceInfo?.path === SOURCE_PATH) continue;
      pi.registerTool({
        name, label: native.name, description: native.description, parameters: native.parameters, sourcePath: SOURCE_PATH,
        approval: name === "write" ? "write" : "read",
        async execute(_id, params, signal, onUpdate, toolCtx) {
          const current = toolCtx?.agent;
          if (!validCurrentAgent(current, registry, mainId) || modelIdentity(toolCtx) !== MODEL_BY_ROLE[current.name])
            return denied("invalid role, identity, or model");
          if (current.kind === "main" && (!sourceGuard(pi, name) || !permitsFinalInput(current, name, params, registry)))
            return denied(`final ${name} input failed the director boundary`);
          if (typeof toolCtx.invokeTool !== "function") return denied(`native ${name} invocation is unavailable`);
          return toolCtx.invokeTool(params, { signal, onUpdate });
        },
      });
    }
  });
  pi.on("tool_call", async (event, ctx) => {
    const agent = ctx?.agent;
    if (!validCurrentAgent(agent, registry, mainId) || modelIdentity(ctx) !== MODEL_BY_ROLE[agent.name]) return blocked("invalid role, identity, or model");
    if (agent.kind === "main") {
      if (MAIN_COORDINATION.has(event.toolName)) return undefined;
      if (event.toolName === "read" || event.toolName === "write") {
        if (!sourceGuard(pi, event.toolName)) return blocked("restricted built-in wrapper is missing or replaced");
        if (event.toolName === "read" && mainRead(event.input, registry, agent.id)) return undefined;
        if (event.toolName === "write") {
          const match = DIRECT_MESSAGE.exec(typeof event.input?.path === "string" ? event.input.path : "");
          if (match && typeof event.input?.path === "string" && !/[\r\n]/.test(event.input.path) &&
              typeof event.input.content === "string" && event.input.content.trim() && directChild(registry, agent.id, match[1])) return undefined;
        }
      }
      return blocked(`director cannot call ${event.toolName} or target an unauthorized recipient`);
    }
    if (agent.name === "security-reviewer" && !await securityReviewerAllows(event, ctx))
      return blocked(`security-reviewer is read-only or outside its source scope: ${event.toolName}`);
    if (READONLY_ROLE_TOOLS[agent.name] && !READONLY_ROLE_TOOLS[agent.name].has(event.toolName))
      return blocked(`${agent.name} role is read-only or tool is outside its definition: ${event.toolName}`);
    if (agent.name === "reviewer" && event.toolName === "lsp" &&
        (!SAFE_LSP_ACTIONS.has(event.input?.action) || Object.values(event.input ?? {}).some(value => typeof value === "string" && /[\r\n]|^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value))))
      return blocked("reviewer LSP action is not read-only");
  });
}
