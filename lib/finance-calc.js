// Logic thuần cho Bàn Tài Sản (phân bổ ngành, cảnh báo tập trung, nhãn độ tươi của giá, dựng CSV).
// Không đụng DOM/mạng -- nạp bằng thẻ <script> thường trước script.js (thành global) và qua
// module.exports cho Vitest, cùng kiểu với lib/pure-helpers.js.

const FinCalc = (function () {

// Bảng ngành nội bộ cho các mã phổ biến (xấp xỉ phân loại ICB cấp 1-2). Mã ngoài bảng -> "Chưa phân ngành".
const SECTOR_GROUPS = {
  'Ngân hàng': 'VCB TCB MBB ACB VPB CTG BID STB SHB HDB TPB EIB LPB MSB OCB VIB SSB NAB BAB ABB BVB KLB PGB SGB VBB',
  'Chứng khoán': 'SSI VND HCM VCI SHS MBS FTS BSI CTS AGR VIX ORS TVS VDS APG',
  'Bất động sản': 'VIC VHM VRE NVL KDH NLG DXG PDR DIG CEO KBC IDC SZC BCM HDG HDC CRE NTL SCR TCH LDG DXS ITC AGG SJS TDH QCG VPI HQC IJC D2D PTL NBB DRH LGL',
  'Thép & vật liệu': 'HPG HSG NKG TLH POM VGS SMC KSB VCS BMP NTP DHA VLB HT1 BCC',
  'Dầu khí & năng lượng': 'GAS PLX PVD PVS BSR OIL PVC PGC PGD PSH COM',
  'Điện & tiện ích': 'POW REE PC1 NT2 GEG GEX HND QTP PPC TTA BWE TDM VSH SBA CHP DTK SHP TMP VPD',
  'Bán lẻ': 'MWG FRT PNJ DGW PET',
  'Thực phẩm & đồ uống': 'VNM SAB MSN KDC DBC BAF HAG HNG PAN SBT QNS LTG VHC ANV FMC IDI MPC CMX BHN TAC SMB SCD',
  'Công nghệ': 'FPT CMG ELC ITD VGI FOX CTR',
  'Hóa chất & phân bón': 'DGC DPM DCM CSV LAS BFC DDV',
  'Cao su & nhựa': 'GVR PHR DPR TRC DRC CSM BRC AAA APH',
  'Vận tải & logistics': 'GMD VJC HVN VTP HAH VOS VSC SGP PVT MVN TCL ACV SCS ASG AST',
  'Xây dựng & hạ tầng': 'CTD HBC VCG FCN LCG C4G HHV CII DPG',
  'Dệt may': 'TCM TNG MSH VGT STK GIL',
  'Y tế & dược': 'DHG IMP TRA DBD DVN PMC',
  'Bảo hiểm': 'BVH BMI MIG PVI VNR PTI'
};
const UNKNOWN_SECTOR = 'Chưa phân ngành';
const SECTOR_BY_SYMBOL = {};
Object.keys(SECTOR_GROUPS).forEach(function (sector) {
  SECTOR_GROUPS[sector].split(' ').forEach(function (sym) { if (!(sym in SECTOR_BY_SYMBOL)) SECTOR_BY_SYMBOL[sym] = sector; });
});

function sectorOf(symbol) {
  return SECTOR_BY_SYMBOL[String(symbol || '').trim().toUpperCase()] || UNKNOWN_SECTOR;
}

// holdings: [{symbol, marketValue}] -> [{sector, value, pct, symbols}] giảm dần theo giá trị. Bỏ qua mã chưa có giá trị.
function sectorAllocation(holdings) {
  const items = (holdings || []).filter(function (h) { return Number(h.marketValue) > 0; });
  const total = items.reduce(function (s, h) { return s + Number(h.marketValue); }, 0);
  if (!total) return [];
  const bySector = {};
  items.forEach(function (h) {
    const sector = sectorOf(h.symbol);
    const row = bySector[sector] || (bySector[sector] = { sector: sector, value: 0, symbols: [] });
    row.value += Number(h.marketValue);
    row.symbols.push(h.symbol);
  });
  return Object.keys(bySector).map(function (k) {
    const row = bySector[k];
    row.pct = (row.value / total) * 100;
    return row;
  }).sort(function (a, b) { return b.value - a.value; });
}

// Cảnh báo tập trung: 1 mã chiếm >= singleLimit% hoặc 1 ngành (đã phân loại) chiếm >= sectorLimit% giá trị thị trường.
// Cần >= 2 mã mới có ý nghĩa cảnh báo (danh mục 1 mã thì tập trung là hiển nhiên).
function concentrationWarnings(holdings, opts) {
  const o = opts || {};
  const singleLimit = o.singleLimit === undefined ? 30 : o.singleLimit;
  const sectorLimit = o.sectorLimit === undefined ? 50 : o.sectorLimit;
  const items = (holdings || []).filter(function (h) { return Number(h.marketValue) > 0; });
  const total = items.reduce(function (s, h) { return s + Number(h.marketValue); }, 0);
  if (items.length < 2 || !total) return [];
  const out = [];
  items.forEach(function (h) {
    const pct = (Number(h.marketValue) / total) * 100;
    if (pct >= singleLimit) out.push({ type: 'symbol', label: h.symbol, pct: pct, limit: singleLimit });
  });
  sectorAllocation(items).forEach(function (s) {
    if (s.sector !== UNKNOWN_SECTOR && s.pct >= sectorLimit && s.symbols.length >= 2) {
      out.push({ type: 'sector', label: s.sector, pct: s.pct, limit: sectorLimit });
    }
  });
  return out.sort(function (a, b) { return b.pct - a.pct; });
}

function pad2(n) { return String(n).padStart(2, '0'); }
function shortDate(iso) {
  if (!iso) return '';
  const p = String(iso).slice(0, 10).split('-');
  return p.length === 3 ? p[2] + '/' + p[1] : '';
}

// priceMeta (api.js _priceMeta) -> nhãn nhỏ dưới ô giá: {text, cls, title}
function priceAgeLabel(meta) {
  if (!meta || meta.kind === 'none') {
    return { text: 'Chưa có giá', cls: 'none', title: 'Chưa có giá cho mã này — nhập tay hoặc chờ lần cập nhật tự động kế tiếp.' };
  }
  const d = shortDate(meta.date);
  if (meta.kind === 'auto') {
    const src = meta.source === 'vnd-finfo' ? ' (nguồn dự phòng)' : '';
    if (meta.stale) {
      return { text: 'Giá ngày ' + d + ' · cũ ' + meta.ageDays + ' ngày', cls: 'stale',
        title: 'Giá tự động của phiên ' + d + ' đã ' + meta.ageDays + ' ngày chưa đổi' + src + '. Có thể mã tạm ngừng giao dịch hoặc nguồn giá đang lỗi.' };
    }
    return { text: 'Phiên ' + d + ' · tự động', cls: 'auto', title: 'Giá đóng cửa/giá gần nhất của phiên ' + d + ', tự cập nhật mỗi 5 phút trong phiên' + src + '.' };
  }
  if (meta.stale) {
    return { text: 'Nhập tay ' + d + ' · cũ ' + meta.ageDays + ' ngày', cls: 'stale',
      title: 'Giá nhập tay đã ' + meta.ageDays + ' ngày chưa cập nhật. Mở khóa giá để nhận giá tự động, hoặc nhập lại.' };
  }
  return { text: 'Nhập tay ' + d, cls: 'manual', title: 'Giá do bạn nhập tay' + (d ? ' ngày ' + d : '') + '.' };
}

// status = app_settings.price_fetch_status (đã parse) -> {level, text, title}. level: ok | warn | bad | none
function priceStatusSummary(status, now) {
  if (!status || !status.ranAt) {
    return { level: 'none', text: 'Giá tự động: chưa có lần cập nhật nào', title: 'Bộ lấy giá tự động chưa chạy lần nào.' };
  }
  const ran = new Date(status.ranAt);
  const t = (now || new Date()).getTime() - ran.getTime();
  const ageH = Math.floor(t / 3600000);
  const when = pad2(ran.getHours()) + ':' + pad2(ran.getMinutes()) + ' ' + pad2(ran.getDate()) + '/' + pad2(ran.getMonth() + 1);
  const failed = Array.isArray(status.failed) ? status.failed : [];
  const fallback = status.sources && status.sources['vnd-finfo'] ? status.sources['vnd-finfo'] : 0;
  if (ageH >= 72) {
    return { level: 'bad', text: 'Giá tự động: lần cuối ' + when + ' — đã hơn 3 ngày chưa cập nhật', title: 'Bộ lấy giá có thể đang lỗi. Giá hiển thị có thể đã cũ.' };
  }
  if (failed.length) {
    return { level: 'warn', text: 'Giá tự động: ' + when + ' · không lấy được ' + failed.join(', '), title: 'Các mã này không có giá từ cả nguồn chính lẫn dự phòng — giá hiện tại là giá cũ hoặc nhập tay.' };
  }
  return {
    level: 'ok',
    text: 'Giá tự động: cập nhật ' + when + ' · ' + status.priced + '/' + status.symbols + ' mã' + (fallback ? ' (' + fallback + ' mã từ nguồn dự phòng)' : ''),
    title: 'Tự động lấy giá mỗi 5 phút trong phiên giao dịch (9h–15h, thứ 2–6).'
  };
}

// rows: mảng các mảng giá trị -> chuỗi CSV (BOM UTF-8 để Excel đọc đúng tiếng Việt), ngăn cách bằng dấu phẩy.
function buildCsv(rows) {
  const body = rows.map(function (row) {
    return row.map(function (cell) {
      const val = (cell === null || cell === undefined) ? '' : String(cell);
      return '"' + val.replace(/"/g, '""') + '"';
    }).join(',');
  }).join('\r\n');
  return '﻿' + body;
}

return { sectorOf, sectorAllocation, concentrationWarnings, priceAgeLabel, priceStatusSummary, buildCsv, UNKNOWN_SECTOR, SECTOR_BY_SYMBOL };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = FinCalc;
