# Hourhand video: the Jitsi server (roadmap 3.11)

Written 2026-11-15. Sources are listed at the end, each with the date it was read.

Hourhand video gives each booking a private video room. Host and guests join from links in their emails and booking pages, and nobody needs a Zoom or Google account. The rooms run on the owner's own **Jitsi Meet** server (docker-jitsi-meet). That is a **separate, rented server**. The app stays on the existing 16 GB Coolify VPS, which only signs short-lived join tokens. No video traffic touches it.

## How it works

1. **The host picks the location.** They choose "Hourhand video" on an event type (Solo and Duo plans only).
   - If the three `JITSI_*` variables are missing, the editor says the feature is "not set up on this server" and refuses to save that choice.
   - There is no fallback to public Jitsi or any other service.
2. **Emails and pages carry Hourhand links, never tokens.** Each guest email, booking page and `.ics` file shows `https://hourhand.cloud/v/<guest manage token>`. Host emails, the host's calendar event and the dashboard show `https://hourhand.cloud/v/host/<booking id>`.
3. **Every visit is checked from scratch.** Hourhand reads the booking as it is now. It has to be confirmed, on Hourhand video, on a host with Solo or Duo, and between 15 minutes before the start and 30 minutes after the end. Hourhand also works out who is joining:
   - The signed-in host of the booking joins as **moderator** and skips the lobby.
   - Whoever holds the guest's link joins as a **participant** and waits in the **lobby** until the host lets them in.
   - The host link only works for that signed-in host. Anyone else is sent to sign in, or gets "not found".
4. **The token is made on the spot.** Hourhand mints a token (HS256, signed with `JITSI_APP_SECRET`) and redirects to `https://meet.hourhand.cloud/<room>?jwt=…`.
   - The token is valid from 15 minutes before the start to 30 minutes after the end.
   - It is not stored, and it is never put in an email.
5. **Room names are random.** Each one is 26 random characters (130 bits), stored in `video_rooms` the first time anyone joins. It is never the booking id.
   - Each booking gets its own room.
   - All seats of a group class share one room.
   - A rescheduled booking is a new booking, so it gets a new room, and the old link says "cancelled or moved".
6. **Nothing is recorded.** Recording, live streaming and transcription are off on the server, and the token also switches them off.

Extra guests (people the guest added) get a join link of their own: `https://hourhand.cloud/v/g/<token>`, one per booking and email, made when their email is sent and kept in `video_guest_links`. It carries none of the guest's manage token, so it can join the call and nothing else. It joins them as a participant under their own email, and only while that email is still on the booking; a moved booking gives them a new link.

## Server size

Jitsi's own guidance:

- **Bandwidth per video stream:** about 200 kbps at 180p, about 500 kbps at 360p, and about 2.5 Mbps at 720p.
- **Memory:** 8 GB is suggested; 4 GB is enough for small meetings.
- **CPU:** "4 dedicated cores can be enough".
- Prosody (the chat and signalling server) uses one core.
- The scalable-setup guide sizes each videobridge at 4 or 8 CPUs with 8 GB of RAM.

The per-participant figures in the table below are **our estimate, not Jitsi's**. We assume about 2.5–3 Mbps up and 2.5–4 Mbps down per person with simulcast: one HD speaker plus small thumbnails.

| Concurrent participants (whole server) | Server traffic, each way | Suggested server | Port |
| --- | --- | --- | --- |
| 10 | ~30–40 Mbps | 2 vCPU / 4–8 GB | 1 Gbps (any) |
| 25 | ~75–100 Mbps | 4 vCPU (dedicated preferred) / 8 GB | 1 Gbps |
| 50 | ~150–200 Mbps | 4–8 vCPU / 8–16 GB | 1 Gbps, check the provider's fair-use terms |

One-to-one calls normally go peer-to-peer between the two browsers, which is Jitsi's default `p2p` setting. The bridge then carries little of that traffic, so in practice group classes are what fill the server. Before relying on the P2P saving, confirm `p2p.enabled` in the web config.

**Monthly traffic:** about 1.6 GB per participant-hour through the bridge, at about 3.5 Mbps. For example, 25 people × 88 hours a month ≈ 3.5 TB.

**Start with the 4 vCPU / 8 GB size.** It covers 25 at once with headroom. Watch CPU and bandwidth for a month before resizing.

## Monthly cost (INR)

Prices were read on 2026-11-15 and exclude tax. Conversions use the ECB rates of 2026-11-13: €1 = ₹104.16 and $1 = ₹94.25.

