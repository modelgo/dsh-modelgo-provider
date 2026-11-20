# dsh-modelgo-provider

English | [中文](README.zh.md)

[ModelGo](https://modelgo.com) model provider for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

ModelGo runs two sites with separate accounts and keys. This plugin adds each as its own group in the model picker:

| Picker group | Provider route | API address | Key reference |
|---|---|---|---|
| ModelGo (modelgo.com) | `modelgo` | `https://api.modelgo.com` | `MODELGO_API_KEY` |
| ModelGo (modelgo.ai) | `modelgo-ai` | `https://api.modelgo.ai` | `MODELGO_AI_API_KEY` |

## Install

```sh
dsh plugin --profile web add @model-go/dsh-modelgo-provider@0.1.0
```

Use `--profile tui` or `--profile headless` for those profiles. To install from source instead:

```sh
dsh plugin --profile web add github:modelgo/dsh-modelgo-provider
```

Requires DSH `>=0.2.1-rc.1 <0.3.0`. There is no build step and no runtime dependency beyond what DSH ships.

## Set your keys

Create a key in the console of the site you use, then put it in the environment that starts DSH:

```sh
export MODELGO_API_KEY=mgk_...        # modelgo.com
export MODELGO_AI_API_KEY=mgk_...     # modelgo.ai
```

You only need the key for the site you use. A site with no key shows no models. A key from one site does not work on the other.

Keys are resolved through the DSH credential service on every request. The plugin never writes a key to a config file and removes key values from error messages.

## What it does

- **Models come from the site.** The list is read from `GET /v1/models` with your key, so you see exactly the models your key may use. It is cached for 10 minutes; if a refresh fails, the previous list keeps serving.
- **Each model uses the protocol the site offers for it.** Claude models go to `/v1/messages` (Anthropic Messages); other chat models go to `/v1/chat/completions`. The plugin reads `GET /v1/models/{model}/endpoints` once per model per day and follows what the site advertises; a model the site offers on no chat protocol is not listed.
- **Context window and image input** come from what the site publishes for each model.
- **Reasoning levels** are offered for the models listed in [`data/model-profiles.json`](data/model-profiles.json). A model not in that file is offered as text-only with no reasoning levels until you describe it (see below).
- **Streaming, tool calls and reasoning replay** are handled by the pi-ai adapter that DSH itself ships, so behaviour matches the built-in providers.

Embedding, image, video and audio models are not listed: this version covers chat models only.

## Configuration

Everything is optional. Override the plugin row in your profile's `cordis.patch.yml`:

```yaml
- id: modelgo
  config:
    sites:
      modelgo-ai:
        enabled: false            # hide a site you do not use
      modelgo:
        models:                   # non-empty: serve exactly these models
          - id: some-new-model
            contextWindow: 256000
            input: [text, image]
            reasoningLevels: [off, low, high]
```

| Field | Default | Meaning |
|---|---|---|
| `sites.<route>.enabled` | `true` | Show this site in the model picker |
| `sites.<route>.apiKeyEnv` | see table above | Credential reference holding the key |
| `sites.<route>.baseURL` | see table above | Site address |
| `sites.<route>.displayName` | see table above | Group heading in the picker |
| `sites.<route>.headers` | none | Extra HTTP headers for this site |
| `sites.<route>.models` | `[]` | Empty serves every chat model the site lists; a list serves exactly those |
| `catalogTtlMs` | `600000` | How long a fetched model list is reused |
| `streamIdleTimeoutMs` | `300000` | Abort a stream that stays silent this long |
| `retryPolicy` | DSH default | Retry policy for model requests |

A model entry takes `id`, and optionally `name`, `contextWindow`, `maxTokens`, `input`, `reasoningLevels` and `api` (`openai-completions`, `anthropic-messages` or `openai-responses`).

## Troubleshooting

| Symptom | Cause |
|---|---|
| A site's group is missing from the picker | No key is set for that site, or the site is disabled |
| `MISSING_CREDENTIAL` | The key reference for that site resolves to nothing in the environment that started DSH |
| `AUTH` when listing models | The key is wrong, or belongs to the other site |
| A model you expect is missing | Your key's policy does not allow it, or it is not a chat model |

## Development

```sh
npm test                 # unit tests, no network
npm run smoke:e2e        # real dsh + local mock gateway: both sites, both protocols
npm run smoke:live       # read-only check against the real sites, using keys from the environment
```

`smoke:e2e` needs `dsh` on `PATH` (or `DSH_BIN`). It installs the packed tarball into an isolated `DSH_HOME` and uses no real key.

## License

MIT
