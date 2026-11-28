<p>
  简体中文 · <a href="public-access-cloudflare.en.md">English</a>
</p>

# 用 Cloudflare Tunnel 让手机从公网连接电脑

即使家里宽带没有公网 IPv4（处于运营商 CGNAT 内网），或电脑所在网络不允许在路由器开放端口，也可以用 **Cloudflare Tunnel（`cloudflared`）** 从本机主动向 Cloudflare 边缘建立出站长连接，把公网 HTTPS/WSS 请求安全回传到本机的 `127.0.0.1:43128`：

```text
手机浏览器 ──HTTPS/WSS──▶ Cloudflare 边缘 ──Tunnel (QUIC/HTTP2:7844)──▶ 本机 cloudflared ──HTTP──▶ 127.0.0.1:43128
```

> **不要使用 `*.trycloudflare.com` 临时隧道（Quick Tunnel）：** 临时隧道每次重启都会更换随机域名；同时 `dsh-carry` 会在启动时主动清理并拒绝绑定在 `.trycloudflare.com` 和 `.lhr.life` 上的设备授权。请使用绑定自己固定域名的 **Named Tunnel**。
>
> **不需要点击「申请证书」：** Cloudflare 边缘网络自动提供正式 HTTPS 证书，并以 HTTP 回源到本机 `127.0.0.1:43128`。在 DSH 里只需保存域名并点击「检测连通性」。

## 前置准备

- 一个将权威 DNS 托管在 Cloudflare 的域名（例如子域名 `dsh.example.com`）。
- 在运行 DSH 的电脑上安装 [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)（Windows 可运行 `winget install Cloudflare.cloudflared`，macOS 可运行 `brew install cloudflared`，Debian/Ubuntu 可从官方 Release 下载安装并用 `cloudflared --version` 验证）。

## 第一步：创建并运行 Named Tunnel

### 方式 A：Zero Trust 控制台 + Token（最省心，适合后台常驻）

