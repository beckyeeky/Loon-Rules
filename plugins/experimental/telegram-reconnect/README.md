# Telegram 策略切换实验版

**仅仓库测试版，未经过 Loon 真机测试，未提交或发布。** 要求 Loon **3.5.1 (983)+** 的 Script V2。默认 `MODE=observe`：只读取子策略和当前选择，记录“检查就绪”，不切换、不写存储，也不声称 Telegram 连接可见。

## 能力与前置条件

本插件只通过 `$config.setSelectPolicy` 把一个用户指定的 **select 策略组**临时选为其已有的 `REJECT` 子策略，再尝试切回原策略。不是连接探针、Telegram 消息处理器或重连成功检测器。**策略切换成功不等于连接被断开，更不等于 Telegram 已重连。** 不降级任意节点、不添加 Telegram 网段封禁、不修改 `[General]`，不读取消息 Body，不发送外部 HTTP 请求。

历史配置中的 **`disconnect-on-policy-change`** 开关可能影响策略切换是否断开已有连接。需要用户自行核对所用最新版 Loon 的 UI、当前文档及实际效果；**不能默认该开关仍存在、已开启或一定有效**。插件不会修改或开启它。若无法确认这一前置条件，不应把本实验当作强制断连方案。

- 用户须自行选择实际承载 Telegram 流量、且允许手动选择的 select 组，并自行加入字面名称为 `REJECT` 的子策略。插件不创建、修改策略组结构。
- Telegram 分地区规则可能分别命中多个组，不能只因默认组叫 `Telegram` 就认定所有流量都经过它。查看主配置的实际规则和所命中的组；**一个实例只管理一个组**。避免同组重复实例或其它切换自动化。
- `getSubPolicies` 能检查可选名称，不能替代用户确认该组的真实类型、路由覆盖和当前连接行为。脚本同时兼容字符串数组和含 `name` 的对象数组；其他元素格式会停止，不切换。非 select 组可能无法切换，会按失败处理。
- `generic` 手动入口始终可用，不受 `AUTO_TRIGGER` 控制。不设置 cron、不注册网络变化事件，不做定时或后台检测。

## 文件与安装

- `telegram-reconnect.plugin`：Script V2 元数据、参数、手动入口和一条 response 入口。
- `telegram-reconnect.js`：两个入口共享的独立脚本。
- `tests/reconnect.test.cjs`：Node 内置 test + VM mocks，无第三方依赖。

插件中的两条 Script 均引用同一固定 raw URL。发布后应分别检查 plugin 与 JS 的 HTTP 状态和正文；URL 可访问只证明资源发布，不证明 Loon 真机执行成功。浮动 `main` 便于更新，但可能受缓存影响。如需可复现版本，应另行固定 commit 或 tag。

先保持默认观察模式，在 Loon 的 generic 手动脚本入口运行；确认日志仅提示子策略/当前选择就绪。核对分流组与风险后，才显式切为 reconnect，并先手动执行。默认自动触发关闭。

## 参数

两个入口传入完全相同的 Script V2 参数对象，运行时保留声明类型，不解析字符串查询参数。

| 参数 | 默认 | 约束/含义 |
|---|---|---|
| `MODE` | `observe` | `observe` / `reconnect` |
| `POLICY_GROUP` | `Telegram` | 非空、实际承载流量的 select 组名称；精确匹配 |
| `INTERVAL` | `300` | number，非负有限秒数；仅是成功后的冷却，不是定时周期 |
| `HOLD_MS` | `300` | number，整数 **100～1500 ms**；越界拒绝运行，不静默夹取 |
| `AUTO_TRIGGER` | `false` | boolean，仅控制第三方 HTTP 响应触发 |
| `NOTIFY` | `true` | boolean；关闭后仍保留日志，紧急告警也不会推送 |

缺参数或类型不符直接停止，不擅自启用重连。

## 可选 HTTP 触发

仅一条 response 规则，必要 URL guard 严格限定 HTTPS 主机：`api.swiftgram.app`、`api.imem.app`、`api.iturrit.com`，可显式使用 443 端口。要求 `AUTO_TRIGGER=true`，脚本内再次校验。域名后缀伪装、userinfo、其它端口不匹配。**不包含 `api.telegram.org`**：它是 Bot API，不能当作官方客户端可靠触发源。

这三个第三方 API 仅是可选触发候选，不证明客户端会访问、响应会命中或聊天连接可见。它们的请求时序与 Telegram MTProto 连接没有可靠等价关系。启用 HTTP 触发需要合适的 MitM 证书、信任配置及可解密流量；TLS pinning、自定义加密、协议变化等可能令其完全不触发。插件列出对应 MitM hostname，但不会安装证书。只手动测试时可移除 MitM 段以缩小解密范围。

