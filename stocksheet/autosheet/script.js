/* --- FILE: /stocksheet/autosheet/script.js --- */

document.addEventListener('DOMContentLoaded', function() {
    // Tự động tính toán lần đầu (nếu có dữ liệu cũ trong cache trình duyệt hoặc mặc định)
    calculate();

    // Gắn sự kiện cho tất cả các ô nhập liệu số
    const inputs = document.querySelectorAll('.input-val');
    inputs.forEach(input => {
        input.addEventListener('input', function(e) {
            // 1. Format hiển thị (thêm dấu phẩy phân cách ngàn ngay khi gõ)
            formatCurrencyInput(e.target);
            // 2. Tính toán lại toàn bộ kết quả
            calculate();
        });
    });
});

// --- 1. CÁC HÀM XỬ LÝ FORMAT SỐ ---

// Hàm format số để hiển thị kết quả (Text tĩnh)
// VD: 1000 -> 1.000 (Định dạng Việt Nam: chấm phân cách ngàn)
function formatNumber(num) {
    if (isNaN(num) || num === Infinity || num === -Infinity) return "0";
    return num.toLocaleString('vi-VN', { maximumFractionDigits: 2 });
}

// Hàm format Input khi đang gõ (Input field)
// VD: 1000 -> 1,000 (Định dạng Quốc tế: phẩy phân cách ngàn - để JS dễ xử lý)
function formatCurrencyInput(input) {
    let cursorPosition = input.selectionStart;
    let oldLength = input.value.length;

    // Chỉ giữ lại số và dấu chấm thập phân
    let rawValue = input.value.replace(/[^0-9.]/g, '');
    
    // Chặn nhập nhiều dấu chấm
    const parts = rawValue.split('.');
    if (parts.length > 2) {
        rawValue = parts[0] + '.' + parts.slice(1).join('');
    }

    if (rawValue === "") {
        input.value = "";
        return;
    }

    // Tách phần nguyên và thập phân
    let integerPart = parts[0];
    let decimalPart = parts.length > 1 ? '.' + parts[1] : '';

    // Format phần nguyên thêm dấu phẩy
    let formattedInteger = parseInt(integerPart || 0).toLocaleString('en-US');
    
    // Xử lý trường hợp đang gõ số 0 hoặc dấu chấm đầu tiên
    if (integerPart === '' && decimalPart) formattedInteger = '0';
    
    let newValue = formattedInteger + decimalPart;
    
    // Cập nhật giá trị vào ô input
    input.value = newValue;

    // Cân chỉnh lại vị trí con trỏ chuột (UX)
    let newLength = newValue.length;
    cursorPosition = cursorPosition + (newLength - oldLength);
    input.setSelectionRange(cursorPosition, cursorPosition);
}

// Hàm lấy giá trị thực (số) từ ô input để tính toán
function getValue(id) {
    const el = document.getElementById(id);
    if (!el) return 0;
    
    // Input đang hiển thị dạng "10,000.5" (có dấu phẩy)
    // Cần xóa dấu phẩy "," đi để thành số chuẩn "10000.5" cho máy tính hiểu
    let valStr = el.value.replace(/,/g, ''); 
    return parseFloat(valStr) || 0;
}


