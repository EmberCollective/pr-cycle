# pr-cycle

使用 Claude Code、官方 Ralph Loop 和 Vibe Kanban，将已确认的软件需求推进为可验证、可审查的 PR。

本仓库包含 PR 工作流、看板批次工具、Windows 启动脚本及测试。支持依赖与资源冲突检查、默认最多 3 个工作会话、独立审查和 P0～P3 分级审批。Ralph 默认最多 20 次循环，每个 PR 最多三轮审查；合并由人工决定。

## 快速开始

运行环境：Windows x64、已安装并登录的 Claude Code（也可在看板使用 Codex）、Git for Windows、Node.js/npm、Python 3.10+。

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

启动器自动接入每台机器 PATH 中的 Codex / Claude Code；每次工作者启动都重新发现本机 CLI，沿用其登录与配置。仓库不固定工作者 CLI 版本、安装路径或模型，未安装时会提示，不自动下载替代版本。换电脑后安装并配置自己的 CLI，再运行同一启动脚本即可。实现参考 agent-orchestrator，详见[本地 CLI 接入](skills/pr-cycle/references/local-cli.md)。

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
- [固定工作流](skills/pr-cycle/references/workflow.md)
- [工作者契约](skills/pr-cycle/references/task-contract.md)
- [项目审查示例](skills/pr-cycle/references/REVIEW.example.md)

## 测试

```powershell
python -m unittest discover -s tests -v
node --test tests/test_kanban_ui_proxy.mjs
node --test tests/test_local_cli_resolution.mjs tests/test_local_cli_shutdown.mjs tests/test_codex_local_bridge.mjs tests/test_codex_bridge_shutdown.mjs
powershell -NoProfile -File skills/pr-cycle/scripts/test-kanban-ui.ps1
```

看板测试使用本地模拟服务；Ralph hook 集成测试需要准备固定运行时；启动器测试还需要 Windows 和 Claude Code CLI。消息列表浏览器测试需要已构建前端及本机 Edge。缺少可选环境时 Python 测试会显示跳过。测试不启动模型会话或真实 AI 工作者。

## 许可与来源

本项目的最初构思来源于 YuShen（[@YuShenLiu06](https://github.com/YuShenLiu06)）的 [yushen-skills 项目](https://github.com/YuShenLiu06/yushen-skills.git)，在此基础上实现 PR cycle、看板与 Claude Code 工作流，并作为独立仓库维护。

采用 [MIT](LICENSE)，保留原作者版权。具体来源与外部运行时边界见[致谢](ACKNOWLEDGEMENTS.md)和[第三方说明](THIRD_PARTY_NOTICES.txt)。
