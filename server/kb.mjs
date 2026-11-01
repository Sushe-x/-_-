/**
 * kb.mjs —— 知识库加载、索引、检索与确定性决策卡
 *
 * 设计原则：三类决策（流程 / 风险分级 / 分级预案）先由本模块用规则算出来，
 * 模型只负责解释与措辞，不得改动数值与结论。这样“模型决策范围”在结构上就被限死。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KB_DIR = path.join(__dirname, "..", "kb");

function read(name) {
  return JSON.parse(fs.readFileSync(path.join(KB_DIR, name), "utf8"));
}

export const kb = {};

/** 幂等加载：任何模块直接 import 时都能安全调用 */
export function ensureKB() {
  if (!kb.units) loadKB();
  return kb;
}

export function loadKB() {
  const pu = read("process_units.json");
  const lec = read("lec.json");
  const em = read("emergency.json");

  kb.units = pu.units;
  kb.links = pu.links;
  kb.hazards = read("hazards.json").hazards;
  kb.lec = lec;
  kb.emergency = em;
  kb.standards = read("standards.json").standards;
  kb.limits = read("limits.json").limits;
  kb.media = read("media.json").substances;
  kb.crosswalk = read("crosswalk.json");
  kb.major = read("major_hazard.json");
  kb.actions = read("actions.json");
  kb.stepRisks = read("step_risks.json");
  kb.manifest = read("manifest.json");

  kb.unitById = Object.fromEntries(kb.units.map((u) => [u.id, u]));
  kb.hazardById = Object.fromEntries(kb.hazards.map((h) => [h.id, h]));
  kb.stdById = Object.fromEntries(kb.standards.map((s) => [s.id, s]));
  kb.limitById = Object.fromEntries(kb.limits.map((l) => [l.id, l]));
  kb.lecRowByHazard = Object.fromEntries(lec.assessments.map((r) => [r.hazard_id, r]));
  kb.scenarioById = Object.fromEntries(em.scenarios.map((s) => [s.id, s]));

  const scheme = lec.grading.schemes.find((s) => s.id === lec.grading.default_scheme) || lec.grading.schemes[0];
  kb.gradeScheme = scheme;
  kb.hazardsByUnit = {};
  for (const h of kb.hazards) (kb.hazardsByUnit[h.unit_id] ||= []).push(h);

  /* 分级响应矩阵：风险等级 -> 响应要求 */
  kb.responseByLevel = Object.fromEntries(
    (em.response_matrix?.levels || []).map((l) => [l.risk_level, l])
  );

  return kb;
}

/* ---------------- 分级工具 ---------------- */

/** 按 LEC 默认口径把 D 映射为等级对象 */
export function gradeOfD(D) {
  for (const l of kb.gradeScheme.levels) {
    const lo = l.min_inclusive === false ? D > l.min : D >= l.min;
    const hi = l.max == null ? true : D <= l.max;
    if (lo && hi) return l;
  }
  return null;
}

/** 单元的最大 D 与等级 */
export function unitRisk(unitId) {
  const hs = kb.hazardsByUnit[unitId] || [];
  let maxD = 0, top = null;
  for (const h of hs) {
    const r = kb.lecRowByHazard[h.id];
    if (r && r.D > maxD) { maxD = r.D; top = { hazard: h, row: r }; }
  }
  const g = gradeOfD(maxD) || { level: "未评", risk_level: "低风险", action: "" };
  return {
    unit_id: unitId,
    unit_name: kb.unitById[unitId]?.name || unitId,
    risk_rank: kb.unitById[unitId]?.risk_rank || "",
    hazard_count: hs.length,
    max_D: maxD,
    grade: g.level,
    risk_level: g.risk_level,
    action: g.action,
    top_hazard: top ? { id: top.hazard.id, title: top.hazard.title, D: top.row.D, L: top.row.L, E: top.row.E, C: top.row.C } : null,
  };
}

/* ---------------- 决策卡 ---------------- */