// --- 2. HÀM TÍNH TOÁN CHÍNH (CALCULATE) ---
function calculate() {
    // A. Lấy dữ liệu đầu vào
    const v1 = getValue('val-1'); // Vốn điều lệ
    const v2 = getValue('val-2'); // Vốn chủ sở hữu
    const v3 = getValue('val-3'); // Lợi nhuận sau thuế
    const v6 = getValue('val-6'); // Giá cổ phiếu hiện tại

    // B. Tính toán các chỉ số cơ bản
    
    // 4. Giá trị sổ sách = (Vốn chủ / Vốn điều lệ) * 10.000
    let v4 = 0;
    if (v1 !== 0) v4 = (v2 / v1) * 10000;
    
    // 5. EPS = (Lợi nhuận / Vốn điều lệ) * 10.000
    let v5 = 0;
    if (v1 !== 0) v5 = (v3 / v1) * 10000;

    // 7. P/E = Giá / EPS
    let v7 = 0;
    if (v5 !== 0) v7 = v6 / v5;

    // 8. P/B = Giá / Giá trị sổ sách
    let v8 = 0;
    if (v4 !== 0) v8 = v6 / v4;

    // C. Hiển thị kết quả tính toán ra màn hình
    document.getElementById('val-4').innerText = formatNumber(v4);
    document.getElementById('val-5').innerText = formatNumber(v5);
    document.getElementById('val-7').innerText = formatNumber(v7);
    document.getElementById('val-8').innerText = formatNumber(v8);

    // D. Tính toán phần TARGET (Mục tiêu)
    const targetPE = getValue('target-pe');
    const targetPB = getValue('target-pb');

    // Giá mục tiêu theo PE = Target PE * EPS
    let priceTargetPE = targetPE * v5;
    
    // Giá mục tiêu theo PB = Target PB * Book Value
    let priceTargetPB = targetPB * v4;

    // Return % = ((Giá mục tiêu - Giá hiện tại) / Giá hiện tại) * 100
    let returnPE = 0;
    let returnPB = 0;

    if (v6 !== 0) {
        returnPE = ((priceTargetPE - v6) / v6) * 100;
        returnPB = ((priceTargetPB - v6) / v6) * 100;
    }

    // E. Hiển thị kết quả Target
    document.getElementById('price-per-pe').innerText = formatNumber(priceTargetPE);
    document.getElementById('price-per-pb').innerText = formatNumber(priceTargetPB);

    const elReturnPE = document.getElementById('return-pe');
    const elReturnPB = document.getElementById('return-pb');

    elReturnPE.innerText = formatNumber(returnPE) + '%';
    elReturnPB.innerText = formatNumber(returnPB) + '%';

    // Tô màu xanh (lãi) / đỏ (lỗ) cho % Return
    colorReturn(elReturnPE, returnPE);
    colorReturn(elReturnPB, returnPB);
}

// Hàm phụ trợ tô màu
function colorReturn(el, val) {
    el.classList.remove('text-green', 'text-red');
    el.style.color = '#333'; // Mặc định
    if (val > 0) el.style.color = '#28a745'; // Xanh
    else if (val < 0) el.style.color = '#dc3545'; // Đỏ
}

// Hàm Reset form nhập liệu
function resetData() {
    const inputs = document.querySelectorAll('.input-val');
    inputs.forEach(input => input.value = '');
    calculate(); // Tính lại về 0
    showToast("Đã xóa dữ liệu nhập", "success");
}


// --- 3. HÀM LƯU DỮ LIỆU VÀO GOOGLE SHEET (API) ---
async function saveToSheet() {
    // Lấy thông tin Header
    const symbol = document.getElementById('stock-symbol').value.trim();
    const year = document.getElementById('stock-year').value.trim();

    if (!symbol) {
        showToast("Vui lòng nhập Mã cổ phiếu!", "error");
        document.getElementById('stock-symbol').focus();
        return;
    }

    // Hiệu ứng nút bấm Loading
    const btn = document.getElementById('btn-save-sheet');
    const originalText = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...`;
    btn.disabled = true;

    // Gom dữ liệu gửi đi (Payload)
    const payload = {
        symbol: symbol,
        year: year,            // <--- QUAN TRỌNG: Gửi thêm năm tài chính
        v1: getValue('val-1'), // Vốn điều lệ
        v2: getValue('val-2'), // Vốn chủ sở hữu
        v3: getValue('val-3'), // Lợi nhuận
        v6: getValue('val-6'), // Giá thị trường
        targetPE: getValue('target-pe'),
        targetPB: getValue('target-pb')
    };

    try {
        // Gọi API GAS (Hàm này nằm trong api.js)
        const response = await callGAS('saveStockValuation', payload);

        if (response.status === 'success') {
            showToast(`Thành công! Đã lưu mã ${symbol} (${year})`, "success");
        } else {
            showToast("Lỗi từ Google Sheet: " + response.message, "error");
        }

    } catch (e) {
        console.error(e);
        showToast("Lỗi kết nối server: " + e.message, "error");
    } finally {
        // Trả lại trạng thái nút bấm
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}


// --- 4. HÀM HIỂN THỊ THÔNG BÁO (TOAST) ---
function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
