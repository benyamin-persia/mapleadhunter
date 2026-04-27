# MapLeadHunter — Complete Application Guide

## What the app does (overview)

MapLeadHunter scrapes Google Maps for local businesses in zip codes you choose, stores them in a shared cloud database (Turso), enriches each lead with phone numbers, emails, hours, reviews, photos, and website data, then lets you send SMS outreach via an Android phone connected over USB.

---

## Architecture

```
Electron (app-main.cjs)
  └─ spawns Node.js server (src/server/index.ts via tsx)
        ├─ serves the web UI (index.html on localhost:3000)
        ├─ talks to Turso cloud database (shared across computers)
        ├─ launches headless Playwright/Chromium for scraping
        └─ talks to Android phone via ADB for SMS
```

Multiple computers can run the app simultaneously. They all share the same Turso database and coordinate scraping so they never scrape the same zip/category at the same time.

---

## Navigation (left sidebar)

| Item | Section |
|------|---------|
| 🕷 Scraper | Run Google Maps scrapes by zip + category |
| 📋 Leads | View, filter, and act on all scraped businesses |
| 💬 Templates | Write and test SMS message templates |
| 📤 SMS Queue | Review queued messages and send them |
| 📜 Outreach Log | Full audit trail of every SMS/email sent |

The green pulse dot in the bottom-left corner shows the scraper is running. The moon/sun icon toggles dark mode.

---

## Section 1 — Scraper

### Layout

Three columns side by side:
1. **Zip Codes** (left) — where to scrape
2. **Categories** (middle) — what to search for
3. **Settings + Live Log** (right) — how many results, live output

---

### Column 1 — Zip Codes

**State / County / Zip browser (top half)**

- Pick a US state from the dropdown → counties and zip codes appear
- Search box filters by zip number or city name
- Each zip has a checkbox; county headers have **Select all / Deselect all**
- **Add N zip(s)** button — moves your checked zips into "My Zips" list below
- **All** — checks every visible zip
- **✕** — unchecks all in the browser

**Manual entry**

- Type one or more zip codes separated by commas (e.g. `20852, 20850`) → press Enter or click **+**

**My Zips list (bottom half)**

This is your personal working list — only zips here can be selected for scraping.

| Control | Effect |
|---------|--------|
| Checkbox per zip | Includes/excludes that zip from the next scrape |
| Search my zips | Filters the list — does not remove zips |
| **All** | Selects every zip in the list |
| **None** | Deselects all (keeps them in the list) |
| **Clear** | Permanently removes all zips from the list |
| **✕** on each row | Removes that single zip |
| Counter at bottom | Shows `N / total selected` |

---

### Column 2 — Categories

Pre-grouped list of business types (plumbers, electricians, HVAC, restaurants, etc.).

| Control | Effect |
|---------|--------|
| Search box | Filters the category list live |
| Checkbox per category | Toggles that category on/off |
| **Select all / Deselect** per group | One click to toggle an entire group |
| **All / None** in the header | Selects or deselects everything |
| Counter at bottom | Shows how many categories are active |

The job count shown in the header bar is `selected_zips × selected_categories`. Each zip+category pair is one scrape job.

---

### Column 3 — Settings and live log

**Settings bar**

| Field | What it controls |
|-------|-----------------|
| Max per zip/category | How many businesses to collect per job (1–500, default 500) |
| Scrape workers | How many parallel jobs run at once (1–10). Higher = faster but more memory and risk of Google throttling |
| Skip already-scraped zips | If checked, any zip+category pair already completed in a previous session is skipped entirely |

**Session counters** (reset each scrape run)

| Counter | Meaning |
|---------|---------|
| Jobs done | How many zip+category pairs have completed |
| Found | Total businesses returned by Google Maps |
| Saved | New businesses inserted into the database |
| Duplicates | Businesses already in the database (skipped) |
| Total in DB | All leads across all sessions |

**Live log tabs**

Five tabs inside the dark terminal box, each receiving a different stream of events:

