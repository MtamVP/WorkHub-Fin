/* ==========================================================================
   WORKHUB FINANCE — PIPELINE OVERVIEW & STAGE CONTROLLER
   ========================================================================== */

const STAGES_META = {
  e1: {
    code: 'E1',
    title: 'E1 - Ingest (Thu thập dữ liệu thô)',
    layer: 'Lớp Bronze (WorkHub Storage)',
    layerClass: 'pill-warning',
    storageTier: 'WorkHub Storage: finance_bucket/bronze/',
    desc: 'Thu thập dữ liệu từ Website, API hoặc upload file (như JSON) để đưa vào lớp Bronze. Giai đoạn này yêu cầu nguồn phải hợp lệ, file đọc được và có siêu dữ liệu (metadata) tối thiểu.'
  },
  e2: {
    code: 'E2',
    title: 'E2 - Source Validation (Xác thực nguồn)',
    layer: 'Lớp Bronze (WorkHub Storage)',
    layerClass: 'pill-warning',
    storageTier: 'WorkHub Storage: finance_bucket/bronze/',
    desc: 'Đánh giá độ tin cậy, độ mới (freshness), độ phủ và giấy phép của dữ liệu để đảm bảo điểm nguồn đạt ngưỡng yêu cầu.'
  },
  e3: {
    code: 'E3',
    title: 'E3 - Standardization (Chuẩn hóa)',
    layer: 'Lớp Silver (WorkHub-Tools Storage)',
    layerClass: 'pill-info',
    storageTier: 'WorkHub-Tools Storage: silver_bucket/silver/',
    desc: 'Làm sạch, chuẩn hóa, ánh xạ (mapping) và phân giải thực thể để chuyển dữ liệu lên lớp Silver. Quá trình này sẽ kiểm tra schema, tính toàn vẹn và gắn cờ các dữ liệu dị biệt (anomaly).'
  },
  e4: {
    code: 'E4',
    title: 'E4 - Analysis (Phân tích)',
    layer: 'Lớp Silver (WorkHub-Tools Storage)',
    layerClass: 'pill-info',
    storageTier: 'WorkHub-Tools Storage: silver_bucket/silver/',
    desc: 'Tính toán các chỉ số kinh tế, chạy các mô hình tài chính và phân tích kịch bản. Yêu cầu mô hình phải rõ ràng, kết quả có thể giải thích được và có kiểm tra độ nhạy.'
  },
  e5: {
    code: 'E5',
    title: 'E5 - Reporting (Tạo báo cáo)',
    layer: 'Lớp Silver Artifacts (WorkHub-Tools)',
    layerClass: 'pill-info',
    storageTier: 'WorkHub-Tools Storage: silver_bucket/reports/',
    desc: 'Tự động tạo dự thảo báo cáo, biểu đồ và tóm tắt theo các mẫu (template) có sẵn. Cần kiểm tra tính đầy đủ của các phần bắt buộc trước khi chuyển sang khâu kiểm duyệt.'
  },
  e6: {
    code: 'E6',
    title: 'E6 - Human QA (Kiểm duyệt chuyên gia)',
    layer: 'Lớp Gold Gate (WorkHub-Tools)',
    layerClass: 'pill-success',
    storageTier: 'WorkHub-Tools Storage: gold_bucket/pending_review/',
    desc: 'Chuyên gia (con người) đọc, kiểm tra các điểm bất thường, ghi chú và quyết định phê duyệt (Approve) hoặc yêu cầu chỉnh sửa (Reject). Bắt buộc phải có ý kiến phản hồi nếu từ chối.'
  },
  e7: {
    code: 'E7',
    title: 'E7 - Publish (Phát hành tri thức)',
    layer: 'Lớp Gold (WorkHub-Tools Storage)',
    layerClass: 'pill-success',
    storageTier: 'WorkHub-Tools Storage: gold_bucket/gold/',
    desc: 'Đưa báo cáo/dữ liệu đã duyệt vào kho tri thức Gold, đánh phiên bản (versioning), lưu trữ bất biến và xuất bản cho các bên liên quan sử dụng.'
  }
};

const STAGE_KEYS = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
let currentStageIndex = 0;

