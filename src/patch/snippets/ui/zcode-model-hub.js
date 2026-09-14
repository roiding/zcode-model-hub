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

  // Credential discovery is anchored on the form's field labels (ZCode renders
  // "<label>Base URL</label><input>" / "<label>API Key</label><input type=password>"
  // as siblings inside a wrapper div), so values are found even before the
  // provider has ever been saved. Value heuristics remain as a fallback for
  // layouts that don't render those labels.
  function scanFormCredentials() {
    var baseUrl = "";
    var apiKey = "";
    var inputFor = function (lb) {
      var inside = lb.querySelector && lb.querySelector("input, textarea");
      if (inside) return inside;
      var sib = lb.nextElementSibling;
      for (var i = 0; sib && i < 3; i++) {
        if (sib.tagName === "INPUT" || sib.tagName === "TEXTAREA") return sib;
        var nested = sib.querySelector && sib.querySelector("input, textarea");
        if (nested) return nested;
        sib = sib.nextElementSibling;
      }
      var parent = lb.parentElement;
      return parent ? parent.querySelector("input, textarea") : null;
    };
    var labels = document.querySelectorAll("label, span, div, p, dt, th, h1, h2, h3, h4");
    for (var i = 0; i < labels.length; i++) {
      var lb = labels[i];
      var text = (lb.textContent || "").trim();
      if (!text || text.length > 60) continue;
      var isBase = /^(base\s*url|接口地址|接入地址|api\s*地址|endpoint|api\s*endpoint)[:：]?$/i.test(text);
      var isKey = /^(api\s*key|密钥|api\s*令牌|令牌|access\s*token|token)[:：]?$/i.test(text);
      if (!isBase && !isKey) continue;
      var input = inputFor(lb);
      if (!input) continue;
      var v = (input.value || "").trim();
      if (isBase && !baseUrl && /^https?:\/\//i.test(v)) baseUrl = v;
      else if (isKey && !apiKey && v && !/^https?:\/\//i.test(v)) apiKey = v;
    }
    // value-based fallback (no recognizable labels in this layout)
    var inputs = visibleInputs();
    for (var j = 0; j < inputs.length; j++) {
      var el = inputs[j];
      var v2 = (el.value || "").trim();
      var ph = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
      if (!baseUrl && /^https?:\/\//i.test(v2)) baseUrl = v2;
      if (!apiKey) {
        if (el.type === "password" && v2) apiKey = v2;
        else if (v2 && /^sk-[A-Za-z0-9]/.test(v2)) apiKey = v2;
        else if (v2 && /key|token|令牌|密钥/i.test(ph) && el.type !== "password" && v2.length > 8 && !/^https?:/i.test(v2))
          apiKey = v2;
      }
    }
    return { baseUrl: baseUrl, apiKey: apiKey, name: providerNameFromUi(baseUrl, false) };
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
    try {
      var parsed = new URL(String(u || "").trim());
      return parsed.origin + parsed.pathname.replace(/\/+$/, "").replace(/\/v1$/, "") + parsed.search;
    } catch (error) {
      return String(u || "").trim().replace(/\/+$/, "");
    }
  }

  function providerReference(hit) {
    return {
      key: hit.key,
      id: hit.p.id,
      name: hit.p.name,
      baseUrl: (hit.p.options && hit.p.options.baseURL) || hit.p.baseURL || "",
      apiKey: (hit.p.options && hit.p.options.apiKey) || hit.p.apiKey || "",
    };
  }

  function findProviderByBaseUrl(cfg, baseUrl, identity) {
    var sec = cfg.provider || {};
    var entries = Array.isArray(sec)
      ? sec.map(function (p, i) {
          return { key: i, p: p };
        })
      : Object.keys(sec).map(function (k) {
          return { key: k, p: sec[k] };
        });
    entries = entries.filter(function (entry) { return entry.p && typeof entry.p === "object"; });
    var reference = identity && identity.providerRef;
    if (reference) {
      var saved = entries.filter(function (entry) {
        if (!Array.isArray(sec)) return entry.key === reference.key;
        if (reference.id != null) return entry.p.id === reference.id;
        if (reference.name) return entry.p.name === reference.name;
        return entry.key === reference.key;
      });
      if (saved.length !== 1) throw new Error("供应商已变更或被删除，请重新拉取");
      var current = providerReference(saved[0]);
      if (normalizeUrlKey(current.baseUrl) !== normalizeUrlKey(reference.baseUrl) || current.apiKey !== reference.apiKey)
        throw new Error("供应商地址或密钥已变更，请重新拉取");
      return saved[0];
    }
    var want = normalizeUrlKey(baseUrl);
    var matches = entries.filter(function (entry) {
      var storedUrl = (entry.p.options && entry.p.options.baseURL) || entry.p.baseURL || "";
      return storedUrl && normalizeUrlKey(storedUrl) === want;
    });
    if (matches.length && identity && identity.apiKey) {
      matches = matches.filter(function (entry) {
        return ((entry.p.options && entry.p.options.apiKey) || entry.p.apiKey || "") === identity.apiKey;
      });
      if (!matches.length) throw new Error("当前密钥与已保存的供应商不一致，请先保存供应商信息");
    }
    if (matches.length > 1 && identity && identity.name) {
      var named = matches.filter(function (entry) {
        return entry.p.name === identity.name || entry.p.id === identity.name || String(entry.key) === identity.name;
      });
      if (named.length) matches = named;
    }
    if (matches.length > 1) throw new Error("多个供应商使用相同地址，请明确选择并保存供应商后重试");
    return matches[0] || null;
  }

  // Name of the provider currently being edited: the selected sidebar entry,
  // else a "名称/Name" form field, else the Base URL host.
  function providerNameFromUi(baseUrl, fallback) {
    var items = document.querySelectorAll("div[class*='rounded'], button, div[class*='cursor-pointer']");
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      var t = (items[i].textContent || "").trim();
      if (r.left < 360 && t && t.length <= 40 && items[i].getAttribute("aria-selected") === "true") return t;
    }
    var labels = document.querySelectorAll("label, span, div, p");
    for (var j = 0; j < labels.length; j++) {
      var lb = labels[j];
      var text = (lb.textContent || "").trim();
      if (!/^(供应商名称|名称|name|provider\s*name)[:：]?$/i.test(text)) continue;
      var inp = lb.nextElementSibling;
      if (inp && (inp.tagName === "INPUT" || inp.tagName === "TEXTAREA")) {
        var v = (inp.value || "").trim();
        if (v) return v;
      }
    }
    if (fallback === false) return "";
    try {
      var parts = new URL(baseUrl).hostname.replace(/^www\./, "").split(".");
      var name = parts[0] || "custom";
      if (/^(api|gateway|openai|service|backend|endpoint|srv|platform)$/i.test(name) && parts.length > 1) name = parts[1];
      return name;
    } catch (e) {
      return "custom";
    }
  }

  // Create a provider entry for one that was pulled before ever being saved.
  function ensureProviderEntry(cfg, creds) {
    var sec = cfg.provider;
    if (!sec || typeof sec !== "object") cfg.provider = {};
    var b = String(creds.baseUrl || "").toLowerCase();
    var kind = b.indexOf("anthropic") >= 0 || b.indexOf("claude") >= 0 ? "anthropic" : "openai-compatible";
    var entry = { name: creds.name || providerNameFromUi(creds.baseUrl), kind: kind, options: { baseURL: creds.baseUrl } };
    if (creds.apiKey) entry.options.apiKey = creds.apiKey;
    if (Array.isArray(cfg.provider)) {
      cfg.provider.push(entry);
      return { key: cfg.provider.length - 1, p: entry };
    }
    var key = entry.name;
    var suffix = 2;
    while (Object.prototype.hasOwnProperty.call(cfg.provider, key) || key in Object.prototype)
      key = entry.name + "-" + suffix++;
    cfg.provider[key] = entry;
    return { key: key, p: entry };
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
  function openModal(result, creds, existingIds) {
    var existing = {};
    if (existingIds && existingIds.length) {
      for (var i = 0; i < existingIds.length; i++) existing[existingIds[i]] = 1;
    } else {
      existing = existingModelIdsFromDom();
    }
    var state = {};
    var newCount = 0;
    var models = result.models || [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var isNew = !existing[m.id];
      // Every fetched model defaults to selected. A plain confirm is then a
      // no-op preserve for models the provider already has (final-state merge
      // deletes unselected fetched models — defaulting existing ones to
      // unchecked is what wiped a provider's model list on save).
      state[m.id] = { isNew: isNew, selected: true, vision: !!m.visionGuess, probing: false };
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
    toolbar.appendChild(toolBtn("仅保留新模型", function () { setAll("new"); }));
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
        let st = state[m.id];
        let row = el("label", "display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px;cursor:pointer");
        row.style.background = st.selected ? (dark ? "rgba(96,165,250,.08)" : "rgba(96,165,250,.06)") : "transparent";
        let cb = document.createElement("input");
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
        Promise.resolve(api().probeVision(creds.baseUrl, creds.apiKey, id, { headers: creds.headers, dialect: result.dialect })).then(function (r) {
          state[id].probing = false;
          if (r && r.ok) {
            state[id].vision = !!r.vision;
            state[id].visionProbed = true;
          }
          next();
        }).catch(function (error) {
          state[id].probing = false;
          probeBtn.disabled = false;
          buildRows();
          toast((error && error.message) || "视觉探测失败", false);
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
          var hit = findProviderByBaseUrl(cfg, creds.baseUrl, creds);
          // Provider may have been pulled before it was ever saved: create the
          // entry (name from the sidebar/form, kind from the URL) instead of
          // failing the whole operation.
          if (!hit) hit = ensureProviderEntry(cfg, creds);
          var fetched = models.map(function (m) {
            return { id: m.id, visionGuess: state[m.id].vision, visionProbed: state[m.id].visionProbed === true };
          });
          mergeFinalState(cfg, hit.p, fetched, selected);
          return writeConfig(cfg).then(function () {
            overlay.remove();
            toast("已保存 " + selected.length + " 个模型到 " + (hit.p.name || hit.key), true);
            triggerRefresh(hit.p.name || hit.key, selected);
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
        var hit = creds.baseUrl ? findProviderByBaseUrl(cfg, creds.baseUrl, creds) : null;
        if (!creds.baseUrl) {
          var sec = cfg.provider || {};
          var keys = Array.isArray(sec) ? sec.map(function (_, i) { return i; }) : Object.keys(sec);
          if (keys.length === 1) {
            var p = Array.isArray(sec) ? sec[0] : sec[keys[0]];
            hit = { key: keys[0], p: p };
            creds.baseUrl = (p.options && p.options.baseURL) || p.baseURL || "";
          }
        }
        if (hit) creds.providerRef = providerReference(hit);
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
          var target = creds.baseUrl ? findProviderByBaseUrl(fresh, creds.baseUrl, creds) : null;
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
        } else if (f.visionProbed && Object.prototype.hasOwnProperty.call(p.models, f.id)) {
          var modalities = p.models[f.id].modalities || {};
          var inputs = Array.isArray(modalities.input) ? modalities.input.filter(function (input) { return input !== "image"; }) : ["text"];
          if (f.visionGuess) inputs.push("image");
          p.models[f.id].modalities = Object.assign({}, modalities, { input: inputs, output: modalities.output || ["text"] });
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

  // Re-render the settings page after an out-of-band config write. ZCode's
  // provider page header is "<p>管理自定义模型供应商…</p>" next to an
  // icon-only refresh button (aria-label="刷新", no text) whose onRefresh
  // re-reads the local provider data, so clicking it is the reliable trigger;
  // a re-click of the sidebar provider entry re-renders the detail view.
  function triggerRefresh(providerName, expectedIds) {
    try {
      var refreshClicked = false;
      // 1. official refresh button, sibling of the page description paragraph
      var ps = document.querySelectorAll("p");
      for (var i = 0; i < ps.length; i++) {
        var t = ps[i].textContent || "";
        if (t.indexOf("管理自定义模型供应商") >= 0 || t.indexOf("配置后可在聊天时选择使用") >= 0) {
          var parent = ps[i].parentElement;
          var btn = parent && parent.querySelector("button");
          if (btn) {
            btn.click();
            refreshClicked = true;
          }
          break;
        }
      }
      // 2. fallback: any refresh control (aria/title/text) or top-right icon button
      if (!refreshClicked) {
        var buttons = document.querySelectorAll("button");
        for (var j = 0; j < buttons.length; j++) {
          var b = buttons[j];
          var aria = (b.getAttribute("aria-label") || "").toLowerCase();
          var title = (b.getAttribute("title") || "").toLowerCase();
          var text = (b.textContent || "").trim();
          var rect = b.getBoundingClientRect();
          if (
            aria.indexOf("刷新") >= 0 ||
            aria.indexOf("refresh") >= 0 ||
            title.indexOf("刷新") >= 0 ||
            title.indexOf("refresh") >= 0 ||
            text === "刷新" ||
            text === "Refresh" ||
            (rect.top < 180 && rect.right > window.innerWidth - 200 && b.querySelector("svg"))
          ) {
            b.click();
            refreshClicked = true;
            break;
          }
        }
      }
      // 3. re-select the current provider so its detail view re-renders
      setTimeout(function () {
        if (providerName) {
          var items = document.querySelectorAll("div[class*='rounded'], button, div[class*='cursor-pointer']");
          for (var k = 0; k < items.length; k++) {
            var r = items[k].getBoundingClientRect();
            if (r.left < 360 && (items[k].textContent || "").indexOf(providerName) >= 0) {
              items[k].click();
              break;
            }
          }
        }
      }, 150);
      // 4. last resort: if the settings page is still active and saved models
      //    are missing from the DOM, reload so the app re-reads config.json
      if (expectedIds && expectedIds.length) {
        setTimeout(function () {
          try {
            var bodyText = document.body.innerText || "";
            if (bodyText.indexOf("模型列表") < 0) return; // user navigated away
            for (var a = 0; a < expectedIds.length; a++) {
              if (bodyText.indexOf(expectedIds[a]) < 0) {
                location.reload();
                break;
              }
            }
          } catch (e2) {}
        }, 1200);
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
    var ready = readConfig().then(function (cfg) {
        var hit;
        if (!creds.baseUrl) {
          // fallback: exactly one provider configured -> use it
          var sec = cfg.provider || {};
          var keys = Array.isArray(sec) ? sec.map(function (_, i) { return i; }) : Object.keys(sec);
          if (keys.length === 1) {
            var p = Array.isArray(sec) ? sec[0] : sec[keys[0]];
            hit = { key: keys[0], p: p };
            creds.baseUrl = (p.options && p.options.baseURL) || p.baseURL || "";
          } else {
            throw new Error("页面上没有识别到 Base URL，请先填写并保存供应商信息");
          }
        } else {
          hit = findProviderByBaseUrl(cfg, creds.baseUrl, creds);
        }
        if (hit) {
          creds.providerRef = providerReference(hit);
          creds.apiKey = creds.apiKey || creds.providerRef.apiKey;
          creds.headers = hit.p.headers || {};
        }
        return creds;
      });
    ready
      .then(function (c) {
        if (!c.baseUrl) throw new Error("缺少 Base URL");
        return Promise.resolve(api().fetchModels(c.baseUrl, c.apiKey, { dialect: "auto", headers: c.headers })).then(function (r) {
          if (!r || !r.ok) throw new Error((r && r.error) || "拉取失败，请检查 Base URL 和 API Key");
          creds = c;
          // Existing models come from config when the provider is already
          // saved; the DOM scan is only the fallback for unsaved providers.
          return readConfig()
            .then(function (cfg) {
              var hit = findProviderByBaseUrl(cfg, c.baseUrl, c);
              return hit && hit.p.models ? Object.keys(hit.p.models) : null;
            })
            .catch(function () {
              return null;
            })
            .then(function (ids) {
              openModal(r, c, ids);
            });
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
