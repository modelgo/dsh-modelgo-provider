# dsh-modelgo-provider

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 [ModelGo](https://modelgo.com) 模型提供商插件。

ModelGo 有两个站点，账号和密钥互不通用。本插件把它们分别接入模型选择器，各成一组：

| 选择器分组 | 提供商路由 | API 地址 | 密钥引用 |
|---|---|---|---|
| ModelGo (modelgo.com) | `modelgo` | `https://api.modelgo.com` | `MODELGO_API_KEY` |
| ModelGo (modelgo.ai) | `modelgo-ai` | `https://api.modelgo.ai` | `MODELGO_AI_API_KEY` |

## 安装

```sh
dsh plugin --profile web add @model-go/dsh-modelgo-provider@0.2.2
```

其他 profile 把 `web` 换成 `tui` 或 `headless`。桌面版在**插件 → 添加插件**里输入 `@model-go/dsh-modelgo-provider`。

请按包名安装，不要填 GitHub 地址：DSH 只对从 npm 安装的插件提供更新。用 `github:modelgo/dsh-modelgo-provider` 装的副本可以用，但永远不会提示「可更新」；要升级只能先卸载，再按包名重新添加。

需要 DSH `>=0.2.1-rc.1 <0.3.0`；CI 在 0.2.1-rc.2、0.2.2-rc.1、0.2.2-rc.5 上运行本插件。插件没有构建步骤，也没有 DSH 自带之外的运行时依赖。

## 配置密钥

安装后只需要这一步。下面两个位置是同一个输入框，任选一个：

| 在哪里 | 怎么到达 |
|---|---|
| 插件自己的页面 | 左侧**插件** → 点开 **ModelGo** → 往下滚动到两张密钥卡片 |
| 模型设置 | 左下角**更多** → **设置** → **模型** |

1. 找到你使用的站点对应的卡片：**ModelGo（modelgo.com）** 或 **ModelGo（modelgo.ai）**。
2. 粘贴密钥，点**验证并保存**。密钥以 `mgk_` 开头，在对应站点的控制台创建。
3. 回到对话框，点输入框右下角的模型名称，选择 ModelGo 这一组里的模型。不需要重启。

密钥在保存前会先向站点验证，填错了，或者填成另一个 ModelGo 站点的密钥，会当场提示。只需要配置你用的那个站点；没有密钥的站点不显示任何模型。

密钥保存在 DSH 凭据库里。插件不会把它写进配置文件，不会再次显示它，报错信息里的密钥值也会被抹掉。

无界面或脚本场景，可以改为在启动 DSH 的环境里设置：

```sh
export MODELGO_API_KEY=mgk_...        # modelgo.com
export MODELGO_AI_API_KEY=mgk_...     # modelgo.ai
```

## 功能

- **模型列表来自站点。** 用你的密钥读取 `GET /v1/models`，所以看到的就是这把密钥能用的模型。列表缓存 10 分钟；刷新失败时继续使用上一次的列表。
- **每个模型走站点为它开放的协议。** Claude 模型走 `/v1/messages`（Anthropic Messages），其他对话模型走 `/v1/chat/completions`。插件对每个模型每天读取一次 `GET /v1/models/{model}/endpoints`，按站点声明的协议发送；站点没有为其开放对话协议的模型不会列出。
- **上下文窗口和图片输入**取自站点为每个模型发布的信息。
- **思考档位**只对 [`data/model-profiles.json`](data/model-profiles.json) 里列出的模型提供，每个档位都在 modelgo.com 上用真实的工具调用验证过。不在该文件里的模型不提供思考档位，直到你为它补充描述（见下文）。
- **模型列表重启后仍在。** 上一次成功读到的列表会保存在本地，下次启动立刻可用，即使当时连不上站点。
- **流式输出、工具调用和思考回放**由 DSH 自带的 pi-ai 适配器处理，行为与内置提供商一致。

向量、图片、视频、音频模型不会列出：当前版本只覆盖对话模型。

## 配置项

全部可选。在 profile 的 `cordis.patch.yml` 里覆盖插件这一行：

```yaml
- id: modelgo
  config:
    sites:
      modelgo-ai:
        enabled: false            # 隐藏不用的站点
      modelgo:
        models:                   # 非空：只提供这里列出的模型
          - id: some-new-model
            contextWindow: 256000
            input: [text, image]
            reasoningLevels: [off, low, high]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sites.<路由>.enabled` | `true` | 是否在模型选择器里显示该站点 |
| `sites.<路由>.apiKeyEnv` | 见上表 | 存放密钥的凭据引用 |
| `sites.<路由>.baseURL` | 见上表 | 站点地址 |
| `sites.<路由>.displayName` | 见上表 | 选择器里的分组标题 |
| `sites.<路由>.headers` | 无 | 仅发给该站点的额外 HTTP 头 |
| `sites.<路由>.models` | `[]` | 为空时提供站点列出的全部对话模型；非空时只提供列出的模型 |
| `catalogTtlMs` | `600000` | 模型列表的缓存时长 |
| `streamIdleTimeoutMs` | `300000` | 流式响应静默超过该时长则中止 |
| `retryPolicy` | DSH 默认 | 模型请求的重试策略 |

模型条目必填 `id`，可选 `name`、`contextWindow`、`maxTokens`、`input`、`reasoningLevels` 和 `api`（`openai-completions`、`anthropic-messages` 或 `openai-responses`）。

## 常见问题

| 现象 | 原因 |
|---|---|
| 选择器里少了一个站点的分组 | 该站点没有配置密钥（在设置 → 模型里填），或被禁用 |
| `MISSING_CREDENTIAL` | 该站点没有保存密钥，启动 DSH 的环境里也没有设置 |
| 读取模型列表时报 `AUTH` | 密钥错误，或者用了另一个站点的密钥 |
| 缺少某个预期的模型 | 密钥的策略不允许使用它，或者它不是对话模型 |

## 开发

```sh
npm test                 # 单元测试，不联网
npm run smoke:e2e        # 真实 dsh + 本地模拟网关：两个站点、两种协议
node scripts/mock-gateway.mjs   # 单独启动模拟网关，手动试设置页里的密钥卡片
npm run smoke:live       # 用环境变量里的密钥对真实站点做只读检查
```

`smoke:e2e` 需要 `PATH` 里有 `dsh`（或设置 `DSH_BIN`）。它把打包产物装进隔离的 `DSH_HOME`，不使用真实密钥。

## 许可证

MIT
