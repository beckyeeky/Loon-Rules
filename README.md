# Loon-Rules

Beck 自用 / 可复用的 **Loon 分流规则** 仓库（远程规则列表）。

> 只放规则（DOMAIN / IP-CIDR 等），**不含**完整 `.lcf` 配置、节点订阅、插件。  
> 完整配置请继续用可莉模板等；本仓用「规则订阅」方式挂进 Loon。

## 安装（远程规则）

Loon → **配置** → **规则** → **订阅规则** → 添加：

| 名称建议 | URL | 建议策略 |
|----------|-----|----------|
| Direct-Custom | 见下方 raw | DIRECT |
| Telegram-SG | 见下方 raw | 新加坡策略组 |
| Telegram-US | 见下方 raw | 美国策略组 |
| Telegram-EU | 见下方 raw | 欧洲策略组 |
| Proxy-Custom | 见下方 raw | PROXY / 你的代理组 |
| Reject-Custom | 见下方 raw | REJECT |

Raw 根：

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/
```

示例完整 URL：

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Direct.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Telegram/SG.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Telegram/US.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Telegram/EU.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Proxy.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Reject.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/PikPak.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/ChatGPT.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/DrugPipeline.list
```

jsDelivr 备用：

```text
https://cdn.jsdelivr.net/gh/beckyeeky/Loon-Rules@main/rules/Direct.list
```

## 规则文件

| 文件 | 用途 |
|------|------|
| `rules/Direct.list` | 强制直连（国内常用、局域网、特殊直连） |
| `rules/Proxy.list` | 强制代理（被墙/想走代理的域名） |
| `rules/Reject.list` | 拦截（广告/追踪；轻量自用，非可莉全家桶） |
| `rules/Telegram/SG.list` | Telegram 新加坡 ASN（挂新加坡策略组） |
| `rules/Telegram/US.list` | Telegram 美国 ASN（挂美国策略组） |
| `rules/Telegram/EU.list` | Telegram 欧洲 ASN/网段（挂欧洲策略组） |
| `rules/Apple.list` | Apple 相关（按需挂 DIRECT 或专线组） |
| `rules/AI.list` | **AI 总表**（OpenAI/Claude/Gemini/xAI/Cursor/… + 官方 allowlist 补漏；含 SOURCES 头） |
| `rules/PikPak.list` | PikPak 网盘（通常挂 PROXY / 下载组） |
| `rules/ChatGPT.list` | （兼容）已并入 AI.list，建议只订 AI.list |
| `rules/DrugPipeline.list` | Drug Pipeline MCP 外部数据源（建议挂美国策略组） |

格式说明见 [`AGENTS.md`](./AGENTS.md)。片段示例见 [`examples/`](./examples/)。

## Telegram 分地区订阅

按以下顺序放在通用 `Proxy.list` 前，避免后面的 Telegram 域名规则提前接管流量：

1. `Telegram/SG.list` → 新加坡策略组
2. `Telegram/US.list` → 美国策略组
3. `Telegram/EU.list` → 欧洲策略组

规则来自 [`@jpkxt/11`](https://t.me/jpkxt/11)，使用 Loon 支持的 `IP-ASN`，并保留原帖顺序。

## AI 总表订阅（推荐只订这一条）

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/AI.list
```

- 策略选 **AIGC**
- 文件头 `SOURCES:` 列出上游链接，方便脚本/AI 自动抓取合并更新
- 旧的 `ChatGPT.list` 仅作兼容，新订阅请用 `AI.list`

## 原则

1. **小而准**：只维护自己在意的域名，大而全用社区规则集。  
2. **列表不含策略名**：策略在 Loon 订阅时选择。  
3. **改完 push 即可**：Loon 里对该规则点更新。  
4. 与插件（如 [TabulaBili-Loon](https://github.com/beckyeeky/TabulaBili-Loon)）正交：分流不管插件逻辑。

## License

MIT