| Option | Size | Included traffic | Price | ₹ / month | + 18% GST | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| **DigitalOcean, Bengaluru (BLR1), Basic** (recommended) | 4 vCPU / 8 GB | 5 TB | $48 | ₹4,524 | ₹5,338 | Close to Indian users; extra traffic $0.01/GiB (≈ ₹965 per extra TB). Shared vCPU. |
| DigitalOcean BLR1, Basic | 2 vCPU / 4 GB | 4 TB | $24 | ₹2,262 | ₹2,669 | Enough for ~10 at once |
| DigitalOcean BLR1, CPU-Optimized | 4 dedicated vCPU / 8 GB | (per plan) | $84 | ₹7,917 | ₹9,342 | For ~50 at once; over the ₹3,000–6,000 budget |
| Hostinger VPS KVM 4 | 4 vCPU / 16 GB | 16 TB | ₹1,099 (24-month promo), renews ₹2,399 | ₹2,399 at renewal | ₹2,831 | Cheapest. The India datacenter and overage terms are **not verified**; check them before buying. |
| Hetzner CPX32, Singapore | 4 vCPU / 8 GB | 2 TB | €49.49 | ₹5,155 | ₹6,083 | Extra traffic about €7.40/TB in Singapore. The Helsinki price is lower (€30.49), but it is too far from India for live video. |

**Recommendation: DigitalOcean BLR1, 4 vCPU / 8 GB.** It costs about **₹4,524 a month + 18% GST (≈ ₹5,338)**, which is inside the ₹3,000–6,000 budget.

- It is in Bengaluru, so latency to Indian guests is low.
- Its 5 TB of included traffic covers about 3,000 participant-hours on the bridge.
- Extra traffic is cheap and the price is clearly published.

The cheaper path is Hostinger KVM 4, once you confirm an India location and its overage policy. GST on a foreign provider's invoice falls under OIDAR rules; confirm the input-credit treatment with the CA.

## DNS, ports, TLS

