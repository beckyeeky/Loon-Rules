# Loon-Rules

Beck 自用 / 可复用的 **Loon 分流规则** 仓库（远程规则列表）。

> 只放规则（DOMAIN / IP-CIDR 等），**不含**完整 `.lcf` 配置、节点订阅、插件。  
> 完整配置请继续用可莉模板等；本仓用「规则订阅」方式挂进 Loon。

## 安装（远程规则）

Loon → **配置** → **规则** → **订阅规则** → 添加：

| 名称建议 | URL | 建议策略 |
|----------|-----|----------|
| Direct-Custom | 见下方 raw | DIRECT |
| Proxy-Custom | 见下方 raw | PROXY / 你的代理组 |
| Reject-Custom | 见下方 raw | REJECT |

Raw 根：

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/
```

示例完整 URL：

```text
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Direct.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Proxy.list
https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Reject.list
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
| `rules/Apple.list` | Apple 相关（按需挂 DIRECT 或专线组） |
| `rules/AI.list` | AI / LLM 服务（通常挂 PROXY） |

格式说明见 [`AGENTS.md`](./AGENTS.md)。片段示例见 [`examples/`](./examples/)。

## 原则

1. **小而准**：只维护自己在意的域名，大而全用社区规则集。  
2. **列表不含策略名**：策略在 Loon 订阅时选择。  
3. **改完 push 即可**：Loon 里对该规则点更新。  
4. 与插件（如 [TabulaBili-Loon](https://github.com/beckyeeky/TabulaBili-Loon)）正交：分流不管插件逻辑。

## License

MIT
