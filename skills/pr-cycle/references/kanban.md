# 本地看板接入

## 固定运行器

使用 [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban) 的 **0.0.166**。它原生提供本地看板、多个 coding agent 会话、Git worktree、diff 与 PR 操作；本项目添加受控阶段、审批和版本门禁，使用替换前端呈现卡片与操作。

[版本记录](../assets/runtime.lock.json) 固定 npm 版本、源码提交、npm integrity 与二进制 manifest。核验日期为 2026-10-28。新版 0.1.44 已宣布 sunsetting，且退休本地 project 看板；`0.1.x` 的 remote issue 接口不能替代本适配器的 local task 接口。**不要接受启动器的 `@latest` 更新提示。** 升级需重新核对协议并在备份数据副本上验证迁移，不能让新旧版本共用同一数据目录运行。

这是固定旧版的适配，不承诺上游继续维护。上游源码和运行器采用 Apache-2.0，本集合只分发自己编写的适配脚本与流程，不捆绑或重新许可其二进制。

## 启动与建项目

需要 Node.js/npm、Git、Python 3.10+；执行任务时还需要已安装并登录的 Claude Code CLI。协调者循环的 Git Bash、jq 与官方 Ralph 插件准备见 [Claude Code 运行方式](claude-code.md)。首次运行先构建替换了商业消息列表的本地前端；仅查看本地看板和导入任务不需要购买云看板，实际 Claude 工作会话按已配置账户计费。

在本仓库根目录运行（技能安装到其他位置时替换路径）：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/setup-kanban-ui.ps1
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

界面和 API/MCP 统一使用 `http://127.0.0.1:13680`，`13681` 兼容入口也显示替换界面。`-Port` 修改公开入口，`-FrontendPort` 修改兼容入口，`-BackendPort` 修改内部后端端口，三者必须不同。服务只监听本机回环地址。Ctrl+C 停止本次创建的服务，不停止复用服务。首次界面按实际情况完成引导，在 Projects 中选已有本地 Git 仓库或新建项目。不要为已有项目重复创建第二份看板。构建、旧入口迁移及回退见[开源前端说明](open-source-ui.md)。

Windows 启动器为看板子进程设置真实 Git Bash 路径，供 `CLAUDE_CODE` 工作者使用，不改系统 PATH。若旧看板已经运行，先确认工作者均已安全结束，再通过本脚本重启；另开协调者不能改变旧看板继承的环境。

启动器也会自动配置项目的本地 CLI 适配：Codex / Claude Code 在每次工作者启动时从本机 PATH 发现，沿用本机登录和配置，不再下载看板内置的固定旧 CLI。每台机器独立发现，移动项目后重启会刷新适配脚本绑定。缺失 CLI 时看板仍可查看，对应工作者明确报错。后端启动日志写入 `.pr-cycle-runtime/kanban-backend.log`。协议兼容范围、诊断与回退见[本地 CLI 接入](local-cli.md)。

macOS / Linux 手动部署同样应让替换前端作为公开入口，并将原版后端置于内部回环地址；直接运行上游 npm 包仍会打开含商业组件的原版界面。具体端口关系见[开源前端说明](open-source-ui.md)，Unix 部署流程尚未真机验证。

运行器使用系统用户数据目录，持久保存数据库与配置；关闭服务不会清空卡片。该版没有核实过的自定义数据目录或禁浏览器开关，不臆造 `VK_DATA_DIR`、`NO_BROWSER` 等参数。若已有其他版本的数据，先停止服务、备份并确认迁移兼容性，不直接降级打开。

获取真实项目 ID（不读取或打印凭据配置）：

```powershell
(Invoke-RestMethod http://127.0.0.1:13680/api/projects).data | Select-Object id,name
```

## Codex 继承本机模型配置

`start-kanban.ps1` 已自动移除内置 Codex 预设的旧模型覆盖。若仅需更新模型继承而不调整 CLI 接入，也可在后端运行时执行：

```powershell
python skills/pr-cycle/scripts/use_local_codex_config.py
python skills/pr-cycle/scripts/use_local_codex_config.py --check
```

脚本先备份，再清除 `CODEX` 的 `DEFAULT`、`HIGH`、`APPROVALS`、`MAX` 四个预设中的模型、服务商、Codex profile 和推理参数覆盖。Codex 随后按自身规则读取 `~/.codex/config.toml`（设置了 `CODEX_HOME` 时使用该目录）以及适用的环境和项目配置。以后修改本机模型配置，无需再次同步模型名或复制密钥。`HIGH`、`MAX` 保留预设名称，但推理强度也改为继承本机设置。

