---
description: 从自定义供应商拉取模型列表并写入 ZCode 配置
---

Run this to pull models for a custom provider (works fully in user space and
survives ZCode updates):

1. `node "{{CLI_PATH}}" sync --list` — list configured providers.
2. If the user didn't say which provider, show the list and ask them to pick one.
3. `node "{{CLI_PATH}}" sync --provider <id>` — fetch and merge the model list.
4. Summarize how many models were added / total, and surface any error
   verbatim. Never print API keys.

If the user asks about updating models later, just rerun step 3 — the merge
is idempotent and preserves manual models.
