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

- `node --test tests/update.test.js`：9/9 通过（变基前）；变基后全量 unit 见本轮执行记录
- `grep tradesdontlie` 全仓无残留

## 下一步

- 评估两个本地独有分支的覆盖情况，决定去留
- 上游 issues/PR 统计（后台进行中），有价值的拉出来讨论
- 注意：`tv_update` 自更新仍指向 origin/main（原 main，已冻结），yolo-main 主线化后该工具实际不再适用，可考虑改造或移除
