# OpenCode Reflex

### An Adaptive Harness for Coding Agents

**Less cost. Less human intervention. Better results.**

> 在 OpenCode 的执行流程中加入 Jev 智能决策层，让 Agent 按任务选模型、按风险请求确认、按结果继续修正。
>
> **目标：用更少的钱、更少的人类确认，完成更多任务。**

[OpenCode](https://opencode.ai) 是开源 AI 编程助手，支持在终端里理解代码、制定方案、修改文件和运行测试。本项目复用它的界面、工具、权限与会话系统，新增一个可直接选择的 **`reflex` Agent**。

**你继续用自然语言提需求。Reflex 负责决定：投入多少模型能力，哪些操作需要你介入，以及什么时候才算完成。**


## 三个决策点，对应三个直接收益

```text
                     User Task
                         │
              ① Model Router · Jev
                选择 Agent 与模型档位
                         │
                  Coding Agent
                  分析、编码、调用工具
                         │
            ② Permission Gate · Jev
               审查规则留下的 ask 操作
                         │
                  执行与真实结果
                         │
             ③ Outcome Judge · Jev
                finish / retry / replan
                         │
                  交付，或继续纠正
```

### ① Model Router：把强模型用在难题上

局部修改、常规开发和跨模块调试，值得投入的推理成本并不相同。Reflex 让 Jev 在任务开始时选择合适的模型档位，并将决定直接应用到实际调用。

```text
局部、明确、机械性任务    → small
常规修改、测试、多步骤开发 → normal
复杂调试、跨模块推理      → strong
```

同时，Jev 根据用户意图选择实际的 `plan / build` Agent：要求分析就规划，要求实现就执行。复杂实现任务可以使用 **Build + Strong**。

普通工具续轮保持当前模型；需要纠正时，模型可以升级。你可以配置自己的三个 Coding LLM，复用原有工具调用和用量统计。

**衡量价值：每项任务花了多少钱，强模型调用减少了多少，通过率是否保持。**

### ② Permission Gate：让人工确认用在需要判断的地方

权限规则能划定边界，Jev 则结合当前任务理解这一次具体操作。Reflex 在规则结果为 `ask` 时，读取真实工具名、参数和目标资源，再决定是否需要打断你。

```text
Tool Call → 原有权限规则
               ├─ deny  → 拒绝
               ├─ allow → 执行
               └─ ask   → Jev 判断
                            ├─ 高置信度 allow → 仅放行本次操作
                            ├─ 高置信度 deny  → 拒绝
                            └─ 不确定或异常   → 原有人工确认
```

明确授权的低风险操作可以继续，不确定的操作仍交给人。**有效的硬拒绝始终生效，自动放行不会变成永久授权。**

**衡量价值：完成一个任务需要人点多少次确认，减少确认后是否出现错误放行。**

### ③ Outcome Judge：把「发现问题」接到「继续修复」

Agent 准备结束时，Reflex 将原始任务、执行记录、相关 diff 和实际测试结果交给 Jev 评价。评价结果会直接改变后续执行。

```text
Agent 准备交付
      ↓
Jev 检查：任务 + trajectory + diff + 验证结果
      ├─ finish → 正常结束
      ├─ retry  → 注入问题类别与失败证据，继续修正
      └─ replan → 重新检查方法，并至少升级一个模型档位
```

例如，Agent 声称修复完成，但相关测试实际失败，失败证据会进入纠正反馈。Coding LLM 读取已有历史，推导下一步修复方案。**这让一次尚未完成的任务，有机会在交还给你之前完成修正。**

最多追加两次纠正，默认整项任务最多 30 个 Coding LLM provider turns，并服从实际 Agent 更严格的步数上限。Plan 任务按方案是否满足请求评价。

**衡量价值：独立验收通过率提高了多少，首次失败后有多少任务被成功修正。**

## Before / After：用结果证明 Harness 的价值

同一批任务、同一模型池、相同初始环境，对比原版 OpenCode 与启用 Reflex 的执行策略。

**↓ Cost · TODO　　↓ Human Approvals · TODO　　↑ Pass Rate · TODO　　↓ Latency · TODO**

> 实测结果待补充。以下均为 benchmark 占位，箭头表示优化目标。

| Metric                                               | OpenCode Baseline | OpenCode + Reflex |  Change |
| ---------------------------------------------------- | ----------------: | ----------------: | ------: |
| **Task Pass Rate** · 独立验收通过率                  |              TODO |              TODO | TODO pp |
| **Total Cost / Task** · 平均总费用                   |              TODO |              TODO |  TODO % |
| **Human Approvals / Task** · 平均人工确认次数        |              TODO |              TODO |  TODO % |
| **Task Latency P50 / P95** · 任务耗时                |              TODO |              TODO |  TODO % |
| **Strong Model Calls / Task** · 强模型调用次数       |              TODO |              TODO |  TODO % |
| **Correction Success Rate** · 首次失败后的纠正成功率 |              TODO |              TODO | TODO pp |


## 为什么 Jev 是核心

三个边界都需要从明确的候选项中作出选择。Jev 通过 Decisions API 提供 typed decision、confidence 和 probabilities；Coding LLM 负责理解代码、生成方案和执行修改。

**Jev 的输出会改变下一步执行：切换模型、放行或拒绝操作、结束或延长任务。** 它贯穿 Harness 的控制流程。

当前版本的结果评价与质量评分也由 Jev 完成。独立 Reward Model、训练和自动调参属于后续方向；confidence 表示预测分布的集中程度，实际正确率需要外部评测验证。

## 每一次执行，都留下可验证的数据

每个 Session 输出结构化 JSONL，关联原有执行轨迹，记录 **Jev 的建议、实际采用的动作、置信度、概率分布、延迟、用量与费用**。

```text
Jev 决策 → Harness 执行 → 真实工具结果 → 决策日志 + Trajectory
                                               ↓
                                    外部验收与 Before / After 评测
                                               ↓
                                    后续策略优化的数据基础
```

这些数据让模型路由是否划算、权限判断是否可靠、纠正是否有效，都有据可查。质量分数作为评价数据保留，任务是否成功由独立测试或验收标准判定。

Benchmark 待补充：

- [ ] **任务集：** TODO — 20–30 个编码任务、来源、难度分布与验收条件。
- [ ] **对照配置：** TODO — 锁定代码版本、模型池、Baseline 模型选择策略、权限规则与任务预算。
- [ ] **实验方法：** TODO — 配对运行、重复次数、失败与超时处理、人工确认策略。
- [ ] **Jev 开销与可靠性：** TODO — 决策延迟 P50 / P95、费用、回退率、错误放行率。
- [ ] **可复现结果：** TODO — 原始日志、验收结果、汇总脚本、成本 / 成功率对比图。

费用统计包含 Coding LLM、Jev 和纠正调用；未知费用保留为未知。单独报告人工等待时间，并用消融实验区分路由、权限审查与结果纠正各自的贡献。

## 现在就试

在仓库根目录安装依赖，首次使用时复制配置模板：

```sh
bun install --frozen-lockfile
cp .env.example .env
```

在 `.env` 中填入 Jev Key、Coding LLM 的 OpenAI-compatible 地址与 Key，以及 `SMALL / NORMAL / STRONG` 三个模型名。三档 Coding LLM 共用一个站点，Jev 使用独立的 Decisions 接口。

启动终端聊天，直接进入 Reflex：

```sh
bun --no-env-file script/reflex.ts --env-file .env --agent reflex
```

输入需求，按 Enter 开始。切换到普通 `build / plan` Agent 可退出 Reflex 自动控制；`REFLEX_ENABLED=false` 可关闭功能。

完整配置、服务端启动、连通性检查与日志位置见 [使用文档](docs/reflex.md)。

---

基于 [OpenCode](https://github.com/anomalyco/opencode) 开发。本项目为独立扩展，与 OpenCode 官方团队无隶属关系。
