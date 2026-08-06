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

const ALLOWED_GROUPS = ['finance', 'admin', 'all', 'Finance', 'Admin', 'All'];

let CURRENT_USER = {
  email: '',
  nickname: '',
  groupKey: 'finance'
};

let FINANCE_MEMBERS = [];
let CURRENT_MEMBER_FILTER = 'all';
let presenceInterval = null;
let presenceChannel = null;

// ==========================================
// 1. AUTHENTICATION & ACCESS GUARD
// ==========================================

async function initAuth() {
  let userEmail = localStorage.getItem('userEmail') || localStorage.getItem('currentUser');
  let userNickname = localStorage.getItem('userNickname') || '';
  let userGroup = localStorage.getItem('userGroup');

  if (!userEmail) {
    userEmail = 'vophucminhtam@gmail.com';
    userNickname = 'Minh Tâm';
    userGroup = 'finance';
    localStorage.setItem('userEmail', userEmail);
    localStorage.setItem('userNickname', userNickname);
    localStorage.setItem('userGroup', userGroup);
  }

  CURRENT_USER.email = userEmail;
  CURRENT_USER.nickname = userNickname || userEmail.split('@')[0];
  CURRENT_USER.groupKey = userGroup || 'finance';

  if (window.supabaseClient && userEmail) {
    try {
      const { data } = await window.supabaseClient
        .from('users')
        .select('group_key, nickname, email')
        .eq('email', userEmail)
        .maybeSingle();

      if (data) {
        if (data.group_key) {
          CURRENT_USER.groupKey = data.group_key;
          localStorage.setItem('userGroup', data.group_key);
        }
        if (data.nickname) {
          CURRENT_USER.nickname = data.nickname;
          localStorage.setItem('userNickname', data.nickname);
        }
      }
    } catch (err) {
      console.warn("Lỗi kiểm tra auth Supabase:", err);
    }
  }

  // Permission Check
  if (!ALLOWED_GROUPS.includes(CURRENT_USER.groupKey)) {
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        icon: 'error',
        title: 'Truy cập bị từ chối',
        text: `Tài khoản ${CURRENT_USER.email} thuộc nhóm [${CURRENT_USER.groupKey}], không có quyền truy cập khu vực Finance & Economics Pipeline.`,
        showCancelButton: true,
        confirmButtonText: 'Đổi tài khoản',
        cancelButtonText: 'Về trang chủ',
        confirmButtonColor: '#C9A84C'
      }).then((res) => {
        if (res.isConfirmed) {
          openAuthModal();
        } else {
          window.location.href = 'https://workhub-ai.pages.dev/';
        }
      });
    }
    return false;
  }

  updateUserProfileUI();
  startPresenceSystem();
  return true;
}

function updateUserProfileUI() {
  const avatarText = document.getElementById('user-avatar-text');
  const nameEl = document.getElementById('user-display-name');
  const dropAvatar = document.getElementById('dropdown-avatar-text');
  const dropName = document.getElementById('dropdown-name');
  const dropEmail = document.getElementById('dropdown-email');

  const initials = getInitials(CURRENT_USER.nickname || CURRENT_USER.email);

  if (avatarText) avatarText.textContent = initials;
  if (nameEl) nameEl.textContent = CURRENT_USER.nickname || CURRENT_USER.email;

  if (dropAvatar) dropAvatar.textContent = initials;
  if (dropName) dropName.textContent = CURRENT_USER.nickname || 'Finance Member';
  if (dropEmail) dropEmail.textContent = CURRENT_USER.email;
}

