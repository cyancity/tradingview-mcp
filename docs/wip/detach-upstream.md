# detach-upstream 脱离上游独立维护

## 目标

上游 tradesdontlie/tradingview-mcp 实质停更（最后提交 2026-07-28，之后 PR 全部积压），且 fork 已领先 11 提交 / 落后 0。本分支移除代码与文档中对上游的所有引用，项目完全独立维护。

## 当前状态（已完成）

- 删除 git remote `upstream`（17 个上游分支引用已清理，均保留在 GitHub 可随时重加）
- 删除本地分支 `feat/b1-study-series`（唯一提交 bb27e24 已包含在 origin/feature/trading-copilot）
- 4 个文件的上游引用改为 cyancity fork：README（徽章+2 处 clone URL）、SETUP_GUIDE、SECURITY、src/core/update.js 错误提示
- `.gitignore` 增加 `.worktree/`
- 本地独有分支 `codex/cold-start-resilience`（6006924）、`feature/paper-trading`（09eb469）**未删**：提交不存在于任何远端分支，删除会丢失，待用户决定（可 push 备份或确认后删）

## 验证结果

- `node --test tests/update.test.js`：9/9 通过
- `grep tradesdontlie` 全仓无残留

## 下一步

- 用户验收后把 chore/detach-upstream 合入 main（基于 main，可 fast-forward）
- 决定两个本地独有分支的去留
