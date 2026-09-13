---
name: model-hub
description: Pull the model list from a custom provider (OpenAI-compatible / Anthropic / Gemini endpoint) and merge it into ZCode's config. Use when the user asks to 拉取模型, sync models, auto-add models for a 中转站/provider, or complains that a provider's model list is missing or outdated.
---

# ZCode Model Hub — pull models for a custom provider

You are helping the user pull the available model list from one of their
configured custom providers and write it into ZCode's config
(`~/.zcode/v2/config.json`) atomically. This works entirely in user space and
survives ZCode updates.

## Tool

A zero-dependency CLI is deployed at:

    {{CLI_PATH}}

## Steps

1. List configured providers:

       node "{{CLI_PATH}}" sync --list

2. If the user named a provider, match it by id/name/baseURL from the list.
   If ambiguous, ask the user to pick one (show id, baseURL, current model count).

3. Pull and merge (union semantics: new models are added, manual models are
   preserved; removed ones are recorded in `zcode.deletedModels` so they stay
   deleted):

       node "{{CLI_PATH}}" sync --provider <id>

4. Report the result: how many models were added, total count, and any fetch
   error verbatim (it already redacts API keys). Never print the API key.

## Notes

- Dialects are auto-detected and tried in order: OpenAI-compatible
  (`/v1/models`, `/models`), Anthropic (`/v1/models`), Gemini
  (`v1beta/models`). Timeouts are 10s per attempt.
- If fetching fails, check with the user: is the Base URL reachable? does it
  need a path like `/v1`? is the key valid? Then retry with
  `--dialect openai|anthropic|gemini` if they know the protocol.
- The user can also run everything themselves; the CLI help is:
  `node "{{CLI_PATH}}" --help`.
