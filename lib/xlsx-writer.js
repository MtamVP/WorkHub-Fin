// Ghi file Excel (.xlsx) không cần thư viện ngoài: XML tối thiểu + gói ZIP không nén (method 0). Logic thuần, chạy được trong trình duyệt và Node.
// Nạp bằng thẻ <script> thường (global XlsxWriter) và module.exports cho Vitest.
//
// Dùng: XlsxWriter.build([{ name, columns:[{width}], rows:[[cell,...],...], freezeHeader:true }]) -> Uint8Array
// cell: chuỗi | số | boolean | null | { v, s } với s = 'header' | 'bold' | 'int' | 'dec' | 'pct' | 'date' | 'wrap' | 'note'.
// 'pct' nhận giá trị dạng phân số (0.038 -> 3,80%). 'date' nhận chuỗi 'YYYY-MM-DD' hoặc Date, ghi thành số ngày Excel (đúng kiểu ngày khi mở).
const XlsxWriter = (function () {
  const STYLE_INDEX = { default: 0, header: 1, int: 2, pct: 3, dec: 4, date: 5, bold: 6, wrap: 7, note: 8 };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
      // ký tự điều khiển không hợp lệ trong XML 1.0
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  }

  function colName(i) {
    let s = '';
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  function excelDate(v) {
    const d = v instanceof Date ? v : new Date(String(v).slice(0, 10) + 'T00:00:00Z');
    if (isNaN(d.getTime())) return null;
    const ms = v instanceof Date ? Date.UTC(v.getFullYear(), v.getMonth(), v.getDate()) : d.getTime();
    return Math.round(ms / 86400000) + 25569;
  }

  function cellXml(ref, cell) {
    let v = cell, style = 'default';
    if (cell !== null && typeof cell === 'object' && !(cell instanceof Date)) { v = cell.v; style = cell.s || 'default'; }
    if (v === null || v === undefined || v === '') return style === 'default' ? '' : `<c r="${ref}" s="${STYLE_INDEX[style] || 0}"/>`;
    const s = STYLE_INDEX[style] !== undefined ? STYLE_INDEX[style] : 0;
    if (style === 'date') {
      const serial = excelDate(v);
      if (serial !== null) return `<c r="${ref}" s="${s}"><v>${serial}</v></c>`;
    }
    if (typeof v === 'number') return isFinite(v) ? `<c r="${ref}" s="${s}"><v>${v}</v></c>` : '';
    if (typeof v === 'boolean') return `<c r="${ref}" s="${s}" t="b"><v>${v ? 1 : 0}</v></c>`;
    return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
  }

  function sheetXml(sheet) {
    const rows = sheet.rows || [];
    let maxCols = 0;
    rows.forEach(r => { if (r.length > maxCols) maxCols = r.length; });
    const cols = (sheet.columns || []).map((c, i) => c && c.width ? `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>` : '').join('');
    const pane = sheet.freezeHeader ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : '';
    const data = rows.map((r, ri) => {
      const cells = r.map((c, ci) => cellXml(colName(ci) + (ri + 1), c)).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${pane}<sheetFormatPr defaultRowHeight="15"/>` +
      (cols ? `<cols>${cols}</cols>` : '') + `<sheetData>${data}</sheetData></worksheet>`;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="4"><numFmt numFmtId="164" formatCode="#,##0"/><numFmt numFmtId="165" formatCode="0.00%"/><numFmt numFmtId="166" formatCode="#,##0.00"/><numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><i/><sz val="10"/><color rgb="FF6B655A"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFE7D2"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function sheetName(raw, used) {
    let n = String(raw || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet';
    let candidate = n, i = 2;
    while (used.has(candidate.toLowerCase())) { const suffix = ' ' + i++; candidate = n.slice(0, 31 - suffix.length) + suffix; }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  // ---- ZIP (không nén) ----
  let crcTable = null;
  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crcTable[n] = c >>> 0; }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    const DOS_TIME = 0, DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1;
    const w16 = (v) => new Uint8Array([v & 255, (v >> 8) & 255]);
    const w32 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]);
    const cat = (...arrs) => { const len = arrs.reduce((s, a) => s + a.length, 0); const out = new Uint8Array(len); let p = 0; arrs.forEach(a => { out.set(a, p); p += a.length; }); return out; };
    entries.forEach(({ name, data }) => {
      const nameBytes = enc.encode(name);
      const body = typeof data === 'string' ? enc.encode(data) : data;
      const crc = crc32(body);
      const local = cat(w32(0x04034b50), w16(20), w16(0x0800), w16(0), w16(DOS_TIME), w16(DOS_DATE), w32(crc), w32(body.length), w32(body.length), w16(nameBytes.length), w16(0), nameBytes);
      parts.push(local, body);
      central.push(cat(w32(0x02014b50), w16(20), w16(20), w16(0x0800), w16(0), w16(DOS_TIME), w16(DOS_DATE), w32(crc), w32(body.length), w32(body.length), w16(nameBytes.length), w16(0), w16(0), w16(0), w16(0), w32(0), w32(offset), nameBytes));
      offset += local.length + body.length;
    });
    const centralBytes = cat(...central);
    const end = cat(w32(0x06054b50), w16(0), w16(0), w16(entries.length), w16(entries.length), w32(centralBytes.length), w32(offset), w16(0));
    return cat(...parts, centralBytes, end);
  }

  function build(sheets) {
    const used = new Set();
    const list = (sheets && sheets.length ? sheets : [{ name: 'Sheet1', rows: [] }]).map(s => Object.assign({}, s, { name: sheetName(s.name, used) }));
    const entries = [];
    entries.push({ name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${list.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>` });
    entries.push({ name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` });
    entries.push({ name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${list.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` });
    entries.push({ name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` });
    entries.push({ name: 'xl/styles.xml', data: STYLES_XML });
    list.forEach((s, i) => entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) }));
    return zip(entries);
  }

  return { build, colName, crc32, excelDate };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = XlsxWriter;
