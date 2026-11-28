<p>
  <a href="public-access-caddy.md">简体中文</a> · English
</p>

# Connecting via Caddy on a VPS

If you have a cloud VPS with a public IP and a domain (`A`/`AAAA` DNS pointing to the VPS, firewall allowing TCP ports `80` and `443`), **Caddy v2** gives you automatic HTTPS certificates with almost zero config. Choose one of the two architectures below:

| Option | How it works | Extra tunnel client needed on desktop? | Best for |
| --- | --- | --- | --- |
| **Option A (Recommended): `Caddy + remote-server`** | Built-in Docker Compose relay + Caddy; your desktop connects outbound over WSS | **No** | Multi-host sharing, clean Compose workflow |
| **Option B: Plain Caddy reverse proxy** | Caddy on the VPS proxies to your computer's port `43128` via `SSH -R`, WireGuard, or self-hosted `frp` | Yes (bring your own tunnel) | Users who already run WireGuard or an SSH tunnel |

> **Do not click "Request certificate" in DSH.** Caddy on your VPS handles all TLS certificates automatically.

---

## Option A: Bundled `remote-server + Caddy` (Recommended)

This repository includes `remote-server/compose.yaml` and `remote-server/Caddyfile`. Running `docker compose up -d --build` deploys both Caddy (automatic HTTPS) and the relay server, so your desktop needs no `ssh` or `frpc` tunnel process.

See the full walkthrough: [**Self-Hosting Guide (`self-host.en.md`)**](self-host.en.md).

---

## Option B: Plain Caddy Reverse Proxy (with `SSH -R` / WireGuard / `frp`)

If you prefer a direct reverse proxy without running `remote-server`, forward your VPS back to your computer's gateway port (`43128`) and let Caddy serve HTTPS in front of it.

### 1. Forward VPS Traffic to Desktop Port `43128`

Pick whichever tunnel you already use (target `43128`, **not** DSH's UI port `52728`):

- **SSH reverse tunnel** (no extra open ports needed on desktop or VPS):
  ```sh
  ssh -NT -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -R 127.0.0.1:43128:127.0.0.1:43128 <user>@<YOUR-VPS-IP>
  ```
  *(Consider `autossh` or a systemd user service to auto-reconnect. The VPS `sshd` must keep `AllowTcpForwarding yes`, the OpenSSH default; otherwise `-R` fails with `administratively prohibited`.)*
- **WireGuard / mesh VPN**: Point Caddy to `http://<desktop-wireguard-ip>:43128`.
- **Self-hosted `frp`**: Forward a VPS loopback port (e.g., `127.0.0.1:43128`) to desktop `127.0.0.1:43128`.

### 2. Configure `Caddyfile` on the VPS

Add to `/etc/caddy/Caddyfile` (replace `dsh.example.com` and the upstream target with yours):

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

Key behaviors in Caddy v2:
- **Automatic HTTPS**: As long as DNS resolves to the VPS and ports `80`/`443` are open, Caddy automatically provisions and renews Let's Encrypt / ZeroSSL certificates and redirects HTTP to HTTPS.
- **Native WebSockets**: `reverse_proxy` proxies WebSocket upgrades out of the box—no manual `Upgrade` header rules needed.
- **Immediate SSE streaming**: Caddy auto-detects `text/event-stream`, and `flush_interval -1` guarantees streaming model responses flush without buffering. If you add `encode gzip zstd`, exclude SSE paths or omit `encode` (the gateway already compresses static text/WS traffic itself).
- **Preserve the `Host` header**: For plain `http://` upstreams (`127.0.0.1:43128`), Caddy passes the original `Host: dsh.example.com` header through by default, which `dsh-carry` checks against your configured public origin. Do **not** override `Host` to `127.0.0.1:43128`.

Validate and reload Caddy:

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

### 3. Configure DSH and Pair Your Phone

1. Open DSH on your computer → **Remote Control → Connection settings → Public connection**, and enable remote access.
2. Enter `https://dsh.example.com` (origin only, no trailing path) and save.
3. Click **Check connectivity** to confirm `GET https://dsh.example.com/.well-known/dsh-remote` returns your computer's fingerprint.
4. Scan the pairing QR code over cellular data (off Wi‑Fi), verify that the **host fingerprint** matches on both devices, and click **Allow connection** on your computer.

## Security Boundary

- A paired browser has near-local access to your DSH sessions and workspace; approve only devices you control and revoke devices anytime under **Authorized devices**.
- Caddy terminates TLS on your VPS before forwarding traffic through your tunnel (`SSH -R` / WireGuard keeps the VPS-to-desktop hop encrypted as well); this plugin does not add end-to-end encryption above TLS.