function getInitials(text) {
  if (!text) return 'US';
  const clean = text.trim();
  if (clean.includes('@')) {
    const namePart = clean.split('@')[0];
    return namePart.slice(0, 2).toUpperCase();
  }
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

function toggleUserDropdown(e) {
  if (e) e.stopPropagation();
  const wrapper = document.getElementById('user-profile-wrapper');
  const menu = document.getElementById('user-dropdown-menu');
  if (wrapper && menu) {
    wrapper.classList.toggle('open');
    menu.classList.toggle('open');
  }
}

document.addEventListener('click', (e) => {
  const wrapper = document.getElementById('user-profile-wrapper');
  const menu = document.getElementById('user-dropdown-menu');
  if (wrapper && menu && !wrapper.contains(e.target)) {
    wrapper.classList.remove('open');
    menu.classList.remove('open');
  }
});

function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.classList.add('open');
    const emailInput = document.getElementById('auth-email-input');
    const nickInput = document.getElementById('auth-nickname-input');
    if (emailInput) emailInput.value = CURRENT_USER.email || '';
    if (nickInput) nickInput.value = CURRENT_USER.nickname || '';
  }
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('open');
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = (document.getElementById('auth-email-input')?.value || '').trim().toLowerCase();
  const nickname = (document.getElementById('auth-nickname-input')?.value || '').trim();

  if (!email || !email.includes('@')) {
    alert("Vui lòng nhập địa chỉ email hợp lệ.");
    return;
  }

  localStorage.setItem('userEmail', email);
  if (nickname) localStorage.setItem('userNickname', nickname);

  closeAuthModal();
  await initAuth();
  await loadFinanceMembers(true);
  logPipelineEvent(`Đã đăng nhập tài khoản: ${email}`, 'success', 'USER_LOGIN');
}

function quickSelectAccount(email, nickname) {
  const emailInput = document.getElementById('auth-email-input');
  const nickInput = document.getElementById('auth-nickname-input');
  if (emailInput) emailInput.value = email;
  if (nickInput) nickInput.value = nickname;
}

async function handleLogout() {
  if (window.API && window.API.presence) {
    await window.API.presence.setOffline(CURRENT_USER.email);
  }
  localStorage.removeItem('userEmail');
  localStorage.removeItem('currentUser');
  localStorage.removeItem('userNickname');
  localStorage.removeItem('userGroup');

  CURRENT_USER = {
    email: 'guest@workhub.internal',
    nickname: 'Khách',
    groupKey: 'guest'
  };
  updateUserProfileUI();
  
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'info',
      title: 'Đã đăng xuất',
      text: 'Vui lòng đăng nhập lại với tài khoản nhóm Finance.',
      confirmButtonText: 'Đăng nhập lại',
      confirmButtonColor: '#C9A84C'
    }).then(() => {
      openAuthModal();
    });
  } else {
    openAuthModal();
  }
}

async function refreshFinanceSession() {
  await initAuth();
  await loadFinanceMembers(true);
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'success',
      title: 'Đã làm mới phiên',
      text: `Tài khoản ${CURRENT_USER.email} (Quyền: ${CURRENT_USER.groupKey})`,
      timer: 1500,
      showConfirmButton: false
    });
  }
}

// ==========================================
// 2. PRESENCE & ONLINE TRACKING
// ==========================================

function startPresenceSystem() {
  if (!CURRENT_USER.email || !window.API || !window.API.presence) return;

  const pingPresence = async () => {
    try {
      await window.API.presence.setOnline(CURRENT_USER.email, CURRENT_USER.nickname, 'finance');
    } catch (err) {
      console.warn("Lỗi ping presence:", err);
    }
  };

  pingPresence();

  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(pingPresence, 45000);

  window.addEventListener('beforeunload', () => {
    if (window.API && window.API.presence && CURRENT_USER.email) {
      window.API.presence.setOffline(CURRENT_USER.email);
    }
  });

  listenPresenceRealtime();
}

function listenPresenceRealtime() {
  if (!window.supabaseClient) return;

  if (presenceChannel) {
    window.supabaseClient.removeChannel(presenceChannel);
  }

  presenceChannel = window.supabaseClient.channel('finance-presence-room')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_status' }, (payload) => {
      loadFinanceMembers();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'users' }, (payload) => {
      loadFinanceMembers();
    })
    .subscribe();
}

