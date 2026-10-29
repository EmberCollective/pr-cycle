# 本地看板接入

## 固定运行器

使用 [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) 的 **0.0.166**。它原生提供本地看板、多个 coding agent 会话、Git worktree、diff 与 PR 操作；本技能补充固定阶段、验收门槛和批次调度协议，不重写看板。

[版本记录](../assets/runtime.lock.json) 固定 npm 版本、源码提交、npm integrity 与二进制 manifest。核验日期为 2026-10-28。新版 0.1.44 已宣布 sunsetting，且退休本地 project 看板；`0.1.x` 的 remote issue 接口不能替代本适配器的 local task 接口。**不要接受启动器的 `@latest` 更新提示。** 升级需重新核对协议并在备份数据副本上验证迁移，不能让新旧版本共用同一数据目录运行。

这是固定旧版的适配，不承诺上游继续维护。上游源码和运行器采用 Apache-2.0，本集合只分发自己编写的适配脚本与流程，不捆绑或重新许可其二进制。

## 启动与建项目

需要 Node.js/npm、Git、Python 3.10+；执行任务时还需要已安装并登录的 Claude Code CLI。协调者循环的 Git Bash、jq 与官方 Ralph 插件准备见 [Claude Code 运行方式](claude-code.md)。第一次启动会从官方源下载固定版本并打开浏览器；仅查看本地看板和导入任务不需要购买云看板，实际 Claude 工作会话按已配置账户计费。

在本仓库根目录运行（技能安装到其他位置时替换路径）：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

默认地址为 `http://127.0.0.1:13680`，用 `-Port 13681` 可改端口。服务在终端运行，Ctrl+C 停止；保持监听在本机，不将未鉴权的本地 API 暴露到公网。首次界面按实际情况完成引导，在 Projects 中选已有本地 Git 仓库或新建项目。不要为已有项目重复创建第二份看板。

Windows 启动器为看板子进程设置真实 Git Bash 路径，供 `CLAUDE_CODE` 工作者使用，不改系统 PATH。若旧看板已经运行，先确认工作者均已安全结束，再通过本脚本重启；另开协调者不能改变旧看板继承的环境。

macOS / Linux 等价启动命令：

```sh
HOST=127.0.0.1 PORT=13680 BACKEND_PORT=13680 npx -y vibe-kanban@0.0.166
```

运行器使用系统用户数据目录，持久保存数据库与配置；关闭服务不会清空卡片。该版没有核实过的自定义数据目录或禁浏览器开关，不臆造 `VK_DATA_DIR`、`NO_BROWSER` 等参数。若已有其他版本的数据，先停止服务、备份并确认迁移兼容性，不直接降级打开。

获取真实项目 ID（不读取或打印凭据配置）：

```powershell
(Invoke-RestMethod http://127.0.0.1:13680/api/projects).data | Select-Object id,name
```

## 一次导入整批

复制 [批次示例](../assets/batch.example.json) 到目标项目的工作记录目录，修改目标、验收、任务与真实 `project_id`，在每项 `description` 中写入单 PR 计划、P0～P3 等级、依据和审批要求。示例中的全零 UUID 只是占位，不会匹配真实项目。`resources` 是协调者约定的独占资源名；共享数据库、测试租户或端口需用同名锁，不能给每个任务起不同名字来规避冲突。

```powershell
python skills/pr-cycle/scripts/kanban_batch.py validate batch.json
python skills/pr-cycle/scripts/kanban_batch.py import batch.json
python skills/pr-cycle/scripts/kanban_batch.py import batch.json --apply > batch-import.json
python skills/pr-cycle/scripts/kanban_batch.py ready batch.json
```

`import` 默认只读预览，`--apply` 创建一张批次卡和每任务一张卡，输出任务键到真实卡片 ID 的映射；上面的首次导入命令将回执保存到 `batch-import.json`，用于恢复时对账。重试时保留原回执，另用新的输出文件名，避免失败的命令覆盖已有映射。两个联网命令均支持 `--url http://127.0.0.1:13681`。导入不会启动代理、创建真实 PR、修改代码或标记通过；执行阶段由下一节的协调者推进。

脚本固定校验服务版本、任务键、依赖图及字段；用描述前两行的稳定标记和定义哈希对账。重复导入复用已有卡片，不覆盖人工状态和追加证据。修改清单定义后再导入会停止；先明确处理范围变更，再选择新批次 ID，不用新批次重置同一 PR 的审查轮数。

描述第三行 `[dispatch:ready]` 表示可参与候选筛选，改为 `[dispatch:hold]` 表示阻塞。父卡设为 hold 时整批停止派发；子卡 hold 只阻塞该任务。协调者通过界面或 MCP 更新描述，保留前两行与其他证据。恢复前核实阻塞原因，再改回 ready。脚本不解析风险等级或审批证据；导入后由协调者将缺用户方案批准的 P0 任务设为 hold，获批并核实后恢复，不能因默认标记为 ready 就启动实现。

描述标记移位，或标记被删除但标题仍含本批身份时，预览、导入与候选筛选都会停止，错误中给出疑似损坏卡的真实 ID。按 ID 核对原卡、运行会话和回执，在原卡恢复标记后再继续；不要删除原卡或新建卡绕过检查。标题与描述中的身份若被全部清除，脚本无法仅凭远端文本归属该卡，应先用已保存回执逐项人工对账，不直接重导。该检测不按标题自动接管卡片，也不更改原状态或证据。