- **DNS:** add an A record `meet.hourhand.cloud` → the new server's public IP. If the domain is on Cloudflare, make it **DNS only** (grey cloud). The video traffic is UDP and cannot go through Cloudflare's proxy.
- **Firewall:** open only `80/tcp` (Let's Encrypt and the redirect), `443/tcp` (web) and `10000/udp` (media). Keep SSH open as well, preferably restricted to your IP.
  - Port 4443/tcp is no longer in the current docs or compose file.
  - Open 20000–20050/udp only if you add Jigasi (dial-in), which Hourhand does not use.
- **TLS:** docker-jitsi-meet gets a Let's Encrypt certificate itself (`ENABLE_LETSENCRYPT=1`). DNS must already point at the server when it first starts.

## Deploying docker-jitsi-meet

On the new server, which only needs Ubuntu with Docker and Docker Compose:

```sh
# Download the release's source tarball from https://github.com/jitsi/docker-jitsi-meet/releases
# (the stable-11248-3 release, marked Latest when this was written) and unpack it. Then:
cp env.example .env
./gen-passwords.sh                       # fills the internal JICOFO/JVB passwords
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
# edit .env as below, then:
docker compose up -d
```

Set these in `.env`, on top of what `gen-passwords.sh` wrote. Generate the secret with `openssl rand -hex 32` and keep it in the password manager. The same value goes into Coolify as `JITSI_APP_SECRET`.

```dotenv
CONFIG=~/.jitsi-meet-cfg
TZ=Asia/Kolkata
JITSI_IMAGE_VERSION=stable-11248-3     # pin a release; the compose default is "unstable"

PUBLIC_URL=https://meet.hourhand.cloud
HTTP_PORT=80
HTTPS_PORT=443
ENABLE_HTTP_REDIRECT=1
ENABLE_LETSENCRYPT=1
LETSENCRYPT_DOMAIN=meet.hourhand.cloud
LETSENCRYPT_EMAIL=<an address you read>
JVB_ADVERTISE_IPS=<the server's public IP>

# Only people with a token from Hourhand get in.
ENABLE_AUTH=1
AUTH_TYPE=jwt
JWT_APP_ID=hourhand                    # = JITSI_APP_ID in Coolify
JWT_APP_SECRET=<openssl rand -hex 32>  # = JITSI_APP_SECRET in Coolify
JWT_ACCEPTED_ISSUERS=hourhand
JWT_ACCEPTED_AUDIENCES=jitsi           # Hourhand always signs aud=jitsi
JWT_ALLOW_EMPTY=0
ENABLE_GUESTS=0                        # no tokenless visitors at all

# Lobby on for every room; the host's token skips it and makes them moderator.
ENABLE_LOBBY=1
ENABLE_PREJOIN_PAGE=1
XMPP_MODULES=persistent_lobby
XMPP_MUC_MODULES=lobby_autostart,token_lobby_bypass,token_affiliation

# Never record.
ENABLE_RECORDING=0
ENABLE_TRANSCRIPTIONS=0
DISABLE_LOCAL_RECORDING=1
```

Do not start `jibri.yml` (recording) or `jigasi.yml` (phone dial-in).

### The token's claims

Hourhand signs these claims (all checked by the vitest suite):

- `iss=JITSI_APP_ID`, `aud=jitsi`, `sub=JITSI_DOMAIN`, `room=<room name>`
- `nbf` = start − 15 minutes; `exp` = end + 30 minutes
- `context.user`: `id`, `name`, `email`, plus `moderator`, `affiliation` and `lobby_bypass`. These last three are `true`/`owner`/`true` for the host and `false`/`member`/`false` for a guest.
- `context.features`: recording, live streaming and transcription all set to `false`.

### Check on a staging run before going live

`lobby_autostart` and `token_lobby_bypass` are jitsi-contrib plugins that the prosody image bundles. `token_affiliation` is in jitsi-meet core. That these three load from the image's contrib folder in this release is **not verified** here. Test with two browsers before announcing the feature:

1. As the host, open `/v/host/<id>` from the dashboard. You should land in the room as moderator, without waiting.
2. As the guest, open `/v/<token>` from the confirmation email. You should land in the lobby and wait until the host lets you in.
3. Paste the meet URL without `?jwt=`. You should be refused.
4. Open the guest link 20 minutes before the start. You should get "the call hasn't opened yet".

If step 2 lets the guest straight in, the lobby modules did not load. Check `docker compose logs prosody`. The fallback is for the host to turn on the lobby from the security menu at the start of each call.

## Monitoring

- **Uptime:** an https check on `https://meet.hourhand.cloud` every minute, from Uptime Kuma or the provider's monitoring.
- **Containers:** `docker compose ps` should show `web`, `prosody`, `jicofo` and `jvb` up. `docker compose logs --since 1h jvb` shows ICE and media errors.
- **Capacity:** set provider alerts at CPU > 70% for 10 minutes and outbound bandwidth > 70% of the port or monthly allowance. Use `docker stats` for a live view.
- **Certificates:** Let's Encrypt renews inside the `web` container. The uptime check catches a failed renewal as a TLS error.
- **Updates:** read the docker-jitsi-meet release notes monthly. Change `JITSI_IMAGE_VERSION`, then `docker compose pull && docker compose up -d`. The config folder layout changed at stable-11146, so follow the notes when jumping across it.
- **Backups:** only the `.env` file and `~/.jitsi-meet-cfg` matter. Rooms hold nothing, and nothing is recorded.

## The app side (Coolify, Runtime variables)

| Name | Value |
| --- | --- |
| `JITSI_DOMAIN` | `meet.hourhand.cloud` (host name only, no `https://`) |
| `JITSI_APP_ID` | `hourhand` (same as `JWT_APP_ID`) |
| `JITSI_APP_SECRET` | the same 64-character secret as `JWT_APP_SECRET` (at least 32 characters) |

Missing or malformed values switch the feature off: the editor says "not set up on this server" and join links explain the same. Migration `0035_hourhand_video.sql` adds the location kind and the `video_rooms` and `video_guest_links` tables. It runs when the container starts, as usual.

## Sources (read 2026-11-15)

- Jitsi handbook, Docker guide: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker (page says last updated 2026-11-11)
- Jitsi handbook, requirements: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-requirements
- Jitsi handbook, scalable setup: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-scalable
- docker-jitsi-meet `env.example`: https://github.com/jitsi/docker-jitsi-meet/blob/master/env.example
- docker-jitsi-meet prosody config template: https://github.com/jitsi/docker-jitsi-meet/blob/master/prosody/rootfs/defaults/conf.d/jitsi-meet.cfg.lua
- docker-jitsi-meet releases (stable-11248-3): https://github.com/jitsi/docker-jitsi-meet/releases
- Token format: https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/tokens.md
- Token checks: https://github.com/jitsi/jitsi-meet/blob/master/resources/prosody-plugins/token/util.lib.lua
- Moderator from token: https://github.com/jitsi/jitsi-meet/blob/master/resources/prosody-plugins/mod_token_affiliation.lua
- Lobby autostart and bypass: https://github.com/jitsi-contrib/prosody-plugins/tree/main/lobby_autostart and https://github.com/jitsi-contrib/prosody-plugins/tree/main/token_lobby_bypass
- DigitalOcean droplet pricing: https://www.digitalocean.com/pricing/droplets
- DigitalOcean bandwidth billing: https://docs.digitalocean.com/platform/billing/bandwidth/ (last updated 2026-11-05)
- Hostinger India VPS: https://www.hostinger.com/in/vps-hosting
- Hetzner cloud pricing: https://www.hetzner.com/cloud/regular-performance
- Exchange rates (ECB, 2026-11-13): https://api.frankfurter.app

Not verified: the forum posts by Jitsi staff on per-participant load (community.jitsi.org could not be reached from here), Hostinger's India location and overage terms, and the exact Hetzner overage unit. The capacity table is our estimate built on Jitsi's per-stream figures.