权限设置、自定义预设和其他执行器保持原值；备份在忽略目录 `.pr-cycle-runtime/backups/`。`--port` 可指定后端端口。修改对后续启动的 Codex 进程生效，已运行的进程需要结束后重新启动；旧错误日志不会被清除。该兼容配置仍保留；受控阶段目前仅支持 Claude Code，不能用 Codex 启动此流程。

## 一次导入整批

复制 [批次示例](../assets/batch.example.json) 到目标项目的工作记录目录，修改目标、验收、任务与真实 `project_id`，在每项 `description` 中写入单 PR 计划、P0～P3 等级、依据和审批要求。示例中的全零 UUID 只是占位，不会匹配真实项目。`resources` 是协调者约定的独占资源名；共享数据库、测试租户或端口需用同名锁，不能给每个任务起不同名字来规避冲突。

```powershell
python skills/pr-cycle/scripts/kanban_batch.py validate batch.json
python skills/pr-cycle/scripts/kanban_batch.py import batch.json
python skills/pr-cycle/scripts/kanban_batch.py import batch.json --apply > batch-import.json
python skills/pr-cycle/scripts/kanban_batch.py ready batch.json
```

`import` 默认只读预览，`--apply` 创建一张批次卡和每任务一张卡，输出任务键到真实卡片 ID 的映射；上面的首次导入命令将回执保存到 `batch-import.json`，用于恢复时对账。重试时保留原回执，另用新的输出文件名，避免失败的命令覆盖已有映射。两个联网命令均支持 `--url http://127.0.0.1:13681`。导入不会启动代理、创建真实 PR、修改代码或标记通过；开始授权和计划批准后，执行阶段由受控后台自动推进。

脚本固定校验服务版本、任务键、依赖图及字段；用描述前两行的稳定标记和定义哈希对账。重复导入复用已有卡片，不覆盖人工状态和追加证据。修改清单定义后再导入会停止；先明确处理范围变更，再选择新批次 ID，不用新批次重置同一 PR 的审查轮数。

描述第三行 `[dispatch:ready]` 表示可参与候选筛选，改为 `[dispatch:hold]` 表示阻塞。父卡设为 hold 时整批停止派发；子卡 hold 只阻塞该任务。协调者通过界面或 MCP 更新描述，保留前两行与其他证据。恢复前核实阻塞原因，再改回 ready。脚本不解析风险等级或审批证据；所有导入任务仍需由规划 Agent 产出计划和等级，再由人类批准。未批准时可以规划，不能因标记为 ready 就启动实施。

描述标记移位，或标记被删除但标题仍含本批身份时，预览、导入与候选筛选都会停止，错误中给出疑似损坏卡的真实 ID。按 ID 核对原卡、运行会话和回执，在原卡恢复标记后再继续；不要删除原卡或新建卡绕过检查。标题与描述中的身份若被全部清除，脚本无法仅凭远端文本归属该卡，应先用已保存回执逐项人工对账，不直接重导。该检测不按标题自动接管卡片，也不更改原状态或证据。

检测会先区分主身份与引用：首行任务标记、哈希行和调度行格式完整且明确属于另一批次时，正文中对本批任务的引用不视为身份损坏。另一批次的标题主标记后也可以引用本批任务。格式不完整的头部不能绕过损坏检查；标题主标记与描述主身份冲突时仍需对账。对其他批次头部的识别仅用于区分归属，不代表已验证其任务内容或验收证据。

`ready` 只是下一批的**只读建议**：按清单顺序筛选，要求依赖卡 done 且未 hold、没有未处理的活动或失败、资源不冲突且不超过 `max_parallel`。`inprogress`、`inreview`、运行中或失败未核对的卡片保守占用在制名额；评审中的任务也不会被下一批挤掉。跨批次共享资源、额外审查或总结代理、实际 base 包含依赖提交、当前 SHA 的审查与分级人工审批，仍由协调者按[受控工作流](workflow.md)核实。受控任务所有等级发布 PR 后都等待最终人类批准及明确合并。此脚本没有后台调度守护进程。