`requires_body=false`，不读取请求/响应 Body。HTTP 入口可能等待最多约 2 秒的子策略查询及最多 1.5 秒的策略保持，增加响应处理延迟。所有可控路径 `$done({})` 恰一次，不修改原请求或响应；generic 也使用相同结束形式。

## 状态、安全恢复与并发边界

1. 异步子策略回调必须在 2 秒内返回，晚回调或重复回调不再执行切换；插件运行超时设为 10 秒。
2. 校验 `REJECT` 存在、原选中非空且不为 `REJECT`。
3. 重连模式检查成功冷却和按组命名的持久化 lease；存储异常在切换前 **fail closed**。
4. 记录 lease 的 owner、开始/到期时间、原策略，写后读回；lease 有效期 15 秒。再次检查当前选择仍是原策略，然后切出。同步 `setSelectPolicy` 必须返回严格 `true`，并读取当前选择验证。
5. 保持后，**只有当前仍是 `REJECT` 才尝试切回原策略**；如用户已选择其它策略，保留用户选择并报警，不记成功冷却。
6. 切出返回失败/抛异常但读到已变成 `REJECT`，也尝试恢复。切回失败/异常给出手动恢复告警，不写成功冷却。
7. 只有切回返回 true 且读回原策略后才写成功冷却；如果恢复后存储失败，不虚报冷却成功。通知异常不会阻止恢复/结束。当前仍为 REJECT 时保留 lease 作为恢复线索。

键名为 `telegram-reconnect:v1:<encodeURIComponent(组名)>:lease` 和 `:cooldown`。不同组隔离；时间倒退、未来时间戳、畸形状态保护性停止，不自动清空全部存储。lease 过期且当前组可用时可以重新尝试，但不会因到期自行恢复或后台执行。

**lease 的读写不是原子 CAS，也不是可靠分布式锁。** 它只防常见重复触发，不能消除同时读写、读后改选、REJECT→其它策略→REJECT 的 ABA 情况。恢复前读选中与写回也不是原子操作，用户恰在两者之间改选仍存在被覆盖风险；脚本只能缩小窗口，无法硬保证。请勿同时手动切换或运行同组自动化。

### 紧急手动恢复（必须预先知道）

**Loon/iOS 杀死脚本、崩溃、挂起、计时器失效或运行时强制超时，都可能让策略永久停在 REJECT。持久化 lease 不会自行执行恢复，没有 watchdog，无法保证崩溃恢复。**

立即禁用本实验自动触发，并在 Loon 的策略组页面把 `POLICY_GROUP` 对应组从 `REJECT` 手动切回原来的可用策略。若时间/存储保护一直阻止新尝试，先检查系统时间和日志；必要时仅人工清理该组上述两个插件键，勿调用无参数 `$persistentStore.remove()` 清空所有脚本存储。故障期间不要反复运行脚本以代替手动恢复。

## 离线测试

在仓库根目录运行：

```sh
node --test plugins/experimental/telegram-reconnect/tests/reconnect.test.cjs
python3 /var/minis/skills/loon-plugin/scripts/check-templates.py plugins/experimental/telegram-reconnect/telegram-reconnect.plugin
```

使用 Node VM mock Loon API、持久化与虚拟时间，覆盖正常/观察/缺参/缺 REJECT/组不存在/冷却/lease/时间异常/切出与恢复失败/用户并发改选/晚回调/存储异常/通知异常/完成次数与 URL guard。测试不接触网络、不读取用户真实策略或消息，也**不等于 Loon 配置解析或真机验证**。红灯阶段在实现文件不存在时执行；原始输出保存在 `/tmp/telegram-reconnect-red.tap`，最终绿灯输出 `/tmp/telegram-reconnect-green.tap`，静态输出 `/tmp/telegram-reconnect-static.log`。这些是本次执行临时证据，不随仓库发布。

## 思路来源与授权边界

改编思路源于 AlbertMusk/Configs 的 `telegram-interrupt`：

- 原插件：https://github.com/AlbertMusk/Configs/blob/main/loon/plugins/telegram-interrupt/plugin/telegram-interrupt.plugin
- 原脚本：https://github.com/AlbertMusk/Configs/blob/main/loon/plugins/telegram-interrupt/script/telegram_interrupt.js

本实现依据需求及官方 API **独立重写，不复制原源码**。来源链接只用于标明思路，不代表获得原项目授权，也不推断其许可证；若后续引用其代码，应另行核验许可证并履行要求。

官方参考：

- Plugin / 参数：https://nsloon.app/docs/Plugin/
- Script V2（983+）：https://nsloon.app/docs/Script/script_v2
- Script API（setSelectPolicy、getSubPolicies、getSelectedPolicy、存储、done）：https://nsloon.app/docs/Script/script_api
- MitM：https://nsloon.app/docs/MitM/

未核验真机上的开关存在性、实际连接关闭效果、第三方触发命中率、相对脚本路径解析或 iOS 生命周期行为，以上均须由测试者确认。
