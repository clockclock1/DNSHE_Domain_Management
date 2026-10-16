# DNSHE 域名管理器

基于 Cloudflare Workers 的 DNSHE 免费域名多账号管理面板，适配 [DNSHE Free Domain API V2.0](https://my.dnshe.com/knowledgebase/13/DNSHE-Free-Domain-API-User-Guide-V2.0.html)。

单文件部署：`worker.js`（前端 UI + API 代理 + 自动续期 Cron）。

## 功能

| 模块 | 能力 |
| --- | --- |
| 登录 | 管理密码登录，Bearer Token 会话 |
| 多账号 | 在 KV 中保存多组 API Key / Secret，侧边栏切换 |
| 域名 | 分页、搜索、筛选、排序；注册、详情、续期、删除 |
| DNS | A / AAAA / CNAME / MX / TXT / NS / SRV / CAA 增删改 |
| API 密钥 | 列表、创建（含 IP 白名单）、删除、重置 Secret |
| 配额 | 已用 / 总额 / 剩余 / 基础额度 / 邀请奖励 |
| WHOIS | 查询完整域名注册信息 |
| 永久升级 | 可升级域名、申请、助力、取消任务 |
| 自动续期 | Cron 定时 + 手动执行；可配置提前天数与账号范围；每账号硬限 30 次/分钟 |

请求只通过 `X-API-Key` / `X-API-Secret` 请求头访问官方 API，不再把密钥放进 Query / Body。

## 部署

### 1. 创建 Worker

Cloudflare Dashboard → **Workers & Pages** → 创建 Worker，把本仓库的 `worker.js` 完整粘贴进去并部署。

也可用 Wrangler：把 `worker.js` 作为入口脚本即可。

### 2. 绑定 KV

1. 创建 KV Namespace（例如 `DNSHE_DATA`）
2. Worker → **Settings → Bindings**
   - Variable name: **`KV`**（必须叫这个名字）
   - KV Namespace: 选中你创建的命名空间

### 3. 设置登录密码

Worker → **Settings → Variables and Secrets**

| 名称 | 说明 |
| --- | --- |
| `PASSWORD` | 管理面板登录密码；不设置时默认为 `admin` |

### 4. 配置自动续期 Cron（可选但推荐）

Worker → **Triggers → Cron Triggers**，添加例如：

```text
0 8 * * *
```

表示每天 **UTC 08:00** 执行一次（北京时间约 16:00）。

然后在面板左侧打开 **自动续期**：

1. 设置「到期前多少天开始续期」（建议 `170`–`175`，官方免费窗口约到期前 180 天）
2. 选择生效账号（不勾选 = 全部账号）
3. 打开开关并 **保存设置**
4. 可先点 **立即执行** 验证

未配置 Cron 时，仍可手动执行；定时任务不会跑。

## 使用说明

1. 打开 Worker 访问地址，用 `PASSWORD` 登录
2. **添加账号**：填入 DNSHE 控制台「免费域名管理 → API 管理」里的 API Key / Secret
3. 选择账号后可管理域名、DNS、密钥、WHOIS、永久升级
4. 侧边栏 **自动续期** 配置定时规则

### 获取 API 凭证

1. 登录 [DNSHE 客户中心](https://my.dnshe.com/)
2. 进入免费域名管理
3. 左侧 **API 管理** → 创建 API Key
4. **Secret 只显示一次**，请妥善保存

## 自动续期规则说明

- 默认在到期前 **175** 天尝试续期
- 跳过「永不过期」域名
- 未进入免费续期窗口（`renewal_not_yet_available`）记为跳过，不算失败
- 每个 API 账号最多 30 次请求/分钟，由 Worker 统一排队，页面操作和定时任务都不会超过
- 运行有互斥锁，Cron 与手动执行不会同时进行

## 项目结构

```text
.
├── worker.js    # Worker 全部代码（API + UI + Cron）
├── README.md    # 本说明
└── LICENSE      # Apache-2.0
```

## 安全建议

- 务必设置强随机 `PASSWORD`，不要使用默认 `admin`
- API Secret 只存在 Cloudflare KV，不要提交到 Git
- 生产环境可为 DNSHE API Key 开启 IP 白名单（Worker 出口 IP 可能变化，按需评估）
- 面板本身没有细粒度多用户权限，适合个人或小团队自用

## 相关文档

- [DNSHE Free Domain API User Guide (V2.0)](https://my.dnshe.com/knowledgebase/13/DNSHE-Free-Domain-API-User-Guide-V2.0.html)
- [DNSHE 免费域名续期与 API 续期说明](https://my.dnshe.com/knowledgebase/5/DNSHE-Free-Domain-Renewal-and-API-Command-Renewal-Methods.html)

## License

Apache-2.0
