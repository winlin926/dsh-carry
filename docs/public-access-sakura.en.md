<p>
  <a href="public-access-sakura.md">简体中文</a> · English
</p>

# Connecting via SakuraFrp (Mainland China FRP)

> **Regional note:** [SakuraFrp (`natfrp.com`)](https://natfrp.com/) is a mainland China FRP service that requires a local account and RMB real-name verification. If you are outside mainland China, [Cloudflare Tunnel](public-access-cloudflare.en.md), [Tailscale](public-access-tailscale.en.md), or [Caddy on a VPS](public-access-caddy.en.md) are usually much easier.

This walkthrough covers Windows + `dsh-carry` + SakuraFrp from scratch without a VPS. You can adapt the same approach to any FRP provider that supports custom domains, HTTP + HTTPS tunnels, and local TLS certificates—the goal is forwarding both HTTP (`80`) and HTTPS (`443`) to `127.0.0.1:43128` on your computer.

> **Not sponsored:** SakuraFrp is simply a setup the author used directly; this project has no sponsorship or commercial relationship with SakuraFrp, domain registrars, or Cloudflare.

## Prerequisites

- A Windows computer running DSH with `dsh-carry` installed.
- A domain whose DNS records you control.
- A SakuraFrp account supporting custom domains with both HTTP and HTTPS tunnels (at least 2 available tunnels) and its Windows launcher.
- A phone on cellular data (off Wi‑Fi) for initial certificate testing and verification.

*(Check renewal prices, TLD restrictions, and mainland ICP filing requirements if picking mainland nodes.)*

## Step 1: Prepare Your Domain & DNS

Register a domain (or reuse an existing one—e.g. subdomain `dsh2.yourdomain.com`) and pick a DNS host (such as Cloudflare DNS or your registrar's DNS).

## Step 2: Create Two Tunnels in SakuraFrp

1. Sign in at [SakuraFrp](https://natfrp.com/) and complete verification, ensuring your account allows at least **2 tunnels**.
2. Download the Windows SakuraFrp launcher and bind your console access key (keep your key private).
3. Create **Tunnel 1**: type **HTTPS (Auto HTTPS)**, node supporting custom domains, local IP `127.0.0.1`, local port **`43128`**, custom domain `dsh2.yourdomain.com`.
4. Create **Tunnel 2**: type **HTTP**, using the same node, local IP `127.0.0.1`, local port **`43128`**, and custom domain `dsh2.yourdomain.com`. *(You need one HTTP tunnel and one HTTPS tunnel—not two HTTPS tunnels.)*
5. Start both tunnels in the Windows launcher and enable auto-start.

> **Check the port:** `43128` is `dsh-carry`'s public gateway port. Do **not** point tunnels to DSH's own UI port (`52728`).

*(Seeing "target connection failed" before turning on Remote Control in DSH is expected.)*

## Step 3: Add DNS Record

In your DNS provider, create a `CNAME` record for `dsh2.yourdomain.com` pointing to the node domain assigned in the SakuraFrp console:

- **Type**: `CNAME`
- **Name**: `dsh2`
- **Target**: `<assigned-frp-domain>`
- **Proxy (if using Cloudflare DNS)**: **DNS only (grey cloud)** — do not enable the orange proxy cloud here, or HTTP-01 challenge validation and FRP routing may break.

## Step 4: Set the Domain and Request Certificate in DSH

1. Turn on **Remote Control** in DSH on your computer.
2. Under **Connection settings → Public connection → Fixed public domain**, enter `https://dsh2.yourdomain.com` (no path) and click **Save**.
3. Click **Check connectivity** to verify both tunnels and DNS reach `127.0.0.1:43128`.
4. Once reachable, expand **Local HTTPS certificate** and click **Request certificate**. `dsh-carry` obtains a Let's Encrypt certificate via HTTP-01 challenge through the HTTP tunnel and writes it to `C:\ProgramData\SakuraFrpService\FrpcWorkingDirectory` by default.
5. When prompted that the certificate has been deployed, **reload the HTTPS tunnel** in the SakuraFrp launcher so `frpc` loads the new certificate.

## Step 5: Verify From Your Phone

1. Click **Check connectivity** again in DSH and verify it passes.
2. Switch **Remote Control** to **Public first** (or Public mode).
3. Turn off Wi‑Fi on your phone, scan the QR code over cellular data, match the **host fingerprint** shown on both screens, and click **Allow connection** on your computer.
4. Keep an eye on renewals: `dsh-carry` handles renewal requests, and when it prompts to reload, reload the HTTPS tunnel in the SakuraFrp launcher.

## Security & Cost Boundary

- A paired browser has near-local control of DSH; approve only devices you trust and revoke devices anytime under **Authorized devices**.
- Because the FRP node terminates TLS and forwards traffic, FRP operators can inspect forwarded requests; this plugin does not add end-to-end encryption above TLS. Use providers you control or trust. Domain and FRP fees/quotas are set by each provider.
