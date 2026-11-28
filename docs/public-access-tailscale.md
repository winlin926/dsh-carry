<p>
  简体中文 · <a href="public-access-tailscale.en.md">English</a>
</p>

# 用 Tailscale 让手机从公网连接电脑

如果你不想购买域名、也不想折腾云服务器或端口映射，只要在电脑上装好 **Tailscale**（v1.52+），就能拿到稳定的 `https://<机器名>.<tailnet>.ts.net` 地址并由 Tailscale 自动托管 HTTPS 证书。

`dsh-carry` 搭配 Tailscale 时有两种暴露方式：

| 模式 | 电脑端命令 | 手机端接入方式 | 访问范围与适用场景 |
| --- | --- | --- | --- |
| **`tailscale serve`（推荐私密方案）** | `tailscale serve --bg http://127.0.0.1:43128` | 手机安装 Tailscale，**或在 FlClash / Clash / OpenClash 内置接入** | **完全不暴露到公网**，仅自己 Tailnet 内设备可访问 |
| **`tailscale funnel`（免配手机方案）** | `tailscale funnel --bg http://127.0.0.1:43128` | **任意手机浏览器直接扫码** | 经 Tailscale 公网边缘开放 HTTPS；即使手机常开 Clash/VPN 也不抢槽位 |

> **不需要在 DSH 里点击「申请证书」：** Tailscale 会自动向 Let's Encrypt 申请并维护 `*.ts.net` 的 HTTPS 证书，然后转发给本机 `http://127.0.0.1:43128`。

---

## 一、电脑端配置

### 前置准备

