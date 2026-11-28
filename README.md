<img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
<h1>dsh-carry</h1>
<p><strong>电脑上的 DSH 会话，拿起手机接着用。</strong></p>
<p>
  <a href="https://awesome-dsh-plugin.com/p/winlin926/dsh-carry/"><img src="https://img.shields.io/static/v1?label=DSH&message=Market&color=8B4A38" height="20" alt="DSH | Market" /></a>
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/winlin926/dsh-carry/ci.yml?branch=main&label=build" height="20" alt="build" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/v/@winlin926/dsh-carry?label=npm" height="20" alt="npm" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/dm/@winlin926/dsh-carry?label=downloads" height="20" alt="downloads" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/package.json"><img src="https://img.shields.io/node/v/@winlin926/dsh-carry?label=node" height="20" alt="node" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/winlin926/dsh-carry?label=license" height="20" alt="license" /></a>
</p>
<p>
  简体中文 · <a href="https://github.com/winlin926/dsh-carry/blob/main/README.en.md">English</a>
</p>

`dsh-carry` 是 DeepSeek Harness（DSH）的远程控制插件，让你用手机浏览器接入电脑上正在运行的 DSH 实例。扫码配对后即可继续会话、审批工具请求、查看工作区文件或预览 HTML 页面——可用的会话、模型与工具完全由电脑端宿主决定，手机只是另一块屏幕。

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/demo.gif" width="320" alt="手机上回复提问卡片、查看工具执行结果并打开工作区 HTML 预览的实机录屏" /></p>
<p align="center"><em>26 秒实机录屏：回答提问卡片 · 查看工具输出 · 打开工作区 HTML 预览</em></p>

## 📦 安装与首次连接

> 运行环境要求：Node.js `>= 24.9.0`，DSH `>= 0.2.2-rc.1`（`< 0.3.0`）。

在需要被远程访问的电脑上安装插件：

- **DSH 桌面版**：打开「插件 → 添加插件」，搜索 `@winlin926/dsh-carry` 安装。
- **DSH CLI / `dsh web`**：运行以下命令安装，安装后重启或重载宿主（将 `default` 替换为你的配置名，常见值为 `default` 或 `web`，可在 DSH 配置中查看）：

```sh
dsh plugin --profile default add @winlin926/dsh-carry@latest
```

首次连接只需三步：

1. 在电脑端 DSH 侧栏打开「远程控制」，点击「开启远程连接」。**首次配对请确保手机与电脑处于同一 Wi‑Fi。**
2. 用手机扫描面板上的二维码，在电脑弹出的确认框核对设备名后点击「允许连接」。
3. 配对完成后即可在手机浏览器中继续已有会话；之后可随时在电脑「已授权设备」列表中重命名或撤销任意设备。

需要在外出或跨网络环境下连接，请参考下方的[公网连接说明](#-离开同一-wi-fi-后怎么连)。

<details>
<summary><strong>查看电脑端面板截图</strong></summary>

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="电脑端远程控制面板，显示配对二维码和已授权设备列表" /></p>

</details>

## 📱 手机上能做什么

<table align="center">
  <tr><th>使用场景</th><th>在手机上的能力</th></tr>
  <tr><td>离开工位，长任务仍在运行</td><td>打开电脑上的会话，实时查看回复并继续发送后续指令。</td></tr>
  <tr><td>工具请求正在等待授权</td><td>直接在宿主同步界面中审查详情并决定是否批准执行。</td></tr>
  <tr><td>需要核对生成产物或网页</td><td>点击工作区文件链接直接下载，或在浏览器中预览 HTML 页面。</td></tr>
  <tr><td>同时配置了公网与局域网</td><td>公网访问且同处局域网时自动建立 WebRTC 直连，主线波动时无感切换、无需重新扫码。</td></tr>
</table>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="31%" alt="手机上的工作区工具与审批入口" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-html-preview.jpg" width="31%" alt="手机上的工作区 HTML 预览" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="31%" alt="手机上已有的对话和消息输入框" />
</p>
<p align="center"><em>工作区工具 · HTML 预览 · 继续对话</em></p>

<details>
<summary><strong>查看更多手机端截图（3 张）</strong></summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" width="31%" alt="启动页预览，顶部可选主题，中央显示插件检查进度" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.jpg" width="31%" alt="手机浏览器中的 DSH 新会话" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="31%" alt="手机上的 DSH 通用设置" />
</p>
<p align="center">启动页预览 · 新会话 · 通用设置</p>

</details>

## 🌐 离开同一 Wi-Fi 后怎么连？

按你的网络与资源条件任选一种即可（电脑无需开放路由器入站端口）：

| 方案 | 特点 | 教程 |
| --- | --- | --- |
| **Cloudflare Tunnel** | 有 Cloudflare 域名即可，免 VPS、边缘自动 HTTPS | [Cloudflare Tunnel 教程](docs/public-access-cloudflare.md) |
| **Tailscale** | 免域名；`serve` 仅本人设备可连，`funnel` 任意浏览器直连 | [Tailscale 教程](docs/public-access-tailscale.md) |
| **Caddy VPS** | 有云服务器即可，Caddy 自动 HTTPS 反代或 Compose 部署 [`remote-server`](docs/self-host.md) | [Caddy VPS 教程](docs/public-access-caddy.md) |
| **SakuraFrp** | 国内无 VPS 方案，支持自定义域名与自动申请证书 | [SakuraFrp 教程](docs/public-access-sakura.md) |

- **单码融合入口**：配置好固定域名隧道网关或自托管节点后，公网与局域网共用同一个二维码，默认「局域网优先」，也可在设置中改选「公网优先」。
- **双线路自动容灾**：同一局域网下即使从公网入口打开，插件也会在后台预建 WebRTC 局域网直连；公网线路中断时自动切换，无需重新扫码。离开局域网时，直接打开面板显示的公网地址即可接入。
- **主机指纹校验**：通过公网首次配对时，手机与电脑会各自显示并核对主机指纹，确认连接到的是你自己的电脑。

> **🔒 安全与信任边界：只批准你信任的设备。**
>
> - 已配对手机拥有接近本机操作 DSH 的权限。
> - 公网中继节点或内网穿透服务会终止 TLS 并转发请求，节点运营者可能看到传输内容。
> - 本插件不提供节点之上的端到端加密，项目方也不托管任何公共节点。
> - 请仅使用自己部署或明确信任的公网节点。

<details>
<summary><strong>常见问题：SSH 隧道与远端 Linux 服务器</strong></summary>

- **支持 SSH 连接吗？** 手机直接用浏览器访问，不需要装 SSH 客户端；若已有 VPS，可用 `ssh -R 127.0.0.1:43128:127.0.0.1:43128` 配合 Caddy 接入（见 [Caddy VPS 教程](docs/public-access-caddy.md)）。
- **能连远程 Linux 服务器上的 DSH 吗？** 直接在那台 Linux 服务器上安装本插件并扫码即可。

</details>

进一步阅读：[自托管部署指南](docs/self-host.md) · [公网节点协议](docs/public-node.md) · [插件能力与宿主接口](docs/features.md) · [测试指南](docs/verification.md) · [发布说明](docs/release-notes.md)

## 📄 致谢与许可

感谢 [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) 的早期实现。本项目以 MIT 协议开源，版权声明见 [LICENSE](LICENSE)。
