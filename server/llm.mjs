/**
 * llm.mjs —— OpenAI 兼容接口的最小客户端（零依赖）
 *
 * 支持任意兼容 /chat/completions 的服务：DeepSeek、通义、Kimi、智谱、
 * 本地 vLLM / Ollama(/v1)、OpenAI 等。配置优先级：运行时设置 > 环境变量 > 配置文件。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 允许用环境变量指向独立配置文件：测试时用临时文件，避免动到用户的密钥
const CONFIG_FILE = process.env.LLM_CONFIG_FILE
  ? path.resolve(process.env.LLM_CONFIG_FILE)
  : path.join(__dirname, "config.local.json");

let runtimeConfig = null;

export function loadConfig() {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) fileCfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    fileCfg = {};
  }
  const envCfg = {
    baseURL: process.env.LLM_BASE_URL,
    apiKey: process.env.LLM_API_KEY,
    model: process.env.LLM_MODEL,
    temperature: process.env.LLM_TEMPERATURE,
  };
  const merged = { ...fileCfg, ...pickDefined(envCfg), ...pickDefined(runtimeConfig || {}) };
  return {
    baseURL: merged.baseURL || "",
    apiKey: merged.apiKey || "",
    model: merged.model || "",
    temperature: merged.temperature != null && merged.temperature !== "" ? Number(merged.temperature) : 0.2,
  };
}

function pickDefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== "") out[k] = v;
  return out;
}

export function isConfigured(cfg = loadConfig()) {
  return Boolean(cfg.baseURL && cfg.apiKey && cfg.model);
}

/** 运行期设置（只存在内存与 config.local.json，不下发前端） */
export function setRuntimeConfig(patch, persist = false) {
  const current = loadConfig();
  runtimeConfig = { ...current, ...pickDefined(patch) };
  if (persist) {
    const { baseURL, apiKey, model, temperature } = runtimeConfig;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({ baseURL, apiKey, model, temperature }, null, 2), "utf8");
  }
  return loadConfig();
}

/** 清空运行期配置，并删除本地配置文件 */
export function clearRuntimeConfig() {
  runtimeConfig = null;
  try {
    if (fs.existsSync(CONFIG_FILE)) fs.unlinkSync(CONFIG_FILE);
  } catch {
    /* ignore */
  }
  return loadConfig();
}

export function publicConfig() {
  const cfg = loadConfig();
  const missing = [];
  if (!cfg.baseURL) missing.push("baseURL");
  if (!cfg.apiKey) missing.push("apiKey");
  if (!cfg.model) missing.push("model");
  return {
    configured: missing.length === 0,
    baseURL: cfg.baseURL,
    model: cfg.model,
    hasKey: Boolean(cfg.apiKey),
    temperature: cfg.temperature,
    missing,
  };
}

function endpoint(baseURL) {
  let b = String(baseURL || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`;
  return `${b}/v1/chat/completions`;
}

function headers(cfg) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.apiKey}`,
  };
}

function body(cfg, messages, { stream, maxTokens, temperature }) {
  return JSON.stringify({
    model: cfg.model,
    messages,
    stream: Boolean(stream),
    temperature: temperature ?? cfg.temperature ?? 0.2,
    max_tokens: maxTokens ?? 1200,
  });
}

const HTTP_HINTS = {
  400: "请求格式不被模型服务接受，检查模型名是否正确",
  401: "API Key 无效或已过期，请到控制台重新生成",
  402: "账户余额不足，请充值或更换 API Key",
  403: "密钥无调用权限，或该模型未开通",
  404: "接口地址不对，检查 Base URL（一般以 /v1 结尾）",
  408: "模型服务超时，稍后重试",
  429: "请求过于频繁或超出配额，稍后重试",
  500: "模型服务内部错误，稍后重试",
  502: "模型服务网关错误，稍后重试",
  503: "模型服务暂时不可用，稍后重试",
};

async function errorOf(res) {
  let detail = "";
  try {
    const txt = await res.text();
    detail = txt.slice(0, 600);
  } catch {
    /* ignore */
  }
  const hint = HTTP_HINTS[res.status] || (res.status >= 500 ? "模型服务异常" : "调用失败");
  const err = new Error(`${hint}（HTTP ${res.status}）${detail ? "：" + detail : ""}`);
  err.status = res.status;
  err.hint = hint;
  err.detail = detail;
  return err;
}

export async function chatOnce(cfg, messages, opts = {}) {
  const res = await fetch(endpoint(cfg.baseURL), {
    method: "POST",
    headers: headers(cfg),
    body: body(cfg, messages, { ...opts, stream: false }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 60000),
  });
  if (!res.ok) throw await errorOf(res);
  const data = await res.json();
  return {
    content: data.choices?.[0]?.message?.content || "",
    usage: data.usage || null,
    raw: data,
  };
}

/** 返回原始 fetch Response（body 为 SSE 流），由调用方转发 */
export async function chatStream(cfg, messages, opts = {}) {
  const res = await fetch(endpoint(cfg.baseURL), {
    method: "POST",
    headers: headers(cfg),
    body: body(cfg, messages, { ...opts, stream: true }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 120000),
  });
  if (!res.ok) throw await errorOf(res);
  return res;
}

/** 从 OpenAI 兼容的 SSE chunk 中抽出增量文本 */
export function deltaOf(obj) {
  const d = obj?.choices?.[0]?.delta;
  if (!d) return "";
  if (typeof d.content === "string") return d.content;
  if (Array.isArray(d.content)) return d.content.map((c) => c.text || "").join("");
  return "";
}
