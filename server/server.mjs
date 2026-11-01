/**
 * 公开版服务：给任意访客提供模型问答，同时保护 API Key 与额度。
 *
 * 环境变量
 *   PORT               端口（默认 8080；Render/Railway 会自动注入）
 *   LLM_BASE_URL       模型服务地址
 *   LLM_API_KEY        服务端共享 Key（配了才允许访客直接问）
 *   LLM_MODEL          模型名
 *   ALLOW_SHARED       0 = 关闭共享 Key，只允许访客自带 Key
 *   RATE_PER_MIN       每 IP 每分钟上限（默认 4）
 *   RATE_PER_DAY       每 IP 每天上限（默认 30）
 *   GLOBAL_PER_DAY     全站每天上限（默认 800，兜底防止被刷爆）
 *   MAX_TOKENS         单次回答上限（默认 700）
 *   CORS_ORIGIN        前后端分离时的允许来源，如 https://xxx.netlify.app
 *
 * 只暴露 4 个接口：/api/health、/api/ask、/api/step、/api/steps
 * 不提供任何读写配置的接口，Key 永远不出服务端。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadKB, kbSummary, retrieve, formatContext, findStep, stepCard, allSteps, stepAnswer } from "./kb.mjs";
import { gateWide, inspect, verifyReasoning } from "./guard.mjs";
import { loadConfig, isConfigured, publicConfig, chatStream, chatOnce, deltaOf } from "./llm.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

const RATE_PER_MIN = Number(process.env.RATE_PER_MIN || 4);
const RATE_PER_DAY = Number(process.env.RATE_PER_DAY || 30);
const GLOBAL_PER_DAY = Number(process.env.GLOBAL_PER_DAY || 800);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 700);
const ALLOW_SHARED = String(process.env.ALLOW_SHARED || "1") !== "0";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "";

loadKB();

const ASK_PROMPT = `你是"煤制天然气工艺安全知识库"的问答助手。回答必须完全来自【知识片段】与【风险速查】，不得使用训练数据。

【输出格式】严格按三段：

【思考】
1. …
2. …
【回答】
…
【依据】
- 条目ID

【规则】
- 只用给定片段里的事实；数值照抄，不得改写或补零。
- 引用限值要带：数值 + 单位 + 标准号 + 置信度。
- 不得编造 ID、D 值、限值、条款号。
- 不得下"构成重大危险源""满足安全生产条件""可以投用"的结论。
- 知识库没有的，写"知识库未收录"。
- 【回答】控制在 300 字内，每条事实后附 ID。`;

/* ---------------- 限流 ---------------- */
const buckets = new Map();
let globalDay = "";
let globalCount = 0;

function today() { return new Date().toISOString().slice(0, 10); }

function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "unknown";
}

/** @returns {{ok:boolean, reason?:string, retryAfter?:number}} */
function rateLimit(ip) {
  const now = Date.now();
  const d = today();
  if (d !== globalDay) { globalDay = d; globalCount = 0; }

  let b = buckets.get(ip);
  if (!b || b.day !== d) { b = { day: d, times: [] }; buckets.set(ip, b); }
  b.times = b.times.filter((t) => now - t < 60_000);

  if (b.times.length >= RATE_PER_MIN) {
    return { ok: false, reason: `请求太频繁，每分钟最多 ${RATE_PER_MIN} 次`, retryAfter: 60 };
  }
  if (b.dayCount == null || b.day !== d) b.dayCount = 0;
  if (b.dayCount >= RATE_PER_DAY) {
    return { ok: false, reason: `今天已达到上限（${RATE_PER_DAY} 次），明天再来` };
  }
  if (globalCount >= GLOBAL_PER_DAY) {
    return { ok: false, reason: "全站今日额度已用完，明天再来" };
  }
  b.times.push(now);
  b.dayCount += 1;
  globalCount += 1;
  return { ok: true };
}

/* ---------------- 工具 ---------------- */
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon", ".svg": "image/svg+xml",
};

