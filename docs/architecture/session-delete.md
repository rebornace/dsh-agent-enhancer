# 会话删除与插件持久化清理

## 宗旨

**删除会话时，必须把该会话在本插件内的一切持久化痕迹清干净。**

后续凡新增「按 `sessionId` 落盘」的能力（检查点、排除规则、用量分片、新功能缓存等），都必须挂到会话删除的 **SessionCleanup** 扩展点；同一变更里完成 `registerSessionCleaner`，并在下表追加一行。未挂清理器即视为该功能未完成。

官方 Desktop 只有归档、没有真删；本插件补的是侧栏单会话真删，不是批量清分组。

## SessionCleanup 登记表

| cleaner id | 持久化位置（相对 plugin-data / 官方路径） | 负责模块 | 状态 |
|---|---|---|---|
| `checkpoint` | `checkpoint/checkpoints`、`journals`、`cuts`、`shadow*` 等按 session 分片 | `src/host/checkpoint/*` | 已接入（`createCheckpointCleaner`） |
| `context-exclude` | `context-exclude/sessions` | filesystem under plugin-data | 已接入（`createContextExcludeCleaner`） |
| `usage` | 全局 `usage/ledger.json` **不按 session 分片**，删除会话时保留聚合行 | `src/host/usage/*` | 有意不按 session 清；若日后分片须注册 cleaner |

覆盖测试：`tests/session-delete.test.ts`。

## 删除流水线（摘要）

1. 忙碌拒绝  
2. 内存 live detach（探测；失败如实报告）  
3. 工作区 / 会话登记移除  
4. 官方会话目录 + projcache + spill  
5. 按登记表执行全部 SessionCleaner  
6. 不动全局 `attachments/`

细节见：`docs/superpowers/specs/2026-11-06-session-delete-design.md`（本地规格；可能被 gitignore）。
