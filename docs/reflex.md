# OpenCode Reflex

Reflex 在当前 OpenCode CLI / TUI / Web 使用的 Session 执行链中加入 Jev 决策。现有 UI 不需要修改；直接选择新增的 `reflex` Agent。

## 启动

在仓库根目录运行：

```sh
bun install --frozen-lockfile
cp .env.example .env
```

编辑 `.env`，填写 `JEV_API_KEY`、`REFLEX_LLM_BASE_URL`、`REFLEX_LLM_API_KEY`，以及 `REFLEX_MODEL_SMALL / NORMAL / STRONG` 三个实际模型名称。Jev 和 Coding LLM 可以使用不同站点和不同 Key；三档 Coding LLM 共用同一站点。

```sh
# TUI：使用现有 Agent 选择器选择 reflex
bun --no-env-file script/reflex.ts --env-file .env

# 命令行任务
bun --no-env-file script/reflex.ts --env-file .env run --agent reflex "解释这个项目的结构"

# 提供服务给现有客户端
bun --no-env-file script/reflex.ts --env-file .env serve

# 显式、会产生费用：一次 Jev 判断和三个模型的 tool-call 连通性检查
bun --no-env-file script/reflex.ts --env-file .env --check
```

`--no-env-file` 防止启动器隐式加载其他 `.env`，启动器只给子进程传入指定文件。已有进程环境变量优先于文件。相对路径以启动命令的当前目录为准。连接远程 OpenCode 时，应在服务端配置凭据；修改配置后重启服务。

`REFLEX_ENABLED=false` 关闭内置 Reflex。直接选择 `build`、`plan` 或其他 Agent 则对该任务使用原有行为。`reflex` 下界面选择的普通模型由自动路由覆盖；需要固定模型时使用普通 Agent。

## 决策与执行

| 边界                 | Jev 判断                                            | 生效方式                                                  |
| -------------------- | --------------------------------------------------- | --------------------------------------------------------- |
| 新用户任务           | `build / plan`、`small / normal / strong`           | 两个 Choice 批量请求，使用实际 Agent 的提示词、工具和权限 |
| 工具有效权限为 `ask` | `allow / ask / deny`                                | 高置信度允许或拒绝，否则使用原有确认界面                  |
| 正常准备结束         | `finish / retry / replan`、五档质量 Score、问题类别 | 最多两次追加纠正；replan 至少升一档模型                   |

Jev 通过 `POST https://openrouter.ai/api/alpha/decisions` 接收 `{model,state,questions}`。这是 Decisions API，与 Coding LLM 的 `/chat/completions` 分开。默认 Jev 模型为 `typesafe/jev-1.13`，URL 和模型名可覆盖。

- 意图决定 Agent：要求方案使用 Plan，要求实现使用 Build，复杂度只影响模型档位。
- 普通工具续轮保持模型；纠正阶段只保持或升级，不降档。
- 新任务路由失败或低置信度时使用 Plan + Normal。工具审查失败回到人工确认；结果评价失败记为 `unverified`。
- 所有既有有效 `allow` / `deny` 规则保持原样。Jev 自动允许仅限本次请求，不保存永久授权，不替用户回答 Question。
- 子 Agent 保留其角色和模型，权限审查沿 Session 父链继承；不会自动嵌套结果纠正循环。
- 模型声称测试通过不等于实际通过。可识别验证命令的真实退出码是单独证据；同一个命令重新执行后使用最新结果。无法识别或未执行的检查仍是未知。
- 质量分数是 Jev 的评价，不是 benchmark 成功标签；confidence 是分布集中程度，不是正确率。

## 模型能力与执行预算

默认配置只需要站点、Key 和三个模型名。已知模型从本地模型目录复用能力、上下文和价格。未知模型默认按支持工具的文本模型注册，采用 32,768 context / 8,192 output 的配置上限；这不是对站点能力的探测，请用实际规格覆盖并运行连通性检查。

可以使用原有 `opencode.json` 的 Provider 配置补充规格，例如：