失败恢复：受控流程暂停新派发并保存原因，核对工作区与进程后点击“恢复自动执行”；连续三轮返工未通过也须如此明确恢复。暂停不终止已运行 Agent。批次 hold 仅控制批次筛选，不代替受控流程的暂停。不能依赖 `ready` 自动重开失败任务。受控任务由最终合并操作核实远端结果后进入 `done`，不能手动移动卡片代替完成证据。旧版手动批次的 `done` / `cancelled` 仅作为筛选信号，协调者须确认实际进程、测试服务和交付终态后恢复 `[dispatch:ready]`；脚本此时忽略历史 `last_attempt_failed`，释放名额。`has_in_progress_attempt` 仍为 true 时继续占槽。终态仍 hold 的失败卡不会释放；不能直接修改数据库来清除派生失败标记。终态本身不是进程或验收的机器证明，协调者不得跳过核对。

导入锁在系统临时目录，锁名由地址、项目和批次派生。只有一个协调者可以导入/启动本批。异常退出留下锁时，核实锁中 PID 已停止后再删除该锁。POST 超时不自动重试：先读取看板，确认已创建的卡片，再重复幂等导入。它不能阻止绕过此脚本的另一个客户端同时写入。

## 连接代理并派发

Claude Code 协调者优先通过 [启动脚本](claude-code.md) 的 `--mcp-config` 接入，配置只用于本次进程，不修改用户全局 MCP。其他客户端可按其格式使用 [MCP 配置示例](../assets/mcp.example.json)；Windows 下客户端若不能直接执行 `npx.cmd`，使用 `cmd /c npx.cmd`，macOS/Linux 使用 `npx`。`VIBE_BACKEND_URL` 必须与已启动的看板一致。不要同时重复加载两个指向同一看板的 MCP 实例。

MCP 可以读取项目和任务、维护批次描述。先用 `tools/list` 核对固定版 task 工具；若只出现 `list_issues` / `start_workspace`，连接的是不兼容版本。

1. 从批次 `ready` 建议取得真实 task ID，补齐[工作者契约](task-contract.md)、仓库及验收条件；更新描述时保留批次标记。
2. 在待办卡片点击开始授权；规划 Agent 生成等级、依据、计划和子任务，人类在独立规划审查面板批准当前版本。
3. 后台按依赖自动运行子实施、主实施及独立双审，失败自动返工，连续三轮未通过暂停。无需浏览器保持打开；服务绑定会话、工作区和批准版本，启动仍消耗本机 CLI 账户资源。
4. 两项审查通过后自动发布 PR；P2 多子 PR 自动集成和复审，最后在独立最终审查面板展示候选、双审证据与 PR，等待人类批准及明确合并。

原生 `start_workspace_session` 是上游能力，不是当前受控流程的直接派发入口。不能通过 MCP、原版界面或恢复接口绕过计划批准及角色绑定；受控服务和数据库许可拦截未经阶段授权的启动。此应用门禁不能隔离同一 OS 用户的本地文件或凭据。

启动失败或结果未知时先查已有任务会话和工作区，避免重复启动；不手动修改数据库修补审批或审查记录。规划与实施复用主会话，两项审查分别使用独立会话。除计划等待批准、最终审查、暂停或错误状态外，阶段结果核验后会自动进入下一阶段。支持范围和真实远端验收限制见[受控工作流](workflow.md#支持范围与验收边界)。

## 固定接口与来源

REST 返回包装为 `{success,data,message}`。批次脚本只读取 `/api/info`、`/api/projects/{id}`、`/api/tasks?project_id=UUID`，写入只用 `POST /api/tasks` 的 `project_id/title/description/status`。REST 的工作区启动字段为 `target_branch`，与 MCP 的 `base_branch` 不同，本脚本不调用工作区启动接口。

- [本地任务模型与状态](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/db/src/models/task.rs)
- [任务 REST](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/routes/tasks.rs) · [项目 REST](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/routes/projects.rs)
- [MCP 工具实现](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/mcp/task_server.rs) · [工作区启动](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/server/src/routes/task_attempts.rs)
- [原生看板](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/frontend/src/components/tasks/TaskKanbanBoard.tsx) · [worktree 实现](https://github.com/BloopAI/vibe-kanban/blob/0c91b082357972dbcfd79c93ab8d899b78181f1a/crates/services/src/services/worktree_manager.rs)

MCP `list_tasks` 默认 limit 为 50 且没有分页参数；大批次对账使用本脚本的 REST 全量任务列表，不把前 50 张当作全量。
