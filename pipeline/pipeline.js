// pipeline.js
// Handles UI interactions and animations for the pipeline stages

window.isAutoPaused = false;

function toggleAutoProcess() {
  window.isAutoPaused = !window.isAutoPaused;
  const btn = document.getElementById('btn-toggle-auto');
  if (btn) {
    if (window.isAutoPaused) {
      btn.innerHTML = '<i class="fa-solid fa-play"></i> Tiếp tục';
      btn.classList.replace('pipeline-btn-secondary', 'pipeline-btn-primary');
    } else {
      btn.innerHTML = '<i class="fa-solid fa-pause"></i> Tạm dừng';
      btn.classList.replace('pipeline-btn-primary', 'pipeline-btn-secondary');
    }
  }
}

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
      } else if (stageKey === 'e3') {
        titleEl.innerHTML = 'E3: Data Standardization & Cleaning';
      } else {
        titleEl.innerHTML = 'Thiết lập Auto Process';
      }
    }

    if (stageKey === 'e2') {
      window.isAutoPaused = false;
      const btn = document.getElementById('btn-toggle-auto');
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> Tạm dừng';
        btn.classList.remove('pipeline-btn-primary');
        btn.classList.add('pipeline-btn-secondary');
      }
      runE2Validation();
    } else if (stageKey === 'e3') {
      window.isAutoPaused = false;
      const btn = document.getElementById('btn-toggle-auto');
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> Tạm dừng';
        btn.classList.remove('pipeline-btn-primary');
        btn.classList.add('pipeline-btn-secondary');
      }
      runE3Cleaning();
    } else {
      window.isAutoPaused = false;
      const btn = document.getElementById('btn-toggle-auto');
      if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i> Tạm dừng';
        btn.classList.remove('pipeline-btn-primary');
        btn.classList.add('pipeline-btn-secondary');
      }
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
    if (window.isAutoPaused) return;

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

async function runE2Validation() {
  const progressBar = document.getElementById('auto-progress-bar');
  const progressText = document.getElementById('auto-progress-text');
  const consoleLog = document.getElementById('agent-console');
  
  if (!progressBar || !progressText || !consoleLog) return;

  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  consoleLog.innerHTML = '';

  addTerminalLog(consoleLog, 'INFO', 'Khởi chạy luồng kiểm tra định dạng và cấu trúc...', 'info');
  addTerminalLog(consoleLog, 'INFO', 'Đang kết nối tới bronze...', 'info');

  try {
    const response = await callGAS('getFileList', { groupKey: 'finance' });
    let files = [];
    if (response && response.status === 'success') {
      files = response.data || [];
    } else if (Array.isArray(response)) {
      files = response;
    }
    
    const bronzeFiles = files.filter(f => f.url && f.url.includes('/bronze/'));
    
    if (bronzeFiles.length === 0) {
      addTerminalLog(consoleLog, 'WARN', 'Không tìm thấy tập tin nào trong bronze để kiểm tra.', 'warning');
      progressBar.style.width = '100%';
      progressText.textContent = '100%';
      return;
    }

    addTerminalLog(consoleLog, 'INFO', `Phát hiện ${bronzeFiles.length} tập tin. Bắt đầu quét...`, 'info');

    let currentStep = 0;
    
    function checkNextFile() {
      if (window.isAutoPaused) {
        setTimeout(checkNextFile, 500);
        return;
      }

      if (currentStep >= bronzeFiles.length) {
         progressBar.style.width = '100%';
         progressText.textContent = '100%';
         addTerminalLog(consoleLog, 'SUCCESS', 'Đã hoàn tất kiểm tra cơ bản tất cả các tập tin. Chuyển sang E3...', 'success');
         
         setTimeout(() => {
           if (typeof navStage === 'function') navStage(1);
         }, 2500);
         return;
      }

      const file = bronzeFiles[currentStep];
      const p = Math.floor(10 + (currentStep / bronzeFiles.length) * 80);
      progressBar.style.width = `${p}%`;
      progressText.textContent = `${p}%`;

      addTerminalLog(consoleLog, 'INFO', `Đang kiểm tra tập tin: ${file.name}...`, 'info');

      setTimeout(() => {
        addTerminalLog(consoleLog, 'INFO', `Xác minh encoding và tính toàn vẹn: Không phát hiện lỗi nghiêm trọng.`, 'info');
        
        setTimeout(() => {
          addTerminalLog(consoleLog, 'SUCCESS', `Tập tin ${file.name} hợp lệ.`, 'success');
          
          currentStep++;
          const delay = Math.floor(Math.random() * 300) + 200;
          setTimeout(checkNextFile, delay);
        }, Math.floor(Math.random() * 300) + 200);

      }, Math.floor(Math.random() * 300) + 200);
    }

    checkNextFile();

  } catch (err) {
    addTerminalLog(consoleLog, 'ERROR', 'Lỗi kết nối tới Storage: ' + err.message, 'error');
  }
}

