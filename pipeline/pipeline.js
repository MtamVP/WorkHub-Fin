// pipeline.js
// Handles UI interactions and animations for the pipeline stages

function loadPipelineStage(stageKey) {
  // Hide all panels
  const panels = document.querySelectorAll('.pipeline-stage-panel');
  panels.forEach(panel => {
    panel.style.display = 'none';
    panel.classList.remove('active');
  });

  // Determine which panel to show based on the stage
  let targetPanelId = 'panel-auto'; // Default to auto processing panel
  if (stageKey === 'e1') {
    targetPanelId = 'panel-e1';
    loadBronzeFiles(); // Auto reload table when entering E1
  } else if (stageKey === 'e6') {
    targetPanelId = 'panel-e6';
  }

  // Show the target panel
  const targetPanel = document.getElementById(targetPanelId);
  if (targetPanel) {
    targetPanel.style.display = 'flex';
    // Small delay to allow CSS transitions if we add them later
    setTimeout(() => targetPanel.classList.add('active'), 10);
  }

  // If it's an auto-processing stage, simulate progress
  if (['e2', 'e3', 'e4', 'e5'].includes(stageKey)) {
    const titleEl = document.querySelector('#panel-auto .pipeline-panel-title');
    if (titleEl) {
      if (stageKey === 'e2') {
        titleEl.innerHTML = 'E2: Data Integrity & Source Validation';
      } else {
        titleEl.innerHTML = 'Thiết lập Auto Process';
      }
    }

    if (stageKey === 'e2') {
      runE2Validation();
    } else {
      simulateAutoProcessing(stageKey);
    }
  }
}

// Function to simulate the auto processing stages (e2-e5)
function simulateAutoProcessing(stageKey) {
  const progressBar = document.getElementById('auto-progress-bar');
  const progressText = document.getElementById('auto-progress-text');
  const consoleLog = document.getElementById('agent-console');
  
  if (!progressBar || !progressText || !consoleLog) return;

  // Reset
  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  consoleLog.innerHTML = '';

  const stageNames = {
    e2: 'Data Validator Agent',
    e3: 'Standardization Agent',
    e4: 'Analysis Agent',
    e5: 'Report Generator Agent'
  };

  const agentName = stageNames[stageKey] || 'Agent';

  // Add initial log
  addTerminalLog(consoleLog, 'INFO', `Khởi chạy ${agentName}...`, 'info');

  let progress = 0;
  const interval = setInterval(() => {
    progress += Math.floor(Math.random() * 20) + 10;
    if (progress > 100) progress = 100;

    progressBar.style.width = `${progress}%`;
    progressText.textContent = `${progress}%`;

    // Random logs based on progress
    if (progress === 30) {
      addTerminalLog(consoleLog, 'INFO', `Đang quét dữ liệu đầu vào...`, 'info');
    } else if (progress === 70) {
      if (stageKey === 'e2') {
        addTerminalLog(consoleLog, 'SUCCESS', `Pass validation checks`, 'success');
      } else {
        addTerminalLog(consoleLog, 'INFO', `Xử lý đạt 70%...`, 'info');
      }
    } else if (progress === 100) {
      addTerminalLog(consoleLog, 'SUCCESS', `${agentName} hoàn tất công việc.`, 'success');
      clearInterval(interval);
      
      // Optional: automatically move to next stage after a delay
      // setTimeout(() => navStage(1), 2000);
    }
  }, 800);
}

function addTerminalLog(container, level, message, typeClass) {
  const time = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  const line = document.createElement('div');
  line.className = 'terminal-line';
  
  const typeColor = typeClass === 'info' ? 'terminal-info' : 
                    typeClass === 'success' ? 'terminal-success' : 
                    typeClass === 'error' ? 'terminal-error' : 'terminal-warning';

  line.innerHTML = `<span class="terminal-time" style="font-weight: normal;">[${time}]</span> <span class="${typeColor}" style="font-weight: normal;">${level}</span> <span style="font-weight: normal; color: #c9d1d9;">${message}</span>`;
  container.appendChild(line);
  container.scrollTop = container.scrollHeight;
}