// --- 1. AUTHENTICATION & ACCESS CONTROL (SHARED SUPABASE) ---
const ALLOWED_GROUPS = ['finance', 'admin', 'all'];

async function checkAccessGuard() {
  const userEmail = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || 'finance.lead@workhub.internal';
  let userGroup = localStorage.getItem('userGroup');

  if (window.supabaseClient && userEmail) {
    try {
      const { data } = await window.supabaseClient
        .from('users')
        .select('group_key, nickname, email')
        .eq('email', userEmail)
        .maybeSingle();

      if (data) {
        userGroup = data.group_key;
        localStorage.setItem('userGroup', userGroup);
        if (data.nickname) {
          const nameEl = document.getElementById('user-display-name');
          if (nameEl) nameEl.textContent = data.nickname;
        }
      }
    } catch (err) {
      console.warn("Supabase shared auth query error, fallback to session:", err);
    }
  }

  if (!userGroup) {
    userGroup = 'finance';
    localStorage.setItem('userGroup', 'finance');
  }

  if (!ALLOWED_GROUPS.includes(userGroup.toLowerCase())) {
    Swal.fire({
      icon: 'error',
      title: 'Truy cập bị từ chối',
      text: `Bạn thuộc nhóm [${userGroup}], không có quyền truy cập Economics Pipeline.`,
      confirmButtonText: 'Quay về trang chủ',
      confirmButtonColor: '#C9A84C',
      allowOutsideClick: false
    }).then(() => {
      window.location.href = '../index.html';
    });
    return false;
  }

  const avatarText = document.getElementById('user-avatar-text');
  if (avatarText && userEmail) {
    avatarText.textContent = userEmail.slice(0, 2).toUpperCase();
  }
  return true;
}

// --- 2. STAGE SWITCHER & INSPECTOR ---
function switchStage(stageKey) {
  const idx = STAGE_KEYS.indexOf(stageKey);
  if (idx === -1) return;
  currentStageIndex = idx;
  updateStageUI(stageKey);
}

function navStage(delta) {
  let newIdx = currentStageIndex + delta;
  if (newIdx < 0) newIdx = 0;
  if (newIdx >= STAGE_KEYS.length) newIdx = STAGE_KEYS.length - 1;
  currentStageIndex = newIdx;
  const stageKey = STAGE_KEYS[currentStageIndex];
  updateStageUI(stageKey);
}

function updateStageUI(stageKey) {
  const meta = STAGES_META[stageKey];
  if (!meta) return;

  // Stepper Visuals
  const stepItems = document.querySelectorAll('.step-item');
  stepItems.forEach((item, i) => {
    item.classList.remove('active');
    if (i <= currentStageIndex) {
      item.classList.add('active');
    }
  });

  const fillPercentage = (currentStageIndex / (STAGE_KEYS.length - 1)) * 100;
  const fillEl = document.getElementById('stepper-progress-fill');
  if (fillEl) fillEl.style.width = `${fillPercentage}%`;

  // Detail Card
  const titleEl = document.getElementById('stage-title');
  const descEl = document.getElementById('stage-desc');
  const badgeEl = document.getElementById('stage-badge-layer');
  const storageTierEl = document.getElementById('stage-storage-tier');

  if (titleEl) titleEl.textContent = meta.title;
  if (descEl) descEl.textContent = meta.desc;
  if (badgeEl) {
    badgeEl.textContent = meta.layer;
    badgeEl.className = `status-pill ${meta.layerClass}`;
  }
  if (storageTierEl) storageTierEl.textContent = meta.storageTier;

  // Log navigation to observation
  logPipelineEvent(`Xem tổng quan ${meta.title}`, 'info', `VIEW_${stageKey.toUpperCase()}`);
}

// --- 3. OBSERVATION LOGS (SYNCED TO WORKHUB SUPABASE SYSTEM_LOGS) ---
let LOCAL_LOGS = [
  { time: '14:32:10', type: 'success', text: 'E7: Báo cáo Vĩ mô v2.4.0 đã ký duyệt và lưu trữ Gold Layer tại WorkHub-Tools.' },
  { time: '14:20:05', type: 'info', text: 'E6: Chuyên gia Trần Thị Thu Trang bắt đầu rà soát tài liệu Q2 Banking.' },
  { time: '13:58:44', type: 'warning', text: 'E3: Phát hiện 1 dị biệt giao dịch thỏa thuận NVL (Z-Score = 3.82).' },
  { time: '13:30:00', type: 'success', text: 'E1: Luồng nạp HOSE & HNX hoàn tất nạp 24.5 MB vào WorkHub Storage (Bronze).' }
];

