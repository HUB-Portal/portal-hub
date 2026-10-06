# Running the Portal Hub on a Hetzner server

This guide takes you from an empty Hetzner account to a running, backed up Hub. Follow the steps in order. Every command was run for real against the files in this folder.

What you will have at the end:

```
Internet ──443──> Caddy (automatic HTTPS) ──> app (API and web app) ──> db (PostgreSQL 16)
                                               worker (jobs)       ──> clamav (malware scanner)
                                               both talk out to: email (SMTP), Google sign in, partner webhooks, K Line portal, object storage
```

* The `backend` network has no route to the internet. The database and the scanner cannot call out and cannot be reached from outside.
* Only ports 80 and 443 are open. There is no port for PostgreSQL, ClamAV or the app.
* Every container runs as a normal user (not root), with a read only file system, no Linux capabilities and `no-new-privileges`. The one exception to "no capabilities" is ClamAV, which needs four to hand its signature folder to its own user.
* Files are encrypted by the application before they are stored (a separate key for every file). Names and instructions are encrypted in the database. The master keys live only in `/srv/kph/secrets/app.env` and in your offline copies.

## 0. Before you start

You need:

* A Hetzner Cloud account, and a domain name you control (for example `hub.example.com`).
* An SMTP account for sending email (the Hub refuses to start in production without one).
* A safe place **outside** the server for the master keys and the backup key: a password manager entry for each person who may need them, and one sealed printed copy in a safe. Decide this now.
* Optional: a Google Workspace admin, if K Line staff should sign in with Google (see step 9).

Size: **CX32 (4 vCPU, 8 GB RAM) or larger**. ClamAV alone uses about 2 GB once its signatures are loaded. Add a Hetzner Cloud Volume (100 GB or more) for the data.

Location: **Falkenstein (fsn1) or Nuremberg (nbg1)**, so all patient data stays in Germany. Choose the same location for the server, the volume, the Storage Box and the Object Storage bucket.

## 1. Create the server

1. Create a server: location Falkenstein or Nuremberg, image **Ubuntu 24.04 LTS**, type CX32 or larger, your SSH public key (no password login), IPv4 and IPv6.
2. Create a **Cloud Firewall** in the Hetzner console and attach it to the server:
   * Inbound TCP 80 and 443 (and UDP 443 for HTTP/3) from anywhere.
   * Inbound TCP 22 **only from your office or VPN address(es)**. Never from anywhere.
   * ICMP is optional. Everything else stays closed.
3. Create a DNS `A` record (and `AAAA` for IPv6) for your domain that points to the server. Caddy gets the certificate on first start, so the record must already work.

## 2. Basic hardening (as root, once)

```bash
apt update && apt -y full-upgrade
adduser --disabled-password --gecos "" kphadmin && usermod -aG sudo kphadmin
mkdir -p /home/kphadmin/.ssh && cp ~/.ssh/authorized_keys /home/kphadmin/.ssh/ && chown -R kphadmin:kphadmin /home/kphadmin/.ssh
# sudo without a password is convenient for a key only account; remove this line if you prefer to set a password
echo 'kphadmin ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kphadmin && chmod 440 /etc/sudoers.d/kphadmin

# SSH: keys only, no root login
cat > /etc/ssh/sshd_config.d/99-kph.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers kphadmin
EOF
systemctl reload ssh

# Host firewall as a second layer (the Cloud Firewall is the first). SSH only from your address.
apt -y install ufw fail2ban unattended-upgrades chrony
ufw default deny incoming && ufw default allow outgoing
ufw allow from YOUR.OFFICE.IP.ADDRESS to any port 22 proto tcp
ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp
ufw --force enable
```

Important: Docker publishes ports through its own firewall rules, which `ufw` does **not** filter. That is why the Cloud Firewall matters, and why `docker-compose.prod.yml` publishes nothing except 80 and 443. Never add a `ports:` entry for the database or ClamAV.

Automatic security updates (no automatic reboot, because the data volume is unlocked by hand in step 4):

```bash
cat > /etc/apt/apt.conf.d/52kph-unattended <<'EOF'
Unattended-Upgrade::Automatic-Reboot "false";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF
dpkg-reconfigure -f noninteractive unattended-upgrades
```

