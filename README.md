# pr-cycle

使用 Claude Code、官方 Ralph Loop 和 Vibe Kanban，将已确认的软件需求推进为可验证、可审查的 PR。

本仓库提供受控任务看板：所有等级先批准计划，再实施、独立功能审查、独立安全审查、创建 PR 和最终人工审查。规划与实施共用主 Agent，实施可以分派子 Agent；P2 多子 PR 集成后重新双审，再提交总 PR。

## 快速开始

运行环境：Windows x64、已安装并登录的 Claude Code、Git for Windows、Node.js/npm、Python 3.10+。自动 PR 和合并还需要已授权的 GitHub CLI；当前受控流程支持单仓库 GitHub 项目。

```powershell
git clone https://github.com/lxbsdsg/pr-cycle.git
cd pr-cycle
powershell -NoProfile -File skills/pr-cycle/scripts/setup-claude-runtime.ps1
powershell -NoProfile -File skills/pr-cycle/scripts/setup-kanban-ui.ps1
```

终端一启动看板并保持运行，然后打开 `http://127.0.0.1:13680`：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

界面使用 MIT 许可的 `react-virtuoso` 消息列表，无需 Virtuoso Message List 商业密钥。`13680` 统一提供界面、API 和 MCP；`13681` 兼容地址及后端自动打开的地址也提供同一替换界面。数据库和工作区保持原位。构建、旧入口迁移与维护见[开源看板前端](skills/pr-cycle/references/open-source-ui.md)。

在待办卡片点击“规划任务”，再点击“开始任务并授权规划”。规划 Agent 生成 P0～P3 等级、依据、实施计划及子任务依赖，人类在独立的“规划审查”面板批准。之后后台自动完成子任务、主实施、独立双审、返工及 PR；P2 多子 PR 自动集成并复审，最后进入独立的“最终审查”面板。看板服务运行时无需保持浏览器打开。所有等级最终都需要人类批准当前版本，再明确执行合并。完整操作和支持边界见[受控工作流](skills/pr-cycle/references/workflow.md)。

待办保留任务正文，后续卡片显示阶段摘要，点击可查看完整任务和证据。蓝线表示顺序或整合、红色虚线表示返工；历史折叠、筛选、关联和阶段提示词收进“设置”。提示词在计划批准时冻结，模板修改只影响下一次批准。历史保留并可在重启后查看。

启动器自动接入每台机器 PATH 中的 Codex / Claude Code；每次工作者启动都重新发现本机 CLI，沿用其登录与配置。仓库不固定工作者 CLI 版本、安装路径或模型，未安装时会提示，不自动下载替代版本。受控阶段目前仅启用 Claude Code；Codex 接入仍保留，但其外部 MCP 工具隔离尚未验证，不能用于此流程。换电脑后安装并配置自己的 CLI，再运行同一启动脚本即可。实现参考 agent-orchestrator，详见[本地 CLI 接入](skills/pr-cycle/references/local-cli.md)。

启动时会自动检查已失效的 Codex `disable_response_storage` 配置：仅在本机 CLI 明确不支持时备份并移除，其他设置保留。自动迁移需要 Python 3.11+ 或 `tomli`；`use_local_clis.py --check` 可预览。

终端二检查环境并启动协调者，将目标路径替换为要开发的 Git 项目：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/start-claude-cycle.ps1 -ProjectPath 'D:\projects\my-app' -CheckOnly
powershell -NoProfile -File skills/pr-cycle/scripts/start-claude-cycle.ps1 -ProjectPath 'D:\projects\my-app'
```

进入 Claude 后提供任务与验收条件，按[循环启动说明](skills/pr-cycle/references/claude-code.md#开始真正的循环)启动 Ralph。`/pr-cycle:pr-cycle` 可读取工作流；仅加载技能或打开 Claude 不会开启 Ralph 循环。实际模型调用受账户权限与预算约束。

固定使用 Ralph Loop 1.0.1 和 Vibe Kanban 0.0.166，具体提交与校验信息在 `skills/pr-cycle/assets/`。外部运行时保存在忽略目录 `.pr-cycle-runtime/`；准备脚本不修改全局插件设置。

## 批次工具

复制并修改[批次示例](skills/pr-cycle/assets/batch.example.json)，填入真实项目 ID、任务、验收条件和依赖：

```powershell
python skills/pr-cycle/scripts/kanban_batch.py validate batch.json
python skills/pr-cycle/scripts/kanban_batch.py import batch.json
python skills/pr-cycle/scripts/kanban_batch.py import batch.json --apply
python skills/pr-cycle/scripts/kanban_batch.py ready batch.json
```

`import` 默认预览，`--apply` 才写入看板。脚本提供候选任务，协调者核对审批和并发条件后派发。新仓库使用 `[pr-cycle:批次:任务]` 卡片标记，不自动接管旧 `yushen-pr-cycle` 卡片；已有批次须先核对，避免重复导入。

## 工作流与参考

- [功能与审批规则](skills/pr-cycle/README.md)
- [技能入口](skills/pr-cycle/SKILL.md)
- [Claude Code 启动、停止与恢复](skills/pr-cycle/references/claude-code.md)
- [看板接入](skills/pr-cycle/references/kanban.md)
- [跨机器复用本地 CLI](skills/pr-cycle/references/local-cli.md)
- [受控工作流与支持边界](skills/pr-cycle/references/workflow.md)
- [工作者契约](skills/pr-cycle/references/task-contract.md)
- [项目审查示例](skills/pr-cycle/references/REVIEW.example.md)

## 测试

```powershell
python -m unittest discover -s tests -v
node --test tests/test_kanban_ui_proxy.mjs
node --test tests/test_kanban_tracking_api.mjs
node --test tests/test_local_cli_resolution.mjs tests/test_local_cli_shutdown.mjs tests/test_codex_local_bridge.mjs tests/test_codex_bridge_shutdown.mjs
powershell -NoProfile -File skills/pr-cycle/scripts/test-kanban-ui.ps1
node tests/test_workflow_board_browser.mjs
node tests/test_workflow_actions_browser.mjs
node --test tests/test_workflow_model.mjs tests/test_kanban_workflow_api.mjs tests/test_workflow_orchestration.mjs tests/test_workflow_git.mjs
```

看板测试使用本地模拟服务；Ralph hook 集成测试需要准备固定运行时；启动器测试还需要 Windows 和 Claude Code CLI。消息列表浏览器测试需要已构建前端及本机 Edge。缺少可选环境时 Python 测试会显示跳过。测试不启动模型会话或真实 AI 工作者。真实模型、远端 PR 创建、集成发布与最终合并尚未完成端到端验收。

受控入口和数据库许可提供应用级门禁，不是同一操作系统用户之间的身份隔离，也不能证明请求一定来自真人。后台对受控工作会话限制最多 3 个并发；连续三轮返工未通过会暂停，检查原因后须明确恢复。暂停仅停止新增派发，不终止已运行 Agent。跨批次资源和费用仍由协调者管理。

## 许可与来源

本项目的最初构思来源于 YuShen（[@YuShenLiu06](https://github.com/YuShenLiu06)）的 [yushen-skills 项目](https://github.com/YuShenLiu06/yushen-skills.git)，在此基础上实现 PR cycle、看板与 Claude Code 工作流，并作为独立仓库维护。

采用 [MIT](LICENSE)，保留原作者版权。具体来源与外部运行时边界见[致谢](ACKNOWLEDGEMENTS.md)和[第三方说明](THIRD_PARTY_NOTICES.txt)。
