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

## 2026-09-06 执行记录（上游 PR 吸收，全部实测后合并）

- codex/cold-start-resilience 已 cherry-pick 进 yolo-main（wait.js 裸符号匹配 + symbol_info tick 字段）
- feature/paper-trading 已 push 到 origin 留底（不合并，未改完）
- **wip/cdp-global-timeout（源 PR #411）已合并**：所有 CDP 交互加硬性截止（evaluate 15s/attach 5s/probe 2.5s/HTTP 3s），超时丢弃缓存 client；macOS tv_launch 改走 `open -a` 防 App Nap 挂死 renderer。保留 fork 的前台 tab 可见性探测（上游版会退化 63bb4e0）
- **wip/pine-new-script-safety（源 PR #463）已合并**：pine_new 改为经 Pine 编辑器菜单真建新脚本（绑定状态前后证明，失败 fail-loud，杜绝 #475 静默覆盖）；smartCompile 默认永不点 Save，Save 按钮限定 .tv-script-widget 面板内，按钮匹配兼容 TV 3.x 图标按钮
- 实测适配（TV 3.4.0 zh-CN）：菜单文案中英双语、子菜单悬停展开、弹层限定 contentDefaultAppearance、跳过通知气泡、未保存=未保存；pine_new 端到端验证通过
- openScript 无需修：fork 已是 fetch→激活 tab→校验的 fail-loud 实现（实测 pine open 无法激活时正确拒绝）
- 测试 236/236 通过；两个 WIP worktree/分支已清理

## Electron 38 评估结论

本机 TV 3.4.0 / Electron 41.7.1（user agent 实测）。Electron 38 是 2025 末的新 major，不是旧版本；本机比它还新两级。fork 的启动路径在 3.4.0 上日常可用（本次 tv launch 实测成功），上游 electron38-compat 分支针对的是 Windows MSIX 场景，不含 ELECTRON_RUN_AS_NODE 处理。剩余暴露面：从 VS Code/Cursor 等 Electron 宿主终端启动 MCP 时 ELECTRON_RUN_AS_NODE 会泄漏给 TV 子进程——目前代码未处理，如遇 TV 启动即崩可加 strip。

## Price Alert REST API（讲解结论）

fork 的 alert 工具已基于 pricealerts.tradingview.com REST API（上游 #301 已并入），alert list/create/delete 可用。上游 open PR #330 增量：alert_create_webhook（带 webhook 的一次性价格告警 + 从剪贴板读 message 避免密钥过 MCP）、alert_modify_price（重建式改价）、alert_delete_one（按 id 删单个并验证）——需要时可以移植。

## 下一步

- `tv_update`/status 的 update 检查仍指向 origin/main（已冻结），yolo-main 主线下提示失真，待改造
- 上游白捡组合中尚未处理：#497←#498（set_inputs 破坏 Pine 输入，fork 需排查同款）、#404←#405、#461（非价格窗格 study values 空）
- GitHub 默认分支仍是 main，如需切到 yolo-main另行操作
