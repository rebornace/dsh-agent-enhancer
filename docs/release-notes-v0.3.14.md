# v0.3.14 — 浏览器 Agent 深度打磨

本轮把浏览器 Agent 的日常手感补齐：标签与 ref 语义、只读、调试工具、闲置回收、启动诊断。对标 Cursor / Claude in Chrome，但**不引入扩展桥**，仍是 Playwright 专用浏览器。

## 新增

- **调试与页面模拟**（设置 → 功能 → 浏览器 Agent，默认关）
  - `browser_network`：读网络请求（方法 / URL / 状态 / 耗时 / 失败原因）
  - `browser_console`：读 console 输出与未捕获异常，带 `file:line`
  - `browser_emulate`：模拟深色模式、减少动画、视口尺寸
  - **不记录请求头、Cookie、响应体**；URL 中疑似密钥的 query 与 console 文本里的 URL 一律掩码为 `***`；缓冲 300 条、关开关即停
- **只读标签**：侧栏标签行一键切换。开启后点击 / 输入 / 同标签导航直接以 `tab_read_only` 失败，不再逐个弹批准框；读工具、滚动、开新标签不受限
- **闲置标签回收**：约 10 分钟无人使用的标签自动关闭（绑定 / 当前 / 最后一个永不关），关闭时同步解绑会话
- **启动诊断**：`browser_status` 与侧栏给出 `diagnosis` + `next:`，覆盖功能未开、未启动、WebKit 缺失、本机无浏览器、profile 被占用等情况

## 修复

- **标签与 ref**：tabId 稳定不复用；ref 全局唯一且按标签保存，切走再切回**无需重拍快照**；用别的标签的 ref 会指名所属标签，不再有静默点错的风险
- **人工介入卡片**：`browser_ask_user` 的普通请求不再套用「登录 / 验证码」文案
- **console 脱敏**：修复只给 network 打码、console 明文泄露 token 的问题
- **快照预算与顺序**：链接密集页不再挤掉搜索框/按钮，控件排在链接前面；快照回显 `emulation:` 与 `harvest:`
- **启动开销**：`playwright-core` 按需加载，插件入口导入 609 → 213 ms
- **状态文案**：`browser_status` 清掉 MV3 时代的 `bridge:` / `extension:` 说法

## 安装

```bash
dsh plugin --profile desktop add dsh-agent-enhancer@0.3.14
```

或在 Desktop「设置 → 插件」搜索 `dsh-agent-enhancer`，安装后重启。

---

完整变更见 [CHANGELOG](https://github.com/rebornace/dsh-agent-enhancer/blob/main/CHANGELOG.md#0314---2026-11-18)。
