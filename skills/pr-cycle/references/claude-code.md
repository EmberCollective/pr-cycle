# Claude Code 循环与并发

## 运行组件

| 职责 | 现有组件 | 边界 |
| --- | --- | --- |
| 读取技能、协调批次 | Claude Code + 本仓库 `pr-cycle` 插件 | 插件入口为 `/pr-cycle:pr-cycle` |
| 继续当前协调者会话 | 官方 `ralph-loop` 1.0.1 的 Stop hook | 有界会话循环，不是后台守护进程 |
| 看板、工作区和实现会话 | Vibe Kanban 0.0.166 + `CLAUDE_CODE` | 独立 worktree；使用经核实的 `APPROVALS` 配置 |
| 清单检查、导入和候选筛选 | `kanban_batch.py` | 可选确定性助手，不启动 AI 或代替授权 |

Ralph 固定在官方仓库提交 `f8c5e7a1dcb71b10cb74586224b5401f3de5db28`，只给协调者加载，不全局安装，也不给每个工作者另开循环。无需另装 oh-my-claudecode 或增加第二套任务调度。已有 Superpowers、代码审查插件可以按需使用，但不把它们当作本流程的循环引擎或重复触发已有审查。

## Windows 启动

保留本仓库完整目录：启动器需要根 `.claude-plugin/plugin.json` 及 `skills/`，不是只复制一个技能目录就能运行。需要已安装、已登录的 Claude Code、Git for Windows、Node.js/npm；批次助手另需 Python 3.10+。

在本仓库根目录运行一次准备：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/setup-claude-runtime.ps1
powershell -NoProfile -File skills/pr-cycle/scripts/setup-kanban-ui.ps1
```

脚本将固定版本的官方 Ralph 插件及其所需 jq 准备到本仓库 `.pr-cycle-runtime`，不改用户全局插件或 PATH；版本与校验信息见 [运行锁定文件](../assets/claude-runtime.lock.json)。该目录不进入 Git。自定义位置用 `-RuntimePath`，后续启动传入相同路径。

终端一启动看板并保持运行：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

使用 `http://127.0.0.1:13680` 打开替换了商业消息列表的界面；API/MCP 也连接 `13680`，`13681` 保留为兼容界面入口。前端构建与回退见[开源前端说明](open-source-ui.md)。

看板启动器也为其子工作者选择 Git Bash 并设置进程级 `CLAUDE_CODE_GIT_BASH_PATH`。若看板是用旧启动方式打开的，先确认没有活动工作者，再停止旧服务并用上述脚本重启；协调者的环境变量不会追溯传给已经运行的看板。工作者不运行 Ralph，因此不需要加载该插件或为循环配置 jq。

