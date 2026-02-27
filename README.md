# On-Call Lookup

Find who's on-call for any team. Fuzzy search by team name — no need to remember exact names or use Slack.

**Live at**: `oncall.quick.shopify.io`

## Setup

### 1. Install Quick CLI

```bash
npm install -g @shopify/quick
```

### 2. Run locally

```bash
quick serve .
```

Opens at `http://on-call.quick.localhost:1337`.

### 3. Seed the PagerDuty API token

On first setup, open the browser console and run:

```js
await quick.db.collection("config").create({ key: "pagerduty_token", value: "YOUR_PAGERDUTY_READ_ONLY_TOKEN" })
```

The token needs read access to escalation policies and on-calls. You only need to do this once — the token persists in Quick's database.

### 4. Deploy

```bash
quick deploy . oncall
```

## How it works

1. Loads `/users.json` (Shopify employee directory from Vault) and extracts unique team names
2. As you type, Fuse.js fuzzy-matches against those team names (typo-tolerant)
3. When you select a team, it queries PagerDuty for the matching escalation policy and current on-call person(s)
4. Displays on-call cards with avatar, name, title, Slack handle, and shift end time (enriched from Vault data)