| Tab | Feed |
|-----|------|
| ⚡ Main | Map scraper events — start, zip completed, errors, done |
| 📋 Details | Detail scraper events (hours, address, amenities) |
| 🌐 Website | Website scraper events (emails, phones, social links) |
| ⭐ Reviews | Review scraper events |
| 🌐 Network | Cross-computer feed — shows activity from ALL connected machines in real time, pulled from Turso every 4 seconds |

Red badge on a tab = new activity arrived while you were on another tab.
**clear** button (top right of the log box) — clears that tab's log only.

---

### Scrape buttons (top-right of the Scraper section)

All buttons are disabled while a scrape is running or stopping.

#### 🔍 Detail Scrape
Calls `POST /api/scrape/start` with `detailFirst: true`.

For each zip+category pair:
1. Opens a headless Chromium browser
2. Navigates to Google Maps and searches e.g. "plumber near 20852"
3. Scrolls through results collecting up to `maxPerZip` businesses
4. For each business, opens its individual Maps listing page and extracts:
   - Full address, phone, website URL
   - Opening hours (every day of the week)
   - Amenities and business attributes
   - Menu URL, booking URL
   - Service area, Plus Code
   - Social links (Facebook, Instagram, etc.)
5. Writes everything to Turso database
6. Marks the zip+category as scraped in `scraped_zips` table

Use this when you want full details without running any follow-up steps manually.

#### 🚀 Master Scraper (from Scraper tab)
Calls `masterScrapeFromScraper()`.

This is a 4-step pipeline that runs automatically in sequence:
1. **Detail Scrape** — scrapes all selected zips/categories AND immediately extracts full details (hours, address, phone, amenities, social links, website URL) in the same pass. This covers everything a Fast Scrape does and more — no separate fast scrape step is needed.
2. **Scrape Websites** — crawls each lead's website for emails, phones, contact form URL, OG image
3. **Scrape Reviews** — opens each Maps listing and saves all reviews
4. **Scrape Photos** — pulls the Maps photo gallery for each lead

You start it once and walk away. Results appear in the log as each stage completes.

#### Stop
Appears only while a scrape is running. Calls `POST /api/scrape/stop`.

What happens immediately:
- All active Playwright browser instances are force-closed
- The abort signal is sent to all workers
- The server confirms stopped state
- The UI polls the server every 800ms and resets to Idle within 12 seconds maximum

---

## Section 2 — Leads

Displays every business in the database. All leads from all computers appear here.

### Filter bar

| Filter | Effect |
|--------|--------|
| Search box | Full-text match on name, phone, address |
| Zip | Exact zip code filter |
| Category | Partial match on category name |
| All businesses / No website / Has website | Shows all, only no-website leads, or only businesses with a website |
| All phones / Has phone / No phone | Filter by whether phone was captured |
| 50/100/250/500 per page | How many rows to show per page |

Results counter shows `filtered / total`.

### Sortable columns

Click any underlined column header to sort. Click again to reverse. Sortable columns:
- Business name
- Created date (✚ created)
- Updated date (✎ edited)
- Phone, Address, Category, Zip, Rating, Reviews, Website (has/no), ID

### Table columns

| Column | Content |
|--------|---------|
| ☐ | Select checkbox |
| Business | Thumbnail (Maps or website OG image), name, internal ID, age (created/updated as "X days ago") |
| Phone(s) | Primary phone as a clickable `tel:` link. If multiple phones were found, shows "+N more" — click to expand all |
| Email(s) | All emails found by the website scraper, as clickable `mailto:` links |
| Address | Street address + zip |
| Category | The search category used (indigo pill) |
| Zip | Zip code |
| Rating | Google Maps star rating |
| Reviews | Review count |
| Website | 🌐 Visit (clickable link) or 📵 none |
| Scraped With | Badges showing which scrapers have run on this lead: ⚡ fast / 🔍 detail / 📋 details / 🌐 website / ⭐ reviews |
| Actions | Maps↗, SMS, Details, Del |

### Per-row actions

