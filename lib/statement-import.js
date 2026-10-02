// Nhập sổ lệnh từ file sao kê của công ty chứng khoán (CSV hoặc Excel .xlsx). Logic thuần -- không đụng DOM/Supabase:
// đọc file, nhận cột theo tên (tiếng Việt/Anh, có/không dấu), chuẩn hoá số + ngày kiểu Việt Nam, kiểm tra, chống nhập trùng.
// Nạp bằng thẻ <script> thường (global StatementImport) và module.exports cho Vitest.
//
// Cố ý KHÔNG đoán mò khi mơ hồ: dòng thiếu cột bắt buộc / không rõ Mua-Bán bị loại kèm lý do để người dùng sửa file hoặc đổi cách ghép cột
// trong màn xem trước, chứ không âm thầm nhập số liệu sai vào sổ lệnh.
const StatementImport = (function () {
  const FIELDS = ['date', 'symbol', 'side', 'quantity', 'price', 'value', 'fee', 'tax', 'ref', 'note'];

  // Tên cột thường gặp (đã chuẩn hoá: không dấu, chữ thường, ký tự lạ -> khoảng trắng). Khớp chính xác trước, "chứa cụm" sau.
  const SYNONYMS = {
    date: ['ngay', 'ngay giao dich', 'ngay gd', 'ngay khop', 'ngay thuc hien', 'ngay khop lenh', 'thoi gian khop', 'thoi gian', 'trade date', 'date', 'ngay hieu luc'],
    symbol: ['ma', 'ma ck', 'ma cp', 'ma chung khoan', 'ma co phieu', 'chung khoan', 'symbol', 'ticker', 'stock', 'ma cks'],
    side: ['loai lenh', 'lenh', 'mua ban', 'loai giao dich', 'loai gd', 'giao dich', 'side', 'buy sell', 'type', 'hanh dong', 'mb', 'm b', 'ban mua'],
    quantity: ['kl', 'kl khop', 'khoi luong', 'khoi luong khop', 'so luong', 'sl', 'sl khop', 'so luong khop', 'quantity', 'qty', 'volume', 'matched volume'],
    price: ['gia', 'gia khop', 'gia gd', 'gia giao dich', 'gia thuc hien', 'don gia', 'price', 'matched price', 'gia mua ban'],
    value: ['gia tri', 'gia tri khop', 'gia tri gd', 'gia tri giao dich', 'thanh tien', 'tong gia tri', 'value', 'amount', 'gross amount'],
    fee: ['phi', 'phi gd', 'phi giao dich', 'phi moi gioi', 'phi mg', 'fee', 'commission', 'phi mua', 'phi ban', 'phi dich vu'],
    tax: ['thue', 'thue tncn', 'thue ban', 'thue thu nhap', 'thue thu nhap ca nhan', 'tax', 'withholding tax'],
    ref: ['so hieu lenh', 'ma lenh', 'so lenh', 'order id', 'order no', 'order number', 'so hieu', 'ma giao dich', 'so tham chieu', 'ref', 'reference'],
    note: ['ghi chu', 'note', 'notes', 'dien giai', 'mo ta', 'noi dung', 'description', 'remark'],
  };

  function normalize(text) {
    return String(text == null ? '' : text)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  // ---------------------------------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------------------------------
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).filter(l => l.trim()).slice(0, 8);
    const counts = { ',': 0, ';': 0, '\t': 0 };
    sample.forEach(line => {
      let inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (!inQ && counts[ch] !== undefined) counts[ch]++;
      }
    });
    return Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  }

  function parseCsv(text) {
    let s = String(text || '');
    if (s.charCodeAt(0) === 0xFEFF) s = s.slice(1);
    const delim = detectDelimiter(s);
    const rows = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (inQ) {
        if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && s[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => String(c).trim() !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some(c => String(c).trim() !== '')) rows.push(row);
    return rows.map(r => r.map(c => String(c).trim()));
  }

  // ---------------------------------------------------------------------------------------------
  // XLSX (zip + XML, không cần thư viện): giải nén bằng DecompressionStream('deflate-raw') có sẵn trong trình duyệt/WebView2/Node 18+
  // ---------------------------------------------------------------------------------------------
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Trình duyệt này không hỗ trợ giải nén file Excel — hãy lưu file thành .csv rồi nhập lại.');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(u8) {
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (u32(u8, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('File không phải định dạng Excel (.xlsx) hợp lệ.');
    const count = u16(u8, eocd + 10);
    let p = u32(u8, eocd + 16);
    const files = {};
    const decoder = new TextDecoder('utf-8');
    for (let n = 0; n < count; n++) {
      if (u32(u8, p) !== 0x02014b50) break;
      const method = u16(u8, p + 10), compSize = u32(u8, p + 20);
      const nameLen = u16(u8, p + 28), extraLen = u16(u8, p + 30), commentLen = u16(u8, p + 32), localOff = u32(u8, p + 42);
      const name = decoder.decode(u8.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (!/^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/.test(name)) continue;
      const lhName = u16(u8, localOff + 26), lhExtra = u16(u8, localOff + 28);
      const start = localOff + 30 + lhName + lhExtra;
      const data = u8.subarray(start, start + compSize);
      files[name] = decoder.decode(method === 0 ? data : await inflateRaw(data));
    }
    return files;
  }

  function xmlDecode(s) {
    return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>'; if (e === 'quot') return '"'; if (e === 'apos') return "'";
      return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    });
  }

  function colIndex(ref) {
    const letters = String(ref).replace(/[^A-Za-z]/g, '').toUpperCase();
    let n = 0;
    for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }

  function parseSharedStrings(xml) {
    if (!xml) return [];
    return (xml.match(/<si\b[\s\S]*?<\/si>/g) || []).map(si =>
      xmlDecode((si.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')));
  }

  function parseSheetXml(xml, shared) {
    const rows = [];
    (xml.match(/<row\b[\s\S]*?<\/row>/g) || []).forEach(rowXml => {
      const rIdx = Number((rowXml.match(/<row\b[^>]*\br="(\d+)"/) || [])[1]) - 1;
      const cells = [];
      const re = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let m;
      while ((m = re.exec(rowXml))) {
        const attrs = m[1], body = m[2] || '';
        const ref = (attrs.match(/\br="([A-Za-z]+\d+)"/) || [])[1];
        const type = (attrs.match(/\bt="(\w+)"/) || [])[1];
        const idx = ref ? colIndex(ref) : cells.length;
        let val = '';
        if (type === 'inlineStr') val = xmlDecode((body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join(''));
        else {
          const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (v !== undefined) {
            if (type === 's') val = shared[Number(v)] !== undefined ? shared[Number(v)] : '';
            else if (type === 'str' || type === 'e') val = xmlDecode(v);
            else if (type === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
            else val = Number(v);              // số thật (ngày Excel cũng là số -> parseDate xử lý)
          }
        }
        cells[idx] = val;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      if (!isNaN(rIdx)) rows[rIdx] = cells; else rows.push(cells);
    });
    for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
    return rows.filter(r => r.some(c => String(c).trim() !== ''));
  }

  // Trả về [{ name, rows }] mọi sheet của file .xlsx (u8: Uint8Array).
  async function readXlsx(u8) {
    const files = await unzip(u8);
    if (!files['xl/workbook.xml']) throw new Error('File không phải định dạng Excel (.xlsx) hợp lệ.');
    const shared = parseSharedStrings(files['xl/sharedStrings.xml']);
    const rels = {};
    ((files['xl/_rels/workbook.xml.rels'] || '').match(/<Relationship\b[^>]*>/g) || []).forEach(r => {
      const id = (r.match(/\bId="([^"]+)"/) || [])[1];
      const target = (r.match(/\bTarget="([^"]+)"/) || [])[1];
      if (id && target) rels[id] = target.replace(/^\/?(xl\/)?/, 'xl/');
    });
    const sheets = [];
    (files['xl/workbook.xml'].match(/<sheet\b[^>]*>/g) || []).forEach((tag, i) => {
      const name = xmlDecode((tag.match(/\bname="([^"]*)"/) || [])[1] || ('Sheet' + (i + 1)));
      const rid = (tag.match(/\br:id="([^"]+)"/) || [])[1];
      const path = (rid && rels[rid]) || ('xl/worksheets/sheet' + (i + 1) + '.xml');
      if (files[path]) sheets.push({ name, rows: parseSheetXml(files[path], shared) });
    });
    return sheets;
  }

  // ---------------------------------------------------------------------------------------------
  // Chuẩn hoá giá trị
  // ---------------------------------------------------------------------------------------------
  // Số kiểu VN/quốc tế: "1.234.567", "1,234,567", "1.234,56", "1,234.56", "25,5", "(1.200)", "12,5%", "25 500"
  function parseNumber(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    let s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    s = s.replace(/[₫đ\s%]|vnd|vnđ/gi, '').replace(/^\+/, '');
    if (s.startsWith('-')) { neg = !neg; s = s.slice(1); }
    if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;
    const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
    if (dots && commas) {
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      const thou = dec === '.' ? ',' : '.';
      s = s.split(thou).join('').replace(dec, '.');
    } else if (commas) {
      // "1,234" / "1,234,567" -> hàng nghìn; "25,5" / "25,55" -> thập phân
      s = (commas > 1 || /,\d{3}$/.test(s)) ? s.split(',').join('') : s.replace(',', '.');
    } else if (dots) {
      // "1.234.567" / "25.500" -> hàng nghìn; "25.5" / "25.55" -> thập phân
      s = (dots > 1 || /\.\d{3}$/.test(s)) ? s.split('.').join('') : s;
    }
    const n = Number(s);
    return isFinite(n) ? (neg ? -n : n) : null;
  }

  function validIso(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
      ? y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0') : null;
  }

  // Ngày -> 'YYYY-MM-DD'. Nhận số ngày Excel, yyyy-mm-dd, dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy (kèm giờ hay không). Mơ hồ dd/mm vs mm/dd -> dd/mm.
  function parseDate(v) {
    if (typeof v === 'number') {
      if (v < 20000 || v > 80000) return null;                 // ngoài khoảng ngày hợp lý (1954-2118)
      const d = new Date(Math.round((v - 25569) * 86400000));  // 25569 = 1970-01-01 theo lịch Excel 1900
      return validIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    }
    const s = String(v == null ? '' : v).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s].*)?$/);
    if (m) return validIso(+m[1], +m[2], +m[3]);
    m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})(?:[T\s].*)?$/);
    if (m) {
      const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
      return validIso(y, +m[2], +m[1]);
    }
    if (/^\d{5}(\.\d+)?$/.test(s)) return parseDate(Number(s));
    return null;
  }

  // 'buy' | 'sell' | 'dividend' | 'other' | null (không nhận ra)
  function parseSide(v) {
    const s = normalize(v);
    if (!s) return null;
    if (/^(mua|buy|b|m|bought|nb)$/.test(s) || /\bmua\b|\bbuy\b/.test(s)) return 'buy';
    if (/^(ban|sell|s|sold)$/.test(s) || /\bban\b|\bsell\b/.test(s)) return 'sell';
    if (/co tuc|dividend/.test(s)) return 'dividend';
    return 'other';
  }

  // ---------------------------------------------------------------------------------------------
  // Nhận cột + chuẩn hoá thành lệnh
  // ---------------------------------------------------------------------------------------------
  // Tìm dòng tiêu đề (trong 30 dòng đầu, dòng có nhiều ô khớp tên cột nhất) rồi ghép cột. Trả về { headerRow, headers, mapping, score }.
  function detectColumns(rows) {
    let best = { headerRow: -1, score: 0, mapping: {}, headers: [] };
    const limit = Math.min(rows.length, 30);
    for (let r = 0; r < limit; r++) {
      const headers = rows[r].map(h => normalize(h));
      const mapping = {};
      const used = new Set();
      // lượt 1: khớp chính xác; lượt 2: tiêu đề CHỨA cụm (chỉ cụm >= 2 từ hoặc >= 4 ký tự, tránh "gia" khớp "gia tri")
      [false, true].forEach(loose => {
        FIELDS.forEach(field => {
          if (mapping[field] !== undefined) return;
          for (let c = 0; c < headers.length; c++) {
            if (used.has(c) || !headers[c]) continue;
            const hit = SYNONYMS[field].some(syn => loose
              ? ((syn.includes(' ') || syn.length >= 4) && (' ' + headers[c] + ' ').includes(' ' + syn + ' '))
              : headers[c] === syn);
            if (hit) { mapping[field] = c; used.add(c); break; }
          }
        });
      });
      const score = Object.keys(mapping).length;
      const core = ['date', 'symbol', 'side', 'quantity', 'price'].filter(f => mapping[f] !== undefined).length;
      if (core >= 3 && score > best.score) best = { headerRow: r, score, mapping, headers: rows[r] };
    }
    return best;
  }

  const REQUIRED = [['date', 'Ngày giao dịch'], ['symbol', 'Mã CK'], ['side', 'Loại lệnh (Mua/Bán)'], ['quantity', 'Khối lượng'], ['price', 'Giá (hoặc Giá trị)']];

  // rows: toàn bộ dòng của sheet (gồm cả dòng tiêu đề). opts: { headerRow, mapping, priceMultiplier, rates, autoFees, mergeFills }
  function normalizeRows(rows, opts) {
    const o = Object.assign({ priceMultiplier: null, autoFees: true, mergeFills: false, rates: null }, opts || {});
    const m = o.mapping || {};
    const out = [], skipped = [];
    const get = (row, f) => (m[f] === undefined || m[f] === null ? '' : row[m[f]]);

    // Hệ số giá: suy ra từ cột Giá trị khi có (đáng tin hơn đoán), hoặc người dùng chọn tay.
    let multiplier = o.priceMultiplier;
    if (multiplier === null || multiplier === undefined) {
      const ratios = [];
      for (let i = o.headerRow + 1; i < rows.length && ratios.length < 20; i++) {
        const q = parseNumber(get(rows[i], 'quantity')), p = parseNumber(get(rows[i], 'price')), val = parseNumber(get(rows[i], 'value'));
        if (q > 0 && p > 0 && val > 0) ratios.push(val / (q * p));
      }
      if (ratios.length >= 2) {
        ratios.sort((a, b) => a - b);
        const med = ratios[Math.floor(ratios.length / 2)];
        multiplier = Math.abs(med - 1000) < 100 ? 1000 : 1;
      } else multiplier = 1;
    }

    for (let i = o.headerRow + 1; i < rows.length; i++) {
      const row = rows[i];
      const line = i + 1;
      const sideRaw = get(row, 'side');
      const symRaw = String(get(row, 'symbol') || '').trim();
      const dateIso = parseDate(get(row, 'date'));
      // Dòng tổng cộng / trống / ghi chú cuối bảng: không có ngày lẫn mã -> bỏ qua im lặng
      if (!dateIso && !symRaw) continue;
      const issues = [];
      let qty = parseNumber(get(row, 'quantity'));
      let price = parseNumber(get(row, 'price'));
      const value = parseNumber(get(row, 'value'));
      let side = parseSide(sideRaw);
      if (!side && qty !== null && qty < 0) side = 'sell';
      if (qty !== null) qty = Math.abs(qty);

      if (side === 'other') { skipped.push({ line, reason: 'Loại giao dịch không hỗ trợ: “' + String(sideRaw).trim() + '”' }); continue; }
      if (!dateIso) issues.push('Không đọc được ngày “' + String(get(row, 'date')).trim() + '”');
      if (!symRaw) issues.push('Thiếu mã chứng khoán');
      if (!side) issues.push('Không xác định được Mua/Bán (“' + String(sideRaw).trim() + '”)');
      if (side !== 'dividend') {
        if (!(qty > 0)) issues.push('Khối lượng không hợp lệ');
        if (!(price > 0) && value > 0 && qty > 0) price = value / qty;
        else if (price > 0) price = price * multiplier;
        if (!(price > 0)) issues.push('Giá không hợp lệ');
      }
      const symbol = symRaw.toUpperCase().replace(/\s+/g, '');
      if (symbol && !/^[A-Z0-9._-]{1,15}$/.test(symbol)) issues.push('Mã chứng khoán lạ: “' + symRaw + '”');

      let fee = parseNumber(get(row, 'fee')), tax = parseNumber(get(row, 'tax'));
      const hasFeeCol = m.fee !== undefined, hasTaxCol = m.tax !== undefined;
      const entry = {
        line, date: dateIso, symbol, type: side, quantity: qty, price,
        fee: fee === null ? null : Math.abs(fee), tax: tax === null ? null : Math.abs(tax),
        ref: String(get(row, 'ref') || '').trim() || null,
        note: String(get(row, 'note') || '').trim() || null,
        amount: side === 'dividend' ? (value !== null ? Math.abs(value) : (qty > 0 && price > 0 ? qty * price : null)) : null,
        feeSource: hasFeeCol && fee !== null ? 'file' : 'auto', issues,
      };
      if (side === 'dividend' && !(entry.amount > 0)) entry.issues.push('Thiếu số tiền cổ tức');
      out.push(entry);
    }

    // Phí/thuế thiếu: tự tính theo biểu phí (nếu bật), nếu không thì 0.
    const rates = o.rates || {};
    out.forEach(e => {
      if (e.type !== 'buy' && e.type !== 'sell') return;
      if (e.fee === null) e.fee = o.autoFees ? Math.round(e.quantity * e.price * (e.type === 'sell' ? (rates.sellFeeRate ?? 0.0015) : (rates.buyFeeRate ?? 0.0015))) : 0;
      if (e.tax === null) e.tax = (o.autoFees && e.type === 'sell') ? Math.round(e.quantity * e.price * (rates.sellTaxRate ?? 0.001)) : 0;
      if (e.type === 'buy') e.tax = 0;
    });

    // Gộp các lần khớp cùng ngày/mã/chiều thành 1 lệnh (giá bình quân gia quyền) -- tuỳ chọn, mặc định tắt để giữ nguyên từng dòng sao kê.
    let list = out;
    if (o.mergeFills) {
      const groups = new Map();
      const keep = [];
      out.forEach(e => {
        if (e.issues.length || (e.type !== 'buy' && e.type !== 'sell')) { keep.push(e); return; }
        const k = e.date + '|' + e.symbol + '|' + e.type;
        if (!groups.has(k)) { groups.set(k, Object.assign({}, e, { merged: 1 })); }
        else {
          const g = groups.get(k);
          const totalQty = g.quantity + e.quantity;
          g.price = (g.price * g.quantity + e.price * e.quantity) / totalQty;
          g.quantity = totalQty; g.fee += e.fee; g.tax += e.tax; g.merged++; g.ref = null;
        }
      });
      list = keep.concat(Array.from(groups.values())).sort((a, b) => a.line - b.line);
    }
    return { rows: list, skipped, priceMultiplier: multiplier };
  }

  // ---------------------------------------------------------------------------------------------
  // Chống nhập trùng + thứ tự nhập
  // ---------------------------------------------------------------------------------------------
  function fuzzyKey(t) {
    return [t.trade_date || t.date, t.symbol, t.type, Number(t.quantity), Math.round(Number(t.price) * 100) / 100].join('|');
  }

  // existing: lệnh đã có trong sổ ([{trade_date, symbol, type, quantity, price, external_ref}]); incoming: kết quả normalizeRows().rows (chỉ mua/bán hợp lệ)
  // Trả về { fresh, duplicates }: duplicates là dòng đã có sẵn (theo mã tham chiếu, hoặc theo ngày+mã+chiều+KL+giá, có đếm số lượng giống nhau).
  function dedupe(existing, incoming) {
    const refs = new Set((existing || []).map(t => t.external_ref).filter(Boolean));
    const counts = new Map();
    (existing || []).forEach(t => { const k = fuzzyKey(t); counts.set(k, (counts.get(k) || 0) + 1); });
    const refFreq = new Map();
    incoming.forEach(e => { if (e.ref) refFreq.set(e.ref, (refFreq.get(e.ref) || 0) + 1); });
    const fresh = [], duplicates = [];
    incoming.forEach(e => {
      // Mã lệnh chỉ dùng làm khoá khi duy nhất trong file (1 lệnh có thể khớp thành nhiều dòng cùng mã lệnh)
      const externalRef = e.ref && refFreq.get(e.ref) === 1 ? e.ref : null;
      if (externalRef && refs.has(externalRef)) { duplicates.push(e); return; }
      const k = fuzzyKey(e);
      if ((counts.get(k) || 0) > 0) { counts.set(k, counts.get(k) - 1); duplicates.push(e); return; }
      fresh.push(Object.assign({}, e, { externalRef }));
    });
    return { fresh, duplicates };
  }

  // Thứ tự chèn vào sổ: theo ngày; trong cùng ngày mua trước bán sau (để bán không bị "thiếu hàng"); còn lại giữ thứ tự file.
  function orderForInsert(list) {
    return list.map((e, i) => ({ e, i })).sort((a, b) =>
      (a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : 0) ||
      ((a.e.type === 'buy' ? 0 : 1) - (b.e.type === 'buy' ? 0 : 1)) || (a.i - b.i)).map(x => x.e);
  }

  // File mẫu để người dùng điền / đối chiếu định dạng
  function sampleCsv() {
    return [
      'Ngày giao dịch,Mã CK,Loại lệnh,Khối lượng,Giá,Phí,Thuế,Số hiệu lệnh',
      '15/09/2026,SSI,Mua,1000,33800,50700,0,A100234',
      '02/10/2026,SSI,Bán,500,35200,26400,17600,A100871',
      '',
    ].join('\r\n');
  }

  return { FIELDS, REQUIRED, normalize, parseCsv, readXlsx, parseNumber, parseDate, parseSide, detectColumns, normalizeRows, dedupe, orderForInsert, fuzzyKey, sampleCsv };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = StatementImport;