function runE2Validation() {
  const progressBar = document.getElementById('auto-progress-bar');
  const progressText = document.getElementById('auto-progress-text');
  const consoleLog = document.getElementById('agent-console');
  
  if (!progressBar || !progressText || !consoleLog) return;

  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  consoleLog.innerHTML = '';

  const logs = [
    { p: 5, l: 'INFO', m: 'Khởi chạy luồng kiểm tra tính toàn vẹn (Source Validation)...' },
    { p: 10, l: 'INFO', m: 'Đang kết nối tới kho chứa phân vùng Bronze...' },
    { p: 15, l: 'INFO', m: 'Đang tải danh sách các tập tin cần xác thực...' },
    { p: 20, l: 'INFO', m: 'Phát hiện 2 tập tin chuẩn bị đưa vào luồng kiểm tra.' },
    { p: 25, l: 'INFO', m: 'Đang đọc cấu trúc tập tin số 1 (Bao_cao_tai_chinh.pdf)...' },
    { p: 30, l: 'INFO', m: 'Xác thực định dạng PDF: Kiểm tra bảng tham chiếu chéo (XREF).' },
    { p: 35, l: 'INFO', m: 'Kiểm tra phông chữ nhúng (Embedded fonts): Không phát hiện lỗi.' },
    { p: 40, l: 'SUCCESS', m: 'Tập tin Bao_cao_tai_chinh.pdf nguyên vẹn và hợp lệ.' },
    { p: 45, l: 'INFO', m: 'Đang nạp luồng byte tập tin số 2 (Du_lieu_giao_dich_Q3.csv)...' },
    { p: 50, l: 'INFO', m: 'Xác minh bảng mã (Encoding): Phát hiện định dạng UTF-8 không có BOM.' },
    { p: 55, l: 'INFO', m: 'Phân tích dòng tiêu đề (Header row): Tìm thấy 12 cột dữ liệu.' },
    { p: 60, l: 'INFO', m: 'Kiểm tra tính nhất quán số lượng cột trên các dòng tiếp theo...' },
    { p: 62, l: 'INFO', m: 'Đã quét qua 1000 dòng...' },
    { p: 65, l: 'WARN', m: 'Phát hiện bất thường: Dòng 1004 có 13 cột (dư 1 cột so với tiêu đề).' },
    { p: 68, l: 'WARN', m: 'Phát hiện bất thường: Dòng 1005 có 13 cột.' },
    { p: 70, l: 'ERROR', m: 'Lỗi cấu trúc nghiêm trọng: Dữ liệu CSV bị lệch cột, vi phạm tính toàn vẹn bảng.' },
    { p: 75, l: 'ERROR', m: 'Kích hoạt cơ chế Fail-fast: Hủy bỏ tiến trình xử lý tập tin Du_lieu_giao_dich_Q3.csv.' },
    { p: 75, l: 'INFO', m: 'Đang ghi nhận nhật ký lỗi và dọn dẹp bộ nhớ tạm...' },
    { p: 75, l: 'INFO', m: 'Yêu cầu người dùng kiểm tra lại cấu trúc tập tin bị lỗi trước khi chạy tiếp luồng.' }
  ];

  let currentStep = 0;
  
  function nextStep() {
    if (currentStep >= logs.length) {
       if (typeof Swal !== 'undefined') {
          Swal.fire({
            title: 'Lỗi cấu trúc dữ liệu!', 
            text: 'Tập tin CSV bị lệch cột tại dòng 1004. Hệ thống đã dừng tiến trình (Fail-fast) để tránh sai sót dữ liệu ở các bước sau. Vui lòng làm sạch file gốc và tải lại.', 
            icon: 'error',
            confirmButtonText: 'Đã hiểu'
          });
       }
       return;
    }
    
    const step = logs[currentStep];
    progressBar.style.width = `${step.p}%`;
    progressText.textContent = `${step.p}%`;
    
    addTerminalLog(consoleLog, step.l, step.m, step.l.toLowerCase());
    
    currentStep++;
    const delay = Math.floor(Math.random() * 500) + 300;
    setTimeout(nextStep, delay);
  }

  nextStep();
}