| Button | What it does |
|--------|-------------|
| Maps↗ | Opens the Google Maps listing in a new tab |
| SMS | Queues a single SMS for this lead using the currently active template |
| Details | Opens the detail drawer on the right side |
| Del | Deletes this lead from the database immediately |

---

### Bulk action bar

Appears when one or more checkboxes are ticked. The **select-all** checkbox in the table header selects/deselects the current page.

| Button | What it does |
|--------|-------------|
| 🚀 **Scrape All (N)** | Runs the full 4-step pipeline (Details → Website → Photos → Reviews) on all selected leads. This is the Master Scraper for leads you already have. |
| Template dropdown | Selects which SMS template to use for bulk send |
| 📱 **Send SMS (N)** | Queues an SMS to every selected lead using the chosen template, then moves to the SMS Queue section |
| **Scrape Reviews (N)** | Runs the review scraper on selected leads — opens their Maps page in Playwright, scrolls through and saves all reviews |
| **Re-scrape Details (N)** | Re-runs the detail scraper (hours, address, amenities, social links) on selected leads |
| 🌐 **Scrape Websites (N)** | Crawls the website for each selected lead — extracts emails, phones, social links, contact form URL |
| 📷 **Scrape Photos (N)** | Opens each lead's Maps page in Playwright, clicks the Photos tab, scrolls and saves up to 20 photo URLs |
| 📋 **Submit Forms (N)** | Opens the Form Sender modal — fills and submits the contact form on each lead's website |
| 🗑 **Delete (N)** | Deletes all selected leads from the database |
| 🗑 **Delete All (total)** | Deletes every lead in the database (does NOT wipe reviews/queue — use Wipe DB for that) |
| 💣 **Wipe DB** | Destroys everything in Turso — leads, reviews, SMS queue, outreach log, scraped zips. Irreversible. |
| Deselect all | Unchecks all selections |

### Export buttons (top-right of Leads)

| Button | What it does |
|--------|-------------|
| ⬇ CSV | Downloads all leads as a spreadsheet |
| 📱 Contacts (VCF) | Downloads all leads with phones as an iPhone/Android contact file |
| ☁ Google Sheets | Pushes all leads to the configured Google Sheet (overwrites previous data) |
| ↺ Refresh | Re-fetches leads from the database |

---

### Detail drawer (right panel)

Opens when you click **Details** on any lead. Shows everything scraped about one business.

**Header**: name, category, rating, review count, open/closed status

**Tabs inside the drawer:**

| Tab | Content |
|-----|---------|
| Info | Full address, phone(s), website link, opening hours for each day, service area, Plus Code, amenities list, social links (Facebook, Instagram, etc.), menu URL, booking URL |
| Website | Emails found on the website, phones found on the website, contact form URL, OG image |
| Reviews | All saved reviews — reviewer name, star rating, date, full review text |
| Photos | Grid of all Maps photos scraped. Click any photo to open full size. |

**Buttons inside the drawer:**

| Button | What it does |
|--------|-------------|
| 🔍 Scrape Details | Re-runs the detail scraper for this single lead |
| 🌐 Scrape Website | Re-runs the website scraper for this single lead |
| ⭐ Scrape Reviews | Runs the review scraper for this single lead |
| 📷 Scrape Photos | Runs the photo scraper for this single lead |
| Maps↗ | Opens Google Maps listing |

---

## Section 3 — SMS Templates

Templates are reusable message bodies. Two placeholders are available:
- `{name}` — replaced with the business name
- `{location}` — replaced with the city derived from the address

### Per-template controls

| Control | Effect |
|---------|--------|
| Name field (editable) | Rename the template |
| Template key (grey pill) | Internal ID used by the queue |
| Body textarea | Edit the message. Live preview shows below. |
| Char count | Length of the body (minus placeholder text) |
| 📲 Test | Sends this template as an actual SMS to the test phone number with sample data |
| Delete | Removes the template (disabled if only one exists) |

### Test SMS bar

