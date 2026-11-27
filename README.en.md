<img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/logo.png" width="112" height="112" alt="dsh-carry" />
<h1>dsh-carry</h1>
<p><strong>Pick up your DSH session on your phone.</strong></p>
<p>
  <img src="https://img.shields.io/static/v1?label=DSH&message=Plugin&color=8B4A38" height="20" alt="DSH | Plugin" />
  <a href="https://github.com/winlin926/dsh-carry/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/winlin926/dsh-carry/ci.yml?branch=main&label=build" height="20" alt="build" /></a>
  <a href="https://www.npmjs.com/package/@winlin926/dsh-carry"><img src="https://img.shields.io/npm/v/@winlin926/dsh-carry?label=npm" height="20" alt="npm" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/package.json"><img src="https://img.shields.io/node/v/@winlin926/dsh-carry?label=node" height="20" alt="node" /></a>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/LICENSE"><img src="https://img.shields.io/github/license/winlin926/dsh-carry?label=license" height="20" alt="license" /></a>
</p>
<p>
  <a href="https://github.com/winlin926/dsh-carry/blob/main/README.md">简体中文</a> · English
</p>

`dsh-carry` is a remote-control plugin for DeepSeek Harness (DSH) that lets you reach your running DSH instance from a phone browser. After a one-time QR scan pairing, you can continue conversations, approve tool calls, download workspace files, and preview HTML outputs—everything served directly by your host computer.

<details>
<summary><strong>Show the phone recording (26-second GIF): answer a question card, watch a tool run, open an HTML preview</strong></summary>

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/demo.gif" width="320" alt="Screen recording: answering a question card, watching a tool run, and opening an HTML preview on a phone" /></p>

</details>

## 📦 Install and pair your phone

> Requirements: Node.js `>= 24.9.0` and DSH `>= 0.2.2-rc.1` (`< 0.3.0`).

Install the plugin on the computer you want to reach:

- **DSH Desktop**: Open **Plugins → Add plugin** and search for `@winlin926/dsh-carry`.
- **DSH CLI / `dsh web`**: Run the command below (replace `default` with your profile name if different—common values are `default` or `web`; check your DSH config), then restart or reload DSH:

```sh
dsh plugin --profile default add @winlin926/dsh-carry@latest
```

Pair in three steps:

1. Open **Remote Control** in the DSH sidebar on your computer and click **Enable Remote Control**. **For your first pairing, make sure your phone and computer are on the same Wi‑Fi network.**
2. Scan the QR code on the panel with your phone, confirm the device name on the desktop prompt, and click **Allow connection**.
3. Resume any existing session in your phone browser; you can rename or revoke paired devices at any time under **Authorized devices** on your computer.

Need access outside your local network? See [Connecting from another network](#-connecting-from-another-network).

<details>
<summary><strong>Show the plugin panel</strong></summary>

<p align="center"><img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/desktop-connect.png" width="720" alt="Remote Control panel on the computer with a pairing QR code and a list of authorized devices" /></p>

</details>

## 📱 What you can do from your phone

<table align="center">
  <tr><th>When…</th><th>On your phone</th></tr>
  <tr><td>A long task is still running after you step away</td><td>Open the same session, follow streaming replies, and send follow-ups.</td></tr>
  <tr><td>A tool call is waiting for confirmation</td><td>Inspect the request in the synced host UI and approve or decline it.</td></tr>
  <tr><td>You want to review generated files or pages</td><td>Download workspace files directly or preview HTML outputs in the browser.</td></tr>
  <tr><td>Both public and LAN routes are configured</td><td>Establish a background LAN WebRTC channel automatically and fail over without re-scanning.</td></tr>
</table>

<details>
<summary><strong>Show phone screenshots (6 images)</strong></summary>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-boot.png" width="45%" alt="Boot screen preview with a theme selector while DSH checks plugins" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-session.jpg" width="45%" alt="A new DSH session in the phone browser" />
</p>
<p align="center">Boot screen preview · New session</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-chat.jpg" width="45%" alt="An existing conversation with its message input on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-tools.jpg" width="45%" alt="Workspace tools on the phone" />
</p>
<p align="center">Ongoing conversation · Workspace tools</p>

<p align="center">
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-html-preview.jpg" width="45%" alt="A workspace HTML preview on the phone" />
  <img src="https://raw.githubusercontent.com/winlin926/dsh-carry/main/assets/mobile-settings.png" width="45%" alt="DSH general settings on the phone" />
</p>
<p align="center">HTML preview · Settings</p>

</details>

## 🌐 Connecting from another network

Follow the [SakuraFrp public-access walkthrough (Chinese)](docs/public-access-sakura.md) for an end-to-end tunnel setup, or deploy the bundled [`remote-server`](docs/self-host.md) relay on your own server (no inbound firewall ports required on your desktop).

- **Unified QR entry**: With a fixed-domain HTTPS tunnel gateway or a self-hosted relay node configured, one QR code serves both LAN and public entries—defaulting to **LAN first** (switchable to **Public first** in settings).
- **Dual-route failover**: Even when you open DSH via your public domain on the same Wi‑Fi, the client brings up a direct LAN WebRTC channel and falls back smoothly if the public route drops, without asking you to scan again. When leaving the LAN, open the public URL shown in the panel.
- **Host fingerprint verification**: During first-time public pairing, both your phone and computer display the host fingerprint so you can verify you are connecting to your own machine.

> **🔒 Security boundary: approve only devices you trust.**
>
> - A paired phone has privileges close to local access.
> - Public relay nodes and tunnel providers terminate TLS and can inspect forwarded traffic.
> - This plugin does not add end-to-end encryption on top of the relay, and the maintainers operate no public servers.
> - Only connect through nodes you host yourself or explicitly trust.

More guides: [Self-hosting guide](docs/self-host.md) · [Public node protocol](docs/public-node.md) · [Plugin capabilities and host interfaces](docs/features.md) · [Verification guide](docs/verification.md) · [Release notes](docs/release-notes.md) *(all in Chinese)*

## 📄 Credits and license

Thanks to [copylee711/dsh-remote-control](https://github.com/copylee711/dsh-remote-control) for the early implementation. MIT license; copyright notice in [LICENSE](LICENSE).
