# 需求到验收

`pr-cycle` · 用 Claude Code 现有生态把已确认需求组织成带看板的小 PR，支持有界 AI 循环、批量并发和 P0～P3 分级审批。

## 何时使用

已明确委托软件开发，需要拆分功能、协调独立工作目录、自证、审查和组合验证时使用。普通讨论不会自动开始实现。

## 会得到什么

固定使用 **Claude Code + Vibe Kanban 0.0.166**。本地工作流服务保存计划批准、阶段角色和版本证据，Vibe 提供会话及独立 worktree。官方 Ralph Loop 1.0.1 可选用于协调批次，不代替看板门禁。

- 待办 → 规划审查（Agent 产出、人类批准）→ 自动实施 → 独立功能审查 → 独立安全审查 → PR → 最终审查 → 明确合并。
- 规划与实施共用主 Agent；实施可以分派计划内子 Agent，两项审查分别使用独立只读会话。
- P2 支持依赖子 PR；多个子 PR 在独立工作区集成，组合版本重新双审后发布总 PR。
- 规划审查面板展示任务、Agent 产出的计划及等级依据；最终审查面板只展示候选、双审证据、PR 与批准合并。提示词和显示选项在设置中。
- JSON 批次助手提供导入与就绪建议；批准计划后后台自动推进，不依赖浏览器轮询。受控会话最多 3 个并发，跨批次资源和费用由协调者管理。

## 变更风险与审批

计划、等级和子任务只由规划 Agent 产出，人类负责审批。所有等级都需要批准当前计划后实施，双审通过并发布 PR 后，再批准当前候选版本和明确执行合并。P3 可以简化计划与验证，但不免除这些步骤。

| 等级 | 典型变更 | PR 安排 |
| --- | --- | --- |
| P0 | 架构等重大变更 | 独立计划和 PR，说明影响与回退方式 |
| P1 | 功能新增或行为变化 | 按完整可验证功能拆分 |
| P2 | 常规低风险维护 | 允许依赖子 PR 与集成后双审 |
| P3 | 低风险文档、注释或排版 | 简化计划和验证，保留全部审批阶段 |

混合变更取最高风险；P2 打包不能降低 P1 门槛。功能审查或安全审查失败均打回实施，修改后重新双审。连续三轮返工未通过会自动暂停；检查原因后点击恢复。暂停仅停止新派发，不终止已运行 Agent。详细要求见[受控工作流](references/workflow.md)。

## 启动

需要 Claude Code（已登录）、Git for Windows、Node.js/npm；Python 3.10+；自动 PR 与合并还需要已授权的 GitHub CLI。保留完整仓库，在根目录先准备固定运行时：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/setup-claude-runtime.ps1
```

终端一启动看板并保持运行：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

打开 `http://127.0.0.1:13680`。终端二启动协调者：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-claude-cycle.ps1 -CheckOnly
powershell -NoProfile -File skills/pr-cycle/scripts/start-claude-cycle.ps1
```

目标是其他仓库时加 `-ProjectPath 'D:\projects\my-app'`。进入 Claude 后，先给出已确认任务，再按 [循环启动命令](references/claude-code.md#开始真正的循环) 开启最多 20 次迭代的 Ralph。仅运行启动脚本会打开 Claude，**不会自动开始付费工作者或 Ralph 循环**。

`/pr-cycle:pr-cycle` 可单独读取技能做手动协作，但不等于开启循环。循环只存在于运行中的 Claude 会话，不是关终端后继续工作的服务；等待人工审批、合并决定或遇到阻塞时安全交接，不代替人类批准和最终合并操作。所有等级发布 PR 后都进入最终审查栏，远端确认合并后才完成。

批量任务修改 [清单示例](assets/batch.example.json)，按[看板接入](references/kanban.md)验证、预览和导入。运行时准备不修改用户全局插件设置；实际代理调用仍受已配置账户、权限和预算约束。

[Claude Code 运行方式](references/claude-code.md) · [受控工作流](references/workflow.md) · [工作者契约](references/task-contract.md) · [看板版本](assets/runtime.lock.json) · [循环版本](assets/claude-runtime.lock.json)

合并须满足对应风险等级的人工门槛和当前操作授权；本技能不额外授予费用、推送、合并或部署权限。实际发布产物仍须按适用的产物验收规则验证。

当前受控阶段仅支持本机 Claude Code、单仓库 GitHub。应用门禁不提供同一 OS 用户下的身份隔离；真实模型与远端 PR、集成发布、合并尚未完成端到端验收。

[执行规则](SKILL.md) · [许可与来源](../../README.md#许可与来源)