async function fetchLiveObservationLogs() {
  const email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser');
  if (window.API && window.API.notification) {
    try {
      const logs = await window.API.notification.get('finance', 25, email);
      if (logs && logs.length > 0) {
        LOCAL_LOGS = logs.map(l => ({
          time: new Date(l.timestamp).toTimeString().slice(0, 8),
          type: l.status === 'success' ? 'success' : (l.status === 'error' ? 'danger' : 'info'),
          text: `[${l.action || 'AUDIT'}] ${l.details || l.message}`
        }));
        renderObservationLogs();
      }
    } catch (err) {
      console.warn("Lỗi tải live logs từ WorkHub system_logs:", err);
    }
  }
}

function renderObservationLogs() {
  const container = document.getElementById('observation-logs-container');
  if (!container) return;
  container.innerHTML = LOCAL_LOGS.map(log => `
    <div class="event-log-card" style="border-left-color: var(--${log.type === 'success' ? 'success-color' : (log.type === 'warning' ? 'warning-color' : (log.type === 'danger' ? 'danger-color' : 'gold'))});">
      <div class="event-log-time">
        <span>${log.time}</span>
        <span class="status-pill pill-${log.type}" style="font-size: 10px; padding: 1px 6px;">${log.type.toUpperCase()}</span>
      </div>
      <p style="margin: 0; color: var(--text-primary); font-size: 13px;">${log.text}</p>
    </div>
  `).join('');
}

async function logPipelineEvent(text, type = 'info', action = 'PIPELINE_FIN_ACTION') {
  const now = new Date();
  const timeStr = now.toTimeString().slice(0, 8);
  LOCAL_LOGS.unshift({ time: timeStr, type, text });
  renderObservationLogs();
  
  const unreadIndicator = document.getElementById('noti-unread-indicator');
  if (unreadIndicator) unreadIndicator.style.display = 'block';

  // Record to shared WorkHub Supabase system_logs
  const userEmail = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || 'finance.lead@workhub.internal';
  const traceId = "TRC_FIN_" + Date.now() + "_" + Math.random().toString(36).substr(2, 6);
  if (window.API && window.API.system && window.API.system.logAction) {
    try {
      await window.API.system.logAction(traceId, action, text, type === 'danger' ? 'error' : 'success', userEmail, 'finance', null);
    } catch (err) {
      console.warn("Không thể ghi log lên Supabase system_logs:", err);
    }
  }
}

function toggleObservationDrawer() {
  const drawer = document.getElementById('observation-drawer');
  if (drawer) {
    drawer.classList.toggle('open');
    if (drawer.classList.contains('open')) {
      const unreadIndicator = document.getElementById('noti-unread-indicator');
      if (unreadIndicator) unreadIndicator.style.display = 'none';
    }
  }
}

// --- 4. THEME TOGGLE ---
function setupThemeToggle() {
  const toggleBtn = document.getElementById('theme-toggle-btn');
  const currentTheme = localStorage.getItem('theme') || 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);

  if (toggleBtn) {
    toggleBtn.innerHTML = currentTheme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    toggleBtn.addEventListener('click', () => {
      const activeTheme = document.documentElement.getAttribute('data-theme');
      const newTheme = activeTheme === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', newTheme);
      localStorage.setItem('theme', newTheme);
      toggleBtn.innerHTML = newTheme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
    });
  }
}

// --- 5. INITIALIZATION ON DOM READY ---
document.addEventListener('DOMContentLoaded', async () => {
  setupThemeToggle();
  const hasAccess = await checkAccessGuard();
  if (!hasAccess) return;

  renderObservationLogs();
  updateStageUI('e1');
  await fetchLiveObservationLogs();

  const notiBtn = document.getElementById('observation-toggle-btn');
  if (notiBtn) notiBtn.addEventListener('click', toggleObservationDrawer);

  console.log("Economics Workspace Pipeline Overview (workhub-fin) Initialized.");
});
