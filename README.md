# Event Check-in — Asia-Pacific Digital Health Interoperability Bootcamp 2026

Simple QR-code check-in for event participants. Participants scan a QR code, find their name, confirm/complete their details, and get a big green **CHECKED-IN** screen to show at the front desk.

- **Check-in page (participants):** `/`
- **Admin page:** `/admin` (protected by a PIN)
- **Health check:** `/health`

No database and no npm packages: plain Node.js with data saved to a single `data.json` file. This is plenty for ~100 participants and 25+ people checking in at once.

---

## Run it on your own computer (testing)

1. Install Node.js 18 or newer (https://nodejs.org).
2. In this folder, run:
   ```
   node server.js
   ```
   or on Windows, double-click `start-windows.bat`.
3. Open **http://localhost:3000/admin**. Use the PIN printed in the server window. A new random PIN is generated each run unless you set `ADMIN_PIN`.
4. Upload `sample-registrations.csv` (or your own file), then open **http://localhost:3000/** to try a check-in.

To test from a phone, the phone must be on the same Wi-Fi network. Scan the QR code on the admin page. Some corporate or guest Wi-Fi networks block phone-to-laptop traffic; if so, use a mobile hotspot.

---

## Workflow on the day

1. **Before the event:** Admin opens `/admin`, clicks **Download template**, fills it in (or uses the existing registration Excel with matching column names), and uploads it.
2. **Print the QR code** from the admin page and place it at the entrance.
3. **Participants** scan → type their name → confirm/complete their details → Submit → green tick.
4. **Front desk** checks the green CHECKED-IN screen and hands over the badge. The admin page refreshes every 5 seconds.
5. **After the event:** click **Export checked-in (Excel)** or **(CSV)**.

After a test run, use **Clear check-ins (keep list)** on the admin page. It removes all check-ins and walk-ins but keeps the registration list.

People not on the list can use **"I can't find my name"**. They are saved and marked as *Walk-in*.

### Registration file format

The first sheet of an `.xlsx` file, or a `.csv` file, with a header row:

| First Name | Last Name | Designation/Role | Organisation/Country | Email | Phone | Gender |
|---|---|---|---|---|---|---|

Only First Name and Last Name are required. Other columns can be blank, and participants fill them in at check-in. Common alternatives are also recognised (`Surname`, `Position`, `Organization`, `Country`, `Mobile`, or a single `Full Name` column).

---

## For DevOps — deploying to AWS

**Configuration (environment variables)**

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `ADMIN_PIN` | random each start | **Required in production.** Use a long passphrase (12+ characters), stored in AWS Secrets Manager or SSM Parameter Store, not in the repo. |
| `DATA_DIR` | app folder (`/data` in Docker) | Folder where `data.json` is stored. **Must be persistent storage.** |
| `EVENT_KEY` | random each start | Event code carried in the QR code (`/#k=CODE`). The public API answers only requests that carry it. Set it, or let the setup script generate and keep one, so printed QR codes stay valid. |
| `PUBLIC_URL` | (empty) | Public URL, e.g. `https://checkin.example.org/`. Used for the QR code on the admin page. |
| `TRUST_PROXY` | (off) | Set to `1` when behind an ALB or reverse proxy, so rate limiting uses the real client IP from `X-Forwarded-For`. Only enable it when the app is reachable **only** through the proxy. |

**Important notes**
- **Run a single instance.** Data is held in one JSON file, so do not scale horizontally or put multiple tasks behind the load balancer.
- **Persistent storage:** `DATA_DIR` must survive restarts and redeploys. Use an EBS volume on EC2 or an EFS mount on ECS/Fargate. Ephemeral container storage will lose check-ins on restart.
- **HTTPS:** serve behind an ALB, CloudFront or nginx with TLS. The app itself speaks plain HTTP.
- SheetJS (Excel reading/writing) and QRCode.js are bundled in `public/vendor/`, so no CDN or internet access is needed.
- Container health check: `GET /health` returns `{"ok":true}`.

**Docker**
```
docker build -t event-checkin .
docker run -d -p 3000:3000 -e ADMIN_PIN='<long-secret>' -e TRUST_PROXY=1 -e PUBLIC_URL=https://checkin.example.org/ -v checkin-data:/data event-checkin
```

**Plain EC2 (no Docker)**
```
ADMIN_PIN='<long-secret>' TRUST_PROXY=1 DATA_DIR=/var/lib/event-checkin PUBLIC_URL=https://checkin.example.org/ node server.js
```
(run under systemd or pm2 so it restarts automatically)

**Backup:** download an Excel export from the admin page, or copy `data.json`.

---

## Security and privacy

**Built in**
- **Admin protection:** admin pages and APIs require `ADMIN_PIN`, which is compared in constant time. An IP address is locked out for 15 minutes after 10 wrong PINs. There is no default PIN in the code.
- **Masked contact details:** the public check-in page never receives a participant's full email or phone, only a masked version (`m•••@domain`, `•••123`). Participants can keep it or type a new one.
- **Event code:** the public API needs the event code from the QR code, so the attendee list can't be searched or scraped by someone who only knows the address.
- **Minimal public data:** search needs at least 3 characters and returns at most 6 names, with only name and organisation. Gender and check-in status are never sent to the public page. A phone can confirm only its own check-in, using a private receipt code.
- **Locked after check-in:** once someone has checked in, their record can't be changed from the public page. Only an admin can undo it.
- **Rate and size limits:** public APIs are limited per IP (generous, because a venue shares one IP). Request bodies, field lengths (200 characters) and walk-in numbers (500) are capped.
- **Security headers:** CSP, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: no-referrer`.
- **Safe exports:** Excel/CSV exports neutralise formula injection (cells starting with `=`, `@`, and so on).
- **No personal data in the repo:** `data.json` is git-ignored. The registration list is uploaded through the admin page after deployment.

**DevOps checklist**
- [ ] HTTPS only (ALB/CloudFront with an ACM certificate). Redirect HTTP to HTTPS.
- [ ] `ADMIN_PIN` set from Secrets Manager or SSM. Long and random.
- [ ] `TRUST_PROXY=1` and the instance or task security group only accepts traffic from the ALB.
- [ ] `DATA_DIR` on encrypted persistent storage (encrypted EBS/EFS). Single instance.
- [ ] Optional: restrict `/admin` and `/api/admin/*` by IP or with AWS WAF.
- [ ] After the event, export the data, then delete it (**Delete all data** on the admin page) and shut the service down.

**Known limits:** someone who knows a participant's name could check that person in before they arrive. The admin can **Undo** this, and the front desk should check the name on the screen against the person. Note too that everyone at the venue typically shares one public IP, so a lockout or rate limit triggered from the venue network affects everyone there.