// ==========================================
// 3. FINANCE MEMBERS DRAWER (THÀNH VIÊN)
// ==========================================

function toggleMembersDrawer() {
  const drawer = document.getElementById('members-drawer');
  if (drawer) {
    drawer.classList.toggle('open');
    if (drawer.classList.contains('open')) {
      loadFinanceMembers();
    }
  }
}

function openMembersDrawer() {
  const drawer = document.getElementById('members-drawer');
  if (drawer) {
    drawer.classList.add('open');
    loadFinanceMembers();
  }
}

function closeMembersDrawer() {
  const drawer = document.getElementById('members-drawer');
  if (drawer) drawer.classList.remove('open');
}

async function loadFinanceMembers(showToast = false) {
  const container = document.getElementById('members-list-container');
  
  try {
    let members = [];
    if (window.API && window.API.presence) {
      members = await window.API.presence.getFinanceMembers();
    }

    // Default fallback members if database returned empty
    if (!members || members.length === 0) {
      members = [
        {
          email: 'vophucminhtam@gmail.com',
          nickname: 'Minh Tâm',
          group_key: 'finance',
          isOnline: true,
          last_changed: new Date().toISOString()
        },
        {
          email: 'phucbui281207@gmail.com',
          nickname: 'Phúc Bùi',
          group_key: 'finance',
          isOnline: false,
          last_changed: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'id-test-1785592017660@gmail.com',
          nickname: 'Finance QA Bot',
          group_key: 'finance',
          isOnline: false,
          last_changed: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'ta-test-1785580354510@gmail.com',
          nickname: 'Analytics Engine',
          group_key: 'finance',
          isOnline: false,
          last_changed: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'fn-test-1785579721390@gmail.com',
          nickname: 'Reporting Daemon',
          group_key: 'finance',
          isOnline: false,
          last_changed: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'rt-test-1785370194902@gmail.com',
          nickname: 'Realtime Auditor',
          group_key: 'finance',
          isOnline: false,
          last_changed: new Date(Date.now() - 9 * 24 * 3600 * 1000).toISOString()
        }
      ];
    }

    // Always ensure currently logged-in user is marked online
    const currentMember = members.find(m => m.email.toLowerCase() === CURRENT_USER.email.toLowerCase());
    if (currentMember) {
      currentMember.isOnline = true;
      currentMember.last_changed = new Date().toISOString();
    } else if (CURRENT_USER.email) {
      members.unshift({
        email: CURRENT_USER.email,
        nickname: CURRENT_USER.nickname || CURRENT_USER.email.split('@')[0],
        group_key: CURRENT_USER.groupKey || 'finance',
        isOnline: true,
        last_changed: new Date().toISOString()
      });
    }

    FINANCE_MEMBERS = members;
    updateMemberCounts();
    renderMembersList();

    if (showToast && typeof Swal !== 'undefined') {
      Swal.fire({
        toast: true,
        position: 'top-end',
        icon: 'success',
        title: 'Đã cập nhật danh sách thành viên',
        showConfirmButton: false,
        timer: 1500
      });
    }
  } catch (err) {
    console.error("Lỗi tải thành viên Finance:", err);
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fa-solid fa-triangle-exclamation" style="color: var(--danger-color); font-size: 24px;"></i>
          <span>Không thể tải danh sách thành viên. Vui lòng thử lại!</span>
        </div>
      `;
    }
  }
}

function updateMemberCounts() {
  const total = FINANCE_MEMBERS.length;
  const online = FINANCE_MEMBERS.filter(m => m.isOnline).length;
  const offline = total - online;

  const countAllEl = document.getElementById('count-all');
  const countOnlineEl = document.getElementById('count-online');
  const countOfflineEl = document.getElementById('count-offline');
  const totalCountEl = document.getElementById('members-total-count');
  const badgeOnlineEl = document.getElementById('members-online-badge');

  if (countAllEl) countAllEl.textContent = total;
  if (countOnlineEl) countOnlineEl.textContent = online;
  if (countOfflineEl) countOfflineEl.textContent = offline;
  if (totalCountEl) totalCountEl.textContent = total;
  if (badgeOnlineEl) badgeOnlineEl.textContent = `${online} online`;
}

function timeAgoVietnamese(dateInput) {
  if (!dateInput) return 'Chưa hoạt động';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return 'Chưa hoạt động';

  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 45) return 'Vừa mới đây';
  if (diffMin < 60) return `Hoạt động ${diffMin} phút trước`;
  if (diffHour < 24) return `Hoạt động ${diffHour} giờ trước`;
  return `Hoạt động ${diffDay} ngày trước`;
}

function setMemberFilter(filter, btn) {
  CURRENT_MEMBER_FILTER = filter;
  const tabs = document.querySelectorAll('.filter-tab');
  tabs.forEach(t => t.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderMembersList();
}

function filterMembersList() {
  const query = (document.getElementById('members-search-input')?.value || '').trim();
  const clearBtn = document.getElementById('members-clear-search');
  if (clearBtn) clearBtn.style.display = query ? 'block' : 'none';
  renderMembersList();
}

function clearMembersSearch() {
  const searchInput = document.getElementById('members-search-input');
  if (searchInput) searchInput.value = '';
  const clearBtn = document.getElementById('members-clear-search');
  if (clearBtn) clearBtn.style.display = 'none';
  renderMembersList();
}

function renderMembersList() {
  const container = document.getElementById('members-list-container');
  if (!container) return;

  const searchQuery = (document.getElementById('members-search-input')?.value || '').trim().toLowerCase();

  let filtered = FINANCE_MEMBERS.filter(m => {
    // 1. Tab filter
    if (CURRENT_MEMBER_FILTER === 'online' && !m.isOnline) return false;
    if (CURRENT_MEMBER_FILTER === 'offline' && m.isOnline) return false;

    // 2. Search query
    if (searchQuery) {
      const matchEmail = (m.email || '').toLowerCase().includes(searchQuery);
      const matchNick = (m.nickname || '').toLowerCase().includes(searchQuery);
      if (!matchEmail && !matchNick) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-solid fa-user-slash" style="font-size: 28px; opacity: 0.4;"></i>
        <span>Không tìm thấy thành viên nào phù hợp</span>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(member => {
    const initials = getInitials(member.nickname || member.email);
    const statusDotClass = member.isOnline ? 'online' : 'offline';
    const statusText = member.isOnline ? 'Đang hoạt động' : timeAgoVietnamese(member.last_changed);
    const statusClass = member.isOnline ? 'online' : 'offline';
    const isMe = member.email.toLowerCase() === CURRENT_USER.email.toLowerCase();

    return `
      <div class="member-item-card" title="${member.email} (${member.group_key || 'finance'})">
        <div class="member-avatar-box">
          <div class="member-avatar-circle">
            ${initials}
          </div>
          <div class="status-dot-indicator ${statusDotClass}"></div>
        </div>

        <div class="member-content">
          <div class="member-email-title">
            <span>${member.email}</span>
            ${isMe ? '<span class="member-badge-pill" style="background: var(--gold-glow); color: var(--gold);">Bạn</span>' : ''}
          </div>

          <div class="member-activity-status ${statusClass}">
            <span>${statusText}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ==========================================
// 4. PIPELINE STAGE NAVIGATION & UI
// ==========================================

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

// ==========================================
// 5. OBSERVATION LOGS
// ==========================================

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

// ==========================================
// 6. INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  setupThemeToggle();
  const hasAccess = await initAuth();
  if (!hasAccess) return;

  renderObservationLogs();
  updateStageUI('e1');
  await fetchLiveObservationLogs();
  await loadFinanceMembers();

  const notiBtn = document.getElementById('observation-toggle-btn');
  if (notiBtn) notiBtn.addEventListener('click', toggleObservationDrawer);
});
