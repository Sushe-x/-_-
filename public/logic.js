/* 纯前端逻辑：不依赖 DOM、不联网，可在浏览器与 Node 中复用 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RiskLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var KB = null;

  function use(kb) {
    KB = kb;
    return api;
  }

  var ALIASES = {
    U01: ["煤场", "卸煤", "煤炭接收", "储煤", "堆存"],
    U02: ["输煤", "配煤", "皮带", "煤仓"],
    U03: ["磨煤", "制粉", "煤粉", "磨机"],
    U04: ["气化", "气化炉", "合成气制备", "烧嘴"],
    U05: ["净化", "变换", "洗涤", "聚结"],
    U06: ["甲烷化", "合成天然气"],
    U07: ["冷凝", "分离", "冷凝液"],
    U08: ["压缩", "干燥", "增压", "脱碳"],
    U09: ["输气", "外输", "调压", "管线"],
    U10: ["副产物", "炉渣", "石膏", "渣场"],
    U11: ["公用工程", "锅炉", "烟气", "脱硝", "除尘"],
  };

  function findStep(text) {
    var t = String(text || "");
    var byUnit = t.match(/\bU(0[1-9]|1[01])\b/i);
    if (byUnit) return "U" + byUnit[1].padStart(2, "0");
    var byNum = t.match(/第\s*(\d{1,2})\s*步/);
    if (byNum) {
      var n = Number(byNum[1]);
      if (n >= 1 && n <= 11) return "U" + String(n).padStart(2, "0");
    }
    var steps = (KB.stepRisks.steps || []);
    for (var i = 0; i < steps.length; i++) {
      if (t.indexOf(steps[i].name) >= 0) return steps[i].unit_id;
      var u = unitOf(steps[i].unit_id);
      if (u && u.short_name && t.indexOf(u.short_name) >= 0) return steps[i].unit_id;
    }
    for (var uid in ALIASES) {
      if (ALIASES[uid].some(function (w) { return t.indexOf(w) >= 0; })) return uid;
    }
    return null;
  }

  function unitOf(id) {
    return (KB.units || []).filter(function (u) { return u.id === id; })[0] || null;
  }
  function hazardOf(id) {
    return (KB.hazards || []).filter(function (h) { return h.id === id; })[0] || null;
  }
  function lecOf(hid) {
    return (KB.lec.assessments || []).filter(function (r) { return r.hazard_id === hid; })[0] || null;
  }
  function scenOf(id) {
    return (KB.emergency.scenarios || []).filter(function (s) { return s.id === id; })[0] || null;
  }
  function responseOf(level) {
    var m = (KB.emergency.response_matrix || {}).levels || [];
    return m.filter(function (x) { return x.risk_level === level; })[0] || null;
  }

  function stepCard(unitId) {
    var raw = (KB.stepRisks.steps || []).filter(function (s) { return s.unit_id === unitId; })[0];
    if (!raw) return null;
    var possible = raw.possible.map(function (p) {
      var h = p.hazard_id ? hazardOf(p.hazard_id) : null;
      var row = h ? lecOf(h.id) : null;
      var rl = row ? row.risk_level : null;
      var resp = rl ? responseOf(rl) : null;
      return {
        cat: p.cat,
        hazard_id: p.hazard_id || null,
        title: h ? h.title : p.note,
        note: p.note || "",
        D: row ? row.D : null,
        level: row ? row.level : "未单独评价",
        risk_level: rl || "未单独评价",
        plan: (p.plan || []).map(scenOf).filter(Boolean),
        response_grade: resp ? resp.response_grade : "",
        first_action: resp ? resp.first_action : "",
      };
    }).sort(function (a, b) { return (b.D || 0) - (a.D || 0); });
    return { unit_id: unitId, step: raw.step, name: raw.name, summary: raw.summary, possible: possible, impossible: raw.impossible };
  }

  /** 与本地版完全一致的固定格式 */
  function stepAnswer(unitId) {
    var c = stepCard(unitId);
    if (!c) return null;
    var lines = ["第" + c.step + "步 " + c.name];
    lines.push("可能发生：");
    c.possible.forEach(function (p, i) {
      var lvl = p.D == null ? "未单独评价" : p.level + "（D=" + p.D + "，" + p.risk_level + "）";
      var plan = p.plan.length
        ? "预案 " + p.plan.map(function (x) { return x.id + " " + x.name; }).join("、")
        : "预案 按现场处置方案";
      var resp = p.response_grade ? "；" + p.response_grade : "";
      var act = p.first_action ? "，" + p.first_action : "";
      lines.push((i + 1) + ". " + p.cat + " —— " + lvl + "；" + plan + resp + act);
    });
    lines.push("不可能发生：");
    c.impossible.forEach(function (x) { lines.push("- " + x.cat + "：" + x.reason); });
    return lines.join("\n");
  }

  /* ---------------- 关键词检索（无模型） ---------------- */

  var INDEX = null;

  function bigrams(s) {
    var t = String(s).replace(/[\s，。、；：,.;:()（）"'“”《》\-—/]/g, "");
    var out = [];
    for (var i = 0; i < t.length - 1; i++) out.push(t.slice(i, i + 2));
    if (t.length === 1) out.push(t);
    return out;
  }

  function buildIndex() {
    var items = [];
    (KB.units || []).forEach(function (u) {
      items.push({ kind: "工艺单元", id: u.id, title: u.name, body: u.summary + " " + u.equipment.map(function (e) { return e.name; }).join(" ") + " " + u.media_in.concat(u.media_out).join(" "), meta: u.risk_rank });
    });
    (KB.hazards || []).forEach(function (h) {
      items.push({ kind: "危险源", id: h.id, title: h.title, body: [h.mechanism, h.consequences.join(" "), h.category, h.gb6441_class || ""].join(" "), meta: h.risk_rank });
    });
    (KB.lec.assessments || []).forEach(function (r) {
      items.push({ kind: "LEC", id: r.id, title: r.activity + " — " + r.hazard_title, body: [r.consequence, r.control, "D=" + r.D, r.level].join(" "), meta: r.level });
    });
    (KB.emergency.scenarios || []).forEach(function (s) {
      items.push({ kind: "应急场景", id: s.id, title: s.name, body: s.trigger + " " + s.steps.map(function (x) { return x.phase + x.action; }).join(" "), meta: s.steps.length + " 步" });
    });
    (KB.standards || []).forEach(function (s) {
      items.push({ kind: "标准", id: s.id, title: s.code + " " + s.title, body: s.scope || "", meta: s.status });
    });
    (KB.limits || []).forEach(function (l) {
      items.push({ kind: "限值", id: l.id, title: l.name, body: (l.note || "") + " " + l.value + l.unit, meta: l.value + " " + l.unit });
    });
    INDEX = items;
    return items;
  }

  function search(query, limit) {
    if (!INDEX) buildIndex();
    var q = String(query || "").trim();
    if (!q) return [];
    var grams = bigrams(q), ql = q.toLowerCase(), scored = [];
    INDEX.forEach(function (it) {
      var title = it.title.toLowerCase(), body = (it.body || "").toLowerCase(), id = it.id.toLowerCase();
      var s = 0;
      if (id === ql || it.id === q) s += 100;
      if (title.indexOf(ql) >= 0) s += 40;
      grams.forEach(function (g) {
        if (title.indexOf(g) >= 0) s += 7;
        if (body.indexOf(g) >= 0) s += 2;
        if (id.indexOf(g) >= 0) s += 4;
      });
      if (s > 0) scored.push({ item: it, score: s });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 6);
  }

  /** 检索型回答：把命中的条目编排成可读卡片 */
  function searchAnswer(query) {
    var hits = search(query, 5);
    if (!hits.length) {
      return { kind: "none", text: "知识库中没有找到相关内容。\n可以问“第几步有什么风险”，例如“第4步有什么风险”；或问具体介质、标准、限值。" };
    }
    var lines = ["在知识库中找到 " + hits.length + " 条相关内容："];
    hits.forEach(function (h, i) {
      lines.push("");
      lines.push((i + 1) + ". " + h.item.title + "（" + h.item.id + "）");
      lines.push("   " + String(h.item.body || "").slice(0, 90).replace(/\s+/g, " "));
      lines.push("   " + h.item.kind + " · " + h.item.meta);
    });
    return { kind: "search", text: lines.join("\n"), hits: hits.map(function (h) { return h.item; }) };
  }

  var api = {
    use: use,
    findStep: findStep,
    stepCard: stepCard,
    stepAnswer: stepAnswer,
    search: search,
    searchAnswer: searchAnswer,
    allSteps: function () {
      return (KB.stepRisks.steps || []).slice().sort(function (a, b) { return a.step - b.step; });
    },
  };
  return api;
});
