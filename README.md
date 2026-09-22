# OpenCode Reflex

**Your agent shouldn't think about every decision.**

[OpenCode](https://opencode.ai) 是一个开源 AI 编程助手。你可以在终端中与它对话，让它理解代码、制定方案、修改文件、运行命令和测试；它已经提供了模型接入、工具调用、权限确认和会话管理。

**Reflex 在这个基础上，为 Agent 加上一层由 Jev 驱动的「条件反射系统」。** Coding LLM 负责思考与写代码，Jev 在关键执行边界判断：该用什么模式、投入多强的模型、这次操作是否需要确认，以及交付前是否还需要修正。

目标很直接：**把昂贵的推理留给难题，把你的注意力留给真正需要判断的地方。**

## 让 Agent 更会分配能力，也更会检查自己的工作

一个编码任务的成本，不只来自生成代码。选错模型、反复确认、过早结束，再由人发现遗漏并重新发起任务，都会消耗时间和注意力。

Reflex 把这些执行决策变成了运行时的一部分。你仍然在熟悉的 OpenCode 界面里聊天，只需选择 `reflex`。

| 能力                 | Reflex 做了什么                                                                | 对你的价值                                             |
| -------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------ |
| **理解你要的交付物** | Jev 根据意图选择实际的 `plan / build` Agent，使用对应提示词、工具与权限        | 讨论方案时专注分析，要求实现时进入执行                 |
| **按难度投入模型**   | 在 `small / normal / strong` 三档 Coding LLM 中路由，纠正阶段可升级            | 简单工作有机会用更低成本完成，困难问题获得更强推理能力 |
| **减少重复确认**     | 在原有权限结果为 `ask` 时，结合真实工具参数、目标资源和用户任务进行判断        | 明确授权的低风险操作可自动继续，不确定时仍交给你确认   |
| **交付前再检查一次** | Jev 根据任务、执行记录、相关 diff 和实际验证结果，判断结束、重试或重新检查方法 | 发现遗漏与失败后，可在同一任务中追加修正，最多两次     |

比如，你输入「修复这个 bug，并运行测试」。Reflex 可以选择 Build 和合适的模型档位；遇到需要确认的工具操作时审查实际参数；准备结束时再核对执行证据。若相关测试明确失败，失败证据会进入纠正反馈，让 Coding LLM 继续处理。

**从选模型，到执行，再到收尾，Agent 开始对整个任务负责。** 成本、人工介入和完成质量的实际变化，将通过下面的对照评测验证。

## Jev 原生的 Harness

Jev 在这里处理的是有明确候选答案的决策，通过独立的 Decisions API 返回 Choice、Score、confidence 和 probabilities。Coding LLM 继续负责推导方案、生成代码与调用工具。

```text
你的任务
   ↓
Jev：选择 Plan / Build + 模型档位
   ↓
Coding LLM：分析、编码、调用工具
   ↕
原有权限规则 → 有效 ask → Jev 审查 → 执行 / 人工确认 / 拒绝
   ↓
Jev：检查结果与真实执行证据
   ├─ finish → 交付
   └─ retry / replan → 追加反馈，必要时升级模型，最多纠正两次
```

自动化保留明确边界：Jev 不能覆盖有效的硬拒绝，自动放行只对本次操作生效；低置信度或网络异常时，权限判断回到现有人工确认。默认每项任务最多 30 个 Coding LLM provider turns，并受实际 Agent 更严格的步数上限约束。

每次决策都留下可追溯的 JSONL 记录：Jev 建议了什么、最终采用了什么、用量、费用、延迟，以及对应的任务、消息和工具调用。这样，后续可以用真实执行数据回答「究竟省了多少、改善了什么」。第一版的质量分数来自 Jev 固定标准评价，尚未引入独立 Reward Model 或自动训练。

## Benchmark · 待实测

**我们要验证：优化 Harness，能否让同一批编码任务以更少的成本、更少的人工介入完成，同时保持或提升成功率？**

以下为结果占位，所有 `TODO` 均待真实运行后填写。

| 指标                         | 原版 OpenCode | OpenCode + Reflex | 变化          |
| ---------------------------- | ------------- | ----------------- | ------------- |
| 任务通过率 ↑                 | TODO          | TODO              | TODO · 百分点 |
| 平均总费用 / 任务 ↓          | TODO          | TODO              | TODO · %      |
| 平均人工确认次数 / 任务 ↓    | TODO          | TODO              | TODO · %      |
| 任务总耗时 P50 / P95 ↓       | TODO          | TODO              | TODO · %      |
| Strong 模型调用次数 / 任务 ↓ | TODO          | TODO              | TODO · %      |
| 首次失败后的纠正成功率 ↑     | TODO          | TODO              | TODO · 百分点 |
| Jev 决策延迟 P50 / P95       | —             | TODO              | —             |

- [ ] **评测任务：** TODO — 任务集来源、任务数量、类型与独立验收条件。
- [ ] **对照设置：** TODO — OpenCode commit、模型版本、Baseline 模型策略、权限规则和执行预算。
- [ ] **实验记录：** TODO — 相同初始仓库与环境下的配对运行、重复次数、失败与超时记录。
- [ ] **结果发布：** TODO — 原始 trajectory、决策 JSONL、汇总脚本及成本 / 成功率对比图。

统计总费用时计入 Coding LLM、Jev 和纠正带来的调用；未知费用标记为未知。任务成功由独立测试或验收标准判定，Jev 自评与 confidence 单独报告。confidence 表示预测分布的集中程度，不等同于实测正确率。人工确认减少也需要结合错误放行情况一起评估。

## 直接聊起来

在本仓库根目录安装依赖，首次配置时复制环境变量模板：

```sh
bun install --frozen-lockfile
cp .env.example .env
```

编辑 `.env`，填写 Jev Key、Coding LLM 的 OpenAI-compatible 地址和 Key，以及 `SMALL / NORMAL / STRONG` 三个模型名。三档 Coding LLM 共用一个站点，Jev 使用独立的 Decisions 接口。

启动交互式终端聊天，默认选中 Reflex：

```sh
bun --no-env-file script/reflex.ts --env-file .env --agent reflex
```

输入需求，按 Enter 开始。可以先试试「解释这个项目的结构」，再试「修复一个 bug 并验证」。选择普通的 `build / plan` Agent 即可退出自动路由；设置 `REFLEX_ENABLED=false` 可关闭 Reflex 功能。

更多配置、服务端启动、连通性检查和日志说明见 [Reflex 使用文档](docs/reflex.md)。

---

本项目基于 [OpenCode](https://github.com/anomalyco/opencode) 开发，是独立扩展项目，与 OpenCode 官方团队无隶属关系。感谢 OpenCode 提供 Agent 执行底座，以及 Jev 提供 typed decision 能力。
