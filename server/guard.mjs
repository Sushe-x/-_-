/**
 * guard.mjs —— 决策范围门禁与输出校验
 *
 * 两层限制：
 *   1) 入口门禁：只有“工艺流程 / 风险分级 / 分级预案”三类问题能进入模型，
 *      其余问题在服务端直接拒答，不消耗 token。
 *   2) 出口校验：模型回答里的条目 ID、D 值、结论性表述逐项对照知识库，
 *      命不中的一律标为“需人工复核”。
 */
import { kb, ensureKB } from "./kb.mjs";

const SCOPE_DEFS = [
  {
    id: "process",
    label: "工艺流程",
    boost: /流程|工序|走向|物料|上游|下游|哪一段|第几|先后|顺序/g,
    patterns: [
      /流程|工序|单元|工段|环节|上下游|物料流|走向/,
      /煤场|输煤|配煤|磨煤|制粉|气化|净化|变换|甲烷化|冷凝|分离|压缩|干燥|脱硫|脱碳|输气|副产物|公用工程|锅炉|烟气/,
      /设备|装置|反应器|压缩机|洗涤|聚结|烧嘴|煤粉仓|脱硝|除尘/,
      /煤制天然气|SNG|合成气|粗煤气|产品天然气/,
    ],
  },
  {
    id: "risk",
    label: "风险分级",
    boost: /等级|分级|风险|D\s*值|分数|排名|最高|最低/g,
    patterns: [
      /风险|分级|等级|级别|危险性|打分|评分|排序|排名|哪个单元|最高|最低/,
      /LEC|D\s*值|L\s*值|E\s*值|C\s*值|核心|主要|次要|轻微/,
      /重大风险|较大风险|一般风险|低风险|极其危险|高度危险|显著危险|稍有危险/,
      /重大危险源|临界量/,
    ],
  },
  {
    id: "emergency",
    label: "分级预案",
    boost: /预案|应急|处置|响应|救援|怎么办|怎么处理/g,
    patterns: [
      /应急|预案|处置|响应|救援|疏散|撤离|警戒|堵漏|急救|终止/,
      /泄漏|火灾|爆炸|中毒|窒息|灼烫|烫伤|停水|停电|仪表风|飞温|超压/,
      /怎么办|如何处置|怎么处理|措施/,
    ],
  },
];

const DENY = [  { re: /写代码|编程|代码实现|python|javascript|java\b|sql\b|算法题|正则表达式|html|css\b/i, why: "编程类问题" },
  { re: /翻译|润色|写诗|作文|小说|文案|简历|情书|笑话|段子/, why: "写作与创作类问题" },
  { re: /股票|基金|彩票|期货|投资建议|理财|房价|汇率/, why: "金融投资类问题" },
  { re: /天气|新闻|政治|选举|历史事件|国际形势|明星|娱乐/, why: "时事与娱乐类问题" },
  { re: /诊断|吃什么药|处方|症状|病历|法律咨询|起诉|离婚|合同纠纷/, why: "医疗与法律类问题" },
  { re: /炸药|制毒|枪支|武器|毒气配方|自制爆炸物/, why: "涉及危险品制作的问题" },
  { re: /你是谁|介绍一下你自己|你叫什么|你有什么功能|写个自我介绍/, why: "闲聊与自我介绍" },
];

const OUT_OF_SCOPE_HINT =
  "本助手只做三件事：① 煤化工工艺流程（11 个单元的走向、设备、物料）；" +
  "② 各单元风险分级（LEC 法的 D 值与等级）；③ 按风险等级对应的应急预案。" +
  "可以这样问：「气化炉属于哪一段流程」「磨煤制粉的风险等级是多少」「重大风险单元泄漏怎么处置」。";

/**
 * 入口门禁
 * @returns {{allowed:boolean, scopes:string[], labels:string[], reason:string, refusal:string|null, constrained:boolean}}
 */
