
const STAGES_META = {
  e1: {
    code: 'E1',
    title: 'E1 - Ingest Data',
    layer: 'Bronze-storage',
    layerClass: 'pill-warning',
    storageTier: 'WorkHub Storage: finance_bucket/bronze/',
    desc: 'Lấy data từ bên ngoài đưa vào để tiến hành pipeline'
  },
  e2: {
    code: 'E2',
    title: 'E2 - Source Validation',
    layer: 'Bronze-storage',
    layerClass: 'pill-warning',
    storageTier: 'WorkHub Storage: finance_bucket/bronze/',
    desc: 'Đảm bảo dữ liệu đầu vào hợp lệ.'
  },
  e3: {
    code: 'E3',
    title: 'E3 - Standardization',
    layer: 'Silver-storage',
    layerClass: 'pill-info',
    storageTier: 'WorkHub-Tools Storage: silver_bucket/silver/',
    desc: 'Tiến hành làm sạch, chuẩn hóa dữ liệu, tách thông tin và đưa vào lớp Silver. Quá trình này sẽ kiểm tra schema, tính toàn vẹn và gắn cờ các dữ liệu khác thường.'
  },
  e4: {
    code: 'E4',
    title: 'E4 - Analysis',
    layer: 'Silver-storage',
    layerClass: 'pill-info',
    storageTier: 'WorkHub-Tools Storage: silver_bucket/silver/',
    desc: 'Tính toán các chỉ số kinh tế và phân tích dữ liệu.'
  },
  e5: {
    code: 'E5',
    title: 'E5 - Reporting',
    layer: 'Silver-storage',
    layerClass: 'pill-info',
    storageTier: 'WorkHub-Tools Storage: silver_bucket/reports/',
    desc: 'Tự động tạo báo cáo theo các mẫu (template) có sẵn.'
  },
  e6: {
    code: 'E6',
    title: 'E6 - Human QA',
    layer: 'Gold-storage',
    layerClass: 'pill-success',
    storageTier: 'WorkHub-Tools Storage: gold_bucket/pending_review/',
    desc: 'Cần người check lại trước khi XUẤT'
  },
  e7: {
    code: 'E7',
    title: 'E7 - Publish',
    layer: 'Gold-storage',
    layerClass: 'pill-success',
    storageTier: 'WorkHub-Tools Storage: gold_bucket/gold/',
    desc: 'Xuất báo cáo...'
  }
};

const STAGE_KEYS = ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'];
let currentStageIndex = 0;

const ALLOWED_GROUPS = ['finance', 'admin', 'all'];

async function checkAccessGuard() {
  const userEmail = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || '';
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
      window.location.href = 'https://workhub-ai.pages.dev/';
    });
    return false;
  }

  const avatarText = document.getElementById('user-avatar-text');
  if (avatarText && userEmail) {
    avatarText.textContent = userEmail.slice(0, 2).toUpperCase();
  }
  return true;
}

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
}

let LOCAL_LOGS = [];

async function fetchLiveObservationLogs() {
  const email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || '';
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
  if (LOCAL_LOGS.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">
        <i class="fa-regular fa-folder-open" style="font-size: 28px; margin-bottom: 10px; display: block; opacity: 0.4;"></i>
        Chưa có nhật ký hoạt động
      </div>
    `;
    return;
  }
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

  const userEmail = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || '';
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

document.addEventListener('DOMContentLoaded', async () => {
  setupThemeToggle();
  const hasAccess = await checkAccessGuard();
  if (!hasAccess) return;

  renderObservationLogs();
  updateStageUI('e1');
  await fetchLiveObservationLogs();

  const notiBtn = document.getElementById('observation-toggle-btn');
  if (notiBtn) notiBtn.addEventListener('click', toggleObservationDrawer);
});