function cors(res) {
  if (!CORS_ORIGIN) return;
  res.setHeader("access-control-allow-origin", CORS_ORIGIN);
  res.setHeader("access-control-allow-headers", "content-type,x-user-key");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function sse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let closed = false;
  return {
    send(ev, data) { if (!closed) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`); },
    end() { if (!closed) { closed = true; res.end(); } },
    onClose(fn) { res.on("close", fn); },
    get closed() { return closed; },
  };
}

function parseStructured(text) {
  const t = String(text || "");
  const afterThink = t.includes("【思考】") ? t.split("【思考】")[1] : t;
  const thinkPart = afterThink.includes("【回答】") ? afterThink.split("【回答】")[0] : "";
  const afterAnswer = afterThink.includes("【回答】") ? afterThink.split("【回答】")[1] : afterThink;
  const answerPart = afterAnswer.includes("【依据】") ? afterAnswer.split("【依据】")[0] : afterAnswer;
  const steps = thinkPart.split(/\n+/)
    .map((l) => l.replace(/^\s*\d+\s*[.、)）]\s*/, "").replace(/^[-*]\s*/, "").trim())
    .filter((l) => l && !/^【/.test(l));
  return { steps, answer: answerPart.trim() };
}

function verifyPayload(acc, hits) {
  const parsed = parseStructured(acc);
  const steps = verifyReasoning(parsed.steps);
  const chk = inspect(parsed.answer || acc);
  const bad = steps.filter((x) => x.verdict === "bad").length;
  const warn = steps.filter((x) => x.verdict === "warn").length;
  return {
    steps, answer: parsed.answer, answerOk: chk.ok, answerIssues: chk.issues,
    coverage: hits.length,
    summary: { total: steps.length, ok: steps.length - bad - warn, bad, warn },
  };
}

function accessMode() {
  if (ALLOW_SHARED && isConfigured(loadConfig())) return "shared";
  return "byok";
}

/* ---------------- 接口 ---------------- */
function answerStep(unitId, res, wantStream) {
  const card = stepCard(unitId);
  const text = stepAnswer(unitId);
  if (!card || !text) {
    if (!wantStream) return json(res, 404, { error: "STEP_NOT_FOUND" });
    const s = sse(res);
    s.send("meta", { mode: "step", refused: true });
    s.send("delta", { text: "这一步不在知识库中（共 11 步）" });
    s.send("done", {});
    return s.end();
  }
  const verify = {
    steps: [], answer: text, answerOk: true, answerIssues: [],
    coverage: card.possible.length + card.impossible.length,
    source: "step_risks.json（规则生成，未调用模型）",
    summary: { total: 0, ok: 0, bad: 0, warn: 0 },
  };
  if (!wantStream) return json(res, 200, { mode: "step", card, text, ...verify });
  const s = sse(res);
  s.send("meta", { mode: "step", coverage: verify.coverage, citations: [{ kind: "step", id: card.unit_id, title: `第${card.step}步 ${card.name}`, meta: "step_risks.json" }] });
  s.send("delta", { text });
  s.send("verify", verify);
  s.send("done", { chars: text.length });
  s.end();
}

async function handleAsk(req, res, body) {
  const message = String(body.message || "").trim();
  const wantStream = body.stream !== false;
  if (!message) return json(res, 400, { error: "EMPTY", message: "请输入问题" });
  if (message.length > 500) return json(res, 400, { error: "TOO_LONG", message: "问题太长了，请精简到 500 字以内" });

  // 步骤类问题不消耗模型额度
  const stepId = findStep(message);
  if (stepId) return answerStep(stepId, res, wantStream);

  const ip = clientIp(req);
  const rl = rateLimit(ip);
  if (!rl.ok) {
    if (!wantStream) return json(res, 429, { error: "RATE_LIMIT", message: rl.reason, retryAfter: rl.retryAfter });
    const s = sse(res);
    s.send("meta", { mode: "ask", refused: true, rateLimited: true });
    s.send("delta", { text: rl.reason + "。步骤类问题（如“第4步有什么风险”）不受限制，随时可问。" });
    s.send("done", { refused: true });
    return s.end();
  }

  const g = gateWide(message, retrieve);
  if (!g.allowed) {
    if (!wantStream) return json(res, 200, { refused: true, reason: g.reason, text: g.refusal });
    const s = sse(res);
    s.send("meta", { mode: "ask", refused: true });
    s.send("delta", { text: g.refusal });
    s.send("done", { refused: true });
    return s.end();
  }

  const hits = retrieve(message, 8);
  if (!hits.length) {
    const msg = "知识库中没有检索到相关内容，换个问法试试，或直接问“第4步有什么风险”。";
    if (!wantStream) return json(res, 200, { refused: true, reason: "无检索结果", text: msg });
    const s = sse(res);
    s.send("meta", { mode: "ask", refused: true });
    s.send("delta", { text: msg });
    s.send("done", { refused: true });
    return s.end();
  }

  // 取用配置：共享 Key 或访客自带
  const userKey = String(req.headers["x-user-key"] || "").trim();
  const mode = accessMode();
  let cfg;
  if (mode === "shared") {
    cfg = loadConfig();
  } else {
    if (!userKey) {
      const msg = "本站需要你自己的 API Key 才能问答。点右上角「接入我的模型」填一次，仅保存在你自己的浏览器。";
      if (!wantStream) return json(res, 401, { error: "NEED_KEY", message: msg });
      const s = sse(res);
      s.send("meta", { mode: "ask", needKey: true });
      s.send("delta", { text: msg });
      s.send("done", { needKey: true });
      return s.end();
    }
    cfg = { baseURL: loadConfig().baseURL, apiKey: userKey, model: loadConfig().model, temperature: 0.2 };
    if (!isConfigured(cfg)) {
      const msg = "服务端没有配置 Base URL 与模型名，无法代访客转发。";
      if (!wantStream) return json(res, 503, { error: "SERVER_NOT_READY", message: msg });
      const s = sse(res);
      s.send("meta", { mode: "ask", refused: true });
      s.send("delta", { text: msg });
      s.send("done", {});
      return s.end();
    }
  }

  const userPrompt = [
    `问题：${message}`, "",
    "【知识片段】", formatContext(hits) || "（无）", "",
    "【风险速查】", loadKB().units.map((u) => `${u.id} ${u.name}`).join("；"),
  ].join("\n");
  const messages = [{ role: "system", content: ASK_PROMPT }, { role: "user", content: userPrompt }];

  if (!wantStream) {
    try {
      const out = await chatOnce(cfg, messages, { maxTokens: MAX_TOKENS });
      return json(res, 200, { mode: "ask", ...verifyPayload(out.content, hits), text: out.content });
    } catch (e) {
      return json(res, 502, { error: "MODEL_ERROR", message: String(e.message || e) });
    }
  }

  const s = sse(res);
  let closed = false;
  s.onClose(() => { closed = true; });
  s.send("meta", { mode: "ask", coverage: hits.length, citations: hits.map((h) => ({ kind: h.kind, id: h.id, title: h.title })) });

  let acc = "";
  try {
    const upstream = await chatStream(cfg, messages, { maxTokens: MAX_TOKENS });
    const dec = new TextDecoder("utf-8");
    let buf = "";
    for await (const chunk of upstream.body) {
      if (closed) break;
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "[DONE]") continue;
        try {
          const d = deltaOf(JSON.parse(p));
          if (d) { acc += d; s.send("delta", { text: d }); }
        } catch { /* ignore */ }
      }
    }
    s.send("verify", verifyPayload(acc, hits));
    s.send("done", { chars: acc.length });
  } catch (e) {
    s.send("error", { message: String(e.message || e) });
    s.send("done", { error: true });
  }
  s.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }

  try {
    if (url.pathname === "/api/health") {
      const cfg = loadConfig();
      return json(res, 200, {
        ok: true,
        mode: accessMode(),
        model: accessMode() === "shared" ? cfg.model : (cfg.model || ""),
        limits: { perMin: RATE_PER_MIN, perDay: RATE_PER_DAY },
        kb: kbSummary(),
        uptime: Math.round(process.uptime()),
      });
    }

    if (url.pathname === "/api/steps") return json(res, 200, { steps: allSteps() });

    if (url.pathname === "/api/step") {
      const unit = url.searchParams.get("unit") || "";
      const n = url.searchParams.get("step") || "";
      const card = stepCard(unit || (n ? "U" + String(n).padStart(2, "0") : ""));
      if (!card) return json(res, 404, { error: "STEP_NOT_FOUND" });
      return json(res, 200, { card, text: stepAnswer(card.unit_id) });
    }

    if (url.pathname === "/api/ask" && req.method === "POST") {
      const body = await readBody(req);
      return await handleAsk(req, res, body);
    }

    if (url.pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });

    // 静态资源
    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403).end("forbidden"); return; }
    fs.stat(filePath, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("404"); return; }
      res.writeHead(200, {
        "content-type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
        "content-length": st.size,
        "cache-control": "public, max-age=300",
      });
      fs.createReadStream(filePath).pipe(res);
    });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`public site on http://${HOST}:${PORT}`);
  console.log(`access mode: ${accessMode()} | per-ip ${RATE_PER_MIN}/min, ${RATE_PER_DAY}/day | global ${GLOBAL_PER_DAY}/day`);
});