```json
{
  "provider": {
    "reflex": {
      "models": {
        "small": {
          "limit": { "context": 32768, "output": 4096 },
          "tool_call": true,
          "cost": { "input": 0.1, "output": 0.3 }
        }
      }
    }
  }
}
```

上面的价格只是配置格式示例，必须替换为站点实际价格；单位沿用 OpenCode 的每百万 tokens 价格。模型名、站点和凭据仍来自环境变量。若配置了 Provider 白名单，必须允许 `reflex`。

`REFLEX_MAX_CORRECTIONS` 默认 2，允许 0–2；`REFLEX_MAX_PROVIDER_TURNS` 默认 30，与当前实际 Agent 的 steps 上限取较小者。一次 provider turn 包含模型输出及其工具结算；原有网络重试仍由原有 LLM 层处理。纠正和自动上下文压缩不会刷新计数。用户新任务开始新预算。

任务状态存于现有 Session metadata，纠正使用带 Reflex metadata 的 synthetic text。退出后显式恢复会话会复用预算，并避免重复注入已保存的反馈；没有新增自动崩溃恢复或工具重放。

## 记录与外部评测

每个 Session 的 JSONL 位于 OpenCode 数据目录的 `reflex/<session_id>.jsonl`，默认通常是 `~/.local/share/opencode/reflex/`，遵循 `XDG_DATA_HOME`。通过现有 `opencode debug paths` 可以查看实际数据目录。

主要字段：

```text
schema_version, timestamp, session_id, task_id, message_id, call_id,
decision_kind, question_version, proposed, applied,
confidence, probabilities, fallback_reason, model, request_id,
latency_ms, usage, cost, correction_index
```

`decision_kind` 包括 `route`、`permission`、`outcome`、`llm`、`budget`。`proposed` 保留 Jev typed answers，`applied` 是实际策略动作。LLM 日志包含实际模型、用量和原有 OpenCode 计费结果；无法确认费用时 `cost=null`，不把目录默认零价当作免费。Jev 使用响应中的实际 `usage.cost`，缺失也记为 null。

外部脚本可按 `task_id` 汇总上述日志，再按消息和 call ID 连接原有 trajectory。不要将 `outcome.applied=finish` 当作测试成功；检查 `verification` 和独立验收结果。没有内置评测脚本、自动调参或模型训练。

日志不写完整上下文、环境变量或 Key。Jev 接收当前任务、有限的历史与工具证据、相关 diff；配置中的 Key 会脱敏，常见凭据文件的工具证据省略。过大的决策状态会回退，避免默默丢弃授权上下文。不要将此脱敏视为通用 DLP。

## 故障与测试

- `http_401/403`：检查 Jev Key 和访问权限。
- `http_402`：检查 OpenRouter 余额。
- `http_404`：检查 `JEV_URL` 和 `JEV_MODEL`；alpha 路径可配置。
- `transport_or_schema_error`：网络、超时或网关协议不匹配；不要将 Jev 配成聊天模型。
- `context_too_large`：决策证据超出请求预算，日志记录回退。
- Coding LLM 不支持工具：更换模型或修正 Provider 配置，运行 `--check` 验证。

普通启动不会发起付费连通性探测。默认测试使用本地 HTTP 服务，不需要真实 Key：

```sh
cd packages/opencode
bun test test/reflex test/session/prompt.test.ts test/permission/next.test.ts test/agent/agent.test.ts
bun typecheck
```

测试需要允许监听 loopback 和文件监听。真实服务的延迟、质量、模型可用性和费用，需要填入凭据后验证。

协议依据：[OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)、[TypeSafe confidence](https://docs.typesafe.ai/confidence)。实现参考：[typesafe-mcp](https://github.com/itsmostafa/typesafe-mcp)、[pi-jev-model-router](https://github.com/da-vinci-noob/pi-jev-model-router)、[pi-jev-router](https://github.com/win4r/pi-jev-router)；未引入它们作为依赖。
