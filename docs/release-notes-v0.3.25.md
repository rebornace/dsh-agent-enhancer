# v0.3.25 — 让官方权限审查看得懂浏览器操作

## 改了什么

官方的权限层（包括实验性的「自动审查」）只能看到**工具名和参数**。以前它看到的是：

```
browser_click { ref: 9 }
```

它没法知道你点的是「导出」还是「删除」，所以只能保守地拒绝。

现在变更类工具要求带上控件名，宿主会核对它是不是这个 ref 对应的控件：

```
browser_click { ref: 9, label: "导出报表" }
```

`browser_demo_recipes` 的运行也带上了站点：

```
browser_demo_recipes { action: "run", name: "周报导出", site: "https://example.com" }
```

`list` 会显示每个流程录制时的站点；`run` 的 `site` 与实际不符会被拒绝。

## 行为变化

- 控件有名字时，漏传 `label` 会直接报错并告诉你该传什么（从 `browser_snapshot` 复制即可）。
- 传错控件名会被拒绝；缩写（「导出」对应「导出报表」）可以接受。
- 无名字的图标按钮不受影响。

## 为什么

为了以后能把审批交给官方统一处理：只有参数里说清「在哪个站点、点什么」，自动审查才可能按你的指令判断放行——这是定时/无人值守运行的前提。

## 升级

```bash
dsh plugin --profile desktop add dsh-agent-enhancer@0.3.25
```

或在 Desktop「设置 → 插件」里更新后重启。

---

完整变更见 [CHANGELOG](https://github.com/rebornace/dsh-agent-enhancer/blob/main/CHANGELOG.md#0325---2026-11-20)。
