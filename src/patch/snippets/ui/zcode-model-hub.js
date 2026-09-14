/* __ZCODE_MODEL_HUB_V1__ renderer UI (injected as out/renderer/zcode-model-hub.js).
 * Adaptive by design: locates the "模型列表" label via semantic features
 * (text / tag / design-token classes) and re-scans on DOM mutations so SPA
 * navigation works across versions. If the label is absent we stay silent.
 * Requires window.zcodeModelHub (installed by the preload bridge). */
;(function () {
  "use strict";
  if (window.__ZCODE_MODEL_HUB_V1_UI__) return;
  window.__ZCODE_MODEL_HUB_V1_UI__ = true;

  var BTN_ID = "zcode-model-hub-btn";

  function api() {
    return window.zcodeModelHub || null;
  }

  function toast(msg, ok) {
    try {
      var d = document.createElement("div");
      d.textContent = msg;
      d.style.cssText =
        "position:fixed;right:18px;bottom:18px;z-index:2147483647;max-width:420px;" +
        "padding:10px 14px;border-radius:10px;font-size:13px;line-height:1.5;" +
        "color:#fff;background:" + (ok === false ? "#c0392b" : "#2d6cdf") + ";" +
        "box-shadow:0 6px 24px rgba(0,0,0,.25);transition:opacity .3s";
      document.body.appendChild(d);
      setTimeout(function () {
        d.style.opacity = "0";
        setTimeout(function () {
          d.remove();
        }, 350);
      }, 3200);
    } catch (e) {}
  }

  // ---- injection point discovery (semantic) ----
  // Locate the "模型列表" label (see injectToolbarAtModelList). If it is not
  // found we do nothing — the CLI/skill layer still works, and injecting into
  // an arbitrary "添加" button would only produce stray buttons.

  // Subtle native-looking button: plain outline, no gradient/glow.
  function makeSubtleButton(label, title, onClick, id) {
    var btn = document.createElement("button");
    if (id) btn.id = id;
    btn.type = "button";
    btn.textContent = label;
    btn.title = title;
    btn.style.cssText =
      "display:inline-flex;align-items:center;justify-content:center;gap:4px;" +
      "padding:2px 10px;border-radius:6px;font-size:12px;line-height:18px;cursor:pointer;color:inherit;" +
      "border:1px solid rgba(128,128,128,.35);background:transparent;transition:background .15s";
    btn.onmouseenter = function () {
      btn.style.background = "rgba(128,128,128,.12)";
    };
    btn.onmouseleave = function () {
      btn.style.background = "transparent";
    };
    btn.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      onClick(btn);
    });
    return btn;
  }

  // Preferred placement: the two action buttons live on the RIGHT side of the
  // "模型列表" row. In ZCode's renderer that title is a text-only <label> with
  // `mb-1 block ...` (full-width block, right side empty; the native "添加模型"
  // button sits BELOW the list, not in this row). We mirror ZCode's own idiom
  // for a label-with-right-control row (its API Key row uses
  // `flex items-center justify-between`) by making this label a flex row and
  // appending the toolbar inside it. No wrapper element, no parent mutation,
  // no absolute overlay — the label keeps its exact position and size.
  function injectToolbarAtModelList() {
    var leaves = document.querySelectorAll("h1,h2,h3,h4,h5,h6,span,label,p,div");
    var titleEl = null;
    for (var i = 0; i < leaves.length; i++) {
      var el = leaves[i];
      if (el.children.length > 0) continue; // leaf only
      var t = (el.textContent || "").trim();
      if (!/^(模型列表[:：]?|model list|models)$/i.test(t)) continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      var tag = (el.tagName || "").toLowerCase();
      if (tag === "label") {
        titleEl = el;
        break;
      }
      // Non-label matches (e.g. a "Models" sidebar nav item in English UIs)
      // only count when they carry ZCode's form-label design tokens.
      if (String(el.className || "").indexOf("text-ui-base") >= 0) {
        titleEl = el;
        break;
      }
    }
    if (!titleEl) return false;

    // Already injected into this label (React may reuse the element).
    if (titleEl.getAttribute("data-model-hub-title") === "1") return true;
    titleEl.setAttribute("data-model-hub-title", "1");

    var toolbar = document.createElement("div");
    toolbar.id = "zcode-model-hub-toolbar";
    toolbar.style.cssText = "display:inline-flex;align-items:center;gap:8px;flex:none;margin-left:auto;";

    toolbar.appendChild(
      makeSubtleButton("请求头模拟", "zcode-model-hub：为该供应商配置 Claude Code / Codex CLI 请求头模拟（写入 provider.headers）", function () {
        onHeadersClick();
      })
    );
    toolbar.appendChild(
      makeSubtleButton("拉取模型", "zcode-model-hub：根据当前 Base URL 和 API Key 自动拉取可用模型列表", onPullClick, BTN_ID)
    );

    // The label holds a single text node; as a flex row the text becomes the
    // leading item and the toolbar is pushed to the far right.
    titleEl.style.display = "flex";
    titleEl.style.alignItems = "center";
    titleEl.style.justifyContent = "space-between";
    titleEl.style.width = "100%";
    titleEl.appendChild(toolbar);

    return true;
  }

  // Fallback placement for builds without a 模型列表 label: sit right after
  // the add-model button, matching its rendered metrics.
  // — removed: injecting next to an arbitrary "添加" button produced stray
  //   buttons at the bottom of the section; if the label is missing we do
  //   nothing and the CLI/skill layer remains the fallback.

  function checkAndInject() {
    if (!api()) return;
    injectToolbarAtModelList();
  }

  // ---- credentials from the visible form (with config fallback) ----
  function visibleInputs() {
    var out = [];
    var inputs = document.querySelectorAll("input, textarea");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var t = el.type || "text";
      if (t === "hidden" || t === "checkbox" || t === "radio" || t === "submit" || t === "button") continue;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      out.push(el);
    }
    return out;
  }

  function scanFormCredentials() {
    var baseUrl = "";
    var apiKey = "";
    var inputs = visibleInputs();
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var v = (el.value || "").trim();
      var ph = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
      if (!baseUrl && /^https?:\/\//i.test(v)) baseUrl = v;
      if (!apiKey) {
        if (el.type === "password" && v) apiKey = v;
        else if (v && /^sk-[A-Za-z0-9]/.test(v)) apiKey = v;
        else if (v && /key|token|令牌|密钥/i.test(ph) && el.type !== "password" && v.length > 8 && !/^https?:/i.test(v))
          apiKey = v;
      }
    }
    return { baseUrl: baseUrl, apiKey: apiKey };
  }

  function readConfig() {
    return Promise.resolve(api().readConfig()).then(function (r) {
      if (r && r.ok) return r.data;
      throw new Error((r && r.error) || "read config failed");
    });
  }
  function writeConfig(cfg) {
    return Promise.resolve(api().writeConfig(cfg)).then(function (r) {
      if (r && r.ok) return true;
      throw new Error((r && r.error) || "write config failed");
    });
  }

  function normalizeUrlKey(u) {
    return String(u || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "").toLowerCase();
  }

  function findProviderByBaseUrl(cfg, baseUrl) {
    var sec = cfg.provider || {};
    var entries = Array.isArray(sec)
      ? sec.map(function (p, i) {
          return { key: i, p: p };
        })
      : Object.keys(sec).map(function (k) {
          return { key: k, p: sec[k] };
        });
    var want = normalizeUrlKey(baseUrl);
    var hit = null;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.p || typeof e.p !== "object") continue;
      var bu = (e.p.options && e.p.options.baseURL) || e.p.baseURL || "";
      if (!bu) continue;
      if (normalizeUrlKey(bu) === want) {
        hit = e;
        break;
      }
    }
    return hit; // {key, p} | null
  }

  // ---- existing models from DOM + config (for the "already added" badge) ----
  function existingModelIdsFromDom() {
    var set = {};
    var inputs = document.querySelectorAll("input");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var cls = el.className || "";
      var ph = el.getAttribute("placeholder") || "";
      if ((/font-mono|mono/i.test(String(cls)) || /模型|model/i.test(ph)) && el.value && el.value.trim()) {
        set[el.value.trim()] = 1;
      }
    }
    return set;
  }

  // ---- modal ----
  function openModal(result, creds) {
    var existing = existingModelIdsFromDom();
    var state = {};
    var newCount = 0;
    var models = result.models || [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var isNew = !existing[m.id];
      state[m.id] = { isNew: isNew, selected: isNew, vision: !!m.visionGuess, probing: false };
      if (isNew) newCount++;
    }

    var overlay = document.createElement("div");
    overlay.id = "zcode-model-hub-modal";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);" +
      "display:flex;align-items:center;justify-content:center";
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var panel = document.createElement("div");
    panel.style.cssText =
      "width:min(620px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:14px;" +
      "overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4);font-size:13px;" +
      "background:" + (dark ? "#1e1f22" : "#ffffff") + ";color:" + (dark ? "#e6e6e6" : "#1a1a1a");

    function el(tag, style, text) {
      var d = document.createElement(tag);
      if (style) d.style.cssText = style;
      if (text != null) d.textContent = text;
      return d;
    }

    var header = el("div", "display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid " + (dark ? "#333" : "#eee"));
    header.appendChild(el("div", "font-weight:600;font-size:14px", "拉取到 " + models.length + " 个模型（" + result.dialect + "）"));
    var closeBtn = el("button", "background:none;border:none;cursor:pointer;font-size:16px;color:inherit", "✕");
    closeBtn.addEventListener("click", function () {
      overlay.remove();
    });
    header.appendChild(closeBtn);

    var toolbar = el("div", "display:flex;gap:8px;align-items:center;padding:10px 18px;flex-wrap:wrap");
    var search = el("input", "flex:1;min-width:140px;padding:6px 10px;border-radius:8px;border:1px solid " + (dark ? "#444" : "#ddd") + ";background:transparent;color:inherit;font-size:13px");
    search.placeholder = "搜索模型…";
    toolbar.appendChild(search);
    function toolBtn(label, fn) {
      var b = el("button", "padding:5px 10px;border-radius:8px;cursor:pointer;border:1px solid " + (dark ? "#444" : "#ddd") + ";background:transparent;color:inherit;font-size:12px", label);
      b.addEventListener("click", fn);
      return b;
    }
    toolbar.appendChild(toolBtn("全选", function () { setAll(true); }));
    toolbar.appendChild(toolBtn("清空", function () { setAll(false); }));
    toolbar.appendChild(toolBtn("仅选新模型", function () { setAll("new"); }));
    var probeBtn = toolBtn("探测视觉(勾选)", function () { probeChecked(); });
    toolbar.appendChild(probeBtn);

    var list = el("div", "flex:1;overflow-y:auto;padding:4px 12px");
    var rows = {};
    function buildRows() {
      list.innerHTML = "";
      rows = {};
      var q = (search.value || "").trim().toLowerCase();
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        if (q && m.id.toLowerCase().indexOf(q) < 0) continue;
        var st = state[m.id];
        var row = el("label", "display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer");
        row.style.background = st.selected ? (dark ? "rgba(96,165,250,.08)" : "rgba(96,165,250,.06)") : "transparent";
        var cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = st.selected;
        cb.addEventListener("click", function (e) {
          e.stopPropagation();
        });
        cb.addEventListener("change", function () {
          st.selected = cb.checked;
          row.style.background = st.selected ? (dark ? "rgba(96,165,250,.08)" : "rgba(96,165,250,.06)") : "transparent";
          updateCounts();
        });
        var name = el("span", "font-family:ui-monospace,monospace;flex:1;word-break:break-all", m.id);
        row.appendChild(cb);
        row.appendChild(name);
        if (st.probing) row.appendChild(el("span", "font-size:11px;opacity:.7", "探测中…"));
        else if (st.visionProbed) row.appendChild(el("span", "font-size:11px;padding:2px 6px;border-radius:6px;background:" + (st.vision ? "rgba(34,197,94,.18)" : "rgba(120,120,120,.18)"), st.vision ? "视觉 ✓" : "无视觉"));
        else if (st.vision) row.appendChild(el("span", "font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(34,197,94,.12)", "疑似视觉"));
        if (!st.isNew) row.appendChild(el("span", "font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(120,120,120,.15)", "已添加"));
        else row.appendChild(el("span", "font-size:11px;padding:2px 6px;border-radius:6px;background:rgba(96,165,250,.15)", "新模型"));
        list.appendChild(row);
        rows[m.id] = { row: row, cb: cb };
      }
    }
    function setAll(mode) {
      for (var i = 0; i < models.length; i++) {
        var m = models[i];
        if (mode === "new") state[m.id].selected = state[m.id].isNew;
        else state[m.id].selected = mode === true;
      }
      buildRows();
      updateCounts();
    }
    function probeChecked() {
      var ids = [];
      for (var i = 0; i < models.length; i++) if (state[models[i].id].selected) ids.push(models[i].id);
      if (!ids.length) return toast("先勾选要探测的模型", false);
      if (!creds.baseUrl) return toast("缺少 Base URL", false);
      var idx = 0;
      probeBtn.disabled = true;
      function next() {
        if (idx >= ids.length) {
          probeBtn.disabled = false;
          buildRows();
          return toast("视觉探测完成");
        }
        var id = ids[idx++];
        state[id].probing = true;
        buildRows();
        Promise.resolve(api().probeVision(creds.baseUrl, creds.apiKey, id, {})).then(function (r) {
          state[id].probing = false;
          if (r && r.ok) {
            state[id].vision = !!r.vision;
            state[id].visionProbed = true;
          }
          next();
        });
      }
      next();
    }
    search.addEventListener("input", buildRows);

    var footer = el("div", "display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid " + (dark ? "#333" : "#eee"));
    var countLabel = el("div", "font-size:12px;opacity:.8", "");
    var actions = el("div", "display:flex;gap:8px");
    actions.appendChild(toolBtn("取消", function () { overlay.remove(); }));
    var confirm = el("button", "padding:7px 16px;border-radius:8px;cursor:pointer;border:none;color:#fff;font-size:13px;background:#2d6cdf", "确认添加并保存");
    actions.appendChild(confirm);
    footer.appendChild(countLabel);
    footer.appendChild(actions);
    function updateCounts() {
      var n = 0;
      for (var k in state) if (state[k].selected) n++;
      countLabel.textContent = "已选 " + n + " / " + models.length + "（新增 " + newCount + "）";
    }

    confirm.addEventListener("click", function () {
      var selected = [];
      for (var i = 0; i < models.length; i++) if (state[models[i].id].selected) selected.push(models[i].id);
      confirm.disabled = true;
      confirm.textContent = "⏳ 正在保存…";
      readConfig()
        .then(function (cfg) {
          var hit = findProviderByBaseUrl(cfg, creds.baseUrl);
          if (!hit) throw new Error("config 中找不到 baseURL 匹配的供应商，请先保存该供应商");
          var fetched = models.map(function (m) {
            return { id: m.id, visionGuess: state[m.id].vision };
          });
          mergeFinalState(cfg, hit.p, fetched, selected);
          return writeConfig(cfg).then(function () {
            overlay.remove();
            toast("已保存 " + selected.length + " 个模型到 " + (hit.p.name || hit.key), true);
            triggerRefresh(hit.p.name || hit.key);
          });
        })
        .catch(function (e) {
          confirm.disabled = false;
          confirm.textContent = "确认添加并保存";
          toast((e && e.message) || "保存失败", false);
        });
    });

    panel.appendChild(header);
    panel.appendChild(toolbar);
    panel.appendChild(list);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    buildRows();
    updateCounts();
  }

  // ---- request-header simulation (provider.headers) ----
  // ZCode natively attaches a provider's `headers` object to every request
  // it sends to that provider — it just has no UI for it. Some gateways
  // fingerprint clients (only accept claude-cli / codex_cli_rs traffic), so
  // we offer presets + a small editor and write the result natively.
  var HEADER_PRESETS = {
    claude: {
      label: "Claude Code (claude-cli)",
      headers: {
        "User-Agent": "claude-cli/2.0.14 (external, cli)",
        "x-app": "cli",
        "anthropic-version": "2023-06-01",
        "x-stainless-lang": "js",
        "x-stainless-runtime": "node",
        "x-stainless-package-version": "2.0.14",
      },
    },
    codex: {
      label: "Codex CLI (codex_cli_rs)",
      headers: {
        "User-Agent": "codex_cli_rs/0.21.0 (Mac OS 15.6.0; arm64) iTerm.app",
        originator: "codex_cli_rs",
        "OpenAI-Beta": "responses=experimental",
        session_id: "<uuid>",
      },
    },
  };

  function newUuid() {
    try {
      return crypto.randomUUID();
    } catch (e) {
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
        var r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
      });
    }
  }

  function onHeadersClick() {
    if (!api()) {
      toast("zcodeModelHub 桥不可用：preload 未注入或需重启 ZCode", false);
      return;
    }
    var creds = scanFormCredentials();
    readConfig()
      .then(function (cfg) {
        var hit = creds.baseUrl ? findProviderByBaseUrl(cfg, creds.baseUrl) : null;
        if (!hit) {
          var sec = cfg.provider || {};
          var keys = Array.isArray(sec) ? sec.map(function (_, i) { return i; }) : Object.keys(sec);
          if (keys.length === 1) {
            var p = Array.isArray(sec) ? sec[0] : sec[keys[0]];
            hit = { key: keys[0], p: p };
          }
        }
        openHeadersModal(hit, creds, cfg);
      })
      .catch(function (e) {
        toast((e && e.message) || "读取配置失败", false);
      });
  }

  function openHeadersModal(hit, creds, cfg) {
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var borderColor = dark ? "#444" : "#ddd";
    var initial = {};
    if (hit && hit.p && hit.p.headers && typeof hit.p.headers === "object") {
      for (var k in hit.p.headers) initial[k] = String(hit.p.headers[k]);
    }

    var overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);" +
      "display:flex;align-items:center;justify-content:center";
    var panel = document.createElement("div");
    panel.style.cssText =
      "width:min(640px,92vw);max-height:80vh;display:flex;flex-direction:column;border-radius:14px;" +
      "overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4);font-size:13px;" +
      "background:" + (dark ? "#1e1f22" : "#ffffff") + ";color:" + (dark ? "#e6e6e6" : "#1a1a1a");

    function el(tag, style, text) {
      var d = document.createElement(tag);
      if (style) d.style.cssText = style;
      if (text != null) d.textContent = text;
      return d;
    }
    function smallBtn(label, fn) {
      var b = el("button", "padding:5px 10px;border-radius:8px;cursor:pointer;border:1px solid " + borderColor + ";background:transparent;color:inherit;font-size:12px", label);
      b.addEventListener("click", fn);
      return b;
    }

    var header = el("div", "display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid " + (dark ? "#333" : "#eee"));
    var title = el("div", "font-weight:600;font-size:14px", "请求头模拟");
    var sub = el("div", "font-size:11px;opacity:.65;margin-top:2px",
      hit ? "写入供应商 " + (hit.p.name || hit.key) + " 的 provider.headers（ZCode 原生支持并随请求发送）"
          : "未定位到供应商：请先在下方填写/保存 Base URL 后重试");
    var titleWrap = el("div");
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);
    header.appendChild(titleWrap);
    var closeBtn = el("button", "background:none;border:none;cursor:pointer;font-size:16px;color:inherit", "✕");
    closeBtn.addEventListener("click", function () { overlay.remove(); });
    header.appendChild(closeBtn);

    var presetBar = el("div", "display:flex;gap:8px;padding:10px 18px;flex-wrap:wrap;align-items:center");
    presetBar.appendChild(el("span", "font-size:12px;opacity:.7", "预设："));
    Object.keys(HEADER_PRESETS).forEach(function (key) {
      presetBar.appendChild(smallBtn(HEADER_PRESETS[key].label, function () {
        rows.length = 0;
        var hs = HEADER_PRESETS[key].headers;
        for (var hk in hs) rows.push({ k: hk, v: hs[hk] === "<uuid>" ? newUuid() : hs[hk] });
        buildRows();
      }));
    });
    presetBar.appendChild(smallBtn("＋ 空行", function () { rows.push({ k: "", v: "" }); buildRows(); }));
    presetBar.appendChild(smallBtn("🗑 清除全部", function () { rows.length = 0; buildRows(); }));

    var list = el("div", "flex:1;overflow-y:auto;padding:4px 18px");
    var rows = [];
    for (var ik in initial) rows.push({ k: ik, v: initial[ik] });

    function buildRows() {
      list.innerHTML = "";
      if (!rows.length) list.appendChild(el("div", "padding:14px 4px;opacity:.6", "（无自定义请求头）"));
      rows.forEach(function (row, idx) {
        var line = el("div", "display:flex;gap:6px;align-items:center;padding:4px 0");
        var kIn = el("input", "flex:0 0 220px;padding:6px 8px;border-radius:8px;border:1px solid " + borderColor + ";background:transparent;color:inherit;font-family:ui-monospace,monospace;font-size:12px");
        kIn.placeholder = "Header 名称";
        kIn.value = row.k;
        kIn.addEventListener("input", function () { row.k = kIn.value; });
        var vIn = el("input", "flex:1;padding:6px 8px;border-radius:8px;border:1px solid " + borderColor + ";background:transparent;color:inherit;font-family:ui-monospace,monospace;font-size:12px");
        vIn.placeholder = "值";
        vIn.value = row.v;
        vIn.addEventListener("input", function () { row.v = vIn.value; });
        line.appendChild(kIn);
        line.appendChild(vIn);
        if (/session[_-]?id|conversation[_-]?id/i.test(row.k)) {
          line.appendChild(smallBtn("换新", function () {
            row.v = newUuid();
            vIn.value = row.v;
          }));
        }
        line.appendChild(smallBtn("✕", function () { rows.splice(idx, 1); buildRows(); }));
        list.appendChild(line);
      });
    }
    buildRows();

    var footer = el("div", "display:flex;align-items:center;justify-content:space-between;padding:12px 18px;border-top:1px solid " + (dark ? "#333" : "#eee"));
    footer.appendChild(el("div", "font-size:11px;opacity:.65", "注意：之后若在 ZCode 自带界面里重新保存该供应商，ZCode 可能剥离 headers，重开本窗口再应用一次即可。"));
    var actions = el("div", "display:flex;gap:8px");
    actions.appendChild(smallBtn("取消", function () { overlay.remove(); }));
    var apply = el("button", "padding:7px 16px;border-radius:8px;cursor:pointer;border:none;color:#fff;font-size:13px;background:#2d6cdf", "应用并保存");
    actions.appendChild(apply);
    footer.appendChild(actions);

    apply.addEventListener("click", function () {
      var obj = {};
      for (var i = 0; i < rows.length; i++) {
        var k = rows[i].k.trim();
        if (k) obj[k] = rows[i].v;
      }
      apply.disabled = true;
      readConfig()
        .then(function (fresh) {
          var target = creds.baseUrl ? findProviderByBaseUrl(fresh, creds.baseUrl) : hit && findProviderByBaseUrl(fresh, (hit.p.options && hit.p.options.baseURL) || hit.p.baseURL || "");
          if (!target) throw new Error("config 中找不到匹配的供应商，请先保存该供应商");
          if (Object.keys(obj).length) target.p.headers = obj;
          else delete target.p.headers;
          return writeConfig(fresh).then(function () {
            overlay.remove();
            toast("已写入 " + Object.keys(obj).length + " 个自定义请求头到 " + (target.p.name || target.key), true);
            triggerRefresh(target.p.name || target.key);
          });
        })
        .catch(function (e) {
          apply.disabled = false;
          toast((e && e.message) || "保存失败", false);
        });
    });

    panel.appendChild(header);
    panel.appendChild(presetBar);
    panel.appendChild(list);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }

  // final-state merge, mirroring src/config.mjs semantics
  function mergeFinalState(cfg, p, fetched, selected) {
    var want = {};
    for (var i = 0; i < selected.length; i++) want[selected[i]] = 1;
    if (!cfg.zcode || typeof cfg.zcode !== "object") cfg.zcode = {};
    if (!Array.isArray(cfg.zcode.deletedModels)) cfg.zcode.deletedModels = [];
    var deleted = {};
    for (var j = 0; j < cfg.zcode.deletedModels.length; j++) deleted[cfg.zcode.deletedModels[j]] = 1;
    if (!p.models || typeof p.models !== "object" || Array.isArray(p.models)) p.models = {};

    var fetchedIds = {};
    for (var k = 0; k < fetched.length; k++) fetchedIds[fetched[k].id] = 1;

    for (var a = 0; a < fetched.length; a++) {
      var f = fetched[a];
      if (want[f.id]) {
        delete deleted[f.id];
        if (!p.models[f.id]) {
          p.models[f.id] = {
            name: f.id,
            limit: { context: 128000, output: 8192 },
            modalities: { input: f.visionGuess ? ["text", "image"] : ["text"], output: ["text"] },
          };
        }
      } else {
        delete p.models[f.id];
        deleted[f.id] = 1;
      }
    }
    // manual models (not in fetched list) survive and are un-deleted
    for (var id in p.models) delete deleted[id];

    cfg.zcode.deletedModels = Object.keys(deleted).sort();
  }

  function triggerRefresh(providerName) {
    try {
      // heuristic 1: official refresh control by text
      var els = document.querySelectorAll("p, span, div, button, a");
      for (var i = 0; i < els.length; i++) {
        var t = (els[i].textContent || "").trim();
        if ((t === "刷新" || t === "Refresh" || t === "重新加载") && els[i].closest("button,a,[role=button]")) {
          var target = els[i].closest("button,a,[role=button]");
          target.click();
          return;
        }
      }
      // heuristic 2: click the matching provider entry in the sidebar
      if (providerName) {
        for (var j = 0; j < els.length; j++) {
          if ((els[j].textContent || "").trim() === providerName) {
            els[j].click();
            return;
          }
        }
      }
    } catch (e) {}
  }

  // ---- pull flow ----
  function onPullClick(btn) {
    if (!api()) {
      toast("zcodeModelHub 桥不可用：preload 未注入或需重启 ZCode", false);
      return;
    }
    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "⏳ 正在拉取…";
    var creds = scanFormCredentials();
    var ready = creds.baseUrl
      ? Promise.resolve(creds)
      : readConfig().then(function (cfg) {
          // fallback: exactly one provider configured -> use it
          var sec = cfg.provider || {};
          var keys = Array.isArray(sec) ? sec.map(function (_, i) { return i; }) : Object.keys(sec);
          if (keys.length === 1) {
            var p = Array.isArray(sec) ? sec[0] : sec[keys[0]];
            return { baseUrl: (p.options && p.options.baseURL) || p.baseURL || "", apiKey: (p.options && p.options.apiKey) || p.apiKey || "" };
          }
          throw new Error("页面上没有识别到 Base URL，请先填写并保存供应商信息");
        });
    ready
      .then(function (c) {
        if (!c.baseUrl) throw new Error("缺少 Base URL");
        return Promise.resolve(api().fetchModels(c.baseUrl, c.apiKey, { dialect: "auto" })).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || "拉取失败，请检查 Base URL 和 API Key");
          creds = c;
          openModal(r, c);
        });
      })
      .catch(function (e) {
        toast((e && e.message) || "拉取失败", false);
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = old;
      });
  }

  // ---- boot ----
  function boot() {
    checkAndInject();
    new MutationObserver(function () {
      checkAndInject();
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
