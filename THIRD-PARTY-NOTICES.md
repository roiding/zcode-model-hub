# Third-party notices

This project is an independent MIT-licensed fusion of ideas from two upstream
projects. No upstream code is distributed here verbatim; the surgical ASAR
technique, anchor-validation strategy and MutationObserver UI approach are
re-implemented with attribution.

## HHQ-666/zcode-model-puller
- https://github.com/HHQ-666/zcode-model-puller
- License: MIT (c) HHQ-666
- Ideas used: standalone renderer script injected via `index.html`,
  MutationObserver-based UI injection, main-process IPC for CORS-free model
  fetching, config read/write IPC, cold backup + one-click restore.

## CSSZYF/zcode-modelhub-patch
- https://github.com/CSSZYF/zcode-modelhub-patch
- License: MIT (c) CSSZYF
- Ideas used: zero-dependency surgical ASAR reader/writer that preserves the
  original data region byte-for-byte, strict anchor-count validation
  (exactly-once or abort), atomic replace with size verification, per-dialect
  (OpenAI/Anthropic/Gemini) endpoint probing, 1x1 image vision probing,
  deleted-model persistence via `zcode.deletedModels`.

## models.dev community
- https://models.dev — referenced as prior art for user-space provider syncing
  (the CLI/skill layer of this project follows the same philosophy).