export function decideProcess(unitId) {
  const units = kb.units
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((u) => ({
      id: u.id, order: u.order, name: u.name, short: u.short_name, stage: u.stage,
      media_in: u.media_in, media_out: u.media_out, risk_rank: u.risk_rank,
      is_key_unit: u.is_key_unit, hazard_count: (kb.hazardsByUnit[u.id] || []).length,
    }));
  const focus = unitId && kb.unitById[unitId] ? unitDecisionDetail(unitId) : null;
  return {
    mode: "process",
    title: "工艺流程决策",
    unit_count: units.length,
    units,
    links: kb.links,
    focus,
  };
}

function unitDecisionDetail(unitId) {
  const u = kb.unitById[unitId];
  const risk = unitRisk(unitId);
  const hazards = (kb.hazardsByUnit[unitId] || []).map((h) => ({
    id: h.id, title: h.title, risk_rank: h.risk_rank,
    D: kb.lecRowByHazard[h.id]?.D ?? null,
    grade: kb.lecRowByHazard[h.id]?.level ?? null,
    emergency_ids: h.emergency_ids,
  }));
  return {
    id: u.id, name: u.name, summary: u.summary,
    equipment: u.equipment.map((e) => e.name),
    media_in: u.media_in, media_out: u.media_out,
    conditions: u.conditions, risk_rank: u.risk_rank, is_key_unit: u.is_key_unit,
    risk, hazards,
    standards: (u.standard_refs || []).map((s) => ({ code: kb.stdById[s.std]?.code || s.std, note: s.note })),
  };
}

export function decideRisk(unitId) {
  const rows = kb.units
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((u) => unitRisk(u.id));
  const ranked = rows.slice().sort((a, b) => b.max_D - a.max_D);
  const byLevel = {};
  for (const r of rows) byLevel[r.grade] = (byLevel[r.grade] || 0) + 1;
  return {
    mode: "risk",
    title: "单元风险分级决策",
    basis: `D = L × E × C；分级口径 ${kb.lec.grading.default_scheme}`,
    rows,
    ranked,
    summary: { total_units: rows.length, by_grade: byLevel, max: ranked[0] || null },
    focus: unitId && kb.unitById[unitId] ? unitDecisionDetail(unitId) : null,
  };
}

export function decideEmergency(unitId) {
  const rows = [];
  for (const u of kb.units) {
    const risk = unitRisk(u.id);
    const resp = kb.responseByLevel[risk.risk_level] || null;
    const scenIds = new Set();
    for (const h of kb.hazardsByUnit[u.id] || []) {
      for (const id of h.emergency_ids || []) scenIds.add(id);
    }
    const scenarios = [...scenIds].map((id) => kb.scenarioById[id]).filter(Boolean).map((s) => ({
      id: s.id, name: s.name, trigger: s.trigger,
      steps: s.steps.length,
      key_steps: s.steps.slice(0, 3).map((x) => ({ phase: x.phase, action: x.action, role: x.role })),
    }));
    rows.push({
      unit_id: u.id, unit_name: u.name, grade: risk.grade, risk_level: risk.risk_level,
      max_D: risk.max_D,
      response_grade: resp?.response_grade || "",
      commander: resp?.commander || "",
      first_action: resp?.first_action || "",
      deadline: resp?.deadline || "",
      scenarios,
    });
  }
  const ranked = rows.slice().sort((a, b) => b.max_D - a.max_D);
  return {
    mode: "emergency",
    title: "风险分级预案",
    matrix: kb.emergency.response_matrix || null,
    rows,
    ranked,
    focus: unitId && kb.unitById[unitId] ? ranked.find((r) => r.unit_id === unitId) : null,
  };
}

/* ---------------- 检索 ---------------- */

