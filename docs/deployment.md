# Hosting a party on the internet

Guests join from anywhere at `https://party.yourdomain.nl`; the game runs on your laptop.

## How it is kept safe

```text
Guests' phones / big screen ──HTTPS──▶ Cloudflare  (your domain, firewall, rate limits)
                                            │  tunnel: an OUTGOING connection from the laptop
Laptop ── Docker ───────────────────────────┼───────────────────────────────────────────
  cloudflared ──▶ app:8080   public: only what guests and the big screen need
                  app:3000   admin: host controls, reachable ONLY from this laptop
  You ──▶ http://localhost:3000/host
```

- **Nothing on the laptop is opened to the internet.** No router or firewall changes, and the
  laptop's address stays hidden: the tunnel is an outgoing connection to Cloudflare, which
  handles HTTPS and absorbs attacks.
- **The host side does not exist on the internet.** The public port answers an allow-list of
  guest and big-screen requests (`packages/server/src/surface.ts`). Creating games, the Setup
  and Run tabs and every host API are only on `localhost:3000` on the laptop. They refuse
  any other host name (DNS rebinding) and still ask for the host password to create a game.
- **Guests need the game code; everything they do needs their own session.** Uploads are
  checked by type and content and served sandboxed. There are limits per address (joins,
  lookups, uploads, connections), at most 200 players per game and 1 GB of uploads per game.
- **The app runs in a locked-down container.** Its files can't be changed, it has no Linux
  privileges, it has limited memory, CPU and processes, and it runs as a normal user. A bug
  in the app cannot reach your laptop's files. Its only writable place is its own data volume.
- **When the party is over, `npm run party:down` takes everything offline.**

No software can be promised to be unhackable. This setup removes every way in to the laptop
and keeps what is left small, isolated and limited.

### Before you start (work laptop)

- Check that running this is fine with your employer's IT policy.
- Company VPNs and web filters (e.g. Zscaler) may block the tunnel. If it doesn't connect,
  set `TUNNEL_PROTOCOL=http2` in `.env` (uses port 443), or switch off the VPN for the evening.
- Docker Desktop is free for personal use and small companies. Companies with more than 250
  employees or more than $10M revenue need a paid licence. Rancher Desktop is a free
  alternative that runs the same `docker compose` commands.

## One-time setup

### 1. Write down your current DNS records (protects your email and website)

1. Log in at mijndomein.nl → **Mijn domeinen** → your domain → **DNS-instellingen**.
2. Screenshot every record. Especially:
   - `MX` (email)
   - `TXT` (SPF `v=spf1 …`, DKIM, DMARC)
   - `A`, `AAAA`, `CNAME` (website, `www`, `mail`, `autodiscover`, webmail)
3. Note the current nameservers too (usually `ns1/ns2/ns3.mijndomein.nl`). Putting these
   back undoes everything.

### 2. Put the domain on Cloudflare (free)

1. Create an account at <https://dash.cloudflare.com/sign-up>. Turn on two-factor
   authentication (My Profile → Authentication).
2. **Add a domain** → your domain → plan **Free**.
3. Cloudflare scans your DNS records. Compare them with your screenshots and add anything
   missing.
   - **Email records** (`MX`, and any `mail`/`autodiscover`/webmail names) must be **DNS only**
     (grey cloud).
   - Leave the website records as Cloudflare suggests, or set them to grey too to change
     nothing.
4. Cloudflare shows two nameservers (e.g. `xxx.ns.cloudflare.com`).
5. At mijndomein.nl: your domain → **Nameservers** → **eigen nameservers** → enter the two
   Cloudflare ones → save.
6. Wait until Cloudflare says the domain is **Active**. This usually takes minutes, but can
   take up to 24 hours.
7. **Test** before going further:
   - send an email to the domain and reply from it
   - open your website

   If something is off, fix the record in Cloudflare, or put the old nameservers back.

### 3. Create the tunnel

The domain must show **Active** in Cloudflare first.

1. Fill in `.env` first (step 5): `PARTY_HOST` and `HOST_CREATE_PASSWORD`. The tunnel wizard
   waits until the tunnel is running.
2. Cloudflare dashboard → **Networking → Tunnels** → **Create a tunnel** → name `party` →
   **Create Tunnel**.
3. The wizard shows install commands. **Do not run them**: Docker runs cloudflared for you.
   Pick any of them (e.g. Docker) and copy only the long token after `--token`. Put it in
   `.env` as `TUNNEL_TOKEN=…`.
4. Start everything:

   ```bash
   npm run party:up
   ```

   Back in the wizard, wait until the connector shows as connected, then **Continue**.
5. Open the tunnel → **Routes** tab → **Add route** → **Published application**:
   - Subdomain `party`
   - Domain: your domain
   - Path empty
   - Service URL `http://app:8080`

   This is the app container's name and its public port inside Docker, not `localhost`.
   **Add route**. Cloudflare creates the DNS record `party.yourdomain.nl` itself.
