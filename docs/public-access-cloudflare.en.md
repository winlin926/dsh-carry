<p>
  <a href="public-access-cloudflare.md">简体中文</a> · English
</p>

# Connecting via Cloudflare Tunnel

Even behind carrier-grade NAT (CGNAT) with no public IPv4 address or router port forwarding, **Cloudflare Tunnel (`cloudflared`)** lets your computer open an outbound persistent tunnel to Cloudflare's edge and forward HTTPS/WSS requests back to `http://127.0.0.1:43128`:

```text
Phone Browser ──HTTPS/WSS──▶ Cloudflare Edge ──Tunnel (QUIC/HTTP2:7844)──▶ Desktop cloudflared ──HTTP──▶ 127.0.0.1:43128
```

> **Do not use temporary `*.trycloudflare.com` quick tunnels.** Quick tunnel domains change on restart, and `dsh-carry` intentionally rejects and prunes pairings tied to ephemeral `.trycloudflare.com` or `.lhr.life` hostnames. Create a **Named Tunnel** attached to your own domain.
>
> **Do not click "Request certificate" in DSH.** Cloudflare handles TLS automatically at its edge and forwards HTTP to `127.0.0.1:43128`. In DSH, simply save your `https://` origin and click **Check connectivity**.

## Prerequisites

- A domain whose authoritative DNS is managed by Cloudflare (e.g., `dsh.example.com`).
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed on the computer running DSH (`winget install Cloudflare.cloudflared` on Windows, `brew install cloudflared` on macOS, or install the package/binary on Linux and verify `cloudflared --version`).

## Step 1: Create and Run a Named Tunnel

### Option A: Zero Trust Dashboard + Token Service (Recommended)

1. Sign in to [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) → **Networks → Connectors (or Tunnels) → Create a tunnel**, choose **Cloudflared**, and name it (e.g. `dsh-carry`).
2. Copy the service install command containing your tunnel token and run it on your computer so it stays active in the background:
   - **Windows (Administrator terminal)**: `cloudflared.exe service install <YOUR-TUNNEL-TOKEN>`
   - **Linux**: `sudo cloudflared service install <YOUR-TUNNEL-TOKEN>`
   *(Dashboard-managed tunnels require no local `config.yml`.)*
3. Back in the dashboard, add a **Published application route (Public Hostname)**:
   - **Domain / Subdomain**: `dsh` + `example.com` (`https://dsh.example.com`)
   - **Service Type**: `HTTP`
   - **URL**: `127.0.0.1:43128` (**never** DSH's internal UI port `52728`)
4. Save. Cloudflare automatically adds the DNS CNAME record and pushes routing updates to your running connector.

### Option B: Local CLI + `config.yml`

1. Authenticate and create the tunnel:
   ```sh
   cloudflared tunnel login
   cloudflared tunnel create dsh-carry
   ```
   Note the generated `<TUNNEL-UUID>` and credentials JSON path.
2. Bind DNS:
   ```sh
   cloudflared tunnel route dns dsh-carry dsh.example.com
   ```
3. Create `config.yml` (`/etc/cloudflared/config.yml` or `~/.cloudflared/config.yml` on Linux/macOS, `C:\Users\<User>\.cloudflared\config.yml` on Windows):

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /path/to/<TUNNEL-UUID>.json
# Uncomment the next line if outbound UDP port 7844 is blocked on your network:
# protocol: http2

originRequest:
  connectTimeout: 30s
  keepAliveTimeout: 90s

ingress:
  - hostname: dsh.example.com
    service: http://127.0.0.1:43128
  - service: http_status:404   # Catch-all rule required at the end
```

4. Validate and start (keep the default `Host` header unchanged—do **not** rewrite it to `127.0.0.1:43128`):
   ```sh
   cloudflared tunnel ingress validate
   cloudflared tunnel run dsh-carry
   ```
   Optionally run `cloudflared service install` (`sudo` on Linux) once verified.

## Step 2: Configure DSH and Pair Your Phone

1. Open DSH on your computer → **Remote Control → Connection settings → Public connection**, and enable remote access.
2. Enter `https://dsh.example.com` (origin only, no trailing path) and save.
3. Click **Check connectivity**. `dsh-carry` probes `https://dsh.example.com/.well-known/dsh-remote` and confirms the responding host fingerprint matches your computer.
4. Scan the pairing QR code over cellular data (off Wi‑Fi), verify that the **host fingerprint** shown on both screens matches, and click **Allow connection** on your computer.

## Troubleshooting & Network Notes

- **Verify the tunnel is truly connected**:
  Look for `Registered tunnel connection` in `cloudflared` logs (`Starting metrics server` alone does not mean it has connected to Cloudflare's edge). You can also run `cloudflared tunnel info dsh-carry`, or test externally with `curl -I https://dsh.example.com/.well-known/dsh-remote` (expect HTTP `200`).
- **UDP 7844 blocked / QUIC fails to connect**:
  `cloudflared` connects to Cloudflare's edge over **UDP 7844 (QUIC)** by default. On restricted corporate/campus networks or ISPs that drop UDP 7844, force **TCP 7844 (HTTP/2)**:
  - CLI flag: `cloudflared tunnel --protocol http2 run dsh-carry`
  - Or add `protocol: http2` to `config.yml` (if installed as a system service, pass `--protocol http2` in the daemon arguments).
- **Error `1033` (Argo Tunnel error) or `404`/`403`**:
  `1033` means `cloudflared` is offline or the route isn't bound yet. `404`/`403` usually means the wrong local port was configured or `httpHostHeader` overrode the `Host` header (`dsh-carry` checks `Host` against `dsh.example.com`).
- **WAF Challenges & Cloudflare Access caveats**:
  - Cloudflare proxies WebSockets and SSE natively, but Managed/JS WAF Challenges break WebSocket upgrades (`403`). Bypass interactive challenges on `dsh.example.com` if needed.
  - **Avoid putting Cloudflare Access login redirects (`302`) in front of `https://dsh.example.com`:** `dsh-carry` treats any `3xx` redirect on `/.well-known/dsh-remote` as a configuration error, and `dsh-carry` already enforces dual-device host fingerprint confirmation plus `Secure; HttpOnly; SameSite=Strict` cookies before exposing DSH.
- **~100-second edge idle timeout**:
  Cloudflare closes idle proxied connections if no traffic moves for ~100 seconds (clients reconnect automatically when active). Latency reflects the path from desktop to Cloudflare edge and phone to Cloudflare edge.

## Security Boundary

- Never point your tunnel `service` to DSH's unauthenticated internal UI port (`52728`); always point to `http://127.0.0.1:43128`. Approve only phones you own and revoke old devices under **Authorized devices**.
- Cloudflare terminates and re-encrypts TLS at its edge; this plugin does not add end-to-end encryption above TLS. Safeguard your Cloudflare account and tunnel credentials/tokens.
