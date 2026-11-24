# dsh-modelgo-provider

English | [中文](README.zh.md)

[ModelGo]([https://modelgo.ai/?utm_source=dsh-market&utm_medium=sponsorship&utm_content=market_first_plugin&campaign_id=dsh-market&ad_group_id=market_first_plugin]) model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh): adds ModelGo models to the DSH model picker.

## Install

Desktop app: **Plugins → Add plugin**, enter `@model-go/dsh-modelgo-provider`.

Command line:

```sh
dsh plugin --profile web add @model-go/dsh-modelgo-provider@0.3.1
```

Use `--profile tui` or `--profile headless` for those profiles.

Install by package name, not by GitHub address: DSH offers updates only for plugins installed from npm.

Requires DSH `>=0.2.1-rc.1 <0.3.0`; CI runs the plugin on 0.2.1-rc.2, 0.2.2-rc.1 and 0.2.2-rc.5.

## Set your key

This is the only step after installing:

1. Open **Plugins → ModelGo**.
2. Paste your API key and click **Verify and save**. A key starts with `mgk_` and is created in the [modelgo.ai](https://modelgo.ai) console.
3. Back in a conversation, click the model name at the bottom right of the composer and pick a model from the ModelGo group. No restart is needed.

The same field is in the ModelGo row of **Settings → Models**.

The key is checked against the site before it is saved, so a mistyped key is refused on the spot. It is kept in the DSH credential store, never written to a config file and never shown again.

For headless or scripted use, set the key in the environment that starts DSH instead:

```sh
export MODELGO_API_KEY=mgk_...
```

## What it does

- **Models come from the site.** The list is read from `GET /v1/models` with your key, so you see exactly the models your key may use. It is cached for 10 minutes and kept on disk, so it is available at once after a restart.
- **Each model uses the protocol the site offers for it.** Claude models go to `/v1/messages`; other chat models go to `/v1/chat/completions`, as the site's `GET /v1/models/{model}/endpoints` says.
- **Context window and image input** come from what the site publishes for each model.
- **Reasoning levels** follow [`data/model-profiles.json`](data/model-profiles.json), each level checked with a real tool call. When you pick no level, the model runs on its vendor's default: the plugin sends no reasoning switch of its own.
- **Streaming, tool calls and reasoning replay** are handled by the pi-ai adapter that DSH itself ships, so behaviour matches the built-in providers.

Embedding, image, video and audio models are not listed: this version covers chat models only.

## Configuration

Everything is optional. Override the plugin row in your profile's `cordis.patch.yml`:

```yaml
- id: modelgo
  config:
    sites:
      modelgo:
        models:                   # non-empty: serve exactly these models
          - id: some-new-model
            contextWindow: 256000
            input: [text, image]
            reasoningLevels: [off, low, high]
```

| Field | Default | Meaning |
|---|---|---|
| `sites.modelgo.enabled` | `true` | Show ModelGo in the model picker |
| `sites.modelgo.apiKeyEnv` | `MODELGO_API_KEY` | Credential reference holding the key |
| `sites.modelgo.baseURL` | `https://api.modelgo.ai` | Site address |
| `sites.modelgo.displayName` | `ModelGo` | Group heading in the picker |
| `sites.modelgo.headers` | none | Extra HTTP headers |
| `sites.modelgo.models` | `[]` | Empty serves every chat model the site lists; a list serves exactly those |
| `catalogTtlMs` | `600000` | How long a fetched model list is reused |
| `streamIdleTimeoutMs` | `300000` | Abort a stream that stays silent this long |
| `retryPolicy` | DSH default | Retry policy for model requests |

A model entry takes `id`, and optionally `name`, `contextWindow`, `maxTokens`, `input`, `reasoningLevels` and `api` (`openai-completions`, `anthropic-messages` or `openai-responses`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| No ModelGo group in the model picker | No key is saved yet. Set it under **Plugins → ModelGo** |
| The key is reported as not valid | The key is mistyped or has been deleted |
| A model you expect is missing | Your key's policy does not allow it, or it is not a chat model |
| The plugin page never shows "update available" | The plugin was installed from a GitHub address. Remove it and add it again by package name |

## Development

```sh
npm test                 # unit tests, no network
npm run smoke:e2e        # real dsh + local mock gateway: both protocols
npm run smoke:live       # read-only check against the real site, using the key from the environment
node scripts/mock-gateway.mjs   # the mock on its own, to try the key field by hand
```

`smoke:e2e` needs `dsh` on `PATH` (or `DSH_BIN`). It installs the packed tarball into an isolated `DSH_HOME` and uses no real key.

## License

MIT
