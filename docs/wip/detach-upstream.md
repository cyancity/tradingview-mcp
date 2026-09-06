# yolo-main 主线迁移 + 脱离上游

## 目标

上游 tradesdontlie/tradingview-mcp 实质停更（最后提交 2026-07-28，之后 PR 全部积压），项目独立维护。按用户决定：新开 `yolo-main` 作为自己的主线并汇集全部已合并工作；原 `main` 分支原封不动（保持 fb16c7f，只作历史基线）。

## 当前状态（迁移已完成）

yolo-main 线性历史 = main(11 提交，fork 独有) + feature/trading-copilot(23 提交：copilot 底座/ICT 引擎/回测引擎) + detach-upstream(2 提交：上游引用清零)。基于 423e3db 变基，无冲突。

- 删除 git remote `upstream`（17 个上游分支引用已清理，均保留在 GitHub 可随时重加）
- 删除本地分支 `feat/b1-study-series`（唯一提交 bb27e24 已包含在 copilot 线）
- 4 个文件的上游引用改为 cyancity fork：README（徽章+2 处 clone URL）、SETUP_GUIDE、SECURITY、src/core/update.js 错误提示
- `.gitignore` 增加 `.worktree/`
- 本地独有分支 `codex/cold-start-resilience`（6006924）、`feature/paper-trading`（09eb469）**未删**：提交不存在于任何远端分支，删除会丢失，待覆盖评估后决定

## 验证结果

- yolo-main 全量单测 233/233 通过（含 copilot 新增 6 个测试文件）
- `grep tradesdontlie` 全仓无残留

## 独有分支覆盖评估（2026-09-06）

- `codex/cold-start-resilience`（6006924，3 文件 +9/-3）：**未覆盖，修复的 bug 在 yolo-main 仍存在**。① src/wait.js:49 仍用子串匹配，"NASDAQ:QQQ" 匹配不上图例 "QQQ" 会超时、"QQ" 会误匹配 "QQQ"；② symbol_info 仍缺 minmov/pricescale tick 字段。建议 cherry-pick 进 yolo-main。
- `feature/paper-trading`（09eb469，+1335 行）：**未覆盖，全网唯一副本**。CDP 驱动 paper trading UI（市价单/平仓/trade_status 已实盘验证，limit/stop 未端到端验证）。不可删，建议 push 备份或后续并入。

## 上游 issues/PR 统计（2026-09-06，全量 506 条：118 issue + 388 PR）

- 上游外部 PR 合并率仅 2.7%，7/28 后完全停更（连 CI 审批都停了，#474）
- 最大痛点：Windows/MSIX 启动（20）、CDP 连接（15，几乎全 open）、Pine/Monaco（32 个修复 PR 0 合并）
- 白捡组合（open issue + 现成 open PR）：#497←#498（set_inputs 破坏 Pine 输入）、#404←#405（indicator_search 重复搜索）、#475←#463/#352（pine 脚本静默覆盖）、#13←#18/#80/#108（Electron 38）、#174←#411（CDP 全局超时）
- 对本 fork 最高价值：#411 CDP 调用全局超时、Electron 38 启动兼容思路、#497 需排查 fork 的 pine 工具是否有同款 bug、#461 非价格窗格 study values 为空（ICT copilot 依赖指标读数）

## 下一步

- 用户决定：cherry-pick codex 修复；paper-trading push 备份
- 上游 issues/PR 统计（后台进行中），有价值的拉出来讨论
- 注意：`tv_update` 自更新仍指向 origin/main（原 main，已冻结），yolo-main 主线化后该工具实际不再适用，可考虑改造或移除；GitHub 仓库默认分支仍是 main，如需把 yolo-main 设为默认分支另行操作
