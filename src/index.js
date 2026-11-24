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

  server.registerTool(
    'validate_multichain_address',
    {
      title: 'Validate & Normalize Multichain Wallet Address',
      description:
        'Cryptographically validates and normalizes addresses across EVM (EIP-55), Tron (Base58Check), Bitcoin (Bech32/Bech32m/Base58Check), Solana (Ed25519 curve vs PDA), TON (EQ/UQ CRC16 + bounce trap), XRP Ledger (r-address + X-address tag), Cosmos, and Stacks.',
      inputSchema: {
        address: z.string().describe('Wallet or contract address string to validate'),
        chain: z.string().optional().describe('Optional chain hint: auto, evm, tron, bitcoin, solana, ton, xrpl, cosmos, stacks'),
        expectedNetwork: z.enum(['any', 'mainnet', 'testnet']).optional().describe('Expected network environment'),
      },
    },
    async (args) => {
      const res = await executeCommercialTool('validate_multichain_address', args, { meter });
      return {
        content: [{ type: 'text', text: JSON.stringify(res.payload, null, 2) }],
        structuredContent: res.payload,
      };
    },
  );

  server.registerTool(
    'decode_and_audit_evm_calldata',
    {
      title: 'Decode & Audit Raw EVM Transaction Calldata',
      description:
        'Decodes raw hex EVM transaction payloads (`to`, `value`, `data`, `chainId`) across ERC-20/721/1155, Permit2, Uniswap V2/V3/UniversalRouter, 1inch, Multicall, and Safe, flagging unlimited approvals, zero-minOut MEV sandwich exposure, and DELEGATECALL takeovers.',
      inputSchema: {
        to: z.string().optional().describe('Target 0x contract or recipient address'),
        value: z.string().optional().describe('Native ETH value in wei (decimal or 0x hex)'),
        data: z.string().describe('0x-prefixed hex calldata string'),
        chainId: z.number().optional().describe('EVM Chain ID (default: 8453 Base)'),
        sender: z.string().optional().describe('Optional sender 0x address'),
        referenceTimestamp: z.number().optional().describe('Optional Unix timestamp in seconds'),
      },
    },
    async (args) => {
      const res = await executeCommercialTool('decode_and_audit_evm_calldata', args, { meter });
      return {
        content: [{ type: 'text', text: JSON.stringify(res.payload, null, 2) }],
        structuredContent: res.payload,
      };
    },
  );

  server.registerTool(
    'audit_eip712_signature_payload',
    {
      title: 'Audit Off-Chain EIP-712 Typed-Data Signature Payload',
      description:
        'Audits eth_signTypedData_v4 payloads (EIP-2612 Permit, DAI Permit, Permit2, Seaport, EIP-3009 x402, ForwardRequest, SafeTx) for unlimited allowances, zero-consideration NFT/token drains, DELEGATECALL, and domain spoofing.',
      inputSchema: {
        typedData: z.any().describe('eth_signTypedData_v4 JSON object or serialized JSON string'),
        expectedChainId: z.number().optional().describe('Optional expected EVM chainId'),
        expectedVerifyingContract: z.string().optional().describe('Optional expected 0x verifyingContract'),
        expectedRecipient: z.string().optional().describe('Optional expected 0x recipient for x402 / EIP-3009'),
        expectedMaxAmount: z.string().optional().describe('Optional maximum expected token amount'),
        referenceTimestamp: z.number().optional().describe('Optional Unix timestamp in seconds'),
      },
    },
    async (args) => {
      const res = await executeCommercialTool('audit_eip712_signature_payload', args, { meter });
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
