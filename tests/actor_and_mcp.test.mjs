/**
 * End-to-End Automated Verification & Adversarial Security Torture Suite (`actor_and_mcp.test.mjs`).
 *
 * Covers:
 * 1. Apify `.actor/*` (`actor.json`, `input_schema.json`, `output_schema.json`, `dataset_schema.json`,
 *    `pay_per_event.json`), `mcpize.yaml`, `server.json`, `Dockerfile`, and `PUBLISH_APIFY_MCPIZE.md` compliance.
 * 2. `repair_cjk_csv_mojibake`: GB18030/GBK raw bytes, UTF-16LE BOM, UTF-8-as-Windows-1252 double mojibake,
 *    unquoted currency commas `(¥1,250.50)`, illegal XML/PDF control chars `\x00-\x08\x0b\x0c\x0e-\x1f`,
 *    and OWASP CSV/DDE formula injection (`=CMD|'/C calc'!A0`, `+SUM(1,2)`, `-2+3+cmd`, `@IMPORTXML`, `\t=CMD`).
 * 3. `extract_and_clean_pdf_tables_to_xlsx`: Real 2-page Chinese vector PDF generated via Python `PyMuPDF` (`fitz`)
 *    with repeating page headers, section divider `=== 第一阶段 ===`, DDE payload, and control chars —
 *    cross-validated in Python `openpyxl.load_workbook(..., data_only=False)` proving `0` XML parse errors,
 *    `0` user formula (`'f'`) cells, and valid live `=SUM(...)` / `=AVERAGE(...)` summary rows + HTML `rowspan`/`colspan`.
 * 4. `reconcile_statements_and_invoices`: Real GBK Alipay CSV + WeChat Pay CSV (with embedded partial refund) +
 *    CN Digital e-Invoice XML + 3-to-1 Didi subset-sum combined invoice + duplicate invoice blocking +
 *    buyer Tax-ID mismatch alert + 3-sheet `.xlsx` verified in Python `openpyxl`.
 * 5. MCP `stdio` JSON-RPC 2.0 E2E (both newline-delimited JSON and LSP `Content-Length` framing).
 * 6. MCP Streamable HTTP (`/mcp`) + Legacy SSE (`/sse` + `/messages`) + Apify Standby Readiness Probe +
 *    Mock Apify Cloud PPE `/v2/actor-runs/:runId/charge` API + `APIFY_MAX_TOTAL_CHARGE_USD` budget ceiling.
 * 7. Apify Batch Actor Mode (`storage/key_value_stores/default/INPUT.json` -> `OUTPUT.json` + `OUTPUT.xlsx` +
 *    `OUTPUT.csv` + `PPE_CHARGES.json` + `datasets/default/000000001.json`).
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { PayPerEventMeter } from '../src/billing/ppe.mjs';
import { createMcpServer } from '../src/index.js';
import { runBatchActor } from '../src/main.mjs';
import { createHttpMcpServer } from '../src/mcp/server.mjs';
import { executeCommercialTool } from '../src/mcp/tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');

function runPythonJson(script, stdinBuffer = null) {
  const out = execFileSync('python', ['-c', script], {
    input: stdinBuffer ? Buffer.from(stdinBuffer) : undefined,
    timeout: 20000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(out.toString('utf8'));
}

function encodeWithPython(text, encoding) {
  const script = `
import sys
data = sys.stdin.buffer.read().decode('utf-8')
sys.stdout.buffer.write(data.encode('${encoding}'))
`;
  return execFileSync('python', ['-c', script], {
    input: Buffer.from(text, 'utf8'),
    timeout: 10000,
  });
}

function inspectXlsxWithOpenpyxl(xlsxBase64) {
  const script = `
import sys, io, json, base64
import openpyxl

raw = base64.b64decode(sys.stdin.buffer.read())
wb = openpyxl.load_workbook(io.BytesIO(raw), data_only=False)
sheets = {}
for name in wb.sheetnames:
    ws = wb[name]
    rows = []
    for r in range(1, ws.max_row + 1):
        row_cells = []
        for c in range(1, ws.max_column + 1):
            cell = ws.cell(row=r, column=c)
            row_cells.append({
                "coord": cell.coordinate,
                "value": cell.value,
                "data_type": cell.data_type
            })
        rows.append(row_cells)
    sheets[name] = {
        "max_row": ws.max_row,
        "max_col": ws.max_column,
        "freeze_panes": ws.freeze_panes,
        "auto_filter": ws.auto_filter.ref if ws.auto_filter else None,
        "rows": rows
    }
sys.stdout.buffer.write(json.dumps({"sheetnames": wb.sheetnames, "sheets": sheets}, ensure_ascii=False).encode("utf-8"))
`;
  return runPythonJson(script, Buffer.from(xlsxBase64, 'utf8'));
}

test('1. Apify .actor schemas, Pay-Per-Event config, MCPize manifest, Dockerfile, and publish guide are valid', () => {
  const actorJson = JSON.parse(readFileSync(resolve(ROOT_DIR, '.actor/actor.json'), 'utf8'));
  assert.equal(actorJson.actorSpecification, 1);
  assert.equal(actorJson.name, 'docuclean-ledger-mcp');
  assert.match(actorJson.version, /^\d+\.\d+$/, 'Apify actor.json version must be MAJOR.MINOR');
  assert.equal(actorJson.usesStandbyMode, true);
  assert.equal(actorJson.webServerMcpPath, '/mcp');
  assert.ok(existsSync(resolve(ROOT_DIR, '.actor', actorJson.dockerfile)));
  assert.ok(existsSync(resolve(ROOT_DIR, '.actor', actorJson.readme)));

  const inputSchema = JSON.parse(readFileSync(resolve(ROOT_DIR, '.actor/input_schema.json'), 'utf8'));
  assert.equal(inputSchema.schemaVersion, 1);
  assert.equal(inputSchema.type, 'object');
  const validEditors = new Set(['select', 'json', 'textfield', 'textarea', 'checkbox', 'number']);
  for (const [propName, propDef] of Object.entries(inputSchema.properties)) {
    assert.ok(
      validEditors.has(propDef.editor),
      `Property ${propName} must specify a valid Apify UI editor`,
    );
  }

  const outputSchema = JSON.parse(readFileSync(resolve(ROOT_DIR, '.actor/output_schema.json'), 'utf8'));
  assert.equal(outputSchema.actorOutputSchemaVersion, 1);

  const datasetSchema = JSON.parse(readFileSync(resolve(ROOT_DIR, '.actor/dataset_schema.json'), 'utf8'));
  assert.equal(datasetSchema.actorSpecification, 1);

  const ppeMeter = new PayPerEventMeter();
  const events = ppeMeter.getCatalogSummary();
  assert.equal(events.length, 4);
  const byName = Object.fromEntries(events.map((e) => [e.eventName, e.eventPriceUsd]));
  assert.equal(byName['reconcile-statements-invoices'], 0.02);
  assert.equal(byName['extract-pdf-tables-to-xlsx'], 0.02);
  assert.equal(byName['repair-cjk-csv-mojibake'], 0.005);
  assert.equal(byName['actor-start'], 0.001);

  const mcpizeYaml = readFileSync(resolve(ROOT_DIR, 'mcpize.yaml'), 'utf8');
  assert.match(mcpizeYaml, /name:\s*docuclean-ledger-mcp/);
  assert.match(mcpizeYaml, /runtime:\s*container/);
  assert.match(mcpizeYaml, /type:\s*http/);
  assert.match(mcpizeYaml, /protocol:\s*x402/);
  assert.match(mcpizeYaml, /network:\s*base/);
  assert.match(mcpizeYaml, /0xfEbDbB880C7f323c145d61683874a45540208a68/);
  assert.doesNotMatch(mcpizeYaml, /0x439Ba3BcFe084fd7A9CF81ee61d5761A1C1B6634/i);
  assert.doesNotMatch(mcpizeYaml, /^\s*(title|transport|monetization):/m);

  const sdkServer = createMcpServer({ meter: ppeMeter });
  assert.ok(sdkServer && typeof sdkServer.connect === 'function');

  const publishDoc = readFileSync(resolve(ROOT_DIR, 'PUBLISH_APIFY_MCPIZE.md'), 'utf8');
  assert.match(publishDoc, /apify-cli/);
  assert.match(publishDoc, /mcpize@latest/);
  assert.doesNotMatch(publishDoc, /Gumroad|Lemon\s*Squeezy/i);
});

test('2. repair_cjk_csv_mojibake repairs GB18030, UTF-16LE, and UTF8-as-CP1252 mojibake while neutralizing DDE & control chars', async () => {
  const meter = new PayPerEventMeter();
  const nastyCsvText = [
    '订单编号,客户名称,备注说明,实付金额',
    '00128450,杭州云栖科技有限公司,"=== 第一阶段 === \x0c\x0b\x07\x01",(¥1,250.50)',
    '2026110522001489021455889901,深圳前海跨境贸易,"=CMD|\'/C calc\'!A0 & <tag> ]]>",¥3,400.00',
    '00991002,上海星辰设计工作室,+SUM(A1:A2),¥88.00',
    '00991003,北京极客工作室,@IMPORTXML("http://evil"),-25.00',
  ].join('\r\n');

  // 2a. Raw GB18030 bytes
  const gb18030Bytes = encodeWithPython(nastyCsvText, 'gb18030');
  const gbRes = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    {
      filename: 'alipay_gbk.csv',
      contentBase64: gb18030Bytes.toString('base64'),
    },
    { meter },
  );

  assert.equal(gbRes.payload.summary.detectedEncoding, 'gb18030');
  assert.equal(gbRes.payload.summary.mojibakeRepaired, true);
  assert.equal(gbRes.payload.summary.columnCount, 4);
  assert.equal(gbRes.payload.summary.rowCount, 4);
  assert.equal(gbRes.payload.rows[0][0], '00128450');
  assert.equal(gbRes.payload.rows[0][1], '杭州云栖科技有限公司');
  assert.equal(gbRes.payload.rows[0][3], '(¥1,250.50)');
  // Illegal control chars (\x00-\x08, \x0b, \x0c, \x0e-\x1f) must be 100% gone
  assert.equal(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(gbRes.payload.utf8BomCsv), false);
  // UTF-8 BOM present
  assert.equal(gbRes.payload.utf8BomCsv.charCodeAt(0), 0xfeff);
  // Every dangerous formula/section cell is prefixed with leading apostrophe in CSV
  assert.match(gbRes.payload.utf8BomCsv, /'=== 第一阶段 ===/);
  assert.match(gbRes.payload.utf8BomCsv, /'=CMD\|'\/C calc'!A0/);
  assert.match(gbRes.payload.utf8BomCsv, /'\+SUM\(A1:A2\)/);
  assert.match(gbRes.payload.utf8BomCsv, /'@IMPORTXML/);
  // Leading-zero and 28-digit IDs armored with apostrophe
  assert.match(gbRes.payload.utf8BomCsv, /'00128450/);
  assert.match(gbRes.payload.utf8BomCsv, /'2026110522001489021455889901/);

  // 2b. Double-encoded UTF-8 mis-decoded as Latin-1
  const cleanUtf8 = '交易单号,商户名称,金额\nTX9001,阿里巴巴云计算,¥368.00\nTX9002,顺丰速运,¥42.50';
  const garbledLatin1 = Buffer.from(cleanUtf8, 'utf8').toString('latin1');
  const dblRes = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    { filename: 'garbled.csv', content: garbledLatin1 },
    { meter },
  );
  assert.equal(dblRes.payload.summary.mojibakeRepaired, true);
  assert.equal(dblRes.payload.rows[0][1], '阿里巴巴云计算');
  assert.equal(dblRes.payload.rows[1][1], '顺丰速运');

  // 2c. UTF-16LE with BOM + Big5 + Shift-JIS raw byte streams
  const utf16Bom = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(cleanUtf8, 'utf16le')]);
  const u16Res = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    { filename: 'u16.csv', contentBase64: utf16Bom.toString('base64') },
    { meter },
  );
  assert.equal(u16Res.payload.summary.detectedEncoding, 'utf-16le');
  assert.equal(u16Res.payload.rows[0][1], '阿里巴巴云计算');

  const big5Bytes = encodeWithPython('訂單編號,客戶名稱,實付金額\nTW01,台灣雲端科技,1200.00', 'big5');
  const big5Res = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    { filename: 'tw_big5.csv', contentBase64: big5Bytes.toString('base64') },
    { meter },
  );
  assert.equal(big5Res.payload.rows[0][1], '台灣雲端科技');

  const sjisBytes = encodeWithPython('注文番号,取引先名,金額\nJP01,東京クラウド株式会社,5400', 'shift_jis');
  const sjisRes = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    { filename: 'jp_sjis.csv', contentBase64: sjisBytes.toString('base64') },
    { meter },
  );
  assert.equal(sjisRes.payload.summary.detectedEncoding, 'shift_jis');
  assert.equal(sjisRes.payload.rows[0][1], '東京クラウド株式会社');

  const sjisKanjiBytes = encodeWithPython('注文番号,取引先名,金額\nJP02,東京商事株式会社,8200', 'shift_jis');
  const sjisKanjiRes = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    { filename: 'jp_kanji.csv', contentBase64: sjisKanjiBytes.toString('base64') },
    { meter },
  );
  assert.equal(sjisKanjiRes.payload.summary.detectedEncoding, 'shift_jis');
  assert.equal(sjisKanjiRes.payload.rows[0][1], '東京商事株式会社');

  const euckrBytes = encodeWithPython('주문번호,거래처명,결제금액\nKR01,서울클라우드주식회사,50000', 'euc_kr');
  const euckrRes = await executeCommercialTool(
    'repair_cjk_csv_mojibake',
    { filename: 'kr_euckr.csv', contentBase64: euckrBytes.toString('base64') },
    { meter },
  );
  assert.equal(euckrRes.payload.summary.detectedEncoding, 'euc-kr');
  assert.equal(euckrRes.payload.rows[0][1], '서울클라우드주식회사');
  assert.equal(meter.totalChargedUsd, 0.035);
});

test('3. extract_and_clean_pdf_tables_to_xlsx extracts 2-page CJK vector PDF + HTML rowspan/colspan into openpyxl-verified XLSX with zero formula injection', async () => {
  // Generate a real 2-page vector-bordered PDF with CJK font (`china-s`), repeating headers,
  // section dividers `=== 第一阶段 ===`, and adversarial `=CMD|'/C calc'!A0 & <tag> ]]>` text!
  const pdfBase64 = execFileSync(
    'python',
    [
      '-c',
      `
import fitz, base64, sys

doc = fitz.open()
rows_p1 = [
    ["项目编号", "项目名称", "备注与安全测试", "预算金额"],
    ["00101", "云原生数据仓库", "=== 第一阶段 ===", "¥1,200.00"],
    ["00102", "智能对账网关", "=CMD|'/C calc'!A0 & <tag> ]]>", "¥800.50"],
]
rows_p2 = [
    ["项目编号", "项目名称", "备注与安全测试", "预算金额"],
    ["00103", "多语种文档清洗", "=SUM(1,2)普通文本说明", "¥1,500.25"],
    ["00104", "跨境税务合规包", "正常验收通过", "¥499.25"],
]

for page_rows in [rows_p1, rows_p2]:
    page = doc.new_page(width=595, height=420)
    x_edges = [30, 100, 210, 485, 565]
    y_top = 60
    row_h = 30
    for r_i, r in enumerate(page_rows):
        y0 = y_top + r_i * row_h
        y1 = y0 + row_h
        for c_i, val in enumerate(r):
            rect = fitz.Rect(x_edges[c_i], y0, x_edges[c_i + 1], y1)
            page.draw_rect(rect, color=(0.2, 0.3, 0.4), width=0.8)
            page.insert_text((x_edges[c_i] + 4, y0 + 19), val, fontsize=8, fontname="china-s")

sys.stdout.buffer.write(base64.b64encode(doc.tobytes()))
`,
    ],
    { timeout: 15000 },
  ).toString('utf8');

  const meter = new PayPerEventMeter();
  const pdfRes = await executeCommercialTool(
    'extract_and_clean_pdf_tables_to_xlsx',
    {
      filename: 'q4_budget_schedule.pdf',
      contentBase64: pdfBase64,
      mergePages: true,
      dedupeRows: true,
      injectFormulas: true,
    },
    { meter },
  );

  assert.equal(pdfRes.payload.summary.pageCount, 2);
  assert.equal(pdfRes.payload.summary.tableCount, 1);
  assert.equal(pdfRes.payload.summary.stitchedPagesCount, 1);
  assert.equal(pdfRes.payload.summary.totalRows, 4);
  assert.equal(meter.totalChargedUsd, 0.02);

  // Cross-validate generated .xlsx in Python openpyxl!
  const wbInfo = inspectXlsxWithOpenpyxl(pdfRes.payload.xlsxBase64);
  assert.equal(wbInfo.sheetnames.length, 1);
  const sheet = wbInfo.sheets[wbInfo.sheetnames[0]];
  assert.equal(sheet.freeze_panes, 'A2');
  assert.equal(sheet.auto_filter, 'A1:D5');

  // Verify user rows (rows 2..5, 0-indexed 1..4):
  // - Leading-zero IDs ("00101") preserved as 's'
  // - Adversarial `=== 第一阶段 ===`, `=CMD|...`, `=SUM(1,2)普通文本说明` MUST be 's' (NEVER 'f'!)
  // - Currency column D parsed as numeric 'n' (1200, 800.5, 1500.25, 499.25)
  for (let rIdx = 1; rIdx <= 4; rIdx++) {
    const row = sheet.rows[rIdx];
    assert.equal(row[0].data_type, 's', `ID cell at row ${rIdx + 1} must remain string`);
    assert.equal(row[2].data_type, 's', `User text starting with '=' at row ${rIdx + 1} must NEVER be formula 'f'`);
    assert.equal(row[3].data_type, 'n', `Currency cell at row ${rIdx + 1} must be numeric 'n'`);
  }
  assert.equal(sheet.rows[1][0].value, '00101');
  assert.equal(sheet.rows[1][2].value, '=== 第一阶段 ===');
  assert.match(sheet.rows[2][2].value, /^=CMD\|'\/C calc'!A0/);

  // Verify summary rows 6 & 7 ARE real Excel formulas ('f')!
  assert.equal(sheet.rows[5][3].data_type, 'f');
  assert.equal(sheet.rows[5][3].value, '=SUM(D2:D5)');
  assert.equal(sheet.rows[6][3].data_type, 'f');
  assert.equal(sheet.rows[6][3].value, '=AVERAGE(D2:D5)');

  // Also verify HTML rowspan/colspan + control-char stripping
  const htmlInput = `
    <table>
      <caption>季度采购汇总</caption>
      <tr><th>部门</th><th colspan="2">项目与说明</th><th>金额</th></tr>
      <tr><td rowspan="2">研发部</td><td>服务器扩容</td><td>=CMD|test \x0c\x07</td><td>¥2,000.00</td></tr>
      <tr><td>安全审计</td><td>正常服务</td><td>¥1,000.00</td></tr>
    </table>
  `;
  const htmlRes = await executeCommercialTool('extract_and_clean_pdf_tables_to_xlsx', {
    filename: 'dept.html',
    content: htmlInput,
  });
  assert.equal(htmlRes.payload.summary.tableCount, 1);
  assert.equal(htmlRes.payload.tables[0].rows[1][0], '研发部');
  const htmlWb = inspectXlsxWithOpenpyxl(htmlRes.payload.xlsxBase64);
  assert.equal(htmlWb.sheets['季度采购汇总'].rows[1][2].data_type, 's');
});

test('4. reconcile_statements_and_invoices handles GBK Alipay, WeChat partial refunds, 3-to-1 subset-sum, duplicate & tax-ID alerts', async () => {
  const alipayCsvUtf8 = [
    '# 支付宝交易明细导出',
    '交易创建时间,交易对方,商品说明,收/支,金额（元）,服务费（元）,交易状态,交易订单号,商家订单号',
    '2026-11-02 10:00:00,客户甲,SaaS年度订阅,收入,500.00,3.00,交易成功,2026110200001001,M9001',
    '2026-11-05 09:15:00,阿里巴巴云计算,ECS服务器续费,支出,368.00,0.00,交易成功,2026110500002001,ALIYUN889901',
    '2026-11-06 21:10:00,滴滴出行,加班快车1,支出,42.00,0.00,交易成功,2026110600003001,DIDI01',
    '2026-11-08 22:05:00,滴滴快车,加班快车2,支出,118.00,0.00,交易成功,2026110800003002,DIDI02',
    '2026-11-12 20:40:00,北京小桔科技有限公司,机场专车3,支出,140.00,0.00,交易成功,2026111200003003,DIDI03',
    '2026-11-15 14:00:00,星巴克咖啡,商务接待无票,支出,38.00,0.00,交易成功,2026111500004001,SBUX01',
  ].join('\r\n');
  const alipayGbkBytes = encodeWithPython(alipayCsvUtf8, 'gb18030');

  const wechatCsv = [
    '微信支付账单明细',
    '----------------------微信支付账单明细列表--------------------',
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-11-10 11:20:00,商户消费,顺丰速运,生鲜冷链寄件,支出,¥100.00,招商银行,已退款(￥20.00),420000202611109988,SF8801,部分保价退回',
  ].join('\r\n');

  const invoices = [
    {
      filename: 'einvoice_aliyun_368.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?>
        <ElectronicInvoice>
          <InvoiceNumber>263320000000368001</InvoiceNumber>
          <IssueTime>2026-11-06</IssueTime>
          <BuyerInformation><BuyerName>杭州自持智能科技有限公司</BuyerName><BuyerIdNum>91330100MA27XXXXXX</BuyerIdNum></BuyerInformation>
          <SellerInformation><SellerName>阿里云计算有限公司</SellerName></SellerInformation>
          <TotalTax-includedAmount>368.00</TotalTax-includedAmount>
          <TotalTaxAm>20.83</TotalTaxAm>
          <Remark>订单号:ALIYUN889901</Remark>
        </ElectronicInvoice>`,
    },
    {
      filename: 'einvoice_aliyun_duplicate.xml',
      content: `<ElectronicInvoice><InvoiceNumber>263320000000368001</InvoiceNumber><IssueTime>2026-11-06</IssueTime><SellerInformation><SellerName>阿里云计算有限公司</SellerName></SellerInformation><TotalTax-includedAmount>368.00</TotalTax-includedAmount></ElectronicInvoice>`,
    },
    {
      filename: 'einvoice_didi_combined_300.xml',
      content: `<ElectronicInvoice>
        <InvoiceNumber>261120000000300999</InvoiceNumber>
        <IssueTime>2026-11-20</IssueTime>
        <BuyerInformation><BuyerName>杭州自持智能科技有限公司</BuyerName><BuyerIdNum>91330100MA27XXXXXX</BuyerIdNum></BuyerInformation>
        <SellerInformation><SellerName>北京小桔科技有限公司</SellerName></SellerInformation>
        <TotalTax-includedAmount>300.00</TotalTax-includedAmount>
        <TotalTaxAm>8.74</TotalTaxAm>
      </ElectronicInvoice>`,
    },
    {
      filename: 'einvoice_sf_80_wrong_taxid.xml',
      content: `<ElectronicInvoice>
        <InvoiceNumber>264420000000080777</InvoiceNumber>
        <IssueTime>2026-11-11</IssueTime>
        <BuyerInformation><BuyerName>杭州自持智能科技有限公司</BuyerName><BuyerIdNum>91330100WRONG99999</BuyerIdNum></BuyerInformation>
        <SellerInformation><SellerName>顺丰速运有限公司</SellerName></SellerInformation>
        <TotalTax-includedAmount>80.00</TotalTax-includedAmount>
        <TotalTaxAm>4.53</TotalTaxAm>
      </ElectronicInvoice>`,
    },
  ];

  const meter = new PayPerEventMeter();
  const res = await executeCommercialTool(
    'reconcile_statements_and_invoices',
    {
      statements: [
        { filename: 'alipay_gbk.csv', contentBase64: alipayGbkBytes.toString('base64') },
        { filename: 'wechat.csv', content: wechatCsv },
      ],
      invoices,
      baseCurrency: 'CNY',
      expectedBuyerName: '杭州自持智能科技有限公司',
      expectedBuyerTaxId: '91330100MA27XXXXXX',
    },
    { meter },
  );

  const s = res.payload.summary;
  assert.equal(s.realizedNetIncome, 497);
  // Active expenses: 368 (Aliyun) + 42 + 118 + 140 (Didi = 300) + 80 (SF after 20 partial refund) + 38 (Starbucks) = 786.00
  assert.equal(s.realizedNetExpense, 786);
  assert.equal(s.activeExpenseCount, 6);
  assert.equal(s.matchedExpenseCount, 5);
  assert.equal(s.unmatchedExpenseCount, 1);

  const didiTxs = res.payload.transactions.filter((t) => t.orderId.startsWith('202611') && t.matchRule === 'COMBINED_3_TO_1');
  assert.equal(didiTxs.length, 3);

  const anomalyTypes = new Set(res.payload.anomalies.map((a) => a.type));
  assert.ok(anomalyTypes.has('DUPLICATE_INVOICE'));
  assert.ok(anomalyTypes.has('WRONG_BUYER_TAX_ID'));
  assert.ok(anomalyTypes.has('MISSING_INVOICE'));

  const wb = inspectXlsxWithOpenpyxl(res.payload.xlsxBase64);
  assert.deepEqual(wb.sheetnames, ['01_Executive_Summary', '02_Reconciled_Ledger', '03_Anomalies_Checklist']);
  assert.equal(meter.totalChargedUsd, 0.02);
});

test('5. MCP stdio server handles both newline-delimited JSON-RPC and Content-Length framed requests end-to-end', async () => {
  const child = spawn(process.execPath, [resolve(ROOT_DIR, 'src/main.mjs'), '--stdio'], {
    cwd: ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const responses = [];
  let stdoutBuf = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    // Parse newline-delimited responses first
    while (stdoutBuf.includes('\n') && !stdoutBuf.startsWith('Content-Length:')) {
      const idx = stdoutBuf.indexOf('\n');
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line) responses.push(JSON.parse(line));
    }
    while (stdoutBuf.startsWith('Content-Length:')) {
      const sep = stdoutBuf.indexOf('\r\n\r\n');
      if (sep === -1) break;
      const len = Number(stdoutBuf.slice(0, sep).match(/Content-Length:\s*(\d+)/i)[1]);
      const restBuf = Buffer.from(stdoutBuf.slice(sep + 4), 'utf8');
      if (restBuf.length < len) break;
      const jsonStr = restBuf.subarray(0, len).toString('utf8');
      stdoutBuf = restBuf.subarray(len).toString('utf8');
      responses.push(JSON.parse(jsonStr));
    }
  });

  const waitForCount = (n) =>
    new Promise((res, rej) => {
      const deadline = Date.now() + 8000;
      const timer = setInterval(() => {
        if (responses.length >= n) {
          clearInterval(timer);
          res();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          rej(new Error(`Timed out waiting for ${n} stdio responses (got ${responses.length})`));
        }
      }, 20);
    });

  try {
    // 5a. Newline-delimited initialize + notifications/initialized + tools/list
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })}\n`,
    );
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    await waitForCount(2);

    assert.equal(responses[0].result.protocolVersion, '2025-03-26');
    assert.equal(responses[0].result.serverInfo.name, 'docuclean-ledger-mcp');
    assert.equal(responses[1].result.tools.length, 3);

    // 5b. Content-Length framed tools/call + unknown tool check
    const callBody = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'repair_cjk_csv_mojibake',
        arguments: {
          filename: 'mini.csv',
          content: Buffer.from('姓名,金额\n张三,¥1,000.00', 'utf8').toString('latin1'),
        },
      },
    });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(callBody, 'utf8')}\r\n\r\n${callBody}`);
    await waitForCount(3);

    assert.equal(responses[2].result.isError, false);
    assert.equal(responses[2].result.structuredContent.rows[0][0], '张三');
    assert.equal(responses[2].result.structuredContent.rows[0][1], '¥1,000.00');
  } finally {
    child.kill();
  }
});

test('6. Streamable HTTP (/mcp), Legacy SSE (/sse), Apify Standby readiness probe, and Apify Cloud PPE /charge + budget cap work end-to-end', async () => {
  const capturedCharges = [];
  const mockApifyApi = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      capturedCharges.push({
        url: req.url,
        auth: req.headers.authorization,
        idempotencyKey: req.headers['idempotency-key'],
        body: JSON.parse(body),
      });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { charged: true } }));
    });
  });

  await new Promise((r) => mockApifyApi.listen(0, '127.0.0.1', r));
  const mockApiPort = mockApifyApi.address().port;

  const meter = new PayPerEventMeter({
    env: {
      ACTOR_RUN_ID: 'run_live_test_99',
      APIFY_TOKEN: 'apify_api_secret_test',
      APIFY_API_BASE_URL: `http://127.0.0.1:${mockApiPort}`,
      APIFY_MAX_TOTAL_CHARGE_USD: '0.03',
    },
  });

  const mcpHttp = createHttpMcpServer({ meter });
  await new Promise((r) => mcpHttp.listen(0, '127.0.0.1', r));
  const mcpPort = mcpHttp.address().port;
  const baseUrl = `http://127.0.0.1:${mcpPort}`;

  try {
    // 6a. Apify Standby Container Readiness Probe + MCPize /ping & /health + POST / MCP Gateway
    const probeRes = await fetch(`${baseUrl}/`, {
      headers: { 'x-apify-container-server-readiness-probe': '1' },
    });
    assert.equal(probeRes.status, 200);
    const probeJson = await probeRes.json();
    assert.equal(probeJson.ok, true);
    assert.equal(probeJson.readinessProbe, true);
    assert.equal(probeJson.mcpEndpoint, '/mcp');

    const pingRes = await fetch(`${baseUrl}/ping`);
    assert.equal(pingRes.status, 200);
    const pingJson = await pingRes.json();
    assert.equal(pingJson.status, 'pong');

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, 'healthy');

    const rootInitRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 901,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcpize-gateway', version: '1.0.0' } },
      }),
    });
    assert.equal(rootInitRes.status, 200);
    const rootInitJson = await rootInitRes.json();
    assert.equal(rootInitJson.result.protocolVersion, '2025-06-18');

    const rootListRes = await fetch(`${baseUrl}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 902, method: 'tools/list', params: {} }),
    });
    assert.equal(rootListRes.status, 200);
    const rootListJson = await rootListRes.json();
    assert.equal(rootListJson.result.tools.length, 3);

    // 6b. Notification returns 202 Accepted
    const notifRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(notifRes.status, 202);

    // 6c. First $0.02 tool call succeeds and triggers Apify Cloud `/v2/actor-runs/run_live_test_99/charge`
    const call1 = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idem-client-tx-001',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'extract_and_clean_pdf_tables_to_xlsx',
          arguments: {
            filename: 'table.md',
            content: '| 科目 | 金额 |\n| --- | --- |\n| 技术服务 | ¥500.00 |\n| 云主机 | ¥300.00 |',
          },
        },
      }),
    });
    assert.equal(call1.status, 200);
    assert.equal(call1.headers.get('x-mcp-billed-event'), 'extract-pdf-tables-to-xlsx');
    assert.equal(call1.headers.get('x-mcp-billed-usd'), '0.02');
    const call1Json = await call1.json();
    assert.equal(call1Json.result.isError, false);
    assert.equal(capturedCharges.length, 1);
    assert.equal(capturedCharges[0].url, '/v2/actor-runs/run_live_test_99/charge');
    assert.equal(capturedCharges[0].auth, 'Bearer apify_api_secret_test');
    assert.equal(capturedCharges[0].idempotencyKey, 'idem-client-tx-001');
    assert.deepEqual(capturedCharges[0].body, { eventName: 'extract-pdf-tables-to-xlsx', count: 1 });

    // 6d. Exact retry with same `Idempotency-Key` succeeds WITHOUT double-charging!
    const call1Retry = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'idem-client-tx-001',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'extract_and_clean_pdf_tables_to_xlsx',
          arguments: {
            filename: 'table.md',
            content: '| 科目 | 金额 |\n| --- | --- |\n| 技术服务 | ¥500.00 |\n| 云主机 | ¥300.00 |',
          },
        },
      }),
    });
    const call1RetryJson = await call1Retry.json();
    assert.equal(call1RetryJson.result.isError, false);
    assert.equal(call1RetryJson.result.structuredContent.billing.deduplicated, true);
    assert.equal(capturedCharges.length, 1, 'Retry with identical Idempotency-Key must not re-bill');

    // 6e. Malformed JSON to legacy `/messages` returns 400 cleanly without crashing
    const badMsg = await fetch(`${baseUrl}/messages?sessionId=nonexistent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not-valid-json',
    });
    assert.equal(badMsg.status, 400);

    // 6f. Second distinct $0.02 call exceeds APIFY_MAX_TOTAL_CHARGE_USD=0.03 -> rejected cleanly without hitting /charge!
    const call2 = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          name: 'extract_and_clean_pdf_tables_to_xlsx',
          arguments: {
            filename: 'table2.md',
            content: '| A | B |\n| --- | --- |\n| 1 | 2 |',
          },
        },
      }),
    });
    const call2Json = await call2.json();
    assert.equal(call2Json.result.isError, true);
    assert.match(call2Json.result.content[0].text, /MAX_TOTAL_CHARGE_EXCEEDED/);
    assert.equal(capturedCharges.length, 1);
  } finally {
    mcpHttp.close();
    mockApifyApi.close();
  }
});

test('7. Apify Batch Actor mode reads INPUT.json and writes OUTPUT.json, OUTPUT.xlsx, OUTPUT.csv, PPE_CHARGES.json, and Dataset item', async () => {
  const tempStorage = mkdtempSync(join(tmpdir(), 'apify-batch-test-'));
  try {
    const kvDir = resolve(tempStorage, 'key_value_stores/default');
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(kvDir)}, { recursive: true })`]);
    writeFileSync(
      resolve(kvDir, 'INPUT.json'),
      JSON.stringify({
        tool: 'reconcile_statements_and_invoices',
        statements: [
          {
            filename: 'stripe.csv',
            content: 'id,created,description,amount,fee,net,currency\ntx_1,2026-11-10,Vercel Pro,-20.00,0.00,-20.00,USD',
          },
        ],
        invoices: [
          {
            filename: 'inv_vercel.json',
            content: JSON.stringify([
              { invoiceNumber: 'INV-VERCEL-01', date: '2026-11-10', sellerName: 'Vercel Inc', total: 20.0, currency: 'USD' },
            ]),
          },
        ],
        baseCurrency: 'USD',
      }),
      'utf8',
    );

    const batchRes = await runBatchActor({
      env: { APIFY_LOCAL_STORAGE_DIR: tempStorage },
    });

    // $0.001 actor-start + $0.02 reconcile-statements-invoices = $0.021
    assert.equal(batchRes.totalChargedUsd, 0.021);
    assert.equal(batchRes.payload.summary.matchedExpenseCount, 1);

    assert.ok(existsSync(resolve(kvDir, 'OUTPUT.json')));
    assert.ok(existsSync(resolve(kvDir, 'OUTPUT.xlsx')));
    assert.ok(existsSync(resolve(kvDir, 'OUTPUT.csv')));
    assert.ok(existsSync(resolve(kvDir, 'PPE_CHARGES.json')));
    assert.ok(existsSync(resolve(tempStorage, 'datasets/default/000000001.json')));

    const savedXlsxB64 = readFileSync(resolve(kvDir, 'OUTPUT.xlsx')).toString('base64');
    const wb = inspectXlsxWithOpenpyxl(savedXlsxB64);
    assert.equal(wb.sheetnames.length, 3);
  } finally {
    rmSync(tempStorage, { recursive: true, force: true });
  }
});
