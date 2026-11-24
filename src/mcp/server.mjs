/**
 * Zero-Dependency Model Context Protocol (MCP) Server (`server.mjs`).
 *
 * Transports supported out of the box:
 * 1. `stdio` JSON-RPC 2.0 (supports both MCP newline-delimited JSON and LSP `Content-Length` framing)
 * 2. Streamable HTTP (`POST /mcp`, `GET /mcp`, `DELETE /mcp`) per MCP `2025-03-26` / `2024-11-05`
 * 3. Legacy HTTP + SSE (`GET /sse` + `POST /messages?sessionId=...`)
 * 4. Apify Standby Server readiness probe (`GET /` with `x-apify-container-server-readiness-probe`)
 *    plus `/health` and `/pricing` discovery endpoints for Apify Store & MCPize.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { executeCommercialTool, MCP_TOOLS } from './tools.mjs';

export const SERVER_INFO = {
  name: 'docuclean-ledger-mcp',
  version: '1.0.0',
};

const SUPPORTED_PROTOCOLS = ['2025-03-26', '2024-11-05', '2024-10-07'];

const MCP_PROMPTS = [
  {
    name: 'monthly-bookkeeping-reconciliation',
    description: 'Reconcile monthly Alipay / WeChat Pay / Stripe exports against electronic invoices and list missing tax receipts.',
    arguments: [
      { name: 'baseCurrency', description: 'Accounting base currency (CNY or USD)', required: false },
    ],
  },
  {
    name: 'clean-financial-pdf-to-excel',
    description: 'Extract multi-page financial or procurement PDF tables into a clean, formula-ready .xlsx workbook.',
    arguments: [],
  },
];

export async function handleJsonRpcMessage(msg, { meter, httpIdempotencyKey = null } = {}) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') {
    return {
      jsonrpc: '2.0',
      id: msg?.id ?? null,
      error: { code: -32600, message: 'Invalid JSON-RPC 2.0 request' },
    };
  }

  const isNotification = msg.id === undefined;
  const { id, method, params = {} } = msg;

  try {
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
      return null;
    }

    if (method === 'initialize') {
      const requested = String(params.protocolVersion || '2024-11-05');
      const negotiated = SUPPORTED_PROTOCOLS.includes(requested) ? requested : '2024-11-05';
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: negotiated,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: SERVER_INFO,
          instructions:
            'Use reconcile_statements_and_invoices for payment/invoice matching, extract_and_clean_pdf_tables_to_xlsx for PDF/HTML/messy table conversion to OpenXML .xlsx, and repair_cjk_csv_mojibake for garbled CJK CSV files.',
        },
      };
    }

    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }

    if (method === 'tools/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: { tools: MCP_TOOLS },
      };
    }

    if (method === 'tools/call') {
      const toolName = params.name;
      const toolArgs = params.arguments || {};
      if (!toolName || !MCP_TOOLS.some((t) => t.name === toolName)) {
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32602, message: `Unknown tool: "${toolName}"` },
        };
      }

      try {
        const execRes = await executeCommercialTool(toolName, toolArgs, {
          meter,
          idempotencyKey: params._meta?.idempotencyKey || httpIdempotencyKey || null,
        });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(execRes.payload, null, 2),
              },
            ],
            structuredContent: execRes.payload,
            isError: false,
          },
          _billing: execRes.billing,
        };
      } catch (toolErr) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    status: 'error',
                    tool: toolName,
                    error: toolErr?.message || String(toolErr),
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: true,
          },
        };
      }
    }

    if (method === 'resources/list') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          resources: [
            {
              uri: 'mcp://docuclean-ledger-mcp/pricing',
              name: 'Pay-Per-Event Pricing Catalog',
              description: 'Transparent per-call USD event pricing for Apify Store & MCPize',
              mimeType: 'application/json',
            },
          ],
        },
      };
    }

    if (method === 'resources/read') {
      if (params.uri === 'mcp://docuclean-ledger-mcp/pricing') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri: params.uri,
                mimeType: 'application/json',
                text: JSON.stringify(
                  {
                    server: SERVER_INFO,
                    events: meter ? meter.getCatalogSummary() : [],
                    totalChargedUsdInSession: meter ? meter.totalChargedUsd : 0,
                  },
                  null,
                  2,
                ),
              },
            ],
          },
        };
      }
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: `Resource not found: ${params.uri}` },
      };
    }

    if (method === 'prompts/list') {
      return { jsonrpc: '2.0', id, result: { prompts: MCP_PROMPTS } };
    }

    if (method === 'prompts/get') {
      const prompt = MCP_PROMPTS.find((p) => p.name === params.name);
      if (!prompt) {
        return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown prompt: ${params.name}` } };
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          description: prompt.description,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Run ${prompt.name} using docuclean-ledger-mcp tools (${JSON.stringify(params.arguments || {})}).`,
              },
            },
          ],
        },
      };
    }

    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Method not found: "${method}"` },
    };
  } catch (err) {
    if (isNotification) return null;
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: err?.message || 'Internal MCP server error' },
    };
  }
}

function stripInternalMeta(resp) {
  if (!resp || typeof resp !== 'object') return resp;
  const { _billing, ...clean } = resp;
  void _billing;
  return clean;
}

/**
 * Starts the MCP Server over `stdio` (supports both newline-delimited JSON and `Content-Length` headers).
 */
