# Operator Shipping & Monetization Playbook — Apify Store + MCPize (`docuclean-ledger-mcp`)

> **Upfront Cost**: **`$0.00`** (GitHub OAuth on both Apify Store and MCPize; Apify includes `$5/mo` free platform credit)  
> **Creator Revenue Split**: **`80%`** net profit share on **Apify Store** (paid monthly via **PayPal** or **Wise**, `$20` min) + **`80%`** creator share on **MCPize**  
> **Repository**: `https://github.com/2848823170/docuclean-ledger-mcp`

---

## 1. Unit Economics & Margin Protection

Every tool in `docuclean-ledger-mcp` executes deterministically in pure Node.js (+ local `PyMuPDF` inside the container for PDF vector grids) with **zero external paid LLM/OCR API calls**:

| Metric | Value | Notes |
|---|---:|---|
| Event Price (`reconcile-statements-invoices` / `extract-pdf-tables-to-xlsx`) | **`$0.0200`** | Charged only after successful execution |
| Event Price (`repair-cjk-csv-mojibake`) | **`$0.0050`** | Sub-25ms in-memory CJK decoding & CSV sanitization |
| Container Memory Footprint (`.actor/actor.json`) | `256–1024 MB` | Hard-capped at `1024 MB` to prevent runaway memory billing |
| Average Compute Cost per Call (`512 MB` @ `~0.15s`) | **`< $0.0001`** | Apify compute is `~$0.30 / CU-hr` (`4 GB * 1 hr`) |
| **Net Creator Payout (`80% * ($0.0200 - $0.0001)`)** | **`~$0.0159` (`79.6%`)** | Apify floors negative runs at `$0.00` — zero downside risk |

At just **1,300 tool calls/month** across Claude Desktop, Cursor, n8n, and API users, net creator earnings cross Apify's **`$20.00 USD`** monthly PayPal / Wise payout threshold.

---

## 2. Publish to Apify Store (Pay-Per-Event Standby MCP Actor — ~5 Minutes)

### Step 2.1 — Sign In via GitHub OAuth & Push Actor (`$0.00`)

```powershell
cd ./docuclean-ledger-mcp

# 1. Authenticate Apify CLI (opens browser or accepts Personal API Token from https://console.apify.com/settings/integrations)
npx --yes apify-cli@latest login

# 2. Build & push Actor (reads .actor/actor.json, Dockerfile, input_schema.json, output_schema.json, dataset_schema.json)
npx --yes apify-cli@latest push
```

Because `.actor/actor.json` already sets:
```json
{
  "usesStandbyMode": true,
  "webServerMcpPath": "/mcp"
}
```
Apify automatically provisions your persistent **Standby MCP Server** endpoint at:
`https://<YOUR_APIFY_USERNAME>--docuclean-ledger-mcp.apify.actor/mcp`
and verifies container readiness via `GET /` (`x-apify-container-server-readiness-probe`).

### Step 2.2 — Enable Pay-Per-Event (PPE) Monetization in Apify Console

Apify requires activating Pay-Per-Event pricing rules in your Actor's Monetization tab (using `.actor/pay_per_event.json` as the exact blueprint):

1. Open **`https://console.apify.com/actors`** -> select **`docuclean-ledger-mcp`** -> **Publication** -> **Monetization**.
2. Choose **Pay per event (PPE)** and add the 4 events matching `.actor/pay_per_event.json`:
   - `reconcile-statements-invoices` -> **`$0.02`** (*Reconcile Statements & Invoices*)
   - `extract-pdf-tables-to-xlsx` -> **`$0.02`** (*Extract & Clean PDF/Messy Tables to XLSX*)
   - `repair-cjk-csv-mojibake` -> **`$0.005`** (*Repair CJK CSV Mojibake*)
   - `actor-start` -> **`$0.001`** (*Actor Batch Run Initialization*)
3. Enable **Categories**: `AI`, `MCP servers`, `Developer tools`, `Finance`, and toggle **Publish to Apify Store**.
4. Under **Settings -> Billing -> Payouts**, connect **Wise** or **PayPal** (`$20 USD` minimum monthly auto-payout on days 21–25).

### Step 2.3 — Live Smoke Test Against Deployed Standby MCP URL

```powershell
$ApifyToken = "<YOUR_APIFY_API_TOKEN>"
$McpUrl = "https://<YOUR_APIFY_USERNAME>--docuclean-ledger-mcp.apify.actor/mcp"

Invoke-RestMethod -Method Post -Uri $McpUrl `
  -Headers @{ Authorization = "Bearer $ApifyToken"; "Content-Type" = "application/json" } `
  -Body '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## 3. Publish to MCPize Marketplace (`80%` Creator Share — ~3 Minutes)

`mcpize.yaml` and `Dockerfile` are pre-configured in the repository root:

```powershell
cd ./docuclean-ledger-mcp

# 1. Authenticate via GitHub OAuth ($0.00)
npx --yes @mcpize/cli@latest login

# 2. Validate mcpize.yaml, Dockerfile, and /health + /mcp endpoints
npx --yes @mcpize/cli@latest doctor

# 3. Deploy container & publish listing with hybrid pricing ($0.02/call + $9/mo Solo & $29/mo Team)
npx --yes @mcpize/cli@latest deploy
```

---

## 4. Companion Direct Checkout & Discovery Cross-Links

- **Direct Self-Serve Desktop/CLI Licenses (`0%` middleman platform lock-in)**:
  - Global Card / Alipay / Polygon `USDC` via **Creem.io** (`https://creem.io`)
  - Mainland China `<5 min` Personal Alipay via **Mianbaoduo (`https://mbd.pub`)**
- **Free MCP Registry Discovery Directories**:
  - Submit `server.json` to the official **Model Context Protocol Registry** (`io.github.2848823170/docuclean-ledger-mcp`), **Glama.ai**, and **Smithery.ai** pointing remote Streamable HTTP traffic directly to your monetized Apify Standby `/mcp` and MCPize gateway URLs.