6. **Networking → Tunnels** should show the tunnel as **Healthy**.

### 4. Harden the edge (Cloudflare dashboard → your domain)

These rules are an extra lock: the app already refuses host requests from the internet and
limits joins itself. With them, Cloudflare stops such requests before they reach the laptop.

- **SSL/TLS → Edge Certificates**:
  - **Always Use HTTPS** on (plain `http://` links get redirected)
  - **Minimum TLS Version** TLS 1.2
- **Security → Security rules → Create rule → Custom rules**:
  - Rule name `Block host pages`.
  - **Edit expression**, paste the following (with your own host name):

    ```text
    (http.host eq "party.yourdomain.nl" and (starts_with(http.request.uri.path, "/host") or starts_with(http.request.uri.path, "/api/local") or (http.request.method eq "POST" and http.request.uri.path eq "/api/games")))
    ```
  - Action **Block** → **Deploy**.
- **Security → Security rules → Create rule → Rate limiting rules**:
  - Rule name `Joins`.
  - **Edit expression**:

    ```text
    (http.host eq "party.yourdomain.nl" and http.request.uri.path eq "/api/join")
    ```
  - Same characteristics: IP.
  - Rate: 30 requests per 10 seconds. Guests on the same Wi-Fi share one address.
  - Action **Block**. The free plan blocks for 10 seconds.
  - **Deploy**.
- Optional: another custom rule that blocks countries you don't expect guests from.

### 5. Configure the laptop

In the project folder:

```bash
copy .env.example .env
```

Edit `.env`:
- `PARTY_HOST=party.yourdomain.nl`
- `TUNNEL_TOKEN=` the token from step 3 (empty until then)
- `HOST_PORT=3002` only if `npm run dev` (port 3000) runs at the same time
- `HOST_CREATE_PASSWORD=` a long random password. For example, generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
  ```

`.env` holds secrets and is never committed (it is in `.gitignore`).

## Party night

1. Start **Docker Desktop**, then:

   ```bash
   npm run party:up
   ```

   The first time this builds the image (a few minutes).
2. On the laptop, open <http://localhost:3000/host> and create the game. It asks for the host
   password. Set up the board, or import a setup file you exported earlier.
3. The QR code and join link now show `https://party.yourdomain.nl/join/CODE`. Guests can use
   Wi-Fi or mobile data.
4. Big screen:
   - On another device: `https://party.yourdomain.nl/display/CODE`.
   - On the laptop: `http://localhost:3000/display/CODE`.
5. Keep the laptop on power, and stop it sleeping for the evening (Settings → System → Power).
6. Logs: `npm run party:logs`.

Afterwards:

```bash
npm run party:down
```

The site goes offline at once. Games stay saved in the Docker volume `party_party-data` for
next time.

### Updating

```bash
git pull
```

```bash
npm run party:up
```

### Backups

- **One game's setup:** Setup tab → export.
- **Everything** (games, photos), in PowerShell in the project folder:

  ```powershell
  docker run --rm -v party_party-data:/data -v "${PWD}:/backup" alpine tar czf /backup/party-data.tgz -C /data .
  ```

Games from `npm run dev` (the `data/` folder) are separate. Bring a board over with its
setup file.

## Checking it

Containers and the admin port:

```bash
docker compose ps
```

```bash
curl http://localhost:3000/api/health
```

- `docker compose ps` should show both containers as `healthy`/`running`.
- The health check should answer with the number of games.

The public port is not reachable from the laptop at all (expect "connection refused"):

```bash
curl http://localhost:8080/api/health
```

From outside:

```bash
curl -I https://party.yourdomain.nl/join/TEST
```

```bash
curl -I https://party.yourdomain.nl/host
```

- `/join/TEST` should give `200`, with `content-security-policy` among the headers.
- `/host` should give `403` (the Cloudflare rule) or `404`.

## Settings (for reference)

| Variable | In compose.yaml | Meaning |
|---|---|---|
| `PORT` | `8080` | The public server (guests, big screen) |
| `ADMIN_PORT` / `ADMIN_HOST` | `3000` / `0.0.0.0` | The host's server; published as `127.0.0.1:3000` only. Setting `ADMIN_PORT` switches the app to internet mode |
| `HOST_PORT` | `3000` (from `.env`) | The laptop port for the host controls; change it when `npm run dev` is running too |
| `PUBLIC_URL` | `https://$PARTY_HOST` | Address in QR codes and join links |
| `HOST_CREATE_PASSWORD` | from `.env` | Asked when creating a game |
| `MEDIA_MAX_BYTES` | 8 MB | Largest single upload |
| `MEDIA_MAX_PER_GAME_BYTES` | 1 GB | All uploads of one game together |