终端二先检查，再进入协调者：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-claude-cycle.ps1 -CheckOnly
powershell -NoProfile -File skills/pr-cycle/scripts/start-claude-cycle.ps1
```

为其他 Git 项目运行时增加 `-ProjectPath 'D:\projects\my-app'`；仍从本集合加载技能，但协调者工作目录和 Ralph 状态属于目标项目。看板须选中该项目，而非自动沿用示例项目。看板与协调者都可传 `-Port 13780` 修改公开 API 端口，两处保持一致；看板的 `-FrontendPort` 和 `-BackendPort` 必须与该端口不同。

启动器为本次进程选择 Git Bash，避免误用 Windows 的 WSL `bash.exe`；检查 jq 等 hook 依赖并通过 `--plugin-dir` 加载本仓库插件和固定 Ralph 插件，通过 `--mcp-config` 连接看板。不使用跳过权限检查参数。`-CheckOnly` 不开始模型对话、循环或工作者，不能替代登录、MCP 授权和真实任务验收。

发现目标目录已有 `.claude/ralph-loop.local.md` 时拒绝另开循环；先核实原会话和工作者，再决定恢复或取消，不能直接删除状态绕过检查。交互启动期间还持有项目内 `.claude/pr-cycle-coordinator.lock` 的独占文件锁，防止另一个本启动器同时进入该目录。官方 setup 本身会覆盖同名状态，绕开本启动器或在同一会话重复运行 Ralph 命令仍可能覆盖旧循环。一个目标目录只运行一个协调者；不同批次若共享资源仍须统一对账。

## 开始真正的循环

进入 Claude 后，先提供已确认的任务、验收条件、目标分支、预算和看板项目；授权范围不清时先补齐，不将任务文本拼入 shell。随后由用户在 Claude 的输入框执行：

```text
/ralph-loop:ralph-loop "Read the pr-cycle:pr-cycle skill and its references/claude-code.md. Execute the confirmed request in this conversation using the fixed workflow. Emit <promise>PR_CYCLE_HANDOFF</promise> only after safe handoff evidence is recorded and no workers remain active." --max-iterations 20 --completion-promise PR_CYCLE_HANDOFF
```

`references/claude-code.md` 相对于该技能目录。协调者实际读取技能及引用文件后才派发。也可先使用 `/pr-cycle:pr-cycle` 做普通手动协作，但**该技能命令本身不会开启循环**。官方 Ralph 命令不暴露为普通 Skill 调用，不假定 AI 可以替用户自动调用它。

Ralph setup 创建项目内 `.claude/ralph-loop.local.md`，保存原始提示词、会话 ID、迭代次数、上限和完成 promise。Claude 准备结束一轮时，Stop hook 读取状态和会话记录：未达到停止条件则返回 `decision: block` 并重新提供原始提示词，Claude 继续处理。达到 20 次上限或看到匹配 promise 时移除循环状态并放行。

因此，这里复用的是实际 hook，而非把文档中的“重复执行”当作运行器。每次继续仍会消耗模型资源，20 次也不是 token 或金额上限。错误状态、缺失会话记录、权限提示或进程退出都可能使自动推进停止；关终端后不会自动重启。不要把 Ralph 迭代次数当成 PR 审查次数：每个 PR 的代码与安全审查仍合计最多三轮，重开会话不能重置。

## 看板派发

按 [看板接入](kanban.md#连接代理并派发) 核对真实 MCP 工具、项目、仓库和 base，再按 [固定工作流](workflow.md) 对账、分配槽位、记录启动意图。默认最多 3 个工作会话，审查会话也计入；先检查依赖和资源，不整批无条件启动。

固定版的 `CLAUDE_CODE` 默认配置可能启用 `dangerously_skip_permissions`，**不能直接使用默认配置**。在看板实际执行器配置中核实 `APPROVALS` 未被改成跳过权限检查，派发显式传 `executor: "CLAUDE_CODE"`、`variant: "APPROVALS"`。配置缺失或实际仍绕过权限检查时停止派发并修正配置；批准模式可能等待用户操作，不承诺完全无人值守。

Vibe 工作者不会自动继承协调者的 `--plugin-dir` 或会话上下文。启动前把 [工作者契约](task-contract.md)、任务验收和可读取的技能绝对路径写入卡片，或附完整必要规则；读取受限时报告缺口。项目规则以 `CLAUDE.md` 为 Claude 入口，已有 `AGENTS.md` 要明确要求读取。工作者只回报本任务，不自行启动 Ralph 或认领下一张卡。

## 安全交接与停止

协调者只有同时满足以下条件，才输出 **`<promise>PR_CYCLE_HANDOFF</promise>`**：

1. 满足以下任一分支：本批约定交付与适用的合并后复盘均已完成，无待执行工作；当前允许的自动工作已完成，下一步需要按[风险等级](../SKILL.md#变更风险与审批等级)进行人工审批或决定合并；存在无法在当前权限、预算、三轮上限内解决的明确阻塞，并记录原因、证据、负责人及恢复条件。P0 方案批准前不派发实现；P3 仅自动开发、独立审查和创建 PR，不自动合并。
2. 看板与真实会话、PR、SHA 已对账，保存风险等级、已完成/未完成项、验证结果、最短验收步骤和下一步。待人工审核或合并决定仍是 `inreview`，包括已完成自动工作的 P3；受阻保留原阶段并 hold，不能为了结束循环标成 `done`。
3. 已停止新增派发；所有已启动工作者及其写进程、测试服务已安全结束或按用户要求停止，并核实结果。状态未知不等于已停止，不能输出 promise。

该 promise 仅表示满足安全停止或交接条件；任务是否成功、人工是否批准以各自证据为准。未满足条件时不要在回复中照抄带标签的 promise 作示例，否则 hook 也可能识别为完成。等待仍在运行的工作者时使用通知或有间隔查询，不忙循环。发现需人类决策时保留证据并交接，不为维持循环反复重试。

主动取消，在 Claude 输入：

```text
/ralph-loop:cancel-ralph
```

**取消只移除当前目录的 Ralph 状态，不停止 Vibe 工作者。** 应先停止派发，再在看板核实并按用户意愿停止或等待各会话；记录仍在运行的服务。达到迭代上限、hook 异常或关闭终端也可能在未完成安全交接时结束协调者，不得据此释放资源或报告成功。

恢复时先检查现存会话、工作区、未提交修改、卡片和 PR SHA；优先恢复已有工作者，避免重复创建。存在 Ralph 状态时不要启动第二个循环；在确认原协调者已停止并明确决定取消后处理旧状态，再重新开始有界循环。持久文件不保证 Claude 会话 ID、hook 或工作者自动恢复。

## 上游依据

- [Ralph Loop 固定源码](https://github.com/anthropics/claude-plugins-official/tree/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/ralph-loop)
- [Claude 插件](https://code.claude.com/docs/en/plugins.md) · [插件 CLI](https://code.claude.com/docs/en/plugins/cli-reference.md) · [MCP](https://code.claude.com/docs/en/mcp.md)
- [Vibe 固定版本与接口](kanban.md#固定接口与来源)
