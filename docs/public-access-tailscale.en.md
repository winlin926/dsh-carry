<p>
  <a href="public-access-tailscale.md">简体中文</a> · English
</p>

# Connecting via Tailscale (`serve`, `funnel`, & Clash/Mihomo)

If you prefer not to buy a domain or rent a VPS, **Tailscale** (v1.52+) provides a stable `https://<machine>.<your-tailnet>.ts.net` hostname with automatic HTTPS certificates.

`dsh-carry` works with two Tailscale exposure modes:

| Mode | Command on Desktop | Phone Connection | Who can reach the URL? |
| --- | --- | --- | --- |
| **`tailscale serve` (Private, recommended)** | `tailscale serve --bg http://127.0.0.1:43128` | Tailscale app on phone, **or embedded via FlClash / Clash / OpenClash** | Strictly private to devices on your tailnet (never exposed publicly) |
| **`tailscale funnel` (Zero phone app)** | `tailscale funnel --bg http://127.0.0.1:43128` | **Any phone browser** | Public HTTPS via Tailscale edge (works alongside phone VPN proxies with no conflict) |

> **Do not click "Request certificate" in DSH.** Tailscale automatically provisions and renews Let's Encrypt TLS certificates for your `*.ts.net` domain and proxies requests to `http://127.0.0.1:43128`.

---

## 1. Desktop Setup

### Prerequisites

