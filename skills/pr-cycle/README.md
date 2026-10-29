# 需求到验收

`pr-cycle` · 用 Claude Code 现有生态把已确认需求组织成带看板的小 PR，支持有界 AI 循环、批量并发和 P0～P3 分级审批。

## 何时使用

已明确委托软件开发，需要拆分功能、协调独立工作目录、自证、审查和组合验证时使用。普通讨论不会自动开始实现。

## 会得到什么

固定使用 **Claude Code + 官方 Ralph Loop 1.0.1 + Vibe Kanban 0.0.166**。Ralph 的 Stop hook 让协调者会话继续，Vibe 提供看板、`CLAUDE_CODE` 工作者和独立 worktree；不自己造 AI 调度运行器。Vibe 新版已退休本地项目看板，因此不跟随 `latest`。

- 一张批次卡 + 每个 PR 一份计划与任务卡，从排队、实现、自证、独立审查、返工走到组合验证、分级人工审批与合并决定。
- JSON 批次清单、幂等导入、依赖和资源冲突检查、默认 3 个在制任务的候选筛选。
- 默认最多 3 个工作会话；显式使用经核实的 Claude `APPROVALS` 配置，不沿用可能绕过权限检查的默认执行器配置。
- 协调者在 Ralph 的有界循环中核对状态、派发和收敛；批次脚本只给建议，不后台运行任务，不把看板状态当成验收证明。
- 真实 PR、对应 SHA 的运行与审查证据、三轮收敛记录、暂停和恢复协议。
- 合并与对应人工批准完成后，由总结 AI 复盘并提出知识库规则候选，经核对和用户确认后更新 `REVIEW.md` 或测试/CI。

## 变更风险与审批

| 等级 | 典型变更 | 审批与 PR 规则 |
| --- | --- | --- |
| P0 | 架构等重大变更 | 单独向用户提交方案，批准后实施；独立 PR，最终由用户批准合并 |
| P1 | 功能新增或行为变化 | 至少一位有项目审批权限的人类明确同意当前版本后才能合并 |
| P2 | 常规低风险维护 | 需要人类审核通过；允许多个相关小变更组合成一个 PR |
| P3 | 低风险文档、注释或排版修改 | AI 自动完成开发、独立审查和创建 PR；等待人工决定合并，不自动合并 |

按实际影响定级，混合变更取最高风险；P2 打包不能降低 P1 功能变更的门槛。所有等级均由独立于统筹和开发者的审查 AI 检查功能、代码质量和安全，共享最多三轮；第三轮仍未通过即停止该任务的自动返工，转人工决策。详细要求见[变更风险与审批等级](SKILL.md#变更风险与审批等级)。

## 启动

需要 Claude Code（已登录）、Git for Windows、Node.js/npm；批次脚本另需 Python 3.10+。保留完整仓库，在根目录先准备固定运行时：

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

`/pr-cycle:pr-cycle` 可单独读取技能做手动协作，但不等于开启循环。循环只存在于运行中的 Claude 会话，不是关终端后继续工作的服务；等待人工审批、合并决定或遇到阻塞时安全交接，不自动合并。P3 自动工作完成但尚待合并时仍为 `inreview`。

批量任务修改 [清单示例](assets/batch.example.json)，按[看板接入](references/kanban.md)验证、预览和导入。运行时准备不修改用户全局插件设置；实际代理调用仍受已配置账户、权限和预算约束。

[Claude Code 运行方式](references/claude-code.md) · [固定工作流](references/workflow.md) · [工作者契约](references/task-contract.md) · [看板版本](assets/runtime.lock.json) · [循环版本](assets/claude-runtime.lock.json)

合并须满足对应风险等级的人工门槛和当前操作授权；本技能不额外授予费用、推送、合并或部署权限。实际发布产物仍须按适用的产物验收规则验证。

[执行规则](SKILL.md) · [许可与来源](../../README.md#许可与来源)