检测会先区分主身份与引用：首行任务标记、哈希行和调度行格式完整且明确属于另一批次时，正文中对本批任务的引用不视为身份损坏。另一批次的标题主标记后也可以引用本批任务。格式不完整的头部不能绕过损坏检查；标题主标记与描述主身份冲突时仍需对账。对其他批次头部的识别仅用于区分归属，不代表已验证其任务内容或验收证据。

`ready` 只是下一批的**只读建议**：按清单顺序筛选，要求依赖卡 done 且未 hold、没有未处理的活动或失败、资源不冲突且不超过 `max_parallel`。`inprogress`、`inreview`、运行中或失败未核对的卡片保守占用在制名额；评审中的任务也不会被下一批挤掉。跨批次共享资源、额外审查或总结代理、实际 base 包含依赖提交、当前 SHA 的审查与分级人工审批，仍由协调者按[固定工作流](workflow.md)核实。P3 创建 PR 并审查通过后仍为 `inreview`，等待人工合并决定。此脚本没有后台调度守护进程。

失败恢复：先把卡片设为 hold，查询已有工作区与真实进程。继续任务时通过已有工作区恢复会话，不能依赖 `ready` 自动重开失败任务。若已按证据完成或明确取消，确认实际进程和测试服务结束后，将卡片置为 `done` / `cancelled` 并恢复 `[dispatch:ready]`，表示协调者已核对终态；脚本此时忽略历史 `last_attempt_failed`，释放名额。`has_in_progress_attempt` 仍为 true 时继续占槽。终态仍 hold 的失败卡不会释放；不能直接修改数据库来清除派生失败标记。终态本身不是进程或验收的机器证明，协调者不得跳过核对。

导入锁在系统临时目录，锁名由地址、项目和批次派生。只有一个协调者可以导入/启动本批。异常退出留下锁时，核实锁中 PID 已停止后再删除该锁。POST 超时不自动重试：先读取看板，确认已创建的卡片，再重复幂等导入。它不能阻止绕过此脚本的另一个客户端同时写入。

## 连接代理并派发

Claude Code 协调者优先通过 [启动脚本](claude-code.md) 的 `--mcp-config` 接入，配置只用于本次进程，不修改用户全局 MCP。其他客户端可按其格式使用 [MCP 配置示例](../assets/mcp.example.json)；Windows 下客户端若不能直接执行 `npx.cmd`，使用 `cmd /c npx.cmd`，macOS/Linux 使用 `npx`。`VIBE_BACKEND_URL` 必须与已启动的看板一致。不要同时重复加载两个指向同一看板的 MCP 实例。

先调用 MCP `tools/list`，核对当前服务实际暴露 `list_projects`、`list_tasks`、`get_task`、`update_task`、`list_repos`、`start_workspace_session`。若出现 `list_issues` / `start_workspace` 而没有 task 工具，连接的是不兼容版本，停止派发。

1. 从 `ready` 结果取得真实 task ID；补齐[工作者契约](task-contract.md)，把可读取的技能和项目规则路径写进卡片描述，保留标记。
2. `list_repos({"project_id":"实际项目 UUID"})` 核对实际仓库 ID。核实目标分支及 base SHA、代理可用性、预算、真实进程数、资源锁和验收证据。检查实际 Claude 执行器配置：固定版 DEFAULT 可能启用 `dangerously_skip_permissions`，必须选择并核实不绕过权限检查的 `APPROVALS` 配置；缺失或被改成不安全配置时不派发。
3. 用 `update_task` 记录启动意图及负责人，先占用在制槽位，再调用一次 `start_workspace_session`。该调用会执行代理，有实际资源和费用影响；沿用本批已明确的操作授权。

```json
{
  "task_id": "真实任务 UUID",
  "executor": "CLAUDE_CODE",
  "variant": "APPROVALS",
  "repos": [{"repo_id": "真实仓库 UUID", "base_branch": "main"}]
}
```

以上是 MCP `start_workspace_session` 参数，`main` 必须替换为本批核实的分支。工具返回 `task_id` / `workspace_id`；记录并核实实际 worktree 与 head。相互独立的任务可在启动确认后继续启动，最多达到上限；不要用 `Promise.all` 无条件启动整张清单。工作者使用 Vibe 实际配置的 Claude 执行器和权限模式，不把协调者的权限或插件加载参数当成会自动继承；不为无人值守而开启跳过权限检查。批准模式可等待人工操作，不承诺自动处理所有权限提示。

若客户端没有 MCP，可在同一看板界面逐个启动筛选出的卡片。两个入口都必须执行同一调度与验收协议。启动失败或超时先查 `GET /api/task-attempts?task_id=UUID` 对账；不得不经核对再创建第二个工作区。

## 固定接口与来源

REST 返回包装为 `{success,data,message}`。适配器只读取 `/api/info`、`/api/projects/{id}`、`/api/tasks?project_id=UUID`，写入只用 `POST /api/tasks` 的 `project_id/title/description/status`。REST 的工作区启动字段为 `target_branch`，与 MCP 的 `base_branch` 不同，本脚本不调用工作区启动接口。

- [本地任务模型与状态](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/db/src/models/task.rs)
- [任务 REST](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/routes/tasks.rs) · [项目 REST](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/routes/projects.rs)
- [MCP 工具实现](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/mcp/task_server.rs) · [工作区启动](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/routes/task_attempts.rs)
- [原生看板](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/frontend/src/components/tasks/TaskKanbanBoard.tsx) · [worktree 实现](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/services/src/services/worktree_manager.rs)

MCP `list_tasks` 默认 limit 为 50 且没有分页参数；大批次对账使用本脚本的 REST 全量任务列表，不把前 50 张当作全量。
