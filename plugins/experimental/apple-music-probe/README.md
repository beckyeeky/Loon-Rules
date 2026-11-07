# Apple Music 节点探测（实验）

一个**只读**探测插件 + 一份保守的 Apple Music 分流列表。用某个 Loon 节点去查 Apple 公开目录接口、
并试取试听资源前 1 KB，用来判断「这个节点能不能访问 Apple Music 的公开目录与试听资源」。

- 插件：`plugins/experimental/apple-music-probe/AppleMusic-Probe.plugin`
- 脚本：`plugins/experimental/apple-music-probe/scripts/applemusic-probe.js`
- 规则：`rules/AppleMusic.list`

**门槛：Loon 3.5.1 (983) 及以上**（用 Script V2 的 `generic then script(...)` 语法，低版本不认）。

## 安装

远程导入（插件里已写死本仓 `main` 分支的 raw 地址，脚本不需要你另外放文件）：

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/plugins/experimental/apple-music-probe/AppleMusic-Probe.plugin
```

规则单独订阅（在订阅界面为本列表选策略）：

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/AppleMusic.list
```

> 换分支（如 `dev`）或改动目录后，插件里那行 raw 地址要同步改，否则会加载不到脚本。

### 运行方式

装好后到 **节点 / 策略页 → 长按目标节点 → 菜单里选「Apple Music 节点探测」**。
是手动触发（`generic`），不会自动跑，也不会随流量触发。

### 参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `url` | 日本站某单曲链接 | 只接受 `https://music.apple.com/<地区>/album|song/...`；带 `?i=` 时优先按歌曲 ID |
| `timeout_ms` | 8000 | 单次请求超时（1000–60000） |
| `total_timeout_ms` | 20000 | 脚本总预算，到点立即结束并标「结果不完整」（2000–120000） |
| `script_timeout` | 30 | 该条 Script 的整体超时（秒） |

**没有运行时输入框**：官方 Script/插件 API 只提供 `[Argument]` 预声明参数与 `$environment.params`，
没有「运行时弹窗问你要链接」的能力。要换链接就改插件里的 `url` 参数（或脚本内 `DEFAULT_URL`），
不存在每次运行再问一次的做法。

## 输出与边界

结果分三段：`① 目录查询`、`② 试听 HTTP`、`结论`。只报告节点名、ID、曲名、状态码、字节数，
不含 token / Cookie / 账号信息。

**已验证的范围**（离线单测 + 有限实测样本）：

- **目录查询**：`https://itunes.apple.com/lookup` 可达、JSON 可解析、`trackId` 与输入一致；
- **试听首段**：`Range: bytes=0-1023` 单次请求，校验状态码、Content-Type 为音频、实收字节 > 0。

**未验证**：

- **完整播放**：不请求媒体许可、不解密、不播整曲，不证明你的账号能播放，也**不承诺地区解锁**；
- 真实设备上的 `$environment.params.node` / `nodeInfo` 结构、`node` 是否接受备注名、重名取哪个；
- 服务器真实的 Range 行为与 Loon 的 `$done` 时序。

### 已知风险

1. **部分服务器会忽略 Range**：返回 200 时 Loon 会把这段**试听**资源整段收下（样本约 1 MB）。
   脚本只发 1 次、失败不重试，但无法阻止服务器忽略 Range；结果里会写明「服务器忽略 Range」与实收字节数。
   收到的是试听片段，不是完整付费曲目。
2. **拿不到节点名就停止**：只认 `$environment.params.node`，缺失即整体停止，不退回「当前默认路由」冒充被测节点；
   停止时**不改动任何配置**（不切策略组、不写存储、不发通知）。丢给 `$httpClient` 的节点名原样不加工。
3. **不需要 MitM**：不拦截、不改写任何请求，也不解析 `music.apple.com` 网页 HTML；插件里没有 `[MitM]` 段，
   也没有 `[Rule]` 段（探测不改变流量路由）。

## 规则：`rules/AppleMusic.list`

8 条保守挑选的音乐相关主机，订阅格式（**行内不带策略**，订阅时在 UI 选）：

```text
DOMAIN,aod-ssl.itunes.apple.com
DOMAIN,aod.itunes.apple.com
DOMAIN,audio-ssl.itunes.apple.com
DOMAIN,audio.itunes.apple.com
DOMAIN,mvod.itunes.apple.com
DOMAIN,streamingaudio.itunes.apple.com
DOMAIN-SUFFIX,applemusic.com
DOMAIN-SUFFIX,music.apple.com
```

**故意未收录**：

- `DOMAIN-SUFFIX,blobstore.apple.com` —— 与 iCloud / App Store 等**共享**，整域收进来会把无关流量一起带走；
- `USER-AGENT,Music*` —— 粒度粗、易误伤，且与主机规则重复；
- 通用 CDN（`*.mzstatic.com`、`*.itunes-apple.com.akadns.net`、`*.phobos.apple.com` 等）—— 与其它 Apple 服务共用，
  不能当音乐专属。**本表不追求 CDN 全覆盖**：某些区域可能经 CDN 拉流，请以 Loon 日志里的真实主机为准确认后再补。

规则只做分流，不做解锁、不改账号/商店地区。若手工粘进主配置 `[Rule]` 段，每行**必须补策略**
（如 `DOMAIN,music.apple.com,PROXY`），否则该条无效。

### 建议的远程规则顺序

```text
1  AI
2  AI补充
3  Apple推送
4  AppleMusic      ← 本仓 rules/AppleMusic.list
5  AppleTV
6  ...
末 Apple（总表）
```

- 优先级：**本地 > 插件 > 订阅**；同类规则自上而下先命中先走。
- 域名类规则先于 IP 类规则（域名规则在前，`IP-CIDR` 在后）。
- 泛 Apple 总表放**最后**，否则会吞掉前面所有细分列表的条目；AppleMusic 与 AppleTV / 泛 Apple 存在重叠
  （如 `*.itunes.apple.com` 也会被 `apple.com` 后缀覆盖），重叠时以排在更前的那条为准。
- 这些规则的策略组必须**已经存在**，本仓不创建策略组、也不提供 `RULE-SET` 片段模板。

## 测试

```bash
node plugins/experimental/apple-music-probe/tests/run-tests.js   # 48 例，Node 22，无第三方依赖
```

覆盖链接解析与越权拒绝、节点缺失零请求、目录各类异常、试听 206/200/HTML/空体、`$done` 恰好一次、
总超时收尾、previewUrl 绕过手法、插件与规则文件静态断言等。

**不能覆盖的宿主行为**（需真机）：`$environment.params` 真实结构、节点名匹配与备注名、
服务器真实 Range 行为、Loon `timeout` 与 `$done` 实际时序、返回框显示宽度。
离线通过 ≠ 真机验证，本仓不把单测通过表述为已上机确认。
