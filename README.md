# DocuClean & LedgerClean MCP (`docuclean-ledger-mcp`)

> **CI: Passing (Ubuntu + Windows)** · **Node.js >= 20** · **MCP: stdio | Streamable HTTP | SSE** · **License: MIT**

**Deterministic Financial Reconciliation, Multi-Page PDF-to-Excel Extraction & CJK CSV Mojibake Repair — Commercial MCP Server & Pay-Per-Event Apify Actor**

AI coding and finance agents routinely hallucinate arithmetic on bank statements, corrupt Chinese/Japanese/Korean (`GB18030` / `GBK` / `Big5` / `Shift_JIS`) CSV exports, or produce broken spreadsheets vulnerable to CSV/DDE formula injection. **`docuclean-ledger-mcp`** gives Claude Desktop, Cursor, Windsurf, Cline, n8n, and API workflows three deterministic, security-hardened tools with **zero external LLM API dependencies**:

1. **`reconcile_statements_and_invoices`** (`$0.02` / run) — Reconciles Alipay (`支付宝`), WeChat Pay (`微信支付`), Stripe, PayPal, and bank CSV/JSON statements against electronic invoices (China Digital e-Invoice `数电票` XML/PDF, UBL 2.1 XML, CSV, JSON) using exact `BigInt` micro-unit (`10,000n = 1.00`) arithmetic:
   - 1-to-1 Order-ID & Merchant-Ref matching
   - Counterparty entity alias + date-window matching (`滴滴` ↔ `北京小桔科技有限公司`, `阿里云` ↔ `阿里巴巴云计算`, etc.)
   - Cross-currency FX card spread matching (`USD`/`EUR`/`HKD` ↔ `CNY`)
   - Bounded combinatorial **N-to-1 subset-sum matching** (`合并开票凑单`, e.g., multiple ride-hail or cloud charges matching a single consolidated monthly tax invoice)
   - Duplicate transaction/invoice blocking + Buyer Tax-ID (`纳税人识别号`) compliance verification
   - Outputs structured JSON + OWASP formula-safe UTF-8 BOM CSV + Base64 **3-sheet OpenXML `.xlsx` Audit Workbook** (`01_Executive_Summary`, `02_Reconciled_Ledger`, `03_Anomalies_Checklist`)
2. **`extract_and_clean_pdf_tables_to_xlsx`** (`$0.02` / document) — Extracts tables from multi-page PDF binaries (`PyMuPDF` vector/spatial grid + pure-JS FlateDecode/CMap fallback), HTML (`rowspan`/`colspan` 2D expansion), Markdown, JSON/JSONL, or messy CSVs; stitches repeating headers across page breaks; strips illegal XML 1.0 control characters (`\x00–\x08`, `\x0B`, `\x0C`, `\x0E–\x1F`); keeps user cells strictly non-formula (`inlineStr`) while appending live `=SUM()` and `=AVERAGE()` summary rows; and outputs Base64 `.xlsx` + Markdown + UTF-8 BOM CSV.
3. **`repair_cjk_csv_mojibake`** (`$0.005` / file) — Detects and repairs garbled CJK CSV/TSV files from `GB18030`, `GBK`, `Big5`, `Shift_JIS`, `EUC-KR`, `UTF-16LE/BE`, and double-encoded `UTF-8-as-Latin1/Windows-1252` strings; heals unquoted currency thousands commas (`¥1,250.00`); armors 15+ digit IDs and leading zeros; and neutralizes OWASP CSV/DDE formula injection (`=`, `+`, `-`, `@`).

---

## Pay-Per-Event Pricing

| Event / Tool | Event Name | Flat Price (USD) | Typical Latency |
|---|---|---:|---:|
| `reconcile_statements_and_invoices` | `reconcile-statements-invoices` | **$0.020** | `30–180 ms` |
| `extract_and_clean_pdf_tables_to_xlsx` | `extract-pdf-tables-to-xlsx` | **$0.020** | `50–250 ms` |
| `repair_cjk_csv_mojibake` | `repair-cjk-csv-mojibake` | **$0.005** | `5–25 ms` |
| Batch Cold-Start Initialization *(Batch mode only)* | `actor-start` | **$0.001** | `<50 ms` |

*Failed or invalid tool calls are **never** charged.*

---

## Quick Connect — Hosted MCP (Apify Standby & MCPize)

### 1. Streamable HTTP MCP (Claude Desktop / Cursor / Windsurf / Inspector)

```json
{
  "mcpServers": {
    "docuclean-ledger": {
      "type": "streamable-http",
      "url": "https://2848823170--docuclean-ledger-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_APIFY_API_TOKEN>"
      }
    }
  }
}
```

### 2. Local `stdio` Mode (`npx` / Node 20+)

```json
{
  "mcpServers": {
    "docuclean-ledger": {
      "command": "node",
      "args": ["./src/index.js", "--stdio"]
    }
  }
}
```

---

## Tools

- `reconcile_statements_and_invoices`: Reconcile Alipay, WeChat Pay, Stripe, PayPal, and bank CSV/JSON statements against electronic invoices (`数电票` XML/PDF, UBL 2.1 XML, CSV, JSON) into a 3-sheet OpenXML `.xlsx` audit workbook and UTF-8 BOM CSV.
- `extract_and_clean_pdf_tables_to_xlsx`: Extract and clean multi-page PDF, HTML (`rowspan`/`colspan`), Markdown, JSON, or CSV tables into formula-ready OpenXML `.xlsx` and UTF-8 BOM CSV.
- `repair_cjk_csv_mojibake`: Detect and repair broken `GB18030`, `GBK`, `Big5`, `Shift_JIS`, `EUC-KR`, `UTF-16`, and `UTF-8-as-Latin1` CJK CSV files while neutralizing OWASP CSV/DDE formula injection.

---

## Tool Input Examples

### `reconcile_statements_and_invoices`

```json
{
  "statements": [
    {
      "filename": "alipay_2026_11.csv",
      "content": "交易创建时间,交易对方,商品说明,收/支,金额（元）,交易状态,交易订单号\n2026-11-05,阿里云计算有限公司,ECS云服务器,支出,368.00,交易成功,202611050001"
    }
  ],
  "invoices": [
    {
      "filename": "einvoice_aliyun.xml",
      "content": "<ElectronicInvoice><InvoiceNumber>26312000000088990011</InvoiceNumber><IssueTime>2026-11-06</IssueTime><SellerInformation><SellerName>阿里云计算有限公司</SellerName></SellerInformation><TotalTax-includedAmount>368.00</TotalTax-includedAmount></ElectronicInvoice>"
    }
  ],
  "baseCurrency": "CNY"
}
```

### `extract_and_clean_pdf_tables_to_xlsx`

```json
{
  "filename": "procurement_schedule.pdf",
  "contentBase64": "<BASE64_PDF_BYTES>",
  "mergePages": true,
  "dedupeRows": true,
  "injectFormulas": true
}
```

### `repair_cjk_csv_mojibake`

```json
{
  "filename": "legacy_gbk_export.csv",
  "contentBase64": "<BASE64_GB18030_OR_BIG5_BYTES>"
}
```

---

## Local Development & Verification

```bash
# Run full unit, OpenXML openpyxl cross-validation, stdio MCP, HTTP Standby MCP & Batch Actor suite
npm test

# Start Streamable HTTP + SSE MCP server on http://localhost:8080/mcp
npm run start:http

# Start stdio MCP server
npm run start:stdio
```
