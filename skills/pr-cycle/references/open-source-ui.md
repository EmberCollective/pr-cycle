# 开源看板前端

Vibe Kanban 0.0.166 的原版消息列表使用商业包 `@virtuoso.dev/message-list`，旧密钥在本地地址会提示开发授权过期。本项目从固定源码构建前端，改用已有的 MIT 许可依赖 `react-virtuoso`。三个入口（旧版会话、新版会话、进程日志）均已替换，移除了商业包依赖、授权容器和密钥读取。

## 运行

在仓库根目录执行（Windows、Node.js/npm、Git）：

```powershell
powershell -NoProfile -File skills/pr-cycle/scripts/setup-kanban-ui.ps1
powershell -NoProfile -File skills/pr-cycle/scripts/start-kanban.ps1
```

打开 **http://127.0.0.1:13680**，同一地址提供界面、API 和 MCP。**13681** 保留为兼容入口。启动器先启动替换前端，再启动原后端；后端自动打开的 **127.0.0.1:13682** 也由替换前端处理，不再显示商业消息列表。数据库和工作区位置不变。

`start-kanban.ps1 -Port 13780 -FrontendPort 13781 -BackendPort 13782` 可改变端口，协调者的 `-Port` 同步为公开 API 端口 `13780`。三个端口必须不同。自定义运行时目录时，准备脚本和启动器均传相同的 `-RuntimePath`。

启动器在终端持续运行，Ctrl+C 停止本次创建的服务，不停止复用的服务。已有前后端都可用时，重复启动只检查入口、同步 CLI 配置并显示地址。`-BackendOnly` 是排障用的原版后端入口，不提供前端替换，不能用作日常看板启动方式。

旧部署若仍将原版后端放在 `127.0.0.1:13680`，必须先结束活动工作者、备份数据并停止旧启动器，再运行新脚本。启动器发现旧服务占用入口会明确报错，不会直接结束用户进程。迁移后刷新原浏览器标签页；已经加载的旧 JavaScript 不会自行更换。

## 实现与构建

- `assets/runtime.lock.json` 固定后端及前端源码提交。`assets/kanban-ui/build.lock.json` 固定源码压缩包 SHA-256 和 pnpm 版本。
- `assets/kanban-ui/frontend.patch` 修改三个消费者并移除商业依赖，也移除本地构建不需要的上游 Sentry 发布插件。
- `assets/kanban-ui/MessageList.tsx` 负责将会话更新、定位及可见项查询接到 `react-virtuoso`，保留按需渲染和动态高度测量。
- `conversation-events.patch` 与 `conversationEntries.ts` 在新旧会话中隐藏 `System: thinking_tokens` 计数通知，并将完整的 `[claude-code:unrecognized_model] {"model":"…","query_source":"sdk"}` 警告显示为普通系统提示，保留原文。旧后端会把标准错误流统一标为错误，但这条 Claude Code 模型识别警告本身不能证明调用失败。包含其他错误的混合日志、实际接口错误及执行失败状态仍保留；原始进程日志不变。这项展示修正不处理服务端响应缺失或中断。
- `assets/kanban-ui/WorkflowBoard.tsx` 与 `workflow-board.css` 替换任务看板，显示保留的阶段卡片和三类追踪线；准备脚本每次复制这些受版本控制的文件，下载源码不是修改的唯一副本。
- `assets/kanban-ui/workflow-page.patch` 调整项目页面的空列表分支，无当前任务时仍挂载追踪看板，以便回看已删除任务的历史。
- 历史首次加载定位到底部；输出追加和流式增高在底部时跟随；向上查看历史时保留阅读位置；搜索及“跳转到底部”仍可主动定位。
- `serve-kanban-ui.mjs` 在 `127.0.0.1` 的三个入口提供构建文件，并透传 HTTP、SSE、WebSocket 到 `127.0.0.2:13682` 的内部原后端。分开的回环地址让后端自动打开的 `127.0.0.1:13682` 也能使用替换界面。保留 Host/Origin 配对并拒绝外部来源；内部后端仍带上游嵌入资源，不作为浏览器入口。
- 构建产物位于 `.pr-cycle-runtime/vibe-kanban-<commit>/frontend/dist`。商业包文本检查、Apache-2.0 与 react-virtuoso MIT 许可副本随本地构建生成。不提交下载的源码、依赖或二进制。

流程历史由本地 SQLite 触发器持久化，界面通过代理的追踪接口读取。首次安装备份、数据库位置、整合操作及兼容性见[流程追踪](workflow-tracking.md)。旧版代理需要重启后才能提供新接口；新版启动器会识别旧代理并提示。

参考了 [agent-orchestrator 的滚动行为](https://github.com/OrchestratorInc/agent-orchestrator/blob/96cd425bd33a5187ff5891731cc7114fe12a7ed6/frontend/src/renderer/hooks/useScrollFollow.ts)：用户阅读历史时保持控制权，流式增量不反复启动平滑动画。本实现使用 react-virtuoso 自身的测量和跟随机制，没有复制该项目源码。

## 验证

```powershell
python -m unittest discover -s tests -v
node --test tests/test_kanban_ui_proxy.mjs
node --test tests/test_conversation_entries.mjs
powershell -NoProfile -File skills/pr-cycle/scripts/test-kanban-ui.ps1
```

浏览器测试使用本机 Edge 和临时安装在忽略目录的 Playwright，检查长列表虚拟化、首次加载、追加、流式增高、搜索定位、阅读位置、可见项查询、上下文更新和清空重载。不连接 AI，不创建真实工作者。测试服务和夹具在结束后清理。前端 TypeScript 检查随构建执行；完整 lint 可在下载的源码根目录运行 `npx -y pnpm@10.13.1 --filter ./frontend run lint`。