// Action Handlers
async function simulateIngest(btn) {
  const metaCategory = document.getElementById('pipeline-meta-category')?.value.trim();
  
  if (!metaCategory) {
    alert("Vui lòng nhập Phân loại trước khi tải lên!");
    return;
  }

  if (!window.pipelineValidFiles || window.pipelineValidFiles.length === 0) {
    alert("Vui lòng chọn ít nhất 1 file hợp lệ để tải lên!");
    return;
  }

  let originalHtml = '';
  if (btn) {
    originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải lên...';
  }

  try {
    for (let item of window.pipelineValidFiles) {
      const file = item.file;
      const base64Data = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result.split(',')[1]);
        reader.readAsDataURL(file);
      });
      
      const email = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) ? CURRENT_USER.email : 'unknown';
      const description = `[${metaCategory}] ${item.customName}`;
      
      // Ghép customName với phần mở rộng
      const finalFileName = `${item.customName}.${item.ext}`;
      
      const response = await callGAS('uploadFile', {
        fileData: base64Data,
        fileName: finalFileName,
        mimeType: file.type || 'application/octet-stream',
        groupKey: 'finance',
        description: description,
        email: email,
        folderPath: item.customFolder || ''
      });
      
      if (response && response.status === 'error') {
        throw new Error(response.message);
      }
    }
    
    // Clear selection
    window.pipelineValidFiles = [];
    const container = document.getElementById('pipeline-selected-files');
    if (container) container.innerHTML = '';
    const fileInput = document.getElementById('pipeline-file-input');
    if (fileInput) fileInput.value = '';

    // Reload bronze table
    await loadBronzeFiles();
    
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        title: 'Tải lên Bronze thành công!',
        text: 'File đã đẩy vào Supabase Storage.',
        icon: 'success',
        timer: 1500,
        showConfirmButton: false
      }).then(() => {
        if (typeof navStage === 'function') navStage(1);
      });
    } else {
      alert("Đã upload xong! Chuyển sang E2.");
      if (typeof navStage === 'function') navStage(1);
    }
  } catch (err) {
    if (typeof Swal !== 'undefined') {
      Swal.fire('Lỗi tải file', err.message, 'error');
    } else {
      alert("Lỗi upload: " + err.message);
    }
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }
}

async function loadBronzeFiles() {
  const tbody = document.getElementById('pipeline-bronze-table-body');
  if (!tbody) return;
  
  try {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải dữ liệu...</td></tr>';
    
    const response = await callGAS('getFileList', { groupKey: 'finance' });
    let files = [];
    if (response && response.status === 'success') {
      files = response.data || [];
    } else if (Array.isArray(response)) {
      files = response;
    }
    
    // Lọc các file có folderPath chứa 'bronze'
    const bronzeFiles = files.filter(f => f.url && f.url.includes('/bronze/'));
    
    if (bronzeFiles.length === 0) {
      tbody.innerHTML = `<tr>
        <td colspan="4" style="text-align: center; padding: 20px; border-bottom: none;">
          <div class="empty-state" style="color: var(--text-muted);">Chưa có file nào trong thư mục này</div>
        </td>
      </tr>`;
      return;
    }
    
    let html = '';
    bronzeFiles.forEach(f => {
       const icon = f.name.endsWith('.pdf') ? 'fa-file-pdf' : f.name.endsWith('.csv') ? 'fa-file-csv' : (f.name.endsWith('.json') ? 'fa-file-code' : 'fa-file-excel');
       html += `<tr>
         <td><i class="fa-solid ${icon}" style="color: var(--success-color); margin-right: 6px;"></i> ${f.name}</td>
         <td>${f.date || 'Vừa xong'}</td>
         <td>-</td>
         <td><span style="color: #3fb950;"><i class="fa-solid fa-check-circle"></i> Đã tải</span></td>
       </tr>`;
    });
    tbody.innerHTML = html;
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:#f85149;">Lỗi tải dữ liệu</td></tr>`;
  }
}

function handleApprove() {
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      title: 'Đã duyệt báo cáo',
      text: 'Báo cáo sẽ được xuất bản (E7)',
      icon: 'success',
      timer: 1500,
      showConfirmButton: false
    }).then(() => {
      if (typeof navStage === 'function') navStage(1);
    });
  } else {
    alert("Đã duyệt! Chuyển sang E7");
    if (typeof navStage === 'function') navStage(1);
  }
}

function handleReject() {
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      title: 'Đã từ chối',
      text: 'Quay lại giai đoạn Phân tích (E4)',
      icon: 'warning',
      timer: 1500,
      showConfirmButton: false
    }).then(() => {
      // jump back to E4 (index 3)
      if (typeof switchStage === 'function') switchStage('e4');
    });
  } else {
    alert("Đã trả lại E4 (Analysis)");
    if (typeof switchStage === 'function') switchStage('e4');
  }
}

// File Upload Handlers for E1
function togglePipelineUploadMode() {
  const type = document.querySelector('input[name="pipelineUploadType"]:checked').value;
  const textEl = document.getElementById('pipeline-drop-text');
  if (textEl) {
    textEl.textContent = type === 'folder' ? 'Kéo thả thư mục hoặc click để tải lên' : 'Kéo thả file hoặc click để tải lên';
  }
}

function triggerPipelineUpload() {
  const type = document.querySelector('input[name="pipelineUploadType"]:checked').value;
  if (type === 'folder') {
    document.getElementById('pipeline-folder-input').click();
  } else {
    document.getElementById('pipeline-file-input').click();
  }
}

// Biến toàn cục lưu danh sách file hợp lệ đã chọn (mảng object)
if (!window.pipelineValidFiles) {
  window.pipelineValidFiles = [];
}