Fill in:
- **Send test to** — a real phone number (yours)
- **Business name** — sample business name for `{name}`
- **Location** — sample city for `{location}`

The preview shows exactly what the message will say before you send.

### Add Template

Type a name and body → **Add Template**. The new template appears immediately and is available in the Leads bulk action dropdown.

---

## Section 4 — SMS Queue

Messages are staged here before being physically sent via ADB.

### How messages get into the queue

1. Select leads in the Leads section
2. Choose a template from the dropdown
3. Click **Send SMS (N)** — this calls `POST /api/sms/send` which resolves `{name}` and `{location}` immediately and writes one queue row per lead
4. The queue shows each message with status PENDING

### Queue columns

| Column | Content |
|--------|---------|
| # | Internal queue ID |
| Business | Lead name |
| Phone | Phone number |
| Template | Which template was used |
| Status | PENDING / SENT / FAILED (color coded) |
| Queued at | When it was added |
| Message | The resolved message text |

### Queue action buttons

| Button | What it does |
|--------|-------------|
| ↺ Refresh | Reloads the queue from the database |
| 📤 Send Now (N) | Sends all PENDING messages via ADB. Checks business hours first (Mon–Fri 8am–8pm only). Checks Android phone is connected. Sends one by one with 1.5 second delay. |
| Force Send | Same as Send Now but skips the business-hours check |
| Clear Sent | Removes all SENT items from the queue |
| Clear All | Removes everything from the queue |

### Auto-schedule

Set a time (HH:MM) and tick which days → **Save Schedule**. Every minute the server checks the clock. At the scheduled time, if the phone is connected and there are PENDING messages, it sends automatically. Cancel with **✕ Cancel**.

---

## Section 5 — Outreach Log

Every SMS sent (and every contact form submission) is permanently recorded here for TCPA compliance.

**Columns**: ID, timestamp, lead ID, business name, phone, zip, channel (SMS / Email), opted-out flag, updated timestamp, full message text.

**Filters**: free-text search (name, phone, message), channel filter, zip filter.

Records with `opted_out = YES` are highlighted red — these are businesses that replied STOP and should never be contacted again.

---

## How scraping works internally (per scraper)

### Map Scraper (⚡ / 🔍)
- **Tech**: Playwright + stealth plugin
- **Flow**: Google Maps search URL → scroll results list → extract business cards → optionally open each listing for full details
- **Rate limiting**: 8–15 second random pause between jobs
- **Overlap prevention**: Before starting each zip, claims it in the `scrape_claims` table (atomic INSERT). If another computer already claimed it, skips and logs "already claimed by another computer"
- **Duplicate handling**: `INSERT OR IGNORE` on `maps_url` (unique key). Returns rows affected = 0 for duplicates.

### Detail Scraper (📋)
- **Tech**: Playwright + stealth
- **Flow**: Opens the Maps listing page → extracts structured data (hours table, address, phone, website, amenities, social links, menu, booking)
- **Writes to**: `details_scraped = 1` on the lead

