/**
 * Official MCP SDK Entrypoint & Capability Registry (`src/index.js`).
 *
 * Registers all tools, resources, and prompts on `@modelcontextprotocol/sdk`'s `McpServer`
 * while unifying Apify Actor (Standby `/mcp` + Batch `storage/`) and MCPize Cloud Run
 * (`PORT=8080`, `POST /` & `POST /mcp`, `GET /health` & `GET /ping`, `x402` Base USDC).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { PayPerEventMeter } from './billing/ppe.mjs';
import { main, runBatchActor } from './main.mjs';
import { createHttpMcpServer, SERVER_INFO, startStdioMcpServer } from './mcp/server.mjs';
import { executeCommercialTool, MCP_TOOLS } from './mcp/tools.mjs';

const FileItemSchema = z.object({
  filename: z.string().describe('Source filename with extension (e.g. alipay_2026_11.csv, einvoice.xml)'),
  content: z.string().optional().describe('UTF-8, XML, CSV, or JSON text payload'),
  contentBase64: z.string().optional().describe('Base64-encoded raw binary or legacy CJK bytes'),
});

/**
 * Builds a fresh `@modelcontextprotocol/sdk` `McpServer` instance with all 3 commercial tools,
 * pricing resource, and workflow prompts registered.
 */
export function createMcpServer({ meter = null } = {}) {
  const server = new McpServer({
    name: SERVER_INFO.name,
    version: SERVER_INFO.version,
  });

  server.registerTool(
    'reconcile_statements_and_invoices',
    {
      title: 'Reconcile Bank / Payment Statements & Electronic Invoices',
      description:
        'Deterministically reconciles Alipay, WeChat Pay, Stripe, PayPal, or bank CSV/JSON statements against electronic invoices (CN Digital e-Invoice XML/PDF, UBL 2.1 XML, CSV, JSON) using exact BigInt micro-unit math (1:1, FX spread, and N-to-1 subset-sum matching) and outputs a 3-sheet OpenXML .xlsx audit workbook + UTF-8 BOM CSV.',
      inputSchema: {
        statements: z.array(FileItemSchema).describe('Payment statement files to reconcile'),
        invoices: z.array(FileItemSchema).optional().describe('Electronic invoice files to match against statements'),
        baseCurrency: z.string().optional().describe('3-letter ISO accounting currency (default: CNY)'),
        expectedBuyerName: z.string().optional().describe('Expected company Buyer Name for tax compliance checks'),
        expectedBuyerTaxId: z.string().optional().describe('Expected Buyer Tax ID / USCC for tax compliance checks'),
        dateWindowDays: z.number().optional().describe('Max day delta between payment and invoice (default: 45)'),
        includeXlsxBase64: z.boolean().optional().describe('Include Base64 3-sheet OpenXML .xlsx workbook (default: true)'),
      },
    },
    async (args) => {
      const res = await executeCommercialTool('reconcile_statements_and_invoices', args, { meter });
      return {
        content: [{ type: 'text', text: JSON.stringify(res.payload, null, 2) }],
        structuredContent: res.payload,
      };
    },
  );

  server.registerTool(
    'extract_and_clean_pdf_tables_to_xlsx',
    {
      title: 'Extract & Clean Multi-Page PDF / HTML / Messy Tables to OpenXML XLSX',
      description:
        'Extracts tables from multi-page PDF binaries (Base64), HTML (rowspan/colspan), Markdown, JSON, or messy CSVs; stitches repeating page headers; strips illegal XML 1.0 control chars; neutralizes Excel formula injection on user cells while appending live =SUM() / =AVERAGE() summary rows; outputs Base64 .xlsx, Markdown, and UTF-8 BOM CSV.',
      inputSchema: {
        filename: z.string().optional().describe('Input filename with extension hint (e.g. report.pdf, table.html)'),
        contentBase64: z.string().optional().describe('Base64-encoded PDF or legacy-encoded file bytes'),
        content: z.string().optional().describe('Direct HTML, Markdown, CSV, or JSON string payload'),
        mergePages: z.boolean().optional().describe('Stitch continuation tables sharing identical headers across pages'),
        dedupeRows: z.boolean().optional().describe('Remove exact duplicate rows across pages'),
        injectFormulas: z.boolean().optional().describe('Append live =SUM() and =AVERAGE() summary rows'),
      },
    },
    async (args) => {
      const res = await executeCommercialTool('extract_and_clean_pdf_tables_to_xlsx', args, { meter });
      return {
        content: [{ type: 'text', text: JSON.stringify(res.payload, null, 2) }],
        structuredContent: res.payload,
      };
    },
  );

  server.registerTool(
    'repair_cjk_csv_mojibake',
    {
      title: 'Repair CJK CSV Mojibake & Neutralize Formula Injection',
      description:
        'Detects and repairs garbled Chinese/Japanese/Korean CSV/TSV files from GB18030, GBK, Big5, Shift-JIS, EUC-KR, UTF-16LE/BE, and double-encoded UTF-8-as-Latin1/CP1252 strings; heals unquoted currency commas; armors 15+ digit IDs; and neutralizes OWASP CSV/DDE formula injection.',
      inputSchema: {
        filename: z.string().optional().describe('Optional source CSV filename'),
        contentBase64: z.string().optional().describe('Base64-encoded raw CSV bytes (GB18030/GBK/Big5/Shift-JIS/EUC-KR/UTF-16)'),
        content: z.string().optional().describe('Garbled or raw CSV text (e.g. UTF-8 mis-decoded as Latin-1/CP1252)'),
      },
    },
    async (args) => {
      const res = await executeCommercialTool('repair_cjk_csv_mojibake', args, { meter });
      return {
        content: [{ type: 'text', text: JSON.stringify(res.payload, null, 2) }],
        structuredContent: res.payload,
      };
    },
  );

  server.registerResource(
    'pricing',
    'mcp://docuclean-ledger-mcp/pricing',
    {
      title: 'Pay-Per-Event & x402 Pricing Catalog',
      description: 'Transparent per-call USD / USDC pricing for Apify Store & MCPize',
      mimeType: 'application/json',
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(
            {
              server: SERVER_INFO,
              events: meter ? meter.getCatalogSummary() : [],
            },
            null,
            2,
          ),
        },
      ],
    }),
  );

  server.registerPrompt(
    'monthly-bookkeeping-reconciliation',
    {
      description:
        'Reconcile monthly Alipay / WeChat Pay / Stripe exports against electronic invoices and list missing tax receipts.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Run reconcile_statements_and_invoices using docuclean-ledger-mcp tools.',
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'clean-financial-pdf-to-excel',
    {
      description:
        'Extract multi-page financial or procurement PDF tables into a clean, formula-ready .xlsx workbook.',
    },
    async () => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: 'Run extract_and_clean_pdf_tables_to_xlsx using docuclean-ledger-mcp tools.',
          },
        },
      ],
    }),
  );

  return server;
}

export const DEFAULT_PORT = parseInt(process.env.PORT || '8080', 10);

export {
  createHttpMcpServer,
  executeCommercialTool,
  main,
  MCP_TOOLS,
  PayPerEventMeter,
  runBatchActor,
  startStdioMcpServer,
  StdioServerTransport,
  StreamableHTTPServerTransport,
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[docuclean-ledger-mcp] Fatal error:', err?.stack || err);
    process.exit(1);
  });
}