1. 登录 [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Connectors（或 Tunnels）→ Create a tunnel**，选择 **Cloudflared** 并命名（如 `dsh-carry`）。
2. 复制页面给出的 Token 安装命令，在电脑终端注册为后台系统服务：
   - **Windows（管理员终端）**：`cloudflared.exe service install <你的Token>`
   - **Linux**：`sudo cloudflared service install <你的Token>`
   *(之后服务会自动开机运行，不需要在本机维护 `config.yml`。)*
3. 回到控制台为该隧道添加 **Published application route（Public Hostname）**：
   - **Domain / Subdomain**：`dsh` + `example.com`（对应 `https://dsh.example.com`）
   - **Service Type**：`HTTP`
   - **URL**：`127.0.0.1:43128`（**务必填 `dsh-carry` 网关端口 `43128`，不要填 DSH 本体端口 `52728`**）
4. 保存后 Cloudflare 会自动生成对应的 CNAME DNS 记录并即时下发路由生效。

### 方式 B：命令行 + 本地配置文件 `config.yml`

适合习惯把配置留在本地文件管理的用户：

1. 登录授权并创建隧道：
   ```sh
   cloudflared tunnel login
   cloudflared tunnel create dsh-carry
   ```
   记住命令输出中的 `<TUNNEL-UUID>` 与凭证 JSON 路径。
2. 绑定域名 DNS 记录：
   ```sh
   cloudflared tunnel route dns dsh-carry dsh.example.com
   ```
3. 编辑配置文件（Linux 默认 `/etc/cloudflared/config.yml` 或 `~/.cloudflared/config.yml`，Windows 为 `C:\Users\<用户名>\.cloudflared\config.yml`）：

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: <凭证路径>/<TUNNEL-UUID>.json
# 若所在网络对 UDP 7844 有限制导致 QUIC 连不上，可取消下面这行注释强制改走 TCP HTTP/2：
# protocol: http2

originRequest:
  connectTimeout: 30s
  keepAliveTimeout: 90s

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:43128
  - service: http_status:404   # 兜底规则，必须放在最后
```

4. 校验并运行（保持默认的 `Host` 头透传，**不要**改写为 `127.0.0.1:43128`）：
   ```sh
   cloudflared tunnel ingress validate
   cloudflared tunnel run dsh-carry
   ```
   确认稳定后也可以用 `cloudflared service install`（Linux 需加 `sudo`）注册成系统服务。

## 第二步：在 DSH 插件内配置并配对

1. 在电脑端 DSH 打开「远程控制 → 连接设置 → 公网连接」，开启连接。
2. 在「固定公网域名」填入 `https://dsh.example.com`（只填 origin，不带末尾斜杠或路径），点击「保存」。
3. 点击「检测连通性」。插件会探测 `https://dsh.example.com/.well-known/dsh-remote` 并核对返回的电脑指纹。
4. 手机关闭 Wi‑Fi（使用蜂窝网络）扫描面板二维码，先确认电脑与手机两边显示的**主机指纹**完全一致，再在电脑点击「允许连接」。

## 常见排查（含受限网络与连接错误）

- **怎么确认 `cloudflared` 真的连上了**：
  日志中必须出现 `Registered tunnel connection` 才算连接成功（只看到 `Starting metrics server` 不算连上）。可用 `cloudflared tunnel info dsh-carry` 查看活跃连接，或外网执行 `curl -I https://dsh.example.com/.well-known/dsh-remote` 确认能收到 `200` 响应。
- **UDP 7844 被拦截 / QUIC 握手超时**：
  `cloudflared` 默认优先走 **UDP 7844（QUIC）** 连 Cloudflare 边缘。如果校园网、公司内网或运营商限制了 UDP，会导致长期卡在重试；改用 **TCP 7844（HTTP/2）** 往往立刻恢复：
  - 命令行加参数：`cloudflared tunnel --protocol http2 run dsh-carry`
  - 或在 `config.yml` 顶层加上 `protocol: http2`（若已安装为系统服务，需在服务启动参数里加上 `--protocol http2`）。
- **访问返回 `1033`（Argo Tunnel error）或 `404`**：
  `1033` 通常说明 `cloudflared` 进程未连上 Cloudflare 或路线还未保存；`404` / `403` 多半是转发错了端口，或隧道配置中用 `httpHostHeader` 篡改了原本应为 `dsh.example.com` 的 `Host` 请求头。
- **WAF / Cloudflare Access 拦截问题**：
  - Cloudflare 默认支持 WebSocket 与 SSE，但如果开启了严格 WAF 或人机质询（Managed/JS Challenge），会造成 WebSocket 握手失败（`403`）。可在 Cloudflare Rules 中为 `dsh.example.com` 跳过交互式质询。
  - **不要直接在域名最外层套需登录跳转（`302`）的 Cloudflare Access**：`dsh-carry` 探测 `/.well-known/dsh-remote` 时禁止任何 `3xx` 重定向（会判定配置无效），且网关自身已有双端主机指纹确认与绑定 `Secure; HttpOnly; SameSite=Strict` 的设备 Cookie。
- **约 100 秒空闲断开限制**：
  Cloudflare 代理层对连续约 100 秒无任何双向数据流量的空闲连接会主动断开（应用恢复活动时会自动重连）。另因流量须经 Cloudflare 边缘中转，端到端延迟取决于本机到就近 Cloudflare 节点以及手机到边缘节点的链路质量。

## 安全说明

- 隧道本身是公网入口而非免认证边界，好在 `dsh-carry` 未配对时只展示验证页，**切勿把 `service` 错指到 DSH 本体端口 `52728`**；仅批准你本人控制的手机设备，不用时在「已授权设备」列表中撤销。
- Cloudflare 边缘会终止并重加密 TLS 流量，本插件不在其上额外提供端到端加密；请妥善保管 Cloudflare 账号与隧道 Token/凭证文件。
