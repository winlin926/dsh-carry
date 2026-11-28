<p>
  简体中文 · <a href="public-access-caddy.en.md">English</a>
</p>

# 用 Caddy + VPS 让手机从公网连接电脑

如果你有一台带公网 IP 的云服务器（VPS）和一个域名（A/AAAA 记录指向该 VPS，防火墙放行 TCP `80` 和 `443` 端口），可以用 **Caddy v2** 自动申请并续期正式 HTTPS 证书，然后通过以下两种方式接入本机 DSH：

| 方案 | 原理 | 电脑端是否需要另开隧道客户端 | 适用场景 |
| --- | --- | --- | --- |
| **方案 A（推荐）：`Caddy + remote-server`** | Docker Compose 一键跑起中继，电脑上的 `dsh-carry` 直接主动连出到 VPS | **不需要** | 一台节点可复用多台电脑，开箱即用 |
| **方案 B：纯 Caddy 反向代理网关** | 在 VPS 上用 `Caddyfile` 反代，经 `SSH -R` / WireGuard / 自建 `frp` 连回本机 `43128` | 需要自备一条通道 | 已有现成 WireGuard / SSH 隧道或内网穿透 |

> **不需要在 DSH 里点击「申请证书」：** 两种方案的 HTTPS 证书都由 VPS 上的 Caddy 托管，插件端不需要申请或部署证书文件。

---

## 方案 A：使用仓库内置 `remote-server + Caddy`（推荐）

仓库已包含 `remote-server/compose.yaml` 与 `remote-server/Caddyfile`，执行 `docker compose up -d --build` 即可同时启动 HTTPS 反代与反向隧道中继，本机无需再维护 `ssh`、`frpc` 或 WireGuard，也支持多台电脑共用同一节点。

完整步骤请参阅：[**自托管公网中继节点教程（`self-host.md`）**](self-host.md)。

---

## 方案 B：纯 Caddy 反向代理（搭配 `SSH -R` / WireGuard / `frp`）

如果你希望流量只经过一条简短的反代链路而不走 `remote-server`，可以先把本机的 `127.0.0.1:43128` 映射到 VPS，再由 Caddy 暴露到公网 HTTPS。

### 1. 打通 VPS 到本机 `43128` 的通道（任选一种）

- **方式 1：SSH 反向端口转发**（最轻，VPS 无需开额外公网端口）：
  ```sh
  ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:43128:127.0.0.1:43128 <user>@<你的VPS-IP>
  ```
  *（也可配合 `autossh` 做断线重连；`43128` 是 `dsh-carry` 网关端口，不要填 DSH 本体端口 `52728`。）*
- **方式 2：WireGuard / Tailscale 组网**：把 Caddy 上游指向 `<电脑在虚拟局域网的IP>:43128`。
- **方式 3：自建 `frp`**：用一条 TCP 或 HTTP 代理把本机 `127.0.0.1:43128` 映射到 VPS 本地回环端口（如 `127.0.0.1:43128`）。

### 2. 在 VPS 配置 `Caddyfile`

按 [Caddy 官方文档](https://caddyserver.com/docs/)，在 `/etc/caddy/Caddyfile` 写入（把 `dsh.example.com` 换成你的域名，把上游换成实际映射地址）：

```caddyfile
{
    email admin@example.com
}

dsh.example.com {
    reverse_proxy 127.0.0.1:43128 {
        flush_interval -1
    }
}
```

几点说明：
- **自动 HTTPS**：DNS 解析指向 VPS 且 `80`/`443` 可达时，Caddy 会自动申请与续期 Let's Encrypt / ZeroSSL 证书并把 HTTP 自动跳转到 HTTPS。
- **WebSocket 原生转发**：Caddy v2 的 `reverse_proxy` 默认支持 WebSocket 升级（无需额外手写 `Upgrade`/`Connection` 头）。
- **流式输出不缓冲（SSE）**：Caddy 默认对 `text/event-stream` 禁用缓冲；显式加上 `flush_interval -1` 可确保模型流式响应第一时间到达手机。注意如果你自行添加了 `encode gzip zstd`，请同时排除 SSE 流以免被缓冲，或者干脆不加全局 `encode`（插件自身已对文本资源与 WebSocket 做压缩）。
- **保持原始 `Host` 头**：上例指向 `http://` 上游（`127.0.0.1:43128`）时，Caddy 默认原样透传客户端请求的 `Host: dsh.example.com`，`dsh-carry` 正是依据它校验来访域名是否受信任。**不要**把 `Host` 改写成 `127.0.0.1:43128`。

重载 Caddy 使配置生效：

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 3. 在 DSH 插件内配置并配对

1. 在电脑端 DSH 打开「远程控制 → 连接设置」，开启连接并切换到公网模式（或在「公网节点」添加节点并设为当前）。
2. 在「固定公网域名」填入 `https://dsh.example.com`（只填 origin，不带路径），点击「保存」。
3. 点击「检测连通性」，确认 `https://dsh.example.com/.well-known/dsh-remote` 返回正确的主机指纹。
4. 手机用蜂窝网络扫码，核对两边显示的**主机指纹**一致后在电脑点击「允许连接」。

## 安全说明

- 已配对手机拥有接近本机操作 DSH 的权限，请只批准你自己的设备，并在不使用时在「已授权设备」中撤销。
- Caddy 在 VPS 上终止 TLS 后以明文 HTTP/WebSocket 与上游通信（若使用 `SSH -R` / WireGuard，这段内网通道本身也是加密的）；本插件不在中继之上提供端到端加密。