function bigrams(s) {
  const t = String(s).replace(/[\s，。、；：,.;:()（）"'“”《》\-—/]/g, "");
  const out = [];
  for (let i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
  if (t.length === 1) out.push(t);
  return out;
}

let INDEX = null;

function buildIndex() {
  const items = [];
  for (const u of kb.units) {
    items.push({
      kind: "unit", id: u.id, title: u.name,
      body: [u.summary, ...u.equipment.map((e) => e.name), ...u.media_in, ...u.media_out].join(" "),
      meta: u.risk_rank,
    });
  }
  for (const h of kb.hazards) {
    items.push({
      kind: "hazard", id: h.id, title: h.title,
      body: [h.mechanism, ...h.consequences, h.category, h.gb6441_class || "", ...(h.detection || [])].join(" "),
      meta: `${h.risk_rank} · ${kb.unitById[h.unit_id]?.name || h.unit_id}`,
    });
  }
  for (const r of kb.lec.assessments) {
    items.push({
      kind: "lec", id: r.id, title: `${r.activity} — ${r.hazard_title}`,
      body: [r.consequence, r.control, `D=${r.D}`, r.level].join(" "),
      meta: r.level,
    });
  }
  for (const s of kb.emergency.scenarios) {
    items.push({
      kind: "scenario", id: s.id, title: s.name,
      body: [s.trigger, ...s.steps.map((x) => x.phase + x.action)].join(" "),
      meta: `${s.steps.length} 步`,
    });
  }
  for (const s of kb.standards) {
    items.push({ kind: "standard", id: s.id, title: `${s.code} ${s.title}`, body: s.scope || "", meta: s.status });
  }
  for (const l of kb.limits) {
    items.push({
      kind: "limit", id: l.id, title: l.name,
      body: l.note || "", meta: `${l.value} ${l.unit} · ${l.confidence}`,
    });
  }
  for (const f of kb.crosswalk.findings) {
    items.push({
      kind: "finding", id: f.id, title: `${f.target} — ${f.verdict}`,
      body: [f.claim, f.evidence, f.action].join(" "), meta: f.severity,
    });
  }
  INDEX = items;
  return items;
}

export function retrieve(query, limit = 6) {
  if (!INDEX) buildIndex();
  const q = String(query || "").trim();
  if (!q) return [];
  const grams = bigrams(q);
  const ql = q.toLowerCase();
  const scored = [];
  for (const it of INDEX) {
    const title = it.title.toLowerCase();
    const body = (it.body || "").toLowerCase();
    const id = it.id.toLowerCase();
    let s = 0;
    if (id === ql) s += 100;
    if (title.includes(ql)) s += 40;
    for (const g of grams) {
      if (title.includes(g)) s += 7;
      if (body.includes(g)) s += 2;
      if (id.includes(g)) s += 4;
    }
    if (s > 0) scored.push({ ...it, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function formatContext(items) {
  return items.map((it) => `- [${it.kind}:${it.id}] ${it.title}｜${it.meta}`).join("\n");
}

/* ---------------- 按工艺步骤的风险卡 ---------------- */

const STEP_ALIASES = {
  U01: ["煤场", "卸煤", "煤炭接收", "储煤", "堆存"],
  U02: ["输煤", "配煤", "皮带", "煤仓"],
  U03: ["磨煤", "制粉", "煤粉", "磨机"],
  U04: ["气化", "气化炉", "合成气制备", "烧嘴"],
  U05: ["净化", "变换", "洗涤", "聚结", "脱硫脱碳前端"],
  U06: ["甲烷化", "合成天然气", "反应器"],
  U07: ["冷凝", "分离", "冷凝液"],
  U08: ["压缩", "干燥", "脱碳", "增压", "处理压缩"],
  U09: ["输气", "外输", "调压", "管线", "输送"],
  U10: ["副产物", "炉渣", "石膏", "渣场"],
  U11: ["公用工程", "锅炉", "烟气", "脱硝", "除尘", "烟囱"],
};

/** 从自然语言里定位是哪一步（返回 unit_id，找不到返回 null） */
export function findStep(text) {
  const t = String(text || "");
  const byUnit = t.match(/\bU(0[1-9]|1[01])\b/i);
  if (byUnit) return "U" + byUnit[1].padStart(2, "0");

  const byNum = t.match(/第\s*(\d{1,2})\s*步/);
  if (byNum) {
    const n = Number(byNum[1]);
    if (n >= 1 && n <= 11) return "U" + String(n).padStart(2, "0");
  }

  for (const st of kb.stepRisks.steps) {
    if (t.includes(st.name)) return st.unit_id;
    const short = kb.unitById[st.unit_id]?.short_name;
    if (short && t.includes(short)) return st.unit_id;
  }
  for (const [uid, words] of Object.entries(STEP_ALIASES)) {
    if (words.some((w) => t.includes(w))) return uid;
  }
  return null;
}

/** 组装某一步的完整风险卡（等级与预案从 lec / emergency 实时联接） */
export function stepCard(unitId) {
  const st = kb.stepRisks.steps.find((s) => s.unit_id === unitId);
  if (!st) return null;
  const unit = kb.unitById[unitId] || {};

  const possible = st.possible.map((p) => {
    const h = p.hazard_id ? kb.hazardById[p.hazard_id] : null;
    const row = h ? kb.lecRowByHazard[h.id] : null;
    const riskLevel = row ? row.risk_level : null;
    const resp = riskLevel ? kb.responseByLevel[riskLevel] : null;
    return {
      cat: p.cat,
      hazard_id: p.hazard_id || null,
      title: h ? h.title : p.note,
      note: p.note || "",
      D: row ? row.D : null,
      level: row ? row.level : "未单独评价",
      risk_level: riskLevel || "未单独评价",
      plan: (p.plan || []).map((id) => kb.scenarioById[id]).filter(Boolean).map((s) => ({ id: s.id, name: s.name })),
      response_grade: resp ? resp.response_grade : "",
      first_action: resp ? resp.first_action : "",
      deadline: resp ? resp.deadline : "",
    };
  });
  possible.sort((a, b) => (b.D || 0) - (a.D || 0));

  return {
    unit_id: unitId,
    step: st.step,
    name: st.name,
    summary: st.summary,
    short: unit.short_name || st.name,
    possible,
    impossible: st.impossible,
  };
}

export function allSteps() {
  return kb.stepRisks.steps
    .slice()
    .sort((a, b) => a.step - b.step)
    .map((s) => {
      const c = stepCard(s.unit_id);
      return { unit_id: s.unit_id, step: s.step, name: s.name, possible: c.possible, impossible: c.impossible };
    });
}

/** 按用户要求的格式输出：只给可能/不可能两块，不夹带其他话 */
export function stepAnswer(unitId) {
  const c = stepCard(unitId);
  if (!c) return null;
  const lines = [`第${c.step}步 ${c.name}`];
  lines.push("可能发生：");
  c.possible.forEach((p, i) => {
    const lvl = p.D == null ? "未单独评价" : `${p.level}（D=${p.D}，${p.risk_level}）`;
    const plan = p.plan.length ? `预案 ${p.plan.map((x) => x.id + " " + x.name).join("、")}` : "预案 按现场处置方案";
    const resp = p.response_grade ? `；${p.response_grade}` : "";
    const act = p.first_action ? `，${p.first_action}` : "";
    lines.push(`${i + 1}. ${p.cat} —— ${lvl}；${plan}${resp}${act}`);
  });
  lines.push("不可能发生：");
  for (const x of c.impossible) lines.push(`- ${x.cat}：${x.reason}`);
  return lines.join("\n");
}

export function kbSummary() {  return {
    version: kb.manifest.kb_version,
    units: kb.units.length,
    hazards: kb.hazards.length,
    lec_rows: kb.lec.assessments.length,
    scenarios: kb.emergency.scenarios.length,
    standards: kb.standards.length,
    limits: kb.limits.length,
    findings: kb.crosswalk.findings.length,
    actions: kb.actions.actions.length,
    step_risks: kb.stepRisks.steps.length,
    generated_at: kb.manifest.generated_at,
  };
}
