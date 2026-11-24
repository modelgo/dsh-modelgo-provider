# dsh-modelgo-provider

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 [ModelGo](https://modelgo.ai/?utm_source=dsh-market&utm_medium=sponsorship&utm_content=market_first_plugin&campaign_id=dsh-market&ad_group_id=market_first_plugin) 模型提供商插件：把 ModelGo 的模型接入 DSH 的模型选择器。

## 安装

桌面版：**插件 → 添加插件**，输入 `@model-go/dsh-modelgo-provider`。

命令行：

```sh
dsh plugin --profile web add @model-go/dsh-modelgo-provider@0.3.1
```

其他 profile 把 `web` 换成 `tui` 或 `headless`。

请按包名安装，不要填 GitHub 地址：DSH 只对从 npm 安装的插件提供更新。

需要 DSH `>=0.2.1-rc.1 <0.3.0`；CI 在 0.2.1-rc.2、0.2.2-rc.1、0.2.2-rc.5 上运行本插件。

## 配置密钥

安装后只需要这一步：

1. 打开**插件 → ModelGo**。
2. 粘贴 API 密钥，点**验证并保存**。密钥以 `mgk_` 开头，在 [modelgo.ai]([https://modelgo.ai](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 [ModelGo](https://modelgo.ai/?utm_source=dsh-market&utm_medium=sponsorship&utm_content=market_first_plugin&campaign_id=dsh-market&ad_group_id=market_first_plugin)) 的控制台创建。
3. 回到对话框，点输入框右下角的模型名称，选择 ModelGo 这一组里的模型。不需要重启。

同一个输入框也在**设置 → 模型**的 ModelGo 一行里。

密钥在保存前会先向站点验证，填错了会当场提示。它保存在 DSH 凭据库里，不会写进配置文件，也不会再次显示。

无界面或脚本场景，可以改为在启动 DSH 的环境里设置：

```sh
export MODELGO_API_KEY=mgk_...
```

## 功能

- **模型列表来自站点。** 用你的密钥读取 `GET /v1/models`，看到的就是这把密钥能用的模型。列表缓存 10 分钟，并保存在本地，重启后立刻可用。
- **每个模型走站点为它开放的协议。** Claude 模型走 `/v1/messages`，其他对话模型走 `/v1/chat/completions`，以站点的 `GET /v1/models/{model}/endpoints` 为准。
- **上下文窗口和图片输入**取自站点为每个模型发布的信息。
- **思考档位**按 [`data/model-profiles.json`](data/model-profiles.json) 提供，每个档位都用真实的工具调用验证过。不选档位时按模型厂商的默认行为运行，插件不会自己加思考开关。
- **流式输出、工具调用和思考回放**由 DSH 自带的 pi-ai 适配器处理，行为与内置提供商一致。

向量、图片、视频、音频模型不会列出：当前版本只覆盖对话模型。

## 配置项

全部可选。在 profile 的 `cordis.patch.yml` 里覆盖插件这一行：

```yaml
- id: modelgo
  config:
    sites:
      modelgo:
        models:                   # 非空：只提供这里列出的模型
          - id: some-new-model
            contextWindow: 256000
            input: [text, image]
            reasoningLevels: [off, low, high]
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `sites.modelgo.enabled` | `true` | 是否在模型选择器里显示 |
| `sites.modelgo.apiKeyEnv` | `MODELGO_API_KEY` | 存放密钥的凭据引用 |
| `sites.modelgo.baseURL` | `https://api.modelgo.ai` | 站点地址 |
| `sites.modelgo.displayName` | `ModelGo` | 选择器里的分组标题 |
| `sites.modelgo.headers` | 无 | 额外的 HTTP 头 |
| `sites.modelgo.models` | `[]` | 为空时提供站点列出的全部对话模型；非空时只提供列出的模型 |
| `catalogTtlMs` | `600000` | 模型列表的缓存时长 |
| `streamIdleTimeoutMs` | `300000` | 流式响应静默超过该时长则中止 |
| `retryPolicy` | DSH 默认 | 模型请求的重试策略 |

模型条目必填 `id`，可选 `name`、`contextWindow`、`maxTokens`、`input`、`reasoningLevels` 和 `api`（`openai-completions`、`anthropic-messages` 或 `openai-responses`）。

## 常见问题

| 现象 | 原因 |
|---|---|
| 模型选择器里没有 ModelGo | 还没有保存密钥。到**插件 → ModelGo**填写 |
| 提示密钥无效 | 密钥填错了，或者已经被删除 |
| 缺少某个预期的模型 | 密钥的策略不允许使用它，或者它不是对话模型 |
| 插件页没有「可更新」 | 插件是用 GitHub 地址装的。卸载后按包名重新添加 |

## 开发

```sh
npm test                 # 单元测试，不联网
npm run smoke:e2e        # 真实 dsh + 本地模拟网关：两种协议
npm run smoke:live       # 用环境变量里的密钥对真实站点做只读检查
node scripts/mock-gateway.mjs   # 单独启动模拟网关，手动试密钥输入框
```

`smoke:e2e` 需要 `PATH` 里有 `dsh`（或设置 `DSH_BIN`）。它把打包产物装进隔离的 `DSH_HOME`，不使用真实密钥。

## 许可证

MIT