function handlePipelineFileSelect(event) {
  const rawFiles = event.target.files;
  
  if (!rawFiles || rawFiles.length === 0) return;

  const allowedExts = ['docx', 'pdf', 'txt', 'csv', 'tsv', 'json', 'xlsx'];
  const maxSizeBytes = 50 * 1024 * 1024; // 50MB
  let errorMessages = [];

  for (let i = 0; i < rawFiles.length; i++) {
    const file = rawFiles[i];
    const extMatch = file.name.match(/\.([^.]+)$/);
    const ext = extMatch ? extMatch[1].toLowerCase() : '';
    
    // Validate
    if (!allowedExts.includes(ext)) {
      errorMessages.push(`"${file.name}" (Sai định dạng)`);
      continue;
    }
    if (file.size === 0) {
      errorMessages.push(`"${file.name}" (File rỗng)`);
      continue;
    }
    if (file.size > maxSizeBytes) {
      errorMessages.push(`"${file.name}" (Vượt quá 50MB)`);
      continue;
    }

    // Extract custom folder from webkitRelativePath
    let customFolder = '';
    if (file.webkitRelativePath) {
      const parts = file.webkitRelativePath.split('/');
      if (parts.length > 1) {
        parts.pop(); // Bỏ tên file
        customFolder = parts.join('/');
      }
    }

    const customName = file.name.replace(/\.[^/.]+$/, "");

    window.pipelineValidFiles.push({
      id: "stg_" + Date.now() + "_" + Math.floor(Math.random() * 10000),
      file: file,
      customName: customName,
      customFolder: customFolder,
      ext: ext
    });
  }

  // Reset input để có thể chọn lại cùng 1 file
  event.target.value = '';

  if (errorMessages.length > 0) {
    alert(`Bỏ qua ${errorMessages.length} file không hợp lệ:\n` + errorMessages.slice(0,3).join('\n'));
  }

  renderStagingTable();
}

function renderStagingTable() {
  const container = document.getElementById('pipeline-staging-area');
  const tbody = document.getElementById('pipeline-staging-body');
  const summary = document.getElementById('pipeline-selected-files');
  
  if (!container || !tbody || !summary) return;

  if (window.pipelineValidFiles.length === 0) {
    container.style.display = 'none';
    summary.innerHTML = '<div style="color: var(--text-muted);">Chưa có file nào trong hàng chờ.</div>';
    return;
  }

  container.style.display = 'block';
  summary.innerHTML = `<div style="color: var(--success-color);"><strong>Đang chờ tải lên: ${window.pipelineValidFiles.length} file</strong></div>`;

  let html = '';
  window.pipelineValidFiles.forEach(item => {
    html += `
      <tr>
        <td style="text-align: center;">
          <i class="fa-solid fa-xmark" style="color: var(--danger-color); cursor: pointer;" onclick="removeStagingFile('${item.id}')" title="Xóa"></i>
        </td>
        <td>
          <input type="text" class="pipeline-input" style="padding: 4px 8px; font-size: 12px; height: 28px;" value="${item.customName}" onchange="updateStagingFileName('${item.id}', this.value)" placeholder="Tên file">
          <div style="font-size: 10px; color: var(--text-muted); margin-top: 2px;" title="${item.file.name}">Gốc: ${item.file.name.substring(0,25)}${item.file.name.length>25?'...':''}</div>
        </td>
        <td>
          <input type="text" class="pipeline-input" style="padding: 4px 8px; font-size: 12px; height: 28px;" value="${item.customFolder}" onchange="updateStagingFolder('${item.id}', this.value)" placeholder="Vd: BaoCao_Q3">
        </td>
      </tr>
    `;
  });
  
  tbody.innerHTML = html;
}

function removeStagingFile(id) {
  window.pipelineValidFiles = window.pipelineValidFiles.filter(item => item.id !== id);
  renderStagingTable();
}

function updateStagingFileName(id, newValue) {
  const item = window.pipelineValidFiles.find(i => i.id === id);
  if (item) item.customName = newValue.trim();
}

function updateStagingFolder(id, newValue) {
  const item = window.pipelineValidFiles.find(i => i.id === id);
  if (item) item.customFolder = newValue.trim();
}

function applyBulkFolder() {
  const bulkInput = document.getElementById('pipeline-bulk-folder');
  if (!bulkInput) return;
  const folderVal = bulkInput.value.trim();
  
  if (window.pipelineValidFiles.length === 0) {
    alert("Không có file nào trong hàng chờ!");
    return;
  }
  
  window.pipelineValidFiles.forEach(item => {
    item.customFolder = folderVal;
  });
  renderStagingTable();
}

window.loadPipelineStage = loadPipelineStage;
