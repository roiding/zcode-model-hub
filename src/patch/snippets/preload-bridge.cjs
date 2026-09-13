/* __ZCODE_MODEL_HUB_V1__ preload bridge (appended block).
 * Exposes window.zcodeModelHub via the official contextBridge.
 * Self-contained; safe to remove this whole block to uninstall. */
;(function () {
  try {
    if (globalThis.__ZCODE_MODEL_HUB_V1_PRELOAD__) return;
    globalThis.__ZCODE_MODEL_HUB_V1_PRELOAD__ = true;
    var electron = require("electron");
    electron.contextBridge.exposeInMainWorld("zcodeModelHub", {
      version: 1,
      fetchModels: function (baseUrl, apiKey, opts) {
        return electron.ipcRenderer.invoke("modelhub:fetch-models", {
          baseUrl: baseUrl,
          apiKey: apiKey,
          headers: (opts && opts.headers) || null,
          dialect: (opts && opts.dialect) || "auto",
        });
      },
      probeVision: function (baseUrl, apiKey, model, opts) {
        return electron.ipcRenderer.invoke("modelhub:probe-vision", {
          baseUrl: baseUrl,
          apiKey: apiKey,
          model: model,
          headers: (opts && opts.headers) || null,
          dialect: (opts && opts.dialect) || "auto",
        });
      },
      readConfig: function () {
        return electron.ipcRenderer.invoke("modelhub:read-config");
      },
      writeConfig: function (cfg) {
        return electron.ipcRenderer.invoke("modelhub:write-config", cfg);
      },
    });
  } catch (e) {
    try {
      console.error("[zcode-model-hub] preload bridge failed:", (e && e.message) || e);
    } catch {}
  }
})();