### Website Scraper (🌐)
- **Tech**: Playwright + stealth
- **Flow**: Navigates to the business website → scans all page text for emails and phone numbers → checks for links to Facebook/Instagram/Twitter/LinkedIn → detects contact form by checking for form elements with submit buttons → also scans raw HTML for social URLs
- **Phone validation**: Only saves valid NANP numbers (area code can't start with 0 or 1, no 555 numbers, no repeated-digit numbers). Max 5 phones saved.
- **Writes to**: `website_emails`, `website_phones`, `social_links`, `website_contact_url`, `website_og_image`

### Review Scraper (⭐)
- **Tech**: Playwright persistent context (saves Google login session so reviews aren't rate-limited)
- **Browser profile location**: `%APPDATA%\MapLeadHunter\maps-profile\` (writable on all machines)
- **Flow**: Opens Maps listing → clicks Reviews tab → scrolls to load all reviews → expands truncated review texts → extracts reviewer name, URL, star rating, date, text
- **Writes to**: `reviews` table (linked to lead by `lead_id`), `review_scrape_status = 'done'`

### Photo Scraper (📷)
- **Tech**: Playwright headless
- **Flow**: Opens Maps listing → clicks Photos tab if visible → scrolls gallery → extracts `img` tags with `googleusercontent.com/p/` URLs → upgrades resolution to `w800-h600` → falls back to regex scan of page HTML if tab not found
- **Max**: 20 photos per lead
- **Writes to**: `maps_photos` (JSON array of URLs)

### Contact Form Submitter (📋 Submit Forms)
- **Tech**: Playwright headless
- **Flow**: Opens the `website_contact_url` saved by the website scraper → finds form fields → fills name, email, phone, message → submits
- **Requires**: Website scraper must have run first to detect the contact form URL
- **Writes to**: `outreach_log` on success

---

## SMS sending (how it works)

Requires a physical Android phone connected via USB cable with USB debugging enabled.

Uses ADB (Android Debug Bridge) from the Android SDK. The app looks for ADB at:
- Windows: `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
- Mac/Linux: `adb` in PATH

**Process for each message:**
1. Opens Google Messages via `am start -a android.intent.action.SENDTO`
2. Waits 3 seconds for the app to open
3. Uses `uiautomator dump` to find the Send button on screen
4. Taps the Send button coordinates
5. 1.5 second pause before next message

**Business hours enforcement**: Mon–Fri 8am–8pm local time. The Force Send button bypasses this.

---

## Multi-computer sync

All computers point to the same Turso cloud database. The `.env` file (embedded in the installer) contains the connection credentials. Both computers see the same leads in real time.

**Zip claiming**: When computer A starts scraping `20852 / plumber`, it inserts a row into `scrape_claims`. Computer B, when it tries the same job, gets a PRIMARY KEY conflict and skips it — preventing double-scraping.

**Stale claim recovery**: Claims older than 2 hours are automatically released at the start of each scrape session (handles crashed machines).

**Network tab**: Shows a live feed of what every computer is doing, pulled from the `scrape_activity` table every 4 seconds.

---

## Data stored per lead

| Field | Source |
|-------|--------|
| name, address, category, rating, review_count, price_level, open_now | Map scraper |
| phone, maps_url, website_url, has_website, maps_thumbnail | Map scraper |
| scrape_method | "fast" or "detail" |
| hours, description, amenities, social_links, menu_url, booking_url, service_area, plus_code, details_scraped | Detail scraper |
| website_emails, website_phones, website_contact_url, website_og_image, website_scrape_status | Website scraper |
| reviews (separate table) | Review scraper |
| maps_photos | Photo scraper |
| created_at, updated_at | Automatic timestamps |

---

## Log file location

Every server startup writes a timestamped session log to:
```
C:\Users\<you>\AppData\Roaming\MapLeadHunter\logs\app.log
```

Access it from the tray icon → **View Logs**, or open `http://localhost:3000/logs` in any browser for a live-streaming terminal view.

---

## Environment variables (.env)

| Variable | Purpose |
|----------|---------|
| `TURSO_DATABASE_URL` | Turso cloud database URL |
| `TURSO_AUTH_TOKEN` | Turso authentication token |
| `GOOGLE_SHEET_ID` | Google Sheets spreadsheet ID for backup |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON of the Google service account credentials |
| `PORT` | HTTP port (default 3000) |
| `GOOGLE_MAPS_PROFILE_DIR` | Override path for the Playwright browser profile |

---

## Database tables

| Table | Purpose |
|-------|---------|
| `leads` | One row per business |
| `reviews` | Reviews linked to leads by lead_id |
| `outreach_log` | Every SMS/email sent |
| `sms_queue` | Messages staged for sending |
| `scraped_zips` | Completed zip+category pairs (prevents re-scraping) |
| `scrape_claims` | Active scraping locks (prevents overlap between computers) |
| `scrape_activity` | Rolling 500-entry log visible in the Network tab |
| `_schema` | Internal version tracking for migrations |
