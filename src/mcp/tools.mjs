/**
 * Commercial MCP Tool Registry & Execution Dispatcher (`tools.mjs`).
 *
 * Exposes 3 high-demand deterministic financial & document processing tools:
 * 1. `reconcile_statements_and_invoices` ($0.02 PPE)
 * 2. `extract_and_clean_pdf_tables_to_xlsx` ($0.02 PPE)
 * 3. `repair_cjk_csv_mojibake` ($0.005 PPE)
 */

import { extractAndCleanTablesToXlsx, gridToNormalizedTable } from '../core/pdf-tables.mjs';
import { reconcileStatementsAndInvoices } from '../core/reconcile-engine.mjs';
import {
  buildSafeUtf8BomCsv,
  cleanCellText,
  decodeAndRepairCjk,
  decodeBase64ToBytes,
  healUnquotedCurrencyCommas,
} from '../core/sanitize.mjs';

export const MCP_TOOLS = [
  {
    name: 'reconcile_statements_and_invoices',
    title: 'Reconcile Bank / Payment Statements & Electronic Invoices',
    description:
      'Deterministically reconciles Alipay, WeChat Pay, Stripe, PayPal, or bank CSV/JSON statements against electronic invoices (CN Digital e-Invoice XML/PDF, UBL 2.1 XML, CSV, JSON) using exact BigInt micro-unit math: 1:1 order-ID matching, vendor+amount+date matching, cross-currency FX spread matching, and N-to-1 subset-sum combined invoice matching. Returns structured JSON summary, anomaly alerts (missing/orphan/duplicate invoices, buyer tax-ID mismatches), OWASP formula-safe UTF-8 BOM CSV, and a Base64-encoded 3-sheet OpenXML .xlsx audit workbook.',
    inputSchema: {
      type: 'object',
      properties: {
        statements: {
          type: 'array',
          description:
            'List of payment statement files ({ filename, content? | contentBase64? }) from Alipay, WeChat Pay, Stripe, or bank CSV/JSON exports.',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Statement filename (e.g. alipay_2026_11.csv)' },
              content: { type: 'string', description: 'UTF-8 or raw CSV/JSON text content' },
              contentBase64: {
                type: 'string',
                description: 'Base64-encoded raw bytes (ideal for GB18030/GBK Alipay or bank exports)',
              },
            },
            required: ['filename'],
          },
        },
        invoices: {
          type: 'array',
          description:
            'List of electronic invoice files ({ filename, content? | contentBase64? }) in CN e-Invoice XML/PDF, UBL XML, CSV, or JSON format.',
          items: {
            type: 'object',
            properties: {
              filename: { type: 'string', description: 'Invoice filename (e.g. einvoice_aliyun.xml)' },
              content: { type: 'string', description: 'XML, CSV, or JSON text content' },
              contentBase64: { type: 'string', description: 'Base64-encoded PDF or binary invoice bytes' },
            },
            required: ['filename'],
          },
        },
        baseCurrency: {
          type: 'string',
          description: '3-letter ISO base accounting currency (default: CNY)',
          default: 'CNY',
        },
        expectedBuyerName: {
          type: 'string',
          description: 'Optional expected company/entity Buyer Name for invoice header compliance auditing',
        },
        expectedBuyerTaxId: {
          type: 'string',
          description: 'Optional expected 18-char Buyer Tax ID / USCC for tax compliance auditing',
        },
        dateWindowDays: {
          type: 'number',
          description: 'Maximum days between payment date and invoice issue date (default: 45)',
          default: 45,
        },
        includeXlsxBase64: {
          type: 'boolean',
          description: 'Include Base64-encoded 3-sheet OpenXML .xlsx workbook in response (default: true)',
          default: true,
        },
      },
      required: ['statements'],
    },
    annotations: {
      title: 'Reconcile Statements & Invoices ($0.02)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'extract_and_clean_pdf_tables_to_xlsx',
    title: 'Extract & Clean Multi-Page PDF / HTML / Messy Tables to OpenXML XLSX',
    description:
      'Extracts tables from multi-page PDF binaries (Base64), HTML (with 2D rowspan/colspan expansion), Markdown, JSON/JSONL, or messy CSVs; automatically stitches repeating headers across page breaks, repairs CJK mojibake, strips illegal XML 1.0 control characters (\\x00-\\x08, \\x0B, \\x0C, \\x0E-\\x1F), neutralizes Excel formula/DDE injection on user cells while generating live =SUM() and =AVERAGE() summary rows, and outputs Base64 OpenXML .xlsx, Markdown, and UTF-8 BOM CSV.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Input filename with extension hint (e.g. financial_report.pdf, table.html)',
          default: 'document.pdf',
        },
        contentBase64: {
          type: 'string',
          description: 'Base64-encoded PDF or legacy-encoded file bytes',
        },
        content: {
          type: 'string',
          description: 'Direct HTML, Markdown, CSV, or JSON string payload (when not sending Base64 bytes)',
        },
        mergePages: {
          type: 'boolean',
          description: 'Stitch multi-page continuation tables sharing identical headers (default: true)',
          default: true,
        },
        dedupeRows: {
          type: 'boolean',
          description: 'Remove exact duplicate rows across pages (default: false)',
          default: false,
        },
        injectFormulas: {
          type: 'boolean',
          description: 'Append live =SUM() and =AVERAGE() summary rows to numeric columns (default: true)',
          default: true,
        },
      },
    },
    annotations: {
      title: 'Extract & Clean PDF Tables to XLSX ($0.02)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: 'repair_cjk_csv_mojibake',
    title: 'Repair CJK CSV Mojibake & Neutralize Formula Injection',
    description:
      'Detects and repairs garbled Chinese/Japanese/Korean CSV/TSV files from GB18030, GBK, Big5, Shift-JIS, EUC-KR, UTF-16LE/BE, and double-encoded UTF-8-as-Latin1/CP1252 strings; heals unquoted currency thousands commas (e.g. ¥1,250.00); strips dangerous PDF/clipboard control characters; armors 15+ digit IDs and leading zeros; and neutralizes OWASP CSV/DDE formula injection (=, +, -, @) into Excel-ready UTF-8 BOM CSV + structured JSON rows.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Optional source filename (e.g. alipay_export.csv)',
          default: 'export.csv',
        },
        contentBase64: {
          type: 'string',
          description: 'Base64-encoded raw CSV bytes (GBK/GB18030/Big5/Shift-JIS/UTF-16)',
        },
        content: {
          type: 'string',
          description: 'Garbled or raw CSV text (e.g. UTF-8 bytes mis-decoded as Latin-1/Windows-1252)',
        },
      },
    },
    annotations: {
      title: 'Repair CJK CSV Mojibake ($0.005)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

function parseSimpleCsvGrid(text) {
  const healed = healUnquotedCurrencyCommas(text);
  const nonEmpty = healed.split('\n').filter((l) => l.trim() !== '');
  if (nonEmpty.length === 0) return { delimiter: ',', headers: [], rows: [] };

  const delims = [',', '\t', ';'];
  let bestDelim = ',';
  let bestScore = -1;
  for (const d of delims) {
    const score = nonEmpty.slice(0, 15).reduce((acc, l) => acc + (l.split(d).length - 1), 0);
    if (score > bestScore) {
      bestScore = score;
      bestDelim = d;
    }
  }

  const rawRows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = healed.endsWith('\n') ? healed : `${healed}\n`;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.trim() === '') {
      field = '';
      inQuotes = true;
    } else if (ch === bestDelim) {
      row.push(cleanCellText(field));
      field = '';
    } else if (ch === '\n') {
      row.push(cleanCellText(field));
      field = '';
      if (row.some((c) => c !== '')) rawRows.push(row);
      row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  const norm = gridToNormalizedTable(rawRows, 'Repaired_CSV');
  if (!norm) return { delimiter: bestDelim, headers: [], rows: [] };
  return { delimiter: bestDelim, headers: norm.headers, rows: norm.rows };
}

/**
 * Executes one of the 3 commercial tools and triggers the corresponding Pay-Per-Event charge
 * ONLY after validation and deterministic execution succeed.
 */
export async function executeCommercialTool(toolName, args = {}, { meter = null, idempotencyKey = null } = {}) {
  const preCheckBudget = (eventName) => {
    if (!meter) return;
    const check = meter.canAfford(eventName, 1, idempotencyKey);
    if (!check.ok) {
      throw new Error(`Pay-Per-Event spending limit reached (${check.reason}).`);
    }
  };

  if (toolName === 'reconcile_statements_and_invoices') {
    if (!Array.isArray(args.statements) || args.statements.length === 0) {
      throw new Error('`reconcile_statements_and_invoices` requires a non-empty `statements` array.');
    }
    preCheckBudget('reconcile-statements-invoices');

    const result = await reconcileStatementsAndInvoices({
      statements: args.statements,
      invoices: Array.isArray(args.invoices) ? args.invoices : [],
      baseCurrency: args.baseCurrency || 'CNY',
      expectedBuyerName: args.expectedBuyerName || '',
      expectedBuyerTaxId: args.expectedBuyerTaxId || '',
      dateWindowDays: Number(args.dateWindowDays ?? 45),
    });

    const chargeReceipt = meter
      ? await meter.charge({ eventName: 'reconcile-statements-invoices', count: 1, idempotencyKey })
      : null;

    if (chargeReceipt && !chargeReceipt.charged) {
      throw new Error(`Pay-Per-Event spending limit reached (${chargeReceipt.reason}).`);
    }

    const includeXlsx = args.includeXlsxBase64 !== false;
    const payload = {
      tool: toolName,
      status: 'ok',
      billing: chargeReceipt,
      summary: result.summary,
      transactions: result.transactions,
      invoices: result.invoices,
      anomalies: result.anomalies,
      utf8BomCsv: result.utf8BomCsv,
      ...(includeXlsx ? { xlsxBase64: result.xlsxBase64, xlsxByteLength: result.xlsxBytes.length } : {}),
    };

    return {
      payload,
      binaryArtifacts: {
        xlsxBytes: result.xlsxBytes,
        utf8BomCsv: result.utf8BomCsv,
      },
      billing: chargeReceipt,
    };
  }

  if (toolName === 'extract_and_clean_pdf_tables_to_xlsx') {
    if (!args.contentBase64 && !args.content) {
      throw new Error(
        '`extract_and_clean_pdf_tables_to_xlsx` requires either `contentBase64` (PDF/binary bytes) or `content` (HTML/Markdown/CSV/JSON string).',
      );
    }
    preCheckBudget('extract-pdf-tables-to-xlsx');

    const result = await extractAndCleanTablesToXlsx({
      filename: args.filename || 'document.pdf',
      contentBase64: args.contentBase64 || '',
      content: args.content || '',
      mergePages: args.mergePages !== false,
      dedupeRows: Boolean(args.dedupeRows),
      injectFormulas: args.injectFormulas !== false,
    });

    const chargeReceipt = meter
      ? await meter.charge({ eventName: 'extract-pdf-tables-to-xlsx', count: 1, idempotencyKey })
      : null;

    if (chargeReceipt && !chargeReceipt.charged) {
      throw new Error(`Pay-Per-Event spending limit reached (${chargeReceipt.reason}).`);
    }

    const payload = {
      tool: toolName,
      status: 'ok',
      billing: chargeReceipt,
      summary: {
        filename: result.filename,
        extractorBackend: result.extractorBackend,
        detectedEncoding: result.detectedEncoding,
        mojibakeRepaired: result.mojibakeRepaired,
        pageCount: result.pageCount,
        tableCount: result.tableCount,
        totalRows: result.totalRows,
        stitchedPagesCount: result.stitchedPagesCount,
        duplicatesRemoved: result.duplicatesRemoved,
        xlsxByteLength: result.xlsxBytes.length,
      },
      tables: result.tables,
      markdown: result.markdown,
      utf8BomCsv: result.utf8BomCsv,
      xlsxBase64: result.xlsxBase64,
    };

    return {
      payload,
      binaryArtifacts: {
        xlsxBytes: result.xlsxBytes,
        utf8BomCsv: result.utf8BomCsv,
      },
      billing: chargeReceipt,
    };
  }

  if (toolName === 'repair_cjk_csv_mojibake') {
    if (!args.contentBase64 && typeof args.content !== 'string') {
      throw new Error(
        '`repair_cjk_csv_mojibake` requires either `contentBase64` (raw legacy bytes) or `content` (garbled string).',
      );
    }
    preCheckBudget('repair-cjk-csv-mojibake');

    const rawBytes = args.contentBase64 ? decodeBase64ToBytes(args.contentBase64) : null;
    const decoded = decodeAndRepairCjk({ bytes: rawBytes, text: args.content || '' });
    const parsedGrid = parseSimpleCsvGrid(decoded.text);
    const safeUtf8BomCsv =
      parsedGrid.headers.length > 0
        ? buildSafeUtf8BomCsv({
            headers: parsedGrid.headers,
            rows: parsedGrid.rows,
            withBom: true,
          })
        : `\uFEFF${decoded.text}`;

    const chargeReceipt = meter
      ? await meter.charge({ eventName: 'repair-cjk-csv-mojibake', count: 1, idempotencyKey })
      : null;

    if (chargeReceipt && !chargeReceipt.charged) {
      throw new Error(`Pay-Per-Event spending limit reached (${chargeReceipt.reason}).`);
    }

    const payload = {
      tool: toolName,
      status: 'ok',
      billing: chargeReceipt,
      summary: {
        filename: args.filename || 'export.csv',
        detectedEncoding: decoded.detectedEncoding,
        mojibakeRepaired: decoded.mojibakeRepaired,
        confidence: decoded.confidence,
        delimiter: parsedGrid.delimiter,
        columnCount: parsedGrid.headers.length,
        rowCount: parsedGrid.rows.length,
      },
      headers: parsedGrid.headers,
      rows: parsedGrid.rows,
      utf8BomCsv: safeUtf8BomCsv,
    };

    return {
      payload,
      binaryArtifacts: {
        xlsxBytes: null,
        utf8BomCsv: safeUtf8BomCsv,
      },
      billing: chargeReceipt,
    };
  }

  const err = new Error(`Unknown MCP tool: "${toolName}"`);
  err.code = -32602;
  throw err;
}