Plan a reboot once a month (or when `/var/run/reboot-required` exists), and do it in working hours, because after a reboot someone must unlock the volume.

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sh
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "no-new-privileges": true,
  "live-restore": true
}
EOF
systemctl restart docker
usermod -aG docker kphadmin
```

Log in again as `kphadmin` from now on (`ssh kphadmin@hub.example.com`).

## 4. Where the data lives: an encrypted volume (or object storage)

The Hub keeps three kinds of data on this server: the database, the encrypted file store (when `STORAGE_DRIVER=fs`), and the ClamAV signatures. Put them on an encrypted volume.

**Option A, LUKS on a Hetzner Cloud Volume (recommended for files on local disk):**

1. In the console, create a Volume in the same location. Choose **no automount, no format**. Attach it to the server.
2. Encrypt and mount it:

```bash
sudo apt -y install cryptsetup
DEV=$(ls /dev/disk/by-id/scsi-0HC_Volume_* | head -n 1)
sudo cryptsetup luksFormat "$DEV"            # type YES, then choose a long passphrase. Store it like a master key.
sudo cryptsetup open "$DEV" kphdata
sudo mkfs.ext4 -L kphdata /dev/mapper/kphdata
sudo mkdir -p /srv/kph/data
sudo mount /dev/mapper/kphdata /srv/kph/data
```

After every reboot, unlock it by hand before starting the stack:

```bash
sudo cryptsetup open /dev/disk/by-id/scsi-0HC_Volume_XXXXXXXX kphdata && sudo mount /dev/mapper/kphdata /srv/kph/data
docker compose -f /opt/kph/deploy/docker-compose.prod.yml up -d
```

Keep the passphrase with the master keys (offline). Do not store it on the server.

**Option B, Hetzner Object Storage for files:** create a private bucket in the same location, **turn on versioning**, create an access key for this bucket only, and set `STORAGE_DRIVER=s3` and the `S3_*` values in `app.env`. Files are still encrypted by the Hub before they leave the server. The database still needs the encrypted volume from option A (a small one is enough).

## 5. Folders, secrets and keys

```bash
sudo mkdir -p /srv/kph/secrets /srv/kph/backups /srv/kph/data/{db,storage,clamav,caddy/data,caddy/config}
# the owners are the user ids the containers run as
sudo chown 70:70   /srv/kph/data/db && sudo chmod 700 /srv/kph/data/db          # postgres
sudo chown 1000:1000 /srv/kph/data/storage /srv/kph/data/caddy/data /srv/kph/data/caddy/config   # node, caddy
sudo chown 100:101 /srv/kph/data/clamav                                          # clamav
sudo chown root:root /srv/kph/secrets /srv/kph/backups && sudo chmod 700 /srv/kph/secrets /srv/kph/backups

