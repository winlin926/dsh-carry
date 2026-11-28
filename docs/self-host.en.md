<p>
  <a href="self-host.md">简体中文</a> · English
</p>

# Self-Hosting a Public Relay Node (`remote-server`)

`remote-server/` is a self-hostable public relay node that pairs your phones with your desktop DSH instances and relays encrypted-in-transit HTTP, SSE, and WebSocket traffic across networks without opening any inbound ports on your desktop.

**Trust boundary:** HTTPS/WSS protects traffic between your phone and the relay, and between your computer and the relay. Because the relay terminates TLS to proxy requests, whoever operates the relay server can inspect forwarded payloads. This plugin does not provide end-to-end encryption on top of the relay, and the project maintainers host no public nodes.

**Data handling:** The relay never holds your computer's or phone's private keys, never writes chat messages or tool approvals to disk, and redacts sensitive fields (`token`, `ticket`, `cookie`, `authorization`, `identityKey`, `ciphertext`) in logs.

## 1. Prerequisites

- A Linux VPS with a public IP address (1 vCPU / 1 GiB RAM is plenty).
- A domain name (e.g. `relay.example.com`) with `A`/`AAAA` DNS records pointing to that VPS.
- Firewall rules allowing inbound TCP ports:

| Port | Protocol | Purpose |
| --- | --- | --- |
| `80` | TCP | ACME HTTP-01 certificate validation & HTTPS redirect |
| `443` | TCP | HTTPS & WSS `/v1/tunnel` (reverse tunnel from Host) |

- Docker Engine 24+ and Docker Compose v2.
- **Single-instance deployment:** Live tunnel routing tables stay in memory and storage uses single-writer `node:sqlite`. One `remote-server` container can already serve multiple computers and phones—do not scale `remote-server` to multiple replicas.

## 2. Deployment

```sh
git clone https://github.com/winlin926/dsh-carry.git dsh
cd dsh/remote-server
cp .env.example .env
```

Edit `.env` and set at least:

- `SITE_ADDRESS`: your domain, e.g. `relay.example.com`
- `PUBLIC_ORIGIN`: `https://` + the same domain
- `ACME_EMAIL`: email address for Let's Encrypt certificate notices
- *(Optional)* `NODE_NAME`: friendly display name shown in DSH (defaults to `My Public Node` in `.env.example`)

Start the stack (`remote-server` + `caddy`):

```sh
docker compose up -d --build
docker compose ps
```

Caddy automatically obtains a Let's Encrypt TLS certificate on first start once DNS has propagated and ports `80`/`443` are reachable (usually within a few dozen seconds).

**Open registration safety:** `POST /v1/hosts` requires no shared token. It is protected by per-origin/IP rate limits and two-sided pairing approval—registering a host grants zero access to any other host's sessions or files. Do **not** add a shared secret token in `.env`.

**Node identity:** On first startup, `remote-server` generates an Ed25519 identity and saves only its public key at `/data/node-identity.json` (mode `0600`, inside the `data` volume; private key is discarded immediately). Keep `/data/node-identity.json` intact across upgrades—deleting or overwriting it changes your node fingerprint and forces every desktop that added your node to re-confirm it.

## 3. Health & TLS Verification

Run these three commands from another machine (omit `-k` so `curl` verifies your real Let's Encrypt certificate chain):

```sh
curl -fsS https://relay.example.com/healthz
curl -fsS https://relay.example.com/v1/config
curl -fsS https://relay.example.com/.well-known/dsh-remote
```

- `/healthz` returns `{"ok":true,"version":"..."}`.
- `/.well-known/dsh-remote` returns the v2 discovery document containing `"protocol": 2`, `"kind": "service"`, and `node` (`id`, 32-char lowercase hex `fingerprint`, and base64url `publicKey`).
- `/v1/config` returns the same public metadata without any secrets.

> Repository CI runs HTTP smoke checks inside an isolated local container; always run the three `https://` checks above against your live domain after initial setup or domain changes.

## 4. Connect Your Computer and Phone

1. Open DSH on your computer → **Remote Control** → add `https://relay.example.com` under **Public nodes**. Check that the displayed **node fingerprint** (8 groups of 4 uppercase hex characters) matches your relay, then save and select it.
2. Enable **Remote Control** to display the pairing QR code (`https://relay.example.com/pair#v=1&ticket=...&key=...`).
3. Scan the QR code with your phone browser. Confirm that the **target computer fingerprint** displayed on your phone matches the host fingerprint shown in DSH on your computer, tap **Confirm this computer** on your phone, and click **Allow** on your computer. Both independent confirmations must complete before the ticket expires (≤5 minutes).

Multiple computers can share the same `remote-server` instance; each Host's devices, pairings, cached assets, and tunnel traffic remain strictly isolated.

## 5. Backup & Restore

The Docker `data` volume holds `node-identity.json` and `remote-server.sqlite`. Stop `remote-server` cleanly before backing up SQLite so WAL files stay consistent:

```sh
docker compose stop remote-server
docker run --rm -v dsh-remote-server_data:/data:ro -v "$PWD:/backup" alpine tar czf /backup/data.tgz -C /data .
docker compose start remote-server
```

To restore, stop `remote-server`, unpack the archive into an empty `data` volume, and start it again. Treat backups as private runtime data.

## 6. Upgrade

```sh
git pull
cd remote-server
docker compose up -d --build
```

Your existing `data` volume (`node-identity.json` and SQLite database) and `caddy_data` certificates are preserved, so **upgrading does not change your node fingerprint**. Database migrations run automatically and idempotently on startup.

## 7. Revoking Devices & Unregistering

- **Revoke a phone**: Removing the host on the phone (`DELETE /v1/hosts/:hostId/devices/:deviceId`) drops its relay session and closes active tunneled connections immediately (close code `4004`). Revoking in DSH's desktop panel terminates that device locally as well.
- **Remove a relay from DSH**: The plugin calls `DELETE /v1/hosts/:hostId` using the Host's bearer credential to cascade-delete its devices, sessions, pairing requests, and cached assets. If the relay was temporarily unreachable and re-adding hits `409 HOST_ALREADY_REGISTERED`, purge that host row on the relay container:
  ```sh
  docker compose exec remote-server npm run admin:reset -- <hostId>
  ```
- **Shut down completely**: `docker compose down` preserves `data` and certificates; `docker compose down -v` **deletes all volumes permanently**.

## 8. Security Summary

- The relay terminates TLS and forwards HTTP/SSE/WebSocket frames (with automatic fragmentation/reassembly for large bodies and oversized WebSocket messages); do not treat the relay operator as blind to forwarded content.
- Credentials, pairing tickets, and session cookies are stored only as SHA-256 hashes; private keys stay solely on your devices and computer.
- Device cookies are `Secure; HttpOnly; SameSite=Strict` and bound to `PUBLIC_ORIGIN`; write routes enforce `Origin` validation and per-route rate limits; `X-Forwarded-*` headers are trusted only when `TRUST_PROXY=1`.
- `remote-server` strictly handles public `/v1/tunnel` relaying and static asset caching; LAN WebRTC direct connections are negotiated directly between your phone browser and desktop gateway.
