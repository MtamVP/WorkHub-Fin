/* --- FILE: /mastersheet/assets/script.js --- */

let myTable = null; 

document.addEventListener('DOMContentLoaded', async function() {
    const userEmail = localStorage.getItem('userEmail') || 'Khách';
    const userDisplay = document.getElementById('user-display');
    if (userDisplay) userDisplay.innerHTML = `<i class="fa-solid fa-user"></i> ${userEmail}`;

    // Kích hoạt lắng nghe nhập liệu (Có tính năng Lưu vào LocalStorage)
    setupInputListeners(userEmail); 

    const columnsConfig = [
        { type: 'text', title: 'STT', width: 40, readOnly: true, align: 'center' },
        { type: 'text', title: 'Danh mục', width: 80, align: 'center' },
        { type: 'numeric', title: 'Vol', width: 90, mask: '#,##0' },
        { type: 'numeric', title: 'CK giao dịch', width: 100, mask: '#,##0', readOnly: true },
        { type: 'numeric', title: 'CK HCCN', width: 90, mask: '#,##0' },
        { type: 'numeric', title: 'Giá vốn', width: 90, mask: '#,##0.00' },
        { type: 'numeric', title: 'Giá TT', width: 90, mask: '#,##0.00' }, 
        { type: 'numeric', title: 'GT vốn', width: 120, mask: '#,##0', readOnly: true },
        { type: 'numeric', title: 'GTTT', width: 120, mask: '#,##0', readOnly: true },
        { type: 'numeric', title: 'Lãi/lỗ', width: 110, mask: '#,##0', readOnly: true }
    ];

    await loadData(userEmail, columnsConfig);

    const saveBtn = document.getElementById('save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => saveData(userEmail, columnsConfig));
});

// --- CÁC KHÓA LƯU TRỮ LOCALSTORAGE ---
function getCacheKey(email, type) {
    return `finance_${type}_${email}`; 
}

// --- HÀM TẢI DỮ LIỆU ---
async function loadData(email, columns) {
    const spreadsheetDiv = document.getElementById('my-spreadsheet');
    if (myTable) { myTable.destroy(); myTable = null; }

    spreadsheetDiv.innerHTML = '<div style="padding:40px; text-align:center;"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><br>Đang đồng bộ dữ liệu...</div>';

    try {
        const response = await callGAS('getAssetData', { email: email });
        spreadsheetDiv.innerHTML = '';

        // 1. Lấy dữ liệu từ Server
        let serverCash = parseFloat(response.cash) || 0;
        let serverDebt = parseFloat(response.debt) || 0;

        // 2. Lấy dữ liệu từ LocalStorage
        const localCash = localStorage.getItem(getCacheKey(email, 'cash'));
        const localDebt = localStorage.getItem(getCacheKey(email, 'debt'));

        // 3. Logic ưu tiên dữ liệu
        let displayCash = serverCash;
        let displayDebt = serverDebt;

        if (serverCash === 0 && localCash && parseMoney(localCash) > 0) {
            displayCash = parseMoney(localCash);
        } else {
            if(serverCash > 0) localStorage.setItem(getCacheKey(email, 'cash'), serverCash);
        }

        if (serverDebt === 0 && localDebt && parseMoney(localDebt) > 0) {
            displayDebt = parseMoney(localDebt);
        } else {
            if(serverDebt > 0) localStorage.setItem(getCacheKey(email, 'debt'), serverDebt);
        }

        // 4. Cập nhật 2 ô INPUT
        const inpCash = document.getElementById('inp-cash');
        const inpDebt = document.getElementById('inp-debt');
        if (inpCash) inpCash.value = displayCash.toLocaleString('en-US');
        if (inpDebt) inpDebt.value = displayDebt.toLocaleString('en-US');

        let tableData = [];
        if (response.status === 'success') {
            if (response.data && response.data.length > 0) {
                tableData = response.data.map((row, index) => {
                    const i = index + 1;
                    // Formula cho Jspreadsheet: Lãi lỗ = GTTT - GTVon
                    return [
                        index + 1, row[1], row[2], row[3] || row[2], row[4] || 0, row[5], row[6],
                        `=C${i}*F${i}*1000`, `=C${i}*G${i}*1000`, `=I${i}-H${i}`
                    ];
                });
            }
        }

        const minStockRows = 5;
        if (tableData.length < minStockRows) {
            for(let i = tableData.length + 1; i <= minStockRows; i++) {
                tableData.push([i, "", "", "", "", "", "", `=C${i}*F${i}*1000`, `=C${i}*G${i}*1000`, `=I${i}-H${i}`]);
            }
        }

        // --- TẠO FOOTER ---
        tableData.push(["TỔNG DANH MỤC", "", "", "", "", "", "", 0, 0, 0]); 
        tableData.push(["Tiền mặt", "", "", "", "", "", "", displayCash, "", ""]); 
        tableData.push(["Dư nợ", "", "", "", "", "", "", displayDebt, "", ""]); 
        tableData.push(["NAV", "", "", "", "", "", "", 0, "", ""]); 

        const totalRowIdx = tableData.length - 4; 
        const idxTotal = totalRowIdx + 1; 
        const idxCash = idxTotal + 1;
        const idxDebt = idxTotal + 2;
        const idxNav = idxTotal + 3;

        myTable = jspreadsheet(spreadsheetDiv, {
            data: tableData,
            columns: columns,
            minDimensions: [10, tableData.length],
            defaultColAlign: 'center',
            license: '39130-64ebc-bd98e-26bc4',
            
            // Merge Cells
            mergeCells: {
                [`A${idxTotal}`]: [7, 1], 
                [`A${idxCash}`]: [7, 1], 
                [`A${idxDebt}`]: [7, 1], 
                [`A${idxNav}`]: [7, 1], 
                [`H${idxNav}`]: [3, 1], 
                [`H${idxCash}`]: [3, 1], 
                [`H${idxDebt}`]: [3, 1] 
            },

            // Unlock Cells
            cells: {
                [`H${idxCash}`]: { readOnly: false }, 
                [`H${idxDebt}`]: { readOnly: false }  
            },
            
            // --- [UPDATE] STYLE CƠ BẢN ---
            // Lưu ý: background-color/color ở đây chỉ set font-weight/text-align đáng tin cậy qua config này;
            // .jexcel td có rule "!important" cho background-color/color nên set màu tô đậm thật sự
            // được thực hiện ở applyHighlightColors() ngay sau khi bảng render xong (dùng setProperty(...,'important')).
            style: {
                [`A${idxTotal}`]: 'font-weight:bold; text-align:center; padding-right:10px;',
                [`H${idxTotal}`]: 'font-weight:bold;',
                [`I${idxTotal}`]: 'font-weight:bold;',
                [`J${idxTotal}`]: 'font-weight:bold;', // Ô Tổng Lãi Lỗ

                [`A${idxCash}`]: 'font-weight:bold; text-align:center; padding-right:10px;',
                [`A${idxDebt}`]: 'font-weight:bold; text-align:center; padding-right:10px;',
                [`A${idxNav}`]: 'font-weight:bold; text-align:center; padding-right:10px;',

                [`H${idxCash}`]: 'font-weight:bold; text-align: center;',
                [`H${idxDebt}`]: 'font-weight:bold; text-align: center;',
                [`H${idxNav}`]: 'font-weight:bold; font-size:1.1em; text-align: center;',
            },

            // --- [SỬA LỖI] LOGIC TÔ MÀU CHÍNH XÁC ---
            updateTable: function(instance, cell, col, row, val, label, cellName) {
                // Kiểm tra cột Lãi/Lỗ (Cột J - index 9)
                if (col === 9) {
                    // QUAN TRỌNG: Dùng 'label' (giá trị hiển thị) thay vì 'val' (công thức)
                    // label sẽ là chuỗi "10,000" hoặc "-5,000"
                    let valueToCheck = label || val; 
                    let numVal = parseMoney(valueToCheck);
                    
                    // Reset class cũ
                    cell.classList.remove('text-success', 'text-danger');
                    cell.style.color = ''; 
                    cell.style.fontWeight = 'bold'; // Mặc định đậm cho cột này

                    if (numVal > 0) {
                        cell.classList.add('text-success'); // Xanh
                    } else if (numVal < 0) {
                        cell.classList.add('text-danger'); // Đỏ
                    }
                    // == 0: giữ màu chữ mặc định (var(--text-primary) từ rule chung .jexcel td)
                }
            },

            onchange: function(instance, cell, x, y, value) {
                const currentTotalRowIdx = findTotalRowIndex();
                if (currentTotalRowIdx === -1) return;
                const rowIndex = parseInt(y);
                if (rowIndex >= currentTotalRowIdx) return;
                if (parseInt(x) === 2) myTable.setValueFromCoords(3, y, value, true); 
                calculateFooterValues();
            },
            
            oninsertrow: function() { updateSTT(); calculateFooterValues(); },
            ondeleterow: function() { updateSTT(); calculateFooterValues(); }
        });

        applyHighlightColors(totalRowIdx, totalRowIdx + 1, totalRowIdx + 2, totalRowIdx + 3);
        calculateFooterValues();

    } catch (e) {
        spreadsheetDiv.innerHTML = `<p style="color:var(--danger-color); text-align:center;">Lỗi: ${e.message}</p>`;
    }
}

// --- TÔ MÀU CÁC DÒNG TỔNG/NAV (setProperty + 'important' để thắng rule !important chung của .jexcel td) ---
function tintCell(col, row, bg, color) {
    if (!myTable) return;
    const cell = myTable.getCellFromCoords(col, row);
    if (!cell) return;
    if (bg) cell.style.setProperty('background-color', bg, 'important');
    if (color) cell.style.setProperty('color', color, 'important');
}

function applyHighlightColors(idxTotal, idxCash, idxDebt, idxNav) {
    const totalTint = 'color-mix(in srgb, var(--border-color) 60%, var(--card-bg))';
    const navTint = 'color-mix(in srgb, var(--gold) 14%, var(--card-bg))';
    [0, 7, 8, 9].forEach(col => tintCell(col, idxTotal, totalTint, null));
    [0, 7, 8, 9].forEach(col => tintCell(col, idxNav, navTint, 'var(--gold)'));
    tintCell(7, idxCash, null, 'var(--success-color)');
    tintCell(7, idxDebt, null, 'var(--danger-color)');
}

// --- HÀM TÍNH TOÁN REAL-TIME ---
function calculateFooterValues() {
    if (!myTable) return;
    const totalRowIdx = findTotalRowIndex();
    if (totalRowIdx === -1) return;

    const data = myTable.getData();
    let sumGTVon = 0, sumGTTT = 0, sumLaiLo = 0;

    for (let i = 0; i < totalRowIdx; i++) {
        if (data[i][1] || data[i][2]) { 
            const vol = parseMoney(data[i][2]);
            const giaVon = parseMoney(data[i][5]);
            const giaTT = parseMoney(data[i][6]);
            const valGTVon = vol * giaVon * 1000;
            const valGTTT = vol * giaTT * 1000;
            sumGTVon += valGTVon;
            sumGTTT += valGTTT;
            sumLaiLo += (valGTTT - valGTVon);
        }
    }

    myTable.setValueFromCoords(7, totalRowIdx, sumGTVon, true); 
    myTable.setValueFromCoords(8, totalRowIdx, sumGTTT, true); 
    
    // Cập nhật giá trị Tổng Lãi Lỗ
    myTable.setValueFromCoords(9, totalRowIdx, sumLaiLo, true); 
    
    // [NEW] Cập nhật màu sắc cho ô Tổng Lãi Lỗ (J_Total) ngay lập tức
    // Jspreadsheet có hàm getCell để lấy DOM element
    // Cột J là index 9
    let cellTotalLaiLo = myTable.getCellFromCoords(9, totalRowIdx);
    if (cellTotalLaiLo) {
        if (sumLaiLo > 0) {
            cellTotalLaiLo.style.setProperty('color', 'var(--success-color)', 'important');
            cellTotalLaiLo.style.fontWeight = 'bold';
        } else if (sumLaiLo < 0) {
            cellTotalLaiLo.style.setProperty('color', 'var(--danger-color)', 'important');
            cellTotalLaiLo.style.fontWeight = 'bold';
        } else {
            cellTotalLaiLo.style.removeProperty('color');
        }
    }

    // Lấy giá trị từ Input
    const inpCash = document.getElementById('inp-cash');
    const inpDebt = document.getElementById('inp-debt');
    const cash = inpCash ? parseMoney(inpCash.value) : 0;
    const debt = inpDebt ? parseMoney(inpDebt.value) : 0;

    // Cập nhật ngược vào bảng
    myTable.setValueFromCoords(7, totalRowIdx + 1, cash, true);
    myTable.setValueFromCoords(7, totalRowIdx + 2, debt, true);

    const nav = sumGTTT + cash - debt;
    myTable.setValueFromCoords(7, totalRowIdx + 3, nav, true);
}

// --- HÀM LƯU DỮ LIỆU ---
async function saveData(email, columnsConfig) {
    if (!myTable) return;
    const btn = document.getElementById('save-btn');
    const originalText = btn.innerHTML;
    const rawData = myTable.getData();
    const totalRowIdx = findTotalRowIndex();

    // 1. Lấy Tiền/Nợ từ Input
    const cash = parseMoney(document.getElementById('inp-cash').value);
    const debt = parseMoney(document.getElementById('inp-debt').value);

    localStorage.setItem(getCacheKey(email, 'cash'), cash);
    localStorage.setItem(getCacheKey(email, 'debt'), debt);

    const stockRows = rawData.slice(0, totalRowIdx);
    const cleanStocks = stockRows.filter(row => row[1] && row[1].toString().trim() !== "");

    const dataToSend = cleanStocks.map((row, index) => {
        const vol = parseMoney(row[2]);
        const giaVon = parseMoney(row[5]);
        const giaTT = parseMoney(row[6]);
        const ckGD = parseMoney(row[3]) || vol;
        const ckHCCN = parseMoney(row[4]) || 0;
        const gtVon = Math.round(vol * giaVon * 1000);
        const gttt = Math.round(vol * giaTT * 1000);
        const laiLo = gttt - gtVon;
        return [index + 1, row[1].toUpperCase(), vol, ckGD, ckHCCN, giaVon, giaTT, gtVon, gttt, laiLo];
    });

    try {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...'; 
        btn.disabled = true;
        
        const result = await callGAS('saveAssetData', {
            email: email,
            data: JSON.stringify({ items: dataToSend, cash: cash, debt: debt })
        });
        
        if (result.status === 'success' || typeof result === 'string') {
             const msg = result.message || result;
             showToast(msg, 'success'); 
             // await loadData(email, columnsConfig); // Tùy chọn: Load lại hoặc giữ nguyên
        } else {
             showToast("Có lỗi: " + JSON.stringify(result), 'error');
        }
    } catch (e) {
        showToast("Lỗi kết nối: " + e.message, 'error');
    } finally {
        btn.innerHTML = originalText; 
        btn.disabled = false;
    }
}

// --- HÀM SETUP SỰ KIỆN NHẬP LIỆU (Có lưu cache) ---
function setupInputListeners(email) {
    ['inp-cash', 'inp-debt'].forEach(id => {
        const el = document.getElementById(id);
        if(el) {
            el.addEventListener('input', function(e) {
                let val = e.target.value.replace(/,/g, '').replace(/[^0-9.]/g, '');
                let numVal = 0;
                
                if(val) {
                    numVal = parseFloat(val);
                    e.target.value = numVal.toLocaleString('en-US');
                } else {
                    e.target.value = 0;
                }
                
                const type = id === 'inp-cash' ? 'cash' : 'debt';
                localStorage.setItem(getCacheKey(email, type), numVal);
                
                // Cập nhật vào bảng khi gõ input
                if(myTable) {
                    const totalRowIdx = findTotalRowIndex();
                    if(totalRowIdx !== -1) {
                         const cellY = type === 'cash' ? totalRowIdx + 1 : totalRowIdx + 2;
                         myTable.setValueFromCoords(7, cellY, numVal, true);
                    }
                }
                
                calculateFooterValues();
            });
        }
    });
}

function findTotalRowIndex() {
    if (!myTable) return -1;
    const data = myTable.getData();
    for (let i = data.length - 1; i >= 0; i--) {
        if (data[i][0] === "TỔNG DANH MỤC") return i;
    }
    return -1;
}

function parseMoney(value) {
    if (!value) return 0;
    if (typeof value === 'number') return value;
    return parseFloat(value.toString().replace(/,/g, '')) || 0;
}

function updateSTT() {
    if (!myTable) return;
    const totalIdx = findTotalRowIndex();
    for(let i = 0; i < totalIdx; i++) myTable.setValueFromCoords(0, i, i + 1, true); 
}

function showToast(message, type = 'success') {
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}