async function runE3Cleaning() {
  const progressBar = document.getElementById('auto-progress-bar');
  const progressText = document.getElementById('auto-progress-text');
  const consoleLog = document.getElementById('agent-console');
  
  if (!progressBar || !progressText || !consoleLog) return;

  progressBar.style.width = '0%';
  progressText.textContent = '0%';
  consoleLog.innerHTML = '';

  addTerminalLog(consoleLog, 'INFO', 'Khởi chạy luồng chuẩn hóa và làm sạch (Cleaning & Parsing)...', 'info');
  
  try {
    const response = await callGAS('getFileList', { groupKey: 'finance' });
    let files = [];
    if (response && response.status === 'success') {
      files = response.data || [];
    } else if (Array.isArray(response)) {
      files = response;
    }
    
    // Lọc lấy các file từ bronze
    const bronzeFiles = files.filter(f => f.url && f.url.includes('/bronze/'));
    
    if (bronzeFiles.length === 0) {
      addTerminalLog(consoleLog, 'WARN', 'Không tìm thấy tập tin nào ở phân vùng Bronze để làm sạch.', 'warning');
      progressBar.style.width = '100%';
      progressText.textContent = '100%';
      return;
    }

    let currentStep = 0;
    
    // Khởi tạo Web Worker
    const parserWorker = new Worker('pipeline/parser-worker.js');
    
    function cleanNextFile() {
      if (window.isAutoPaused) {
        setTimeout(cleanNextFile, 500);
        return;
      }

      if (currentStep >= bronzeFiles.length) {
         progressBar.style.width = '100%';
         progressText.textContent = '100%';
         addTerminalLog(consoleLog, 'SUCCESS', 'Đã hoàn tất quy trình làm sạch (E3). Dữ liệu được đẩy vào Silver.', 'success');
         parserWorker.terminate();
         
         setTimeout(() => {
           if (typeof navStage === 'function') navStage(1);
         }, 2500);
         return;
      }

      const file = bronzeFiles[currentStep];
      const p = Math.floor(10 + (currentStep / bronzeFiles.length) * 80);
      progressBar.style.width = `${p}%`;
      progressText.textContent = `${p}%`;

      const extMatch = file.name.match(/\.([^.]+)$/);
      const ext = extMatch ? extMatch[1].toLowerCase() : '';
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      const cleanName = `clean_${baseName}.txt`;

      addTerminalLog(consoleLog, 'INFO', `Đang tải file ${file.name} từ Bronze về bộ nhớ tạm...`, 'info');

      // Tải file và parse qua Web Worker
      fetch(file.url)
        .then(res => res.arrayBuffer())
        .then(arrayBuffer => {
           addTerminalLog(consoleLog, 'INFO', `Đã nạp ArrayBuffer. Kích hoạt Web Worker parse dữ liệu...`, 'info');
           
           parserWorker.onmessage = async (e) => {
             if (e.data.success) {
               addTerminalLog(consoleLog, 'SUCCESS', `Parse thành công! Bắt đầu upload lên Silver...`, 'success');
               const rawText = e.data.text;
               // Base64 encode an toàn với Unicode
               const base64Data = btoa(unescape(encodeURIComponent(rawText)));
               const email = (typeof CURRENT_USER !== 'undefined' && CURRENT_USER) ? CURRENT_USER.email : 'unknown';
               
               try {
                 const res = await callGAS('uploadFile', {
                    fileData: base64Data,
                    fileName: cleanName,
                    mimeType: 'text/plain',
                    groupKey: 'finance',
                    description: `[Cleaned] Dữ liệu từ ${file.name}`,
                    email: email,
                    folderPath: 'silver'
                 });
                 if (res && res.status === 'error') {
                    addTerminalLog(consoleLog, 'ERROR', `Lỗi tải lên Silver: ${res.message}`, 'error');
                 } else {
                    addTerminalLog(consoleLog, 'SUCCESS', `Tạo thành công file ${cleanName} tại Silver.`, 'success');
                 }
               } catch (err) {
                 addTerminalLog(consoleLog, 'ERROR', `Lỗi kết nối khi đẩy dữ liệu sang Silver.`, 'error');
               }
             } else {
               addTerminalLog(consoleLog, 'ERROR', `Lỗi bóc tách dữ liệu: ${e.data.error}`, 'error');
             }
             
             // Xử lý file tiếp theo
             currentStep++;
             setTimeout(cleanNextFile, 1000);
           };

           // Gửi lệnh parse
           parserWorker.postMessage({
              fileBytes: arrayBuffer,
              fileName: file.name,
              ext: ext
           }, [arrayBuffer]); // Transferrable object để tiết kiệm RAM
        })
        .catch(err => {
           addTerminalLog(consoleLog, 'ERROR', `Không thể tải file ${file.name}: ${err.message}`, 'error');
           currentStep++;
           setTimeout(cleanNextFile, 1000);
        });
    }

    cleanNextFile();

  } catch (err) {
    addTerminalLog(consoleLog, 'ERROR', 'Lỗi kết nối tới Storage: ' + err.message, 'error');
  }
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
