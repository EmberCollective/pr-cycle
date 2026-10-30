# 保留卡片与流程追踪

看板按阶段保留卡片。任务进入下一阶段时，原位置留下该轮的历史快照，并连接到新阶段的当前卡片。历史节点只用于回看，同一个任务仍只有一个原生任务 ID、一个当前状态，不会因历史卡片增加工作者或调度名额。

## 使用

- 蓝色实线 **顺序执行**：同一任务的阶段推进自动记录；跨任务的执行顺序通过「关联任务 → 顺序执行」记录。
- 红色虚线 **打回返工**：状态回退或重新打开完成/取消的任务时自动记录，并增加轮次。点击连线填写原因；未填写时显示「状态回退，待补充原因」。该分类来自状态变化，不代表系统已判断审查结果。
- 紫色实线 **小改动整合**：点击「关联任务」，勾选多个来源任务，选择目标整合任务并填写说明。多个来源分别连到整合节点，来源显示「已纳入整合」。该标记不等于来源已完成，也不会执行 Git 合并。

点击「追踪」高亮该节点所在的关联路径；点击历史卡片查看当时的标题、说明、时间和轮次。当前卡片仍支持原有详情、操作菜单与拖动。工具栏可筛选任务、分别隐藏三类线条、折叠历史；隐藏端点时也隐藏对应线条并显示数量提示，展开即可恢复。

删除最后一个原生任务后，项目仍显示保留的历史卡片和连线，刷新页面后也可查看。没有任务或历史的新项目显示空看板，并保留「新建任务」入口。

顶部搜索同时匹配当前任务与历史快照的标题、说明，忽略大小写和首尾空格。任一阶段匹配时保留该任务的完整路径，包括已删除任务的历史；无关任务不会因已删除而绕过搜索。无匹配结果时看板仍保留，显示提示，可清空搜索恢复全部记录。

任务关联是流程证据，不启动工作者、不改变调度依赖或状态。实际顺序执行仍需在批次清单的 `depends_on` 中声明，并由协调者核实依赖交付；整合仍需执行组合验证和适用审批。手工关联不允许同一任务自连、跨项目关联或任务间循环。误建的手工关联可在连线详情中移除；自动流转连线不能删除，可补充说明。

## 安装与持久化

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/setup-kanban-ui.ps1
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

初次启用前，安装器用 SQLite 在线备份保存数据库副本 `db.before-pr-cycle-tracking-<UTC时间>.sqlite`，位于原数据库旁。然后在同一个数据库中增加 `pr_cycle_*` 表、索引和触发器，不复制原生任务、不替换数据库，不改变固定后端二进制。

触发器与原生任务更新处于同一事务：UI、REST、MCP 和后台自动状态变化都会留下记录；失败事务会一起回滚。网页或代理服务关闭时也继续记录。历史卡片在离开阶段时保存标题和说明；当前阶段的文本修改更新当前快照。删除原生任务会关闭其最后节点，保留已有追踪记录。说明可能含项目资料，应按原数据库同样的权限和备份策略保护。

启用前已存在的任务只建立当前状态起点，明确标注「此前历史未记录」，不推测过去发生的流转。停留在同一原生状态的细阶段（如实现到自证）不会产生新节点；仍按工作流在描述中记录细阶段和证据。

Windows 默认数据库是 `%APPDATA%\bloop\vibe-kanban\data\db.sqlite`。`-RuntimePath` 只指定源码/构建目录，不改变后端数据库位置。维护隔离测试或手动部署时，可用 `start-kanban.ps1 -TrackingDatabase <真实后端数据库路径>` 指定数据库；必须与内部后端一致，不能指向另一项目的数据库。不存在的路径会报错，不创建空数据库。旧代理没有追踪接口时，启动器提示关闭旧启动器后重启，不会擅自结束旧服务。

直接运行 `serve-kanban-ui.mjs` 时，先运行 `python skills/pr-cycle/scripts/kanban_tracking.py --install --db <路径>`，再传 `--tracking-db <相同路径> --python <Python路径>`。脚本与后端运行在同一用户下。此实现只针对固定版 0.0.166；升级后端前，在数据副本验证表结构和触发器兼容性。

追踪 API 为 `/api/pr-cycle/tracking`：GET 使用 `project_id`，POST JSON 使用 `project_id` 和 `action`（`relate` / `annotate` / `unlink`）。节点 ID 只标识历史记录，不能用作原生 task ID。接口沿用本机 Host/Origin 校验，返回数据不缓存；读取刷新间隔为 2.5 秒。

## 验证与维护

```powershell
python -m unittest discover -s tests -p test_kanban_tracking.py -v
node --test tests/test_kanban_tracking_api.mjs tests/test_kanban_ui_proxy.mjs
node tests/test_workflow_board_browser.mjs
node tests/test_workflow_history_page_browser.mjs
```

浏览器测试需要已构建前端、本机 Edge 和 `.pr-cycle-runtime/ui-tests` 内的 Playwright（可先运行 `scripts/test-kanban-ui.ps1` 准备）。测试使用临时数据库、模拟原生任务写入与真实追踪 API，不修改用户任务，不启动 AI 工作者。截图保存在忽略目录 `.pr-cycle-runtime/workflow-board.png`。

`test_workflow_history_page_browser.mjs` 验证实际构建页面的空列表分支，需要已启动新版看板且至少有一个项目（默认 `http://127.0.0.1:13680`，可用 `PR_CYCLE_UI_URL` 指定）。它在浏览器中模拟任务删除和历史数据，拦截所有 HTTP 写请求，不删除真实任务、不修改服务端配置。

恢复旧前端不会删除记录，数据库触发器仍会记录任务变化。若必须完全停用追踪，先停看板和工作者并备份，再仅删除四个 `pr_cycle_task_*` 触发器；保留 `pr_cycle_nodes`、`pr_cycle_edges` 和元数据以便回看。停用后产生的变化无法补录，不应将这种数据库直接当作连续历史恢复使用。不要将旧备份直接覆盖包含后续任务变更的数据库。
