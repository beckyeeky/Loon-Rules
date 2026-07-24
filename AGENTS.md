# AGENTS.md — Loon-Rules 维护说明

## 仓库定位

- **只做 Loon 可订阅的远程规则列表**（`.list`）
- 不放节点、不放完整配置、不放 MitM 插件脚本
- Owner：beckyeeky · 本地：`/root/repos/Loon-Rules`

## Loon 规则行格式（本仓约定）

远程规则订阅时，**行内不要写策略**（DIRECT/PROXY/REJECT 在订阅 UI 里选）：

```text
# 注释以 # 开头
DOMAIN,example.com
DOMAIN-SUFFIX,example.com
DOMAIN-KEYWORD,example
IP-CIDR,10.0.0.0/8,no-resolve
IP-CIDR6,fe80::/10,no-resolve
IP-ASN,44907,no-resolve
USER-AGENT,MicroMessenger*
URL-REGEX,^https?://ads\.example\.com
HOST,www.example.com
HOST-SUFFIX,example.com
HOST-WILDCARD,*.example.com
```

注意：

1. 同一域名不要同时出现在 Direct / Proxy 两边（后添加的规则优先级取决于 Loon 配置顺序）。  
2. `IP-CIDR` 建议加 `no-resolve`，避免无意义 DNS。  
3. 优先 `DOMAIN-SUFFIX`，少用过宽的 `DOMAIN-KEYWORD`。  
4. 改文件后 commit + push；Loon 客户端手动「更新」订阅。

## 推荐规则顺序（用户主配置里）

由上到下（仅建议）：

1. REJECT（广告）  
2. Direct-Custom（本仓直连）  
3. Proxy-Custom / AI（本仓代理）  
4. 社区大规则（如 geoip / 主流分流）  
5. FINAL 兜底  

具体以你主 `.conf` / 可莉配置为准。

## 目录

```text
rules/*.list             # 通用可订阅规则
rules/Telegram/*.list    # Telegram 分地区可订阅规则
examples/                # 主配置片段示例（不直接订阅）
```

## 禁止

- 把完整机场订阅写进本仓  
- 在 `.list` 行尾写 `,PROXY` 等策略（除非你明确改成「带策略规则」并全仓统一）  
- 提交密钥、证书、MitM 私钥  

## 发布检查

```bash
# raw 是否 200
curl -sSIL "https://raw.githubusercontent.com/beckyeeky/Loon-Rules/main/rules/Direct.list" | head -5
```

## AI.list 维护

- 单一订阅入口：`rules/AI.list`（策略 AIGC）
- 文件头 `SOURCES:` / `UPDATE_HINT:` 供自动更新脚本解析
- 更新流程：拉取 SOURCES 中 raw → 抽规则行 → 按厂商分段去重 → 保留头注释 → commit
- `ChatGPT.list` 为兼容残留，勿再扩大；新域只进 `AI.list`