export function gate(rawText) {
  ensureKB();
  const text = String(rawText || "").trim();
  if (!text) {
    return {
      allowed: false, scopes: [], labels: [], reason: "空输入",
      refusal: "请描述你要决策的问题，例如「气化炉的风险等级」。", constrained: false,
    };
  }

  for (const d of DENY) {
    if (d.re.test(text)) {
      return {
        allowed: false, scopes: [], labels: [], reason: `命中禁用主题：${d.why}`,
        refusal: `这个问题超出本助手的决策范围（${d.why}）。${OUT_OF_SCOPE_HINT}`,
        constrained: false,
      };
    }
  }

  // 按命中密度排序，避免“气化炉的风险等级”被路由到流程模式
  const scored = SCOPE_DEFS.map((s) => {
    let score = 0;
    for (const re of s.patterns) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      const m = text.match(g);
      if (m) score += m.length;
    }
    if (s.boost) {
      const m = text.match(s.boost);
      if (m) score += m.length * 3;
    }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  const scopes = scored.map((x) => x.s.id);

  if (scopes.length === 0) {
    return {
      allowed: false, scopes: [], labels: [], reason: "未命中任何可决策主题",
      refusal: `没有识别到煤化工流程、风险分级或分级预案相关的内容。${OUT_OF_SCOPE_HINT}`,
      constrained: false,
    };
  }

  // 涉重大危险源判定：允许解释方法，但不允许下结论
  const constrained = /重大危险源|临界量/.test(text);

  return {
    allowed: true,
    scopes,
    labels: SCOPE_DEFS.filter((s) => scopes.includes(s.id)).map((s) => s.label),
    reason: "命中可决策主题",
    refusal: null,
    constrained,
  };
}

/* ---------------- 出口校验 ---------------- */

const ID_RE = /\b(?:H-U\d{2}-\d{2}|L-U\d{2}-\d{2}|U\d{2}|E-\d{2}(?:-S\d+)?|X-\d{3}|A-\d{3}|LMT-[A-Z0-9_]+|STD-[A-Za-z0-9.\-]+)\b/g;

const KNOWN = {
  hazard: () => new Set(Object.keys(kb.hazardById)),
  lec: () => new Set(kb.lec.assessments.map((r) => r.id)),
  unit: () => new Set(Object.keys(kb.unitById)),
  scenario: () => new Set(Object.keys(kb.scenarioById)),
  finding: () => new Set(kb.crosswalk.findings.map((f) => f.id)),
  action: () => new Set(kb.actions.actions.map((a) => a.id)),
  limit: () => new Set(Object.keys(kb.limitById)),
  std: () => new Set(Object.keys(kb.stdById)),
};

function kindOfId(id) {
  if (/^H-/.test(id)) return "hazard";
  if (/^L-/.test(id)) return "lec";
  if (/^U\d/.test(id)) return "unit";
  if (/^E-/.test(id)) return "scenario";
  if (/^X-/.test(id)) return "finding";
  if (/^A-/.test(id)) return "action";
  if (/^LMT-/.test(id)) return "limit";
  if (/^STD-/.test(id)) return "std";
  return null;
}

const FORBIDDEN_CONCLUSIONS = [
  { re: /(构成|属于|判定为)\s*重大危险源/, why: "重大危险源结论须由有资质机构辨识" },
  { re: /(不构成|不属于)\s*重大危险源/, why: "重大危险源结论须由有资质机构辨识" },
  { re: /(符合|满足)\s*安全生产条件/, why: "合规性结论须由法定评价出具" },
  { re: /可以(投用|投产|开工|验收)/, why: "投用决定不属于本助手权限" },
  { re: /(该|本)(装置|系统|单元)\s*(是)?安全(的)?/, why: "不得作绝对安全承诺" },
  { re: /保证(不会|不)发生/, why: "不得作绝对安全承诺" },
];

/**
 * 出口校验
 * @returns {{ok:boolean, issues:Array<{type:string,detail:string,severity:string}>, unknownIds:string[]}}
 */
export function inspect(text) {
  ensureKB();
  const issues = [];
  const unknownIds = [];

  const ids = [...new Set(String(text).match(ID_RE) || [])];
  for (const id of ids) {
    const kind = kindOfId(id);
    if (!kind) continue;
    const set = KNOWN[kind]();
    if (!set.has(id)) {
      unknownIds.push(id);
      issues.push({ type: "未知ID", detail: `回答引用了知识库中不存在的条目 ${id}`, severity: "high" });
    }
  }

  const dValues = [...String(text).matchAll(/D\s*[=＝]\s*(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const knownD = new Set(kb.lec.assessments.map((r) => Number(r.D)));
  for (const d of dValues) {
    if (!knownD.has(d)) {
      issues.push({ type: "D值不符", detail: `D=${d} 不在 LEC 评估表的 32 行里`, severity: "medium" });
    }
  }

  for (const f of FORBIDDEN_CONCLUSIONS) {
    if (f.re.test(text)) {
      issues.push({ type: "越权结论", detail: f.why, severity: "high" });
    }
  }

  const conf = [...String(text).matchAll(/(\d+(?:\.\d+)?)\s*(mg\/m³|%LEL|%\(V\/V\)|dB\(A\))/g)];
  if (conf.length) {
    const knownVals = new Set(kb.limits.flatMap((l) => [String(l.value), String(l.value).replace(/[^\d.]/g, "")]));
    for (const m of conf) {
      if (!knownVals.has(m[1])) {
        issues.push({ type: "限值可疑", detail: `${m[1]} ${m[2]} 未在 limits.json 中找到`, severity: "medium" });
      }
    }
  }

  return { ok: issues.length === 0, issues, unknownIds };
}

/* ---------------- 宽口径门禁（对话页用） ---------------- */

const DENY_REASON_PREFIX = "命中禁用主题";

/**
 * 对话模式：三类决策之外，只要检索能命中知识库就放行。
 * 仍然先走 DENY，避免“能检索到词”就成了绕过口子。
 */
export function gateWide(rawText, retrieve) {
  const g = gate(rawText);
  if (g.allowed) return { ...g, wide: false };
  if (g.reason.startsWith(DENY_REASON_PREFIX)) return { ...g, wide: false };

  const hits = retrieve(String(rawText || ""), 3);
  const best = hits.length ? hits[0].score : 0;
  if (best >= 12) {
    return {
      allowed: true,
      scopes: ["kb"],
      labels: ["知识库问答"],
      reason: `检索命中（score=${best}）`,
      refusal: null,
      constrained: false,
      wide: true,
      hits,
    };
  }
  return { ...g, wide: true, hits };
}

/* ---------------- 推理步骤逐条核对 ---------------- */

function titleOf(id) {
  const k = kindOfId(id);
  if (!k) return "";
  if (k === "hazard") return kb.hazardById[id]?.title || "";
  if (k === "unit") return kb.unitById[id]?.name || "";
  if (k === "lec") return kb.lec.assessments.find((r) => r.id === id)?.activity || "";
  if (k === "scenario") return kb.scenarioById[id]?.name || "";
  if (k === "limit") return kb.limitById[id]?.name || "";
  if (k === "std") return kb.stdById[id]?.code || "";
  if (k === "finding") return kb.crosswalk.findings.find((f) => f.id === id)?.target || "";
  if (k === "action") return kb.actions.actions.find((a) => a.id === id)?.title || "";
  return "";
}

/**
 * 对模型给出的每一步推理判“对 / 错 / 待核”
 *   对   = 引用的 ID 存在且数值对得上
 *   错   = 引用不存在的 ID、D 值对不上、越权结论
 *   待核 = 没有任何可核对的依据
 */
export function verifyReasoning(steps) {
  ensureKB();
  const knownD = new Set(kb.lec.assessments.map((r) => Number(r.D)));
  return (steps || []).map((raw, i) => {
    const text = String(raw).trim();
    const ids = [...new Set(text.match(ID_RE) || [])];
    const unknown = [];
    const evidence = [];
    for (const id of ids) {
      const k = kindOfId(id);
      if (!k) continue;
      if (KNOWN[k]().has(id)) evidence.push({ id, title: titleOf(id) });
      else unknown.push(id);
    }
    const badD = [...text.matchAll(/D\s*[=＝]\s*(\d+(?:\.\d+)?)/g)]
      .map((m) => Number(m[1]))
      .filter((d) => !knownD.has(d));
    const forb = FORBIDDEN_CONCLUSIONS.find((f) => f.re.test(text));

    const reasons = [];
    if (unknown.length) reasons.push(`引用了知识库中不存在的条目：${unknown.join("、")}`);
    if (badD.length) reasons.push(`D=${badD.join("、")} 不在 LEC 评估表中`);
    if (forb) reasons.push(`越权结论：${forb.why}`);

    let verdict = "ok";
    if (reasons.length) verdict = "bad";
    else if (evidence.length === 0) {
      verdict = "warn";
      reasons.push("这一步没有标注任何依据 ID，无法核对");
    }
    return { n: i + 1, text, verdict, reasons, evidence };
  });
}

export const scopeCatalog = SCOPE_DEFS.map((s) => ({ id: s.id, label: s.label }));
export const outOfScopeHint = OUT_OF_SCOPE_HINT;