1. Install and sign in to [Tailscale](https://tailscale.com/download) (v1.52+) on the computer running DSH (run commands with `sudo` on Linux/macOS, or an Administrator terminal on Windows).
2. Open [Tailscale Admin Console → DNS](https://login.tailscale.com/admin/dns):
   - Enable **MagicDNS**
   - Enable **HTTPS Certificates**
3. **Only required for `tailscale funnel`** (skip for `serve`): Tailscale blocks Funnel in ACLs by default. Add a `nodeAttrs` rule under **Access Controls** allowing Funnel for your user or tag:

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

### Start Forwarding to Gateway Port `43128`

Pick either private (`serve`) or public (`funnel`), pointing to `dsh-carry`'s gateway port `43128` (**not** DSH's UI port `52728`):

- **Private tailnet access (`serve`)**:
  ```sh
  tailscale serve --bg http://127.0.0.1:43128
  tailscale serve status
  ```
- **Public HTTPS access (`funnel`)**:
  ```sh
  tailscale funnel --bg http://127.0.0.1:43128
  tailscale funnel status
  ```

Status output shows your URL, e.g. `https://my-desktop.tail12345.ts.net`. Stop later with `tailscale serve off` or `tailscale funnel off`.

### Configure DSH

1. On your computer, open DSH → **Remote Control → Connection settings → Public connection**, and enable remote access.
2. Enter your exact `https://<machine>.<your-tailnet>.ts.net` origin (no trailing slash or path) and save.
3. Click **Check connectivity** to verify `GET <origin>/.well-known/dsh-remote` returns your computer's fingerprint.

---

## 2. Phone Access & Solving Clash / FlClash Android VPN Conflicts

- **If using `tailscale funnel`**: No Tailscale app is needed on your phone. Even if you run **FlClash / Clash** continuously, it will **not** fight over the Android VPN slot. Add `DOMAIN-SUFFIX,ts.net,DIRECT` if you want phone traffic to bypass proxy nodes and connect directly to Tailscale's edge.
- **If using private `tailscale serve` while keeping FlClash / Clash running on Android**:
  Android allows only **one** app at a time to hold the system VPN slot, so running FlClash alongside the official Tailscale app disconnects one or the other. Three clean ways to coexist:
  - **Desktop / Router (OpenClash)**: On desktop clients, exclude `100.64.0.0/10`; on an **OpenClash** router (running Mihomo ≥ `v1.19.25`), add the Mihomo `type: tailscale` outbound config below so every LAN device reaches your tailnet automatically.
  - **Android Single-VPN Solution (Mihomo `type: tailscale` outbound)**: **Mihomo v1.19.25+** embeds Tailscale (`tsnet`) directly as a proxy outbound (`FlClash >= 0.8.93`, recommend `0.8.94+`, Clash Verge, etc.). Your phone joins your tailnet *inside* FlClash without running the official Tailscale app.
  - **Android Work Profile (Zero config changes)**: If you prefer keeping both official apps untouched—or need other tailnet hosts to initiate inbound connections / Taildrop back to the phone—place one of the apps inside an Android Work Profile (e.g., Shelter) so each holds its own VPN slot.

---

## 3. Embedded Tailscale Outbound in FlClash / Mihomo / OpenClash

> **Version requirements:** **mihomo ≥ `v1.19.25`**. For **FlClash**, use **≥ `0.8.93`** (if `0.8.93` hits `NeedsLogin` or `Rebind IPv4` issues on Android, upgrade to **`0.8.94` or later**).

### Step 1: Generate a Tailscale Auth Key

Open [Tailscale Admin Console → Settings → Keys](https://login.tailscale.com/admin/settings/keys) → **Generate auth key**:

| Setting | Recommendation | Why |
| --- | --- | --- |
| **Reusable** | **Recommended: OFF** | A one-time key becomes invalid immediately after initial login, minimizing risk if your config or backup leaks. If you enable it, revoke the key in the console right after logging in. |
| **Ephemeral** | **OFF** | Prevents the node from being removed whenever the client disconnects. |
| **Pre-approved** | Check if device approval is enabled | Avoids getting stuck pending approval; if checked, strongly prefer a one-time key or revoke promptly after login. |

Copy the `tskey-auth-...` string (shown once). After the client appears online in **Machines**, open `⋯ → Disable key expiry` so it stays logged in without periodic re-authentication.

> **Security note:** Never share screenshots or backups containing an active plaintext `auth-key`.

### Step 2: YAML Config (Clash Verge / OpenClash / Mihomo)

Add the `type: tailscale` proxy, `dns.nameserver-policy` (so private `tailscale serve` `*.ts.net` names resolve via Tailscale MagicDNS rather than failing on public DNS with `NXDOMAIN`), and top-priority routing rules:

```yaml
proxies:
  - name: TAILSCALE
    type: tailscale
    hostname: mihomo-client
    auth-key: tskey-auth-xxxxxxxxxxxxxxxx
    control-url: https://controlplane.tailscale.com
    state-dir: ./tailscale # On OpenClash/Linux, point to a persistent writable dir e.g. /etc/openclash/tailscale
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
  # Resolve *.ts.net via the embedded Tailscale outbound's MagicDNS resolver
  nameserver-policy:
    "+.ts.net": ts://TAILSCALE

rules:
  # Place before subscription rules so tailnet traffic is never hijacked
  - IP-CIDR,100.64.0.0/10,Tailscale,no-resolve
  - IP-CIDR,100.100.100.100/32,Tailscale,no-resolve
  - DOMAIN-SUFFIX,ts.net,Tailscale
  # Keep private LAN ranges direct
  - IP-CIDR,192.168.0.0/16,DIRECT,no-resolve
  - IP-CIDR,10.0.0.0/8,DIRECT,no-resolve
  - IP-CIDR,172.16.0.0/12,DIRECT,no-resolve
```

### Step 3: FlClash Script Override (Survives Subscription Updates)

Manual edits to a downloaded YAML subscription are wiped on every refresh. Use FlClash's **Script Override** instead:

1. In FlClash, go to **Tools → Advanced → Script Override → New Script** and paste:

```javascript
function main(config) {
  config["proxies"] = config["proxies"] || [];
  config["proxy-groups"] = config["proxy-groups"] || [];
  config["rules"] = config["rules"] || [];

  // Rename these if your subscription already defines TAILSCALE or Tailscale
  const nodeName = "TAILSCALE";
  const groupName = "Tailscale";

  config["proxies"].push({
    name: nodeName,
    type: "tailscale",
    hostname: "flclash-android",
    "auth-key": "tskey-auth-YOUR-KEY-HERE",
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

  // Route *.ts.net DNS queries through embedded MagicDNS for private `tailscale serve`
  config["dns"] = config["dns"] || {};
  config["dns"]["nameserver-policy"] = config["dns"]["nameserver-policy"] || {};
  if (!config["dns"]["nameserver-policy"]["+.ts.net"]) {
    config["dns"]["nameserver-policy"]["+.ts.net"] = `ts://${nodeName}`;
  }

  config["rules"] = [
    `IP-CIDR,100.64.0.0/10,${groupName},no-resolve`,
    `IP-CIDR,100.100.100.100/32,${groupName},no-resolve`,
    `DOMAIN-SUFFIX,ts.net,${groupName}`,
    ...config["rules"],
  ];

  return config;
}
```

2. **Attach the script to your profile (easy to miss):** Just saving a script does nothing. Open **Profiles → `⋮` on your active profile → More → Override → Override Mode = Script**, select your script, and leave the page to reload config. Check **Preview** to confirm `type: tailscale` is present and `Tailscale` appears under Proxies.

### Step 4: Verify & Important Behavior

1. **On-demand login:** Mihomo connects its `type: tailscale` node **only when traffic actually hits a matching Tailscale rule**. Not seeing `flclash-android` in Tailscale **Machines** before you open `https://<machine>.<tailnet>.ts.net` (or scan the pairing QR) is normal—make one test request first.
2. **Outbound only:** Embedded `type: tailscale` lets your phone reach desktop DSH and tailnet hosts cleanly, without allowing inbound connections (like Taildrop or SSH *into* the phone). Use an Android Work Profile if you need two-way incoming connections.
3. **Unique proxy/group names:** Mihomo requires globally unique names across `proxies` and `proxy-groups`; rename `nodeName`/`groupName` if your subscription already uses them.

---

## Troubleshooting

- **"Funnel is disabled by your network administrator"**: Verify **MagicDNS**, **HTTPS Certificates**, and the `tailscale.com/cap/funnel` ACL `nodeAttrs` rule are enabled in your Tailscale admin console.
- **"Check connectivity" fails with `tailscale serve`**: `dsh-carry` probes `https://<machine>.<your-tailnet>.ts.net` from the desktop itself. If DSH uses an outbound HTTP proxy, add `*.ts.net` to your proxy bypass list or switch to `tailscale funnel`.
- **WebSockets**: Supported out of the box across `tailscale serve`, `tailscale funnel`, and Mihomo `type: tailscale`.

## Security Boundary

- `tailscale serve` limits access strictly to devices authenticated on your tailnet. `tailscale funnel` exposes an internet-reachable HTTPS URL protected by `dsh-carry` host-fingerprint pairing and `Secure` device cookies—approve only your own devices and revoke unused ones under **Authorized devices**.
- Keep auth keys secret and revoke reusable keys once enrolled.