sudo git clone https://YOUR-GIT-SERVER/kline-partner-hub.git /opt/kph     # or copy the repository there
cd /opt/kph
sudo cp deploy/hetzner/app.env.example   /srv/kph/secrets/app.env
sudo cp deploy/hetzner/owner.env.example /srv/kph/secrets/owner.env
sudo cp deploy/hetzner/db.env.example    /srv/kph/secrets/db.env
sudo cp deploy/hetzner/caddy.env.example /srv/kph/secrets/caddy.env
sudo chmod 600 /srv/kph/secrets/*.env
```

Generate the secrets (write each value into the file, and into your password manager):

```bash
openssl rand -hex 24   # the owner database password: db.env (POSTGRES_PASSWORD) and owner.env (same value)
openssl rand -hex 24   # the app database password: app.env (DATABASE_URL), a different value
openssl rand -base64 32   # master key k1
openssl rand -base64 32   # blind index key b1
```

Edit the four files with `sudo nano`. `app.env` explains every setting. The two keys go into `MASTER_KEYS`; leave `ACTIVE_KEY_ID=k1` and `BLIND_INDEX_KEY_ID=b1`.

**Keep an OFFLINE copy of every master key, now, before you store any data.** A master key that is lost cannot be recovered, and everything sealed with it is gone for good. The same goes for each future key you add (`k2`, `k3` ...): copy it offline before it becomes active. Do not keep the only copy on this server, and do not keep keys in the backup folder.

Later, `kph run --rm migrate node dist/cli.js gen-key --id k2` (see step 6 for the `kph` shortcut) prints a new key. The command does not read any settings, so it works even while the secrets files still hold placeholders.

## 6. Build the image

```bash
cd /opt/kph
sudo docker build -t kph:1 .
```

Use a new tag for every release (`kph:2`, `kph:3` ...). Tell compose which one to run by adding `KPH_IMAGE=kph:1` to `/opt/kph/deploy/.env` (a small file next to the compose file; it holds no secrets), or export it in your shell. The same image runs the app, the worker and every command.

A shortcut for this guide:

```bash
echo 'KPH_IMAGE=kph:1' | sudo tee /opt/kph/deploy/.env
alias kph='sudo docker compose -f /opt/kph/deploy/docker-compose.prod.yml'
```

## 7. First start

```bash
kph up -d db clamav
kph ps                      # wait until db shows "healthy"; clamav needs a few minutes to load its signatures

kph run --rm migrate node dist/cli.js migrate
kph run --rm migrate node dist/cli.js create-admin --email first.admin@example.com --name "First Admin"
```

The last command prints a one time link (valid for 7 days). Keep it private until you open it. Now start everything:

```bash
kph up -d
kph ps                      # caddy, app, worker, db and clamav should all be running; app, db and worker "healthy"
curl -s https://hub.example.com/api/health      # {"ok":true}
```

Open the invite link, choose a password (12 characters or more) and set up the authenticator app. You are in the K Line console. Then:

* Add the sites, create the production specification template, invite the other staff (Staff page).
* Run `kph run --rm migrate node dist/cli.js audit-verify` (it prints `Audit chain OK`).

If the app does not start, read why: `kph logs app`. The application checks its settings on start and lists every problem (for example `PUBLIC_URL must be https in production`).

**Demo data must never be loaded on a real server.** `seed` is refused in production and `DEMO_MODE` makes the application refuse to start. `TUNNEL_HOOKS_ONLY` (a development tunnel setting) is refused in production as well.

`TRUST_PROXY` must name the proxy in front of the app, otherwise every visitor looks like the proxy and shares one rate limit. In this stack it is the fixed Caddy address (`172.29.10.2`). It accepts `true`, `false`, a number of hops, or a comma separated list of addresses, CIDR ranges and the names `loopback`, `linklocal` and `uniquelocal`; a value it does not understand stops the app from starting.

## 8. Backups and the monthly restore test

What is backed up: the database every night (encrypted with `age`), and optionally the encrypted file store. The master keys are **not** in any backup. That is deliberate: keep them offline (step 5).

1. On **your own computer** (not the server) create the backup key pair:

   ```bash
   age-keygen -o kph-backup-identity.txt        # prints "Public key: age1..."
   ```

   Keep `kph-backup-identity.txt` (the private key) offline, like a master key. Only the line starting with `age1` goes to the server:

   ```bash
   echo 'age1...yourpublickey...' | sudo tee /srv/kph/secrets/backup-recipient.txt
   ```

   The script refuses to run if that file contains a private key.

2. Order a **Hetzner Storage Box** in the same location. Enable SSH and add a key for the server. On the server:

   ```bash
   sudo apt -y install age rclone
   sudo rclone config        # new remote "kphbox", type sftp, host uXXXXXX.your-storagebox.de, port 23, user uXXXXXX, key file
   sudo rclone mkdir kphbox:kph-backups
   ```

3. Try it once by hand, then schedule it:

   ```bash
   sudo /opt/kph/deploy/hetzner/backup.sh
   echo '17 2 * * * root MAILTO=ops@example.com /opt/kph/deploy/hetzner/backup.sh' | sudo tee /etc/cron.d/kph-backup
   ```

   Add `INCLUDE_STORAGE=yes` in front of the script name if files are on local disk (`STORAGE_DRIVER=fs`). If cron cannot send mail, use a systemd timer with `OnFailure=` or an external check that looks at the age of `/srv/kph/backups/last-success`.

   Dumps older than **35 days** are deleted, locally and on the Storage Box. That is the longest time a purged case can still exist in a backup, and it is the time to state in the privacy documents.

4. **Test the restore every month.** Put a reminder in the calendar. On a computer with Docker, `age` and `rclone`:

   ```bash
   AGE_IDENTITY=/path/to/kph-backup-identity.txt /opt/kph/deploy/hetzner/restore-test.sh
   ```

   It downloads the newest dump, decrypts it, restores it into a throw away database container without a network, checks the tables, counts and the audit hash chain, prints only numbers, and deletes everything. It stops with an error if anything is wrong. A backup that was never restored is not a backup.

### Real restore after a disaster

1. New server and volume (steps 1 to 6), same `app.env`, `owner.env`, `db.env`, `caddy.env` (from your password manager) and the **same master keys**.
2. `kph up -d db`, then decrypt a dump with the offline identity and stream it straight into the restore (the plain dump never touches the disk):

   ```bash
   age --decrypt -i kph-backup-identity.txt kph-db-XXXX.dump.age      | docker exec -i -e PGPASSWORD=OWNERPASSWORD kph-db-1 pg_restore -h localhost -U kph_owner -d kph --no-owner --no-acl --exit-on-error
   ```

3. `kph run --rm migrate node dist/cli.js migrate` (creates the app login and its rights again), copy the file store back (`rclone copy kphbox:kph-backups/storage /srv/kph/data/storage`), then `kph up -d`.
4. Run `audit-verify`, sign in, open a case and download a file.

## 9. Sign in with Google for K Line staff (optional)

1. Google Cloud console: create an OAuth client of type **Web application**. Authorised redirect URI: `https://hub.example.com/api/auth/oidc/google/callback`. Set the consent screen to **Internal**.
2. Put `OIDC_GOOGLE_CLIENT_ID`, `OIDC_GOOGLE_CLIENT_SECRET` and `OIDC_ALLOWED_DOMAIN` into `app.env`, then `kph up -d app`.
3. Create a staff member who signs in with Google (no password, no link):

   ```bash
   kph run --rm migrate node dist/cli.js create-admin --google --email first.name@yourdomain.com --name "First Name"
   ```

The account must exist first. The Hub never creates accounts from a Google sign in, and partner users cannot use Google. The authenticator code is always asked after Google (two factor sign in is required for everyone). `OIDC_REQUIRE_LOCAL_MFA` can only be `true`; `false` stops the server from starting.

## 10. Everyday operations

```bash
kph ps                                   # what is running and healthy
kph logs -f --tail 100 app worker        # logs (they hold no patient data; the web server log has no query strings)
kph run --rm migrate node dist/cli.js audit-verify      # weekly: the audit chain is intact
kph run --rm migrate node dist/cli.js retention         # normally runs by itself every day in the worker
df -h /srv/kph/data                      # disk space
```

Watch from outside with an uptime monitor on `https://hub.example.com/api/health` (alert after two failures). Check once a month: pending OS updates, free disk, the age of `/srv/kph/backups/last-success`, the ClamAV container log (signature updates), and that the restore test passed.

## 11. Upgrading

Releases only add to the database (migrations never remove or rename columns), so the previous image keeps working against a newer database.

```bash
sudo /opt/kph/deploy/hetzner/backup.sh                 # 1. a fresh backup first
cd /opt/kph && sudo git pull                           # 2. new code (read the release notes)
sudo docker build -t kph:2 .                           # 3. build the new image
echo 'KPH_IMAGE=kph:2' | sudo tee /opt/kph/deploy/.env
kph run --rm migrate node dist/cli.js migrate          # 4. database changes
kph up -d app worker                                   # 5. new containers replace the old ones
kph ps && curl -s https://hub.example.com/api/health   # 6. check
```

To go back: put the old tag into `deploy/.env` and run `kph up -d app worker`. Only restore the database from a backup if a release damaged data.

Update the base images now and then (`kph pull caddy db clamav`, then `kph up -d`). Watch the Caddy, PostgreSQL 16 and ClamAV release notes. A new PostgreSQL major version needs a dump and restore, not just a new tag.

## 12. Key rotation

Rotate the active master key once a year, after a suspected exposure, or when a person who held the keys leaves. Nothing has to be switched off; files and names stay available throughout.

1. **Backup and restore test first** (step 8).
2. Create the new key and store an **offline copy** of it:

   ```bash
   kph run --rm migrate node dist/cli.js gen-key --id k2
   ```

   Add the printed entry to the `MASTER_KEYS` object in `app.env` (keep `k1` and `b1`). Do not remove anything yet.
3. Set `ACTIVE_KEY_ID=k2` in `app.env` and run `kph up -d app worker`. New files and fields are now sealed with `k2`; old ones still open with `k1`.
4. See what will change, then do it:

   ```bash
   kph run --rm migrate node dist/cli.js rewrap --dry-run
   kph run --rm migrate node dist/cli.js rewrap
   ```

   `rewrap` moves the key of every file, and every encrypted name, instruction, authenticator secret, webhook secret and portal key, to the active key. It works in batches with progress output, can be stopped and started again, and can be run as often as you like (the second run changes nothing). It never prints a secret or a name. At the end it opens a sample of each kind using only the new key and reports. The exit code is 0 only if everything succeeded. `--only files` (or `patient_names`, `instructions`, `file_names`, `totp`, `webhooks`, `portal_keys`, `blind_index`) limits a run.
5. Take a new backup and run the restore test on it.
6. Keep `k1` in `MASTER_KEYS` until every backup made before the `rewrap` is older than 35 days (those backups still need it). After that remove it from `app.env` and run `kph up -d app worker`. **Keep the offline copy of `k1` for as long as you may ever need to read an old backup or an archived export.**

Things that do not rotate with `ACTIVE_KEY_ID`: `BLIND_INDEX_KEY_ID` (the exact name search index) and `HASH_KEY_ID` (API keys, recovery codes, CSRF). They are not affected when the active key changes. Change the blind index key only with a reason: set `HASH_KEY_ID` to the old blind index key id first (otherwise every API key and recovery code stops working), change `BLIND_INDEX_KEY_ID`, restart, and run `rewrap`, which notices the change and rebuilds the index.

## 13. Things you must never do

* Never publish port 5432 or 3310, never attach the database to the `edge` network.
* Never turn on `DEMO_MODE`, `PORTAL_FAKE` or `ALLOW_NO_SCANNER` on a real server. The application refuses to start with the first two.
* Never keep a master key, the backup identity or the LUKS passphrase only on the server.
* Never copy production data to a laptop or a test system. The restore test runs in a throw away container for that reason.
* Never paste log lines that contain case references or names into a ticket without checking them. The Hub logs no patient data, but people sometimes add it.
