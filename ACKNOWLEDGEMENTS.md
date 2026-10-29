# 来源与整理边界

## 工作流来源

本项目的最初构思来源于 YuShen（[@YuShenLiu06](https://github.com/YuShenLiu06)）的 [yushen-skills 项目](https://github.com/YuShenLiu06/yushen-skills.git)。本仓库在其基础上实现 PR cycle 工作流、Claude Code 启动适配与看板批次工具，配套提供测试，并作为独立项目维护。感谢 YuShen 提供的原始构思与工作方法；原有 MIT 版权声明保留在 [LICENSE](LICENSE)。

开发协调规则、返工总结与 REVIEW 示例来自原项目已获授权的用户自有材料；原项目还核对了公开的 [learning-station 固定版本](https://github.com/YuShenLiu06/learning-station/tree/c566ff841d4cb228fe08dc38c00cf347a0753af5)，其根许可证为 MIT，版权人为 YuShen。未复制学习站程序或其他文档技能。

## Claude Code 与 Ralph Loop

会话循环使用 Anthropic 官方 [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/f8c5e7a1dcb71b10cb74586224b5401f3de5db28/plugins/ralph-loop) 1.0.1，固定完整源码提交，通过 Claude Code 本地插件机制加载。复用其 setup、Stop hook 和取消命令；准备脚本另行取得运行时，存放于 Git 忽略目录并保留上游源码与许可。

Windows hook 依赖 Git Bash 与 [jq](https://github.com/jqlang/jq)，jq 由官方固定发行包取得并校验，版本及哈希见[运行锁定文件](skills/pr-cycle/assets/claude-runtime.lock.json)。本仓库的适配内容包括插件入口、准备、检查与启动脚本，以及工作流约束。

执行入口参考 [Claude Code 插件](https://code.claude.com/docs/en/plugins.md)、[插件 CLI](https://code.claude.com/docs/en/plugins/cli-reference.md) 和 [MCP 文档](https://code.claude.com/docs/en/mcp.md)。Claude Code 由用户另行安装并登录，运行模型和工作者受其账户、授权及费用约束。

## Vibe Kanban

看板与隔离工作会话接入 [BloopAI/vibe-kanban](https://github.com/BloopAI/vibe-kanban)，固定 npm `0.0.166` / [源码提交](https://github.com/BloopAI/vibe-kanban/tree/0c91b082357972dbcfd79c93ab8d899b78181f1a)。根许可证为 Apache-2.0；该项目源码及二进制不随本仓库分发。

本仓库提供批次适配脚本、清单模板、状态映射和调度、验收规则，未复制上游实现。固定版本的接口与来源见[接入说明](skills/pr-cycle/references/kanban.md)和[版本记录](skills/pr-cycle/assets/runtime.lock.json)。

## 许可边界

本仓库只包含 PR 工作流及必要参考。官方 Ralph Loop、Vibe Kanban、jq 和 Claude Code 各自保留原许可，不因本仓库使用 MIT 而重新授权。分发外部运行时须遵守其实际许可；参见[第三方说明](THIRD_PARTY_NOTICES.txt)。