export function startStdioMcpServer({ meter, input = process.stdin, output = process.stdout } = {}) {
  let buffer = Buffer.alloc(0);

  const writeResponse = (resp, useContentLength) => {
    const clean = stripInternalMeta(resp);
    const json = JSON.stringify(clean);
    if (useContentLength) {
      const byteLen = Buffer.byteLength(json, 'utf8');
      output.write(`Content-Length: ${byteLen}\r\n\r\n${json}`);
    } else {
      output.write(`${json}\n`);
    }
  };

  const processPayload = async (rawStr, useContentLength) => {
    const trimmed = rawStr.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeResponse(
        { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
        useContentLength,
      );
      return;
    }

    if (Array.isArray(parsed)) {
      const results = (
        await Promise.all(parsed.map((item) => handleJsonRpcMessage(item, { meter })))
      ).filter(Boolean);
      if (results.length > 0) {
        const cleanedBatch = results.map(stripInternalMeta);
        const json = JSON.stringify(cleanedBatch);
        if (useContentLength) {
          output.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
        } else {
          output.write(`${json}\n`);
        }
      }
      return;
    }

    const res = await handleJsonRpcMessage(parsed, { meter });
    if (res) writeResponse(res, useContentLength);
  };

  const drainBuffer = () => {
    while (buffer.length > 0) {
      const headerProbe = buffer.subarray(0, Math.min(buffer.length, 64)).toString('ascii');
      if (/^Content-Length:/i.test(headerProbe)) {
        const sepIdx = buffer.indexOf('\r\n\r\n');
        if (sepIdx === -1) return;
        const headerStr = buffer.subarray(0, sepIdx).toString('ascii');
        const m = headerStr.match(/Content-Length:\s*(\d+)/i);
        const contentLen = m ? Number(m[1]) : 0;
        const totalFrameLen = sepIdx + 4 + contentLen;
        if (buffer.length < totalFrameLen) return;
        const bodyStr = buffer.subarray(sepIdx + 4, totalFrameLen).toString('utf8');
        buffer = buffer.subarray(totalFrameLen);
        void processPayload(bodyStr, true);
      } else {
        const nlIdx = buffer.indexOf(0x0a);
        if (nlIdx === -1) return;
        const lineStr = buffer.subarray(0, nlIdx).toString('utf8');
        buffer = buffer.subarray(nlIdx + 1);
        void processPayload(lineStr, false);
      }
    }
  };

  input.on('data', (chunk) => {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, b]);
    drainBuffer();
  });
}

function readHttpBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        rejectBody(new Error('Request payload exceeds 32 MB limit'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

/**
 * Starts the Streamable HTTP + SSE + Apify Standby HTTP Server.
 */
export function createHttpMcpServer({ meter } = {}) {
  const sseSessions = new Map();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS headers for browser-based MCP Inspectors & Web Gateways
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Accept, Mcp-Session-Id, X-Payment, Idempotency-Key',
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id, X-MCP-Billed-Event, X-MCP-Billed-USD',
    );

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 1. Apify Standby Container Readiness Probe & Root Info
    if (req.method === 'GET' && (pathname === '/' || pathname === '/health')) {
      const isReadinessProbe = Boolean(req.headers['x-apify-container-server-readiness-probe']);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          status: 'ready',
          readinessProbe: isReadinessProbe,
          server: SERVER_INFO,
          mcpEndpoint: '/mcp',
          sseEndpoint: '/sse',
          pricingEndpoint: '/pricing',
          tools: MCP_TOOLS.map((t) => t.name),
        }),
      );
      return;
    }

    // 2. Public Pay-Per-Event Pricing Endpoint
    if (req.method === 'GET' && pathname === '/pricing') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          server: SERVER_INFO,
          currency: 'USD',
          creatorRevenueSharePct: 80,
          events: meter ? meter.getCatalogSummary() : [],
          sessionTotalChargedUsd: meter ? meter.totalChargedUsd : 0,
        }),
      );
      return;
    }

    // 3. Streamable HTTP MCP Endpoint (`/mcp`)
    if (pathname === '/mcp') {
      const sessionId = req.headers['mcp-session-id'] || randomUUID();
      res.setHeader('Mcp-Session-Id', String(sessionId));

      if (req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ closed: true, sessionId }));
        return;
      }

      if (req.method === 'GET') {
        // Streamable HTTP SSE listener stream
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        req.on('close', () => res.end());
        return;
      }

      if (req.method === 'POST') {
        let rawBody;
        try {
          rawBody = await readHttpBody(req);
        } catch (err) {
          res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(rawBody);
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'Invalid JSON payload' },
            }),
          );
          return;
        }

        const isBatch = Array.isArray(parsed);
        const items = isBatch ? parsed : [parsed];
        const hdrIdemKey = !isBatch && req.headers['idempotency-key']
          ? String(req.headers['idempotency-key'])
          : null;
        const rawResponses = (
          await Promise.all(
            items.map((item) =>
              handleJsonRpcMessage(item, { meter, httpIdempotencyKey: hdrIdemKey }),
            ),
          )
        ).filter(Boolean);

        // Notifications-only request -> 202 Accepted per MCP Streamable HTTP spec
        if (rawResponses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const billed = rawResponses.find((r) => r._billing?.charged)?._billing;
        if (billed) {
          res.setHeader('X-MCP-Billed-Event', billed.eventName);
          res.setHeader('X-MCP-Billed-USD', String(billed.amountUsd));
        }

        const cleanPayload = isBatch
          ? rawResponses.map(stripInternalMeta)
          : stripInternalMeta(rawResponses[0]);

        const accept = String(req.headers.accept || '');
        if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
          });
          res.write(`event: message\ndata: ${JSON.stringify(cleanPayload)}\n\n`);
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(cleanPayload));
        }
        return;
      }
    }

    // 4. Legacy MCP SSE Transport (`GET /sse` + `POST /messages`)
    if (req.method === 'GET' && pathname === '/sse') {
      const sessionId = randomUUID();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
      sseSessions.set(sessionId, res);
      req.on('close', () => sseSessions.delete(sessionId));
      return;
    }

    if (req.method === 'POST' && pathname === '/messages') {
      const sessionId = url.searchParams.get('sessionId') || '';
      const sseRes = sseSessions.get(sessionId);
      let rawBody;
      try {
        rawBody = await readHttpBody(req);
      } catch (err) {
        res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Invalid JSON payload' },
          }),
        );
        return;
      }
      const hdrIdemKey = req.headers['idempotency-key']
        ? String(req.headers['idempotency-key'])
        : null;
      const rpcRes = await handleJsonRpcMessage(parsed, { meter, httpIdempotencyKey: hdrIdemKey });
      const clean = stripInternalMeta(rpcRes);
      if (sseRes && clean) {
        sseRes.write(`event: message\ndata: ${JSON.stringify(clean)}\n\n`);
      }
      res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(clean ?? { accepted: true }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found', mcpEndpoint: '/mcp' }));
  });

  return server;
}
