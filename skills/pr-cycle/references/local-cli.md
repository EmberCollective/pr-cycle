# 项目级本地 CLI 接入

项目复用每台机器已安装的 **Codex / Claude Code CLI**。Web 看板继续使用 Vibe Kanban；本项目提供可执行文件发现、启动配置和 Codex 协议适配。参考 [agent-orchestrator 的本机可执行文件发现](https://github.com/OrchestratorInc/agent-orchestrator/blob/96cd425bd33a5187ff5891731cc7114fe12a7ed6/backend/internal/adapters/agent/codex/codex.go) 与 [Codex app-server 驱动](https://github.com/OrchestratorInc/agent-orchestrator/blob/96cd425bd33a5187ff5891731cc7114fe12a7ed6/backend/internal/adapters/chatdriver/codexappserver/driver.go) 的设计，自行实现适配，未复制其源代码。

## 换一台电脑使用

1. 安装 Node.js、Python 3.10+、Git，以及要使用的 Codex 或 Claude Code CLI；把工具加入 PATH，并在该机器完成登录和模型配置。
2. 克隆本项目，按 README 准备运行时和前端。
3. 运行 `start-kanban.ps1`。启动器检查本机 CLI，并通过看板 API 配置内置执行器；已有看板也会更新接入。

无需复制另一台电脑的 CLI 路径、密钥、模型名或看板 profiles.json。生成的看板配置只引用当前安装位置的项目适配脚本；CLI 本体在**每次启动工作者时**从当前进程的 PATH 解析。移动项目、切换 Node 安装或换电脑后重新运行启动器，即会更新本项目管理的脚本绑定。操作系统 PATH 有变更时，应从新终端启动看板，使后端继承新的环境。

`start-claude-cycle.ps1` 的协调者也使用同一发现器，兼容原生 Claude 可执行文件和 npm 安装，不再要求机器上必须有 `claude.cmd`。

未安装某个 CLI 时，看板仍可使用。对应工作者启动会显示安装提示，不会退回 `npx` 下载另一个版本。发现器支持 Windows 原生安装、标准 npm shim/native 包和 npm JS 入口；Unix 支持 PATH 中的原生程序与 npm JS 入口。Windows 启动流程已做集成测试；macOS/Linux 启动流程未在真机验证。

## 发现与配置

只检查本机安装，不调用模型：

```powershell
node skills/pr-cycle/scripts/local-cli.mjs --probe
python skills/pr-cycle/scripts/use_local_clis.py --check
```

`start-kanban.ps1` 默认执行接入，无需额外同步。手动启动后端、macOS/Linux 或单独更新接入时，运行：

```sh
python skills/pr-cycle/scripts/use_local_clis.py
# 只配置其中一个执行器
python skills/pr-cycle/scripts/use_local_clis.py --executor codex
```

`--port` 指定后端端口。非标准安装可在启动看板前设置 `PR_CYCLE_CODEX_PATH` / `PR_CYCLE_CLAUDE_PATH`，值为该机器上的绝对可执行文件或 JS 入口路径；这些环境变量不写入仓库。未知的 Windows shell shim 不会被当作任意 shell 命令执行，应指定实际入口。

脚本会备份 profiles，更新后重新读取校验，并检测保存前的并发修改。已有自定义命令和自定义预设保持原值；本项目管理的内置配置带 `env.PR_CYCLE_LOCAL_CLI=1` 标记，并在 `env.PR_CYCLE_LOCAL_CLI_COMMAND` 记录上次生成的命令。只有命令未被修改时，移动项目才会自动更新绑定；在看板保存自定义命令后，后续启动会保留该预设的全部设置。旧版仅有标记的配置会按完整适配器命令格式识别迁移，无法确认的自定义命令保持原值。备份在忽略目录 `.pr-cycle-runtime/backups/`，可能包含原有执行器环境设置，不应提交。

## 本机设置与兼容边界

- Codex 的 DEFAULT、HIGH、APPROVALS、MAX 读取本机模型、服务商和推理配置，包括 `CODEX_HOME`。HIGH/MAX 保留看板名称，不再指定旧模型。登录和密钥仍由 Codex 自己读取。
- Claude DEFAULT/PLAN/APPROVALS 沿用本机设置；OPUS 等明确的模型选项保持原义。登录和密钥仍由 Claude 自己读取。
- 现有权限、附加参数、环境变量和工作流的 APPROVALS 约定保留。仅后续新工作者使用新的接入；正在运行的进程不被重启。
- Vibe Kanban 后端继续固定 0.0.166。它的 Codex v1 协议由 `codex-local-bridge.mjs` 转为本机 app-server v2，转换消息流、命令、文件修改、MCP 日志及审批结果，并保留可续接的原生会话记录。
- 无法由旧看板表达的新审批类型会明确失败，不会自动授予权限。旧版 `on-failure`、per-thread profile / compactPrompt / includeApplyPatchTool 覆盖也会报兼容错误。其他新版条目可能只能在原生会话历史中查看。
- 接入不会切换回历史会话记录的旧 CLI 版本，也不会安装固定 CLI 版本。CLI 升级后如协议发生变化，先做以下验证。实际验证过 Codex 0.165.0 的新会话、续接、工具与文件审批；Claude 2.1.312 已验证流式协议启动，未验证所有交互模式。
- Unix 停止工作者时，适配器向 CLI 进程组发送 `SIGTERM`，1 秒后对仍存在的进程组发送 `SIGKILL`，也清理主进程退出后留下的同组子进程。Windows 继续使用 `taskkill /T /F`。
- Codex 桥接器关闭输入后给予 CLI 2 秒正常退出时间；主进程提前退出时立即清理剩余进程组。清理计时器保持有效，子进程不持有标准流时也不会被遗漏；正常退出会取消宽限计时器。

## 验证与回退

离线测试覆盖两套不同机器安装目录、PATH 切换、项目移动、缺失 CLI、审批转换，以及启动器创建/复用后端：

进程退出测试还覆盖正常 EOF、忽略 EOF、错误退出码、缓冲消息，以及主进程退出后仍运行的子进程。EOF 和信号清理已在 WSL/Linux 实测，包含子进程关闭标准流的场景；这不代表完整 macOS/Linux 看板启动流程已验证。

```powershell
node --test tests/test_local_cli_resolution.mjs tests/test_local_cli_shutdown.mjs tests/test_codex_local_bridge.mjs tests/test_codex_bridge_shutdown.mjs
python -m unittest discover -s tests -v
```

真实 Codex 测试会产生两次简短模型请求和原生测试会话，使用临时 Git 仓库验证新建、复制记录后续接及上下文保持：

```powershell
python tests/smoke_local_codex.py
```

回退时先结束相关工作者，在看板执行器设置中恢复备份对应的配置，并移除 `PR_CYCLE_LOCAL_CLI` 和 `PR_CYCLE_LOCAL_CLI_COMMAND` 两项环境记录。保留一个明确的自定义命令，后续启动器会尊重它；仅删除命令覆盖会在下次启动时再次启用默认的本地接入。不直接覆盖正在使用的数据库文件。