1. 在电脑上安装并登录 [Tailscale](https://tailscale.com/download)（v1.52 或更新版本；Windows 请用管理员权限终端运行，Linux/macOS 前加 `sudo`）。
2. 登录 [Tailscale Admin Console → DNS](https://login.tailscale.com/admin/dns)：
   - 开启 **MagicDNS**；
   - 开启 **HTTPS Certificates**。
3. **仅 `tailscale funnel` 需要此步**（`serve` 模式可跳过）：Tailscale 默认在 ACL 中禁止 Funnel，需在控制台 **Access Controls** 的 JSON 策略里加入 `nodeAttrs` 放行规则：

```json
"nodeAttrs": [
  {
    "target": ["autogroup:member"],
    "app": {
      "tailscale.com/cap/funnel": [
        {
          "allowFunnel": true
        }
      ]
    }
  }
]
```

### 启动转发（指向网关端口 `43128`）

根据需要二选一（**不要指到 DSH 本体端口 `52728`**）：

- **私密内网模式（`serve`）**：
  ```sh
  tailscale serve --bg http://127.0.0.1:43128
  tailscale serve status
  ```
- **公网直连模式（`funnel`）**：
  ```sh
  tailscale funnel --bg http://127.0.0.1:43128
  tailscale funnel status
  ```

状态输出会给出完整域名，例如 `https://my-desktop.tail12345.ts.net`。如需停止代理，运行 `tailscale serve off` 或 `tailscale funnel off`。

### 在 DSH 插件内保存与检测

1. 打开电脑端 DSH「远程控制 → 连接设置」，开启连接并切换到公网模式（或在「公网节点」添加节点并设为当前）。
2. 在「固定公网域名」填入 `https://<机器名>.<你的tailnet>.ts.net`（不带末尾斜杠或路径），点击「保存」。
3. 点击「检测连通性」，确认 `https://<域名>/.well-known/dsh-remote` 返回本机指纹且校验通过。

---

## 二、手机端连接与解决 Clash / FlClash VPN 冲突

- **如果电脑用的是 `tailscale funnel`**：手机上不需要装 Tailscale App，即使手机常开 **FlClash / Clash**，两者也**不会抢占 Android VPN 槽位**。建议在代理规则里加上一条 `DOMAIN-SUFFIX,ts.net,DIRECT`（直连畅通时无需绕节点），手机浏览器直接扫码即可。
- **如果电脑用的是私密 `tailscale serve`，且手机一直开着 FlClash / Clash**：
  Android 同一时间只允许一个 App 占用系统 VPN 通道，默认同时开启 FlClash 与官方 Tailscale App 会互相顶掉。你有三种解决方式：
  - **桌面端 / 路由器**：在路由排除中放行 `100.64.0.0/10` 即可与官方客户端共存；或者在 **OpenClash**（路由器端）配置下面同一套 Mihomo `type: tailscale` 出站，局域网内设备免装客户端直连。
  - **Android 不换方案（推荐给不想双开的人）**：利用 **Mihomo（`v1.19.25` 及以上）内置的 `type: tailscale` 出站**（基于 `tsnet`），直接把 Tailscale 作为代理配置里的一个出站节点运行在 **FlClash ≥ `0.8.93`**（实测推荐 `0.8.94+`）、Clash Verge 等客户端内，无需再开官方 Tailscale App。
  - **Android 双开（Zero 配置修改）**：如果不想改代理脚本，或者希望其他 Tailnet 设备也能反向连入手机（如 Taildrop），可用 Work Profile 工具（如 Shelter）把官方 Tailscale App 装进工作空间，占据独立 VPN 槽位。

---

## 三、在 FlClash / Mihomo / OpenClash 内置接入 Tailscale

> **内核与版本要求：** 依赖 **mihomo ≥ `v1.19.25`**；使用 **FlClash 需 ≥ `0.8.93`**（部分 Android 机型在 `0.8.93` 上若出现 `NeedsLogin` / `Rebind IPv4` 报错，建议升级至 **`0.8.94` 或最新维护版**）。

### 第 1 步：生成 Tailscale Auth Key

登录 [Tailscale Admin Console → Settings → Keys](https://login.tailscale.com/admin/settings/keys) → **Generate auth key**：

| 选项 | 建议 | 说明 |
| --- | --- | --- |
| **Reusable** | **建议关闭**（按需开启） | 关闭即为一次性 key，首次登录后立即作废，留在本地配置中即使泄露也无风险；若开启便于重装迁移，登录成功后建议回控制台 **Revoke** |
| **Ephemeral** | **关闭** | 避免进程休眠或重连后设备被从 Tailnet 自动移除 |
| **Pre-approved** | 开启设备审批时勾选 | 避免新设备卡在待批准状态；若开启此项，务必使用一次性 key 或在登录后立即撤销 |

记录以 `tskey-auth-` 开头的完整字符串（仅显示一次）。首次连接上线后，也可前往 **Machines** 页面点开对应设备右侧 `⋯ → Disable key expiry` 关闭节点密钥定期过期。

> **安全提醒：** 切勿把含有效 `auth-key` 的覆写脚本或 FlClash 备份文件截图或外传。使用一次性 key（`Reusable` 关闭）最省心安全。

### 第 2 步：YAML 节点、DNS 与规则（适用于 Clash Verge / OpenClash 等）

在你的 Mihomo 配置中加入 `type: tailscale` 节点、`nameserver-policy`（确保私密 `tailscale serve` 的 `*.ts.net` 域名走 Tailscale MagicDNS 解析而不会在公网 DNS 返回 `NXDOMAIN`）以及前置分流规则：

```yaml
proxies:
  - name: TAILSCALE
    type: tailscale
    hostname: mihomo-client # Tailscale 控制台显示名，可自定义
    auth-key: tskey-auth-xxxxxxxxxxxxxxxx # 替换为你生成的 key（首次登录后也可不保留明文 reusable key）
    control-url: https://controlplane.tailscale.com
    state-dir: ./tailscale # OpenClash/Linux 请改用有写权限的持久化目录，如 /etc/openclash/tailscale
    ephemeral: false
    udp: true
    accept-routes: true
    ip-version: ipv4-prefer

proxy-groups:
  - name: Tailscale
    type: select
    proxies:
      - TAILSCALE
      - DIRECT

dns:
  enable: true
  # 让 *.ts.net 域名交由内置 Tailscale 出站的 MagicDNS 解析（对应上面的节点名 TAILSCALE）
  nameserver-policy:
    "+.ts.net": ts://TAILSCALE

rules:
  # 必须插在所有订阅规则之前，避免先被普通代理规则抢走
  - IP-CIDR,100.64.0.0/10,Tailscale,no-resolve
  - IP-CIDR,100.100.100.100/32,Tailscale,no-resolve
  - DOMAIN-SUFFIX,ts.net,Tailscale
  # 保留内网段直连（在家同 Wi-Fi 时优先局域网通信）
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
```

### 第 3 步：FlClash 覆写脚本（防止刷新订阅被覆盖）

直接修改订阅 YAML 会在下次更新订阅时被覆盖。在 FlClash 中请改用**覆写脚本**：

1. 打开 **工具 → 进阶配置 → 覆写脚本 → 新建脚本**，粘贴下面的脚本并替换 `auth-key`：

```javascript
function main(config) {
  config["proxies"] = config["proxies"] || [];
  config["proxy-groups"] = config["proxy-groups"] || [];
  config["rules"] = config["rules"] || [];

  // 若订阅中已同名，请修改此处的节点名与分组名并同步调整规则与 ts:// 引用
  const nodeName = "TAILSCALE";
  const groupName = "Tailscale";

  config["proxies"].push({
    name: nodeName,
    type: "tailscale",
    hostname: "flclash-android",
    "auth-key": "tskey-auth-替换为你的key",
    "control-url": "https://controlplane.tailscale.com",
    "state-dir": "./tailscale",
    ephemeral: false,
    udp: true,
    "accept-routes": true,
    "ip-version": "ipv4-prefer",
  });

  config["proxy-groups"].unshift({
    name: groupName,
    type: "select",
    proxies: [nodeName, "DIRECT"],
  });

  // 配合 tailscale serve 的私有 *.ts.net MagicDNS 解析
  config["dns"] = config["dns"] || {};
  config["dns"]["nameserver-policy"] = config["dns"]["nameserver-policy"] || {};
  if (!config["dns"]["nameserver-policy"]["+.ts.net"]) {
    config["dns"]["nameserver-policy"]["+.ts.net"] = `ts://${nodeName}`;
  }

  // 插到订阅规则最前面，保证优先级最高
  config["rules"] = [
    `IP-CIDR,100.64.0.0/10,${groupName},no-resolve`,
    `IP-CIDR,100.100.100.100/32,${groupName},no-resolve`,
    `DOMAIN-SUFFIX,ts.net,${groupName}`,
    ...config["rules"],
  ];

  return config;
}
```

2. **关键一步（最容易遗漏）**：仅保存脚本不会生效。前往 **配置 → 点击正在使用的订阅右上角 `⋮` → 更多 → 覆写**：
   - 将顶部「覆写模式」切换为 **「脚本」**；
   - 在下方列表中点选刚才新建的脚本；
   - 返回后 FlClash 会自动重新应用，可以在「预览」中确认配置已包含 `type: tailscale` 且代理页出现了 `Tailscale` 分组。

### 第 4 步：连接验证与机制说明

1. **按需激活（重要）**：Mihomo 的 `type: tailscale` 出站通常在**第一次有流量命中 Tailscale 规则时才会发起登录连接**。刚启用代理、尚未访问 `https://<机器名>.<tailnet>.ts.net` 前，Tailscale 后台 **Machines** 列表看不到设备上线属正常现象；先用手机浏览器打开一次你的 `https://*.ts.net` 地址或扫描 DSH 二维码即可触发上线并核对主机指纹配对。
2. **仅支持出站方向**：内置 `type: tailscale` 只提供手机主动向外连接 Tailnet 内主机（访问电脑上的 DSH 完全正常），不支持从其他设备反连这台手机或向其发送 Taildrop 文件。
3. **重名冲突排查**：Mihomo 要求 `proxies` 与 `proxy-groups` 名字全局唯一；若你的订阅里已经存在名为 `TAILSCALE` 或 `Tailscale` 的节点/分组，改掉脚本里的 `nodeName` / `groupName` 即可。

---

## 常见排查（电脑侧与代理侧）

- **`tailscale funnel` 提示未启用 / 无权限**：检查后台 DNS 是否同时开启了 **MagicDNS** 与 **HTTPS Certificates**，并检查 Access Controls ACL 的 `nodeAttrs` 是否已配置 `allowFunnel: true`。
- **电脑端 `serve` 模式下「检测连通性」失败**：若电脑或 DSH 本身走了系统 HTTP 代理且代理未绕过 `*.ts.net`，请把 `*.ts.net` 加入代理绕过列表（Bypass），或改用 `tailscale funnel`。
- **WebSocket 连接**：`tailscale serve`、`tailscale funnel` 及 Mihomo `type: tailscale` 均支持 WebSocket 转发。

## 安全说明

- `tailscale serve` 配合私密入口只允许登录你本人 Tailnet 的设备接入；`tailscale funnel` 会暴露公网 HTTPS 入口，依赖 `dsh-carry` 的双端主机指纹确认与 `Secure` 设备 Cookie 鉴权，只批准你自己的设备并随时在「已授权设备」撤销。
- 经公网中继或 Funnel 转发时，TLS 在边缘或本机代理层终止；请勿把含有效 Auth Key 的配置或备份分享给他人。
