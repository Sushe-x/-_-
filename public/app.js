(function () {
  "use strict";

  var KB = window.KB;
  if (!KB) {
    document.getElementById("log").innerHTML = "<div class='msg bot'><div class='avatar'>KB</div><div class='bubble'><p>知识库加载失败：没有找到 kb.js。</p></div></div>";
    return;
  }
  var L = window.RiskLogic.use(KB);

  var logEl = document.getElementById("log");
  var input = document.getElementById("q");
  var sendBtn = document.getElementById("send");
  var badgeEl = document.getElementById("mode");
  var keyBtn = document.getElementById("btn-key");
  var busy = false;

  var SERVER = { ok: false, mode: null, model: "", limits: null };
  var BYOK = readByok();

  function readByok() {
    try { return JSON.parse(localStorage.getItem("sng.byok") || "{}") || {}; } catch (e) { return {}; }
  }
  function saveByok(o) {
    BYOK = o || {};
    try { localStorage.setItem("sng.byok", JSON.stringify(BYOK)); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function levelClass(level) {
    if (!level) return "none";
    if (level.indexOf("极其") >= 0) return "crit";
    if (level.indexOf("高度") >= 0) return "high";
    if (level.indexOf("显著") >= 0) return "mid";
    if (level.indexOf("一般") >= 0 || level.indexOf("稍有") >= 0) return "low";
    return "none";
  }

  /* ---------------- 渲染 ---------------- */
  function scroll() { logEl.scrollTop = logEl.scrollHeight; }

  function addUser(text) {
    var d = document.createElement("div");
    d.className = "msg user";
    d.innerHTML = '<div class="avatar">你</div><div class="bubble"><p>' + esc(text).replace(/\n/g, "<br>") + "</p></div>";
    logEl.appendChild(d);
    scroll();
  }

  function addBot(html) {
    var d = document.createElement("div");
    d.className = "msg bot";
    d.innerHTML = '<div class="avatar">KB</div><div class="bubble">' + html + "</div>";
    logEl.appendChild(d);
    scroll();
    return d.querySelector(".bubble");
  }

  function stepHtml(card) {
    var h = '<div class="step-head"><span class="step-no">第' + card.step + "步</span>" +
      '<span class="step-name">' + esc(card.name) + "</span></div>" +
      '<div class="step-sum">' + esc(card.summary || "") + "</div>";

    h += '<div class="sec possible"><span class="dot"></span>可能发生（' + card.possible.length + "）</div>";
    card.possible.forEach(function (p, i) {
      var lv = '<span class="lv ' + levelClass(p.level) + '">' + esc(p.level) + (p.D == null ? "" : " · D=" + p.D) + "</span>";
      h += '<div class="risk"><div class="idx">' + (i + 1) + '</div><div class="main">' +
        '<div class="name">' + esc(p.cat) + lv + "</div>" +
        (p.note ? '<div class="note">' + esc(p.note) + "</div>" : "") +
        '<div class="plan">' + (p.plan.length
          ? p.plan.map(function (s) { return '<span class="chip e">' + s.id + " " + esc(s.name) + "</span>"; }).join("")
          : '<span class="chip">按现场处置方案</span>') + "</div>" +
        (p.response_grade ? '<div class="resp"><b>' + esc(p.response_grade) + "</b>" + (p.first_action ? "：" + esc(p.first_action) : "") + "</div>" : "") +
        "</div></div>";
    });

    h += '<div class="sec impossible"><span class="dot"></span>不可能发生（' + card.impossible.length + "）</div>";
    card.impossible.forEach(function (x) {
      h += '<div class="risk no"><div class="idx">—</div><div class="main">' +
        '<div class="name">' + esc(x.cat) + "</div><div class=\"reason\">" + esc(x.reason) + "</div></div></div>";
    });
    return h;
  }

  function hitsHtml(hits) {
    var h = '<p class="muted">在知识库中找到 ' + hits.length + " 条相关内容：</p>";
    hits.forEach(function (it) {
      h += '<div class="hit"><div class="t">' + esc(it.title) + '<span class="id">' + esc(it.id) + "</span></div>" +
        '<div class="b">' + esc(String(it.body || "").slice(0, 110).replace(/\s+/g, " ")) + "</div>" +
        '<div class="plan"><span class="chip">' + esc(it.kind) + "</span><span class=\"chip\">" + esc(it.meta) + "</span></div></div>";
    });
    return h;
  }

  function fmtBlock(s) {
    return esc(s).replace(/\n/g, "<br>");
  }

  function thinkHtml(v) {
    if (!v || !v.steps || !v.steps.length) return "";
    var sum = v.summary || {};
    var rows = v.steps.map(function (st) {
      var cls = st.verdict === "bad" ? "bad" : st.verdict === "warn" ? "warn" : "ok";
      var label = st.verdict === "bad" ? "错" : st.verdict === "warn" ? "待核" : "对";
      return '<li><span class="tag ' + cls + '">' + label + "</span><div>" + esc(st.text) +
        (st.reasons && st.reasons.length ? '<div class="why">' + st.reasons.map(esc).join("；") + "</div>" : "") +
        (st.evidence && st.evidence.length ? '<div class="plan">' + st.evidence.map(function (e) {
          return '<span class="chip">' + esc(e.id) + "</span>";
        }).join("") + "</div>" : "") + "</div></li>";
    }).join("");
    return '<div class="think"><b>思考过程核对</b><span class="think-sum">' + (sum.total || 0) + " 步 · " +
      (sum.ok || 0) + " 对 / " + (sum.bad || 0) + " 错 / " + (sum.warn || 0) + " 待核</span><ul>" + rows + "</ul></div>";
  }

  function issueHtml(v) {
    if (!v || !v.answerIssues || !v.answerIssues.length) return "";
    return '<div class="warnbox"><b>正文需复核（' + v.answerIssues.length + "）：</b>" +
      v.answerIssues.map(function (i) { return esc(i.detail); }).join("；") + "</div>";
  }

  /* ---------------- 服务端探测 ---------------- */
  function probe() {
    if (typeof fetch !== "function") { SERVER = { ok: false }; renderBadge(); return Promise.resolve(); }
    return fetch("api/health", { cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("bad"); return r.json(); })
      .then(function (h) { SERVER = h; SERVER.ok = true; renderBadge(); })
      .catch(function () { SERVER = { ok: false }; renderBadge(); });
  }

  function renderBadge() {
    if (!badgeEl) return;
    if (!SERVER.ok) {
      badgeEl.textContent = "本地模式 · 无需联网";
      badgeEl.className = "pill local";
      if (keyBtn) keyBtn.style.display = "none";
      return;
    }
    if (SERVER.mode === "shared") {
      badgeEl.textContent = "模型问答已开放";
      badgeEl.className = "pill live";
      if (keyBtn) keyBtn.style.display = "none";
    } else {
      badgeEl.textContent = BYOK.key ? "自带 Key · 已接入" : "需自带 Key";
      badgeEl.className = "pill " + (BYOK.key ? "live" : "warn");
      if (keyBtn) keyBtn.style.display = "";
    }
  }

  /* ---------------- 提问 ---------------- */
  function ask(text) {
    var q = String(text || input.value || "").trim();
    if (!q || busy) return;
    busy = true;
    sendBtn.disabled = true;
    input.value = "";
    input.style.height = "auto";
    addUser(q);

    var unitId = L.findStep(q);
    if (unitId) {
      var card = L.stepCard(unitId);
      addBot(stepHtml(card) + '<p class="muted">规则作答 · 不消耗模型额度 · 数据源 step_risks.json</p>');
      busy = false;
      sendBtn.disabled = false;
      return;
    }

    var canModel = SERVER.ok && (SERVER.mode === "shared" || (SERVER.mode === "byok" && BYOK.key));
    if (!canModel) {
      if (SERVER.ok && SERVER.mode === "byok" && !BYOK.key) {
        addBot('<p>这个问题需要模型，但本站要求使用你自己的 API Key。</p>' +
          '<p class="muted">点右上角「接入我的模型」填一次，Key 只存在你本机浏览器。步骤类问题（如“第4步有什么风险”）不受影响，随时可问。</p>');
      } else {
        var res = L.searchAnswer(q);
        addBot(res.kind === "search" ? hitsHtml(res.hits) + '<p class="muted">本地检索模式：没有连接模型，以下是知识库中命中的条目。</p>'
          : "<p>" + esc(res.text).replace(/\n/g, "</p><p>") + "</p>");
      }
      busy = false;
      sendBtn.disabled = false;
      return;
    }

    callModel(q);
  }

  function callModel(q) {
    var bubble = addBot('<p class="cursor">▌</p>');
    var raw = "", meta = null;

    var headers = { "content-type": "application/json" };
    if (SERVER.mode === "byok" && BYOK.key) headers["x-user-key"] = BYOK.key;

    fetch("api/ask", {
      method: "POST", headers: headers,
      body: JSON.stringify({ message: q, stream: true }),
    }).then(function (res) {
      if (!res.ok && (res.headers.get("content-type") || "").indexOf("application/json") >= 0) {
        return res.json().then(function (e) { throw new Error(e.message || e.error || ("HTTP " + res.status)); });
      }
      if (!res.body) throw new Error("浏览器不支持流式读取");
      var reader = res.body.getReader();
      var dec = new TextDecoder("utf-8");
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          var i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            var block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            handle(block);
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (e) {
      bubble.innerHTML = "<p>" + esc(String(e.message || e)) + "</p>";
    }).finally(function () {
      busy = false;
      sendBtn.disabled = false;
    });

    function handle(block) {
      var ev = null, data = null;
      block.split("\n").forEach(function (line) {
        if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
        else if (line.indexOf("data:") === 0) { try { data = JSON.parse(line.slice(5).trim()); } catch (e) {} }
      });
      if (ev === "meta") { meta = data; return; }
      if (ev === "delta") {
        raw += (data.text || "");
        bubble.innerHTML = fmtBlock(raw) + '<span class="cursor">▌</span>';
        scroll();
        return;
      }
      if (ev === "verify") {
        bubble.innerHTML = fmtBlock(data.answer || raw) + thinkHtml(data) + issueHtml(data) +
          (meta && meta.citations && meta.citations.length
            ? '<div class="cite">引用：' + meta.citations.map(function (c) { return esc(c.id); }).join("、") + "</div>"
            : "");
        scroll();
        return;
      }
      if (ev === "error") {
        bubble.innerHTML += '<div class="warnbox">' + esc(data.message || "模型调用失败") + "</div>";
        scroll();
      }
    }
  }

  /* ---------------- 自带 Key ---------------- */
  var dlg = document.getElementById("dlg");
  if (keyBtn && dlg) {
    var kEl = document.getElementById("k-key");
    var mEl = document.getElementById("k-msg");
    keyBtn.onclick = function () {
      kEl.value = BYOK.key || "";
      mEl.textContent = "";
      dlg.classList.add("on");
    };
    document.getElementById("k-cancel").onclick = function () { dlg.classList.remove("on"); };
    dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.classList.remove("on"); });
    document.getElementById("k-save").onclick = function () {
      var k = kEl.value.trim();
      if (k && !/^sk-|^[A-Za-z0-9_\-]{16,}$/.test(k)) { mEl.className = "kmsg err"; mEl.textContent = "Key 格式看起来不对"; return; }
      saveByok({ key: k });
      renderBadge();
      mEl.className = "kmsg ok"; mEl.textContent = "已保存到本机";
      setTimeout(function () { dlg.classList.remove("on"); }, 500);
    };
    document.getElementById("k-clear").onclick = function () {
      saveByok({});
      kEl.value = "";
      renderBadge();
      mEl.className = "kmsg"; mEl.textContent = "已清除";
    };
  }

  /* ---------------- 事件与初始化 ---------------- */
  var stepsEl = document.getElementById("steps");
  stepsEl.innerHTML = L.allSteps().map(function (s) {
    var u = (KB.units || []).filter(function (x) { return x.id === s.unit_id; })[0] || {};
    return '<button data-u="' + s.unit_id + '"><span class="n">' + s.step + "</span>" + esc(u.short_name || s.name) + "</button>";
  }).join("");
  stepsEl.addEventListener("click", function (e) {
    var b = e.target.closest("[data-u]");
    if (!b) return;
    var card = L.stepCard(b.getAttribute("data-u"));
    addUser("第" + card.step + "步有什么风险？");
    addBot(stepHtml(card) + '<p class="muted">规则作答 · 不消耗模型额度 · 数据源 step_risks.json</p>');
  });

  sendBtn.onclick = function () { ask(); };
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); }
  });
  input.addEventListener("input", function () {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  });

  addBot(
    "<p>直接问第几步，我会告诉你这一步 <b>会发生什么风险</b>（附等级与预案）、<b>不会发生什么风险</b>（附理由）。</p>" +
    "<p class='muted'>步骤类问题由浏览器直接算，快且不消耗额度；其他问题如果本站开了模型，会走模型回答并逐条核对推理。</p>"
  );

  probe();
})();
