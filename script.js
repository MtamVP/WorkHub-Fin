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
const ALLOWED_GROUPS = ['admin', 'finance'];

let CURRENT_USER = {
  email: '',
  nickname: '',
  groupKey: ''
};

let FINANCE_MEMBERS = [];
let CURRENT_MEMBER_FILTER = 'all';
let presenceInterval = null;
let presenceChannel = null;

const auth = sbClient ? sbClient.auth : null;

// activeGroup = định danh cố định "dữ liệu của app nào" được gửi làm groupKey trong mọi
// lời gọi callGAS(...) — khác với CURRENT_USER.groupKey (quyền của người dùng đang đăng
// nhập). App này chỉ phục vụ nhóm Finance nên giá trị luôn cố định.
let activeGroup = 'finance';

// ===== Project / Task / Calendar module globals (ported từ app WorkHub anh em) =====
let currentTaskProjectID = null;
let globalAllProjects = [];
let globalAllTasks = [];
let showArchivedProjects = false;
let editingTaskExpectedVersion = null;
let pendingTaskFilterRestore = null;
let expanded = false; // toggle dropdown #checkboxes (chọn người thực hiện task)
let eventAttendeesExpanded = false; // toggle dropdown #event-attendee-checkboxes

// Calendar globals
let currentCalendarType = 'group';
let selectedDate = new Date();
let selectedEventId = null;
let currentCalendarDate = new Date();
let currentMonthEvents = [];
let todayEventList, manageEventBtn, addEventBtn, eventForm;
let eventModalDefaultTitleHTML = null;
let eventModalDefaultSubmitHTML = null;

// Section navigation (Tổng Quan / Pipeline / Nhiệm Vụ / Tiến Độ / Lịch)
const SECTION_KEYS = ['dashboard', 'chat', 'pipeline', 'task', 'progress', 'calendar', 'drive', 'mytasks'];
let currentSectionKey = 'dashboard';
const SECTION_LOADED = { dashboard: false, projects: false, calendar: false, drive: false, mytasks: false, chat: false };

// ==========================================
// 1. AUTHENTICATION & ACCESS GUARD (real Supabase Auth)
// ==========================================

function lockApp() {
  document.body.classList.add('app-locked');
  openAuthModal(true);
}

function unlockApp() {
  document.body.classList.remove('app-locked');
  closeAuthModal(true);
}

async function resolveUserProfile(user) {
  CURRENT_USER.email = user.email;
  CURRENT_USER.id = user.id;
  // localStorage.getItem('userEmail') is read as a "who am I" fallback in many places across
  // this app family (api.js's callGAS, mastersheet/, mastersheet/assets/, note/, observation
  // logs) but nothing ever wrote it — it only ever existed as an in-memory variable here. Any
  // browser that once had this key set (by an older build) kept reading that same stale email
  // forever, no matter who actually logs in now. Keep it in sync with the real session.
  try { localStorage.setItem('userEmail', user.email); } catch (e) {}

  try {
    const info = await API.auth.getUserInfo(user.email);
    CURRENT_USER.nickname = (info && info.name) || user.user_metadata?.display_name || user.email.split('@')[0];
    CURRENT_USER.groupKey = (info && info.group) || 'guest';
  } catch (err) {
    console.warn("Lỗi lấy thông tin user:", err);
    CURRENT_USER.nickname = user.email.split('@')[0];
    CURRENT_USER.groupKey = 'guest';
  }

  if (!ALLOWED_GROUPS.includes(CURRENT_USER.groupKey)) {
    document.body.classList.add('app-locked');
    closeAuthModal(true);
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        icon: 'error',
        title: 'Truy cập bị từ chối',
        text: `Tài khoản ${CURRENT_USER.email} thuộc nhóm [${CURRENT_USER.groupKey}], không có quyền truy cập khu vực Finance & Economics Pipeline.`,
        showCancelButton: true,
        confirmButtonText: 'Đổi tài khoản',
        cancelButtonText: 'Về trang chủ',
        confirmButtonColor: '#C9A84C',
        allowOutsideClick: false
      }).then((res) => {
        if (res.isConfirmed) {
          auth.signOut().then(() => openAuthModal(true));
        } else {
          window.location.href = 'https://workhub-org.pages.dev/';
        }
      });
    }
    return false;
  }

  unlockApp();
  updateUserProfileUI();
  startPresenceSystem();
  if (typeof initRealtimeSync === 'function') initRealtimeSync();

  if (!window.__financeSessionBootstrapped) {
    window.__financeSessionBootstrapped = true;
    fetchLiveObservationLogs();
    loadFinanceMembers();
    switchSection(currentSectionKey); // tải dữ liệu cho section đang hiển thị sẵn (mặc định: dashboard)
  }

  return true;
}

async function initAuth() {
  if (!auth) {
    console.error('Supabase auth chưa sẵn sàng — kiểm tra api.js.');
    return;
  }

  auth.onAuthStateChange(async (event, session) => {
    const user = session?.user;
    if (user) {
      await resolveUserProfile(user);
      if (event === 'SIGNED_IN') {
        logPipelineEvent(`Đã đăng nhập tài khoản: ${user.email}`, 'success', 'USER_LOGIN');
      }
    } else {
      CURRENT_USER = { email: '', nickname: '', groupKey: '', id: '' };
      try { localStorage.removeItem('userEmail'); } catch (e) {}
      if (typeof stopRealtimeSync === 'function') stopRealtimeSync();
      if (chatChannel && sbClient) { sbClient.removeChannel(chatChannel); chatChannel = null; }
      lockApp();
    }
  });
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

function openAuthModal(forced) {
  const modal = document.getElementById('auth-modal');
  if (modal) {
    modal.classList.add('open');
    const cancelBtn = document.getElementById('auth-cancel-btn');
    const closeBtn = document.getElementById('auth-modal-close-btn');
    if (cancelBtn) cancelBtn.style.display = forced ? 'none' : '';
    if (closeBtn) closeBtn.style.display = forced ? 'none' : '';
    const emailInput = document.getElementById('auth-email-input');
    if (emailInput) emailInput.value = CURRENT_USER.email || '';
    const errBox = document.getElementById('auth-error-msg');
    if (errBox) errBox.style.display = 'none';
  }
}

function closeAuthModal(force) {
  if (document.body.classList.contains('app-locked') && !force) return;
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.remove('open');
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const email = (document.getElementById('auth-email-input')?.value || '').trim().toLowerCase();
  const password = document.getElementById('auth-password-input')?.value || '';
  const errBox = document.getElementById('auth-error-msg');
  const submitBtn = document.getElementById('auth-submit-btn');

  if (!email || !password) {
    if (errBox) { errBox.textContent = 'Vui lòng nhập đầy đủ email và mật khẩu.'; errBox.style.display = 'block'; }
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xác thực...'; }
  if (errBox) errBox.style.display = 'none';

  try {
    const realEmail = (await API.auth.getRealEmail(email)) || email;
    const { error } = await auth.signInWithPassword({ email: realEmail, password });
    if (error) throw error;
    // auth.onAuthStateChange picks up the SIGNED_IN event and finishes the flow
  } catch (err) {
    let msg = err.message || 'Đăng nhập thất bại.';
    if (msg.includes('Invalid login credentials')) msg = 'Sai email hoặc mật khẩu.';
    if (errBox) { errBox.textContent = msg; errBox.style.display = 'block'; }
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Đăng nhập'; }
  }
}

async function switchAccount() {
  if (auth) await auth.signOut();
  openAuthModal(true);
}

async function handleLogout() {
  if (API && API.presence && CURRENT_USER.email) {
    await API.presence.setOffline(CURRENT_USER.email);
  }
  if (auth) await auth.signOut();
  // auth.onAuthStateChange fires SIGNED_OUT -> clears CURRENT_USER and locks the app
  if (typeof Swal !== 'undefined') {
    Swal.fire({
      icon: 'info',
      title: 'Đã đăng xuất',
      text: 'Vui lòng đăng nhập lại với tài khoản nhóm Finance.',
      confirmButtonText: 'OK',
      confirmButtonColor: '#C9A84C'
    });
  }
}

async function refreshFinanceSession() {
  if (!auth) return;
  const { data: { user } } = await auth.getUser();
  if (user) {
    await resolveUserProfile(user);
    await loadFinanceMembers(true);
  }
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
  if (!CURRENT_USER.email || !API || !API.presence) return;

  const pingPresence = async () => {
    try {
      await API.presence.setOnline(CURRENT_USER.email, CURRENT_USER.nickname, 'finance');
    } catch (err) {
      console.warn("Lỗi ping presence:", err);
    }
  };

  pingPresence();

  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(pingPresence, 45000);

  window.addEventListener('beforeunload', () => {
    if (API && API.presence && CURRENT_USER.email) {
      API.presence.setOffline(CURRENT_USER.email);
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
    if (API && API.presence) {
      members = await API.presence.getFinanceMembers();
    }
    if (!Array.isArray(members)) members = [];

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
// 3.5 SHARED UI HELPERS (Toast, Generic Modal, Skeleton loaders)
// ==========================================
// Dùng chung cho Project/Task/Calendar module bên dưới — bản gốc bên app WorkHub anh em
// dùng alert() trần trụi cho showToast(); ở đây đổi sang Swal toast góc trên phải cho
// nhất quán với phần còn lại của app (vốn đã dùng SweetAlert2 cho mọi thông báo khác).

function showToast(message, type = 'success') {
  if (typeof Swal === 'undefined') { console.log(`[${type}] ${message}`); return; }
  const iconMap = { success: 'success', error: 'error', warning: 'warning', info: 'info' };
  Swal.fire({
    toast: true,
    position: 'top-end',
    icon: iconMap[type] || 'info',
    title: message,
    showConfirmButton: false,
    timer: 2200,
    timerProgressBar: true
  });
}

// Modal generic show/hide theo đúng convention .modal-overlay + class "open" mà app này
// đã dùng cho auth-modal (khác kiểu display:flex + "show-modal" của app nguồn).
function openAppModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.add('open');
}

function closeAppModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.classList.remove('open');
}

function skeletonTableRows(colCount, rowCount) {
  rowCount = rowCount || 5;
  let rows = '';
  for (let i = 0; i < rowCount; i++) {
    let cells = '';
    for (let c = 0; c < colCount; c++) {
      cells += `<td><div style="height:12px; border-radius:6px; background:var(--hover-bg);"></div></td>`;
    }
    rows += `<tr>${cells}</tr>`;
  }
  return rows;
}

function skeletonListItems(count) {
  count = count || 3;
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div style="height:52px; border-radius:8px; background:var(--hover-bg); margin-bottom:10px;"></div>`;
  }
  return html;
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
// 4.5 TOP-LEVEL SECTION NAVIGATION (Pipeline / Nhiệm Vụ / Tiến Độ / Lịch)
// ==========================================
// Tab ngang mới, tách biệt với switchStage() (điều hướng nội bộ của pipeline stepper).
// Task/Progress dùng chung danh sách dự án (globalAllProjects) nên chỉ cần 1 cờ tải.

function switchSection(sectionKey) {
  if (!SECTION_KEYS.includes(sectionKey)) return;
  currentSectionKey = sectionKey;

  document.querySelectorAll('#app-sidebar .nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-section') === sectionKey);
  });
  document.querySelectorAll('.app-section').forEach(sec => sec.classList.remove('active'));
  const target = document.getElementById(sectionKey + '-section');
  if (target) target.classList.add('active');

  if (!CURRENT_USER.email) return; // chưa đăng nhập: chỉ đổi giao diện, không gọi API

  if (sectionKey === 'dashboard' && !SECTION_LOADED.dashboard) {
    SECTION_LOADED.dashboard = true;
    loadDashboardOverview();
  }

  if ((sectionKey === 'task' || sectionKey === 'progress') && !SECTION_LOADED.projects) {
    SECTION_LOADED.projects = true;
    loadProjectOverview();
    if (typeof loadAssigneeDropdown === 'function') loadAssigneeDropdown();
  }

  if (sectionKey === 'task' && typeof renderProjectManagerList === 'function') {
    renderProjectManagerList();
  }

  if (sectionKey === 'calendar' && !SECTION_LOADED.calendar) {
    SECTION_LOADED.calendar = true;
    loadCalendarData();
    if (typeof loadEventAttendeeCheckboxes === 'function') loadEventAttendeeCheckboxes();
  }

  if (sectionKey === 'drive' && !SECTION_LOADED.drive) {
    SECTION_LOADED.drive = true;
    loadFileList();
  }

  if (sectionKey === 'mytasks' && !SECTION_LOADED.mytasks) {
    SECTION_LOADED.mytasks = true;
    loadMyTasks();
  }

  if (sectionKey === 'chat' && !SECTION_LOADED.chat) {
    SECTION_LOADED.chat = true;
    loadChatMessages();
  }
}

// -------------------- Chat (Trò Chuyện) --------------------

let chatChannel = null;
let currentChatReply = null;
let chatMessagesCache = [];
const CHAT_EMOJI_LIST = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

function formatChatTime(timestamp) {
  const date = new Date(timestamp);
  if (isNaN(date.getTime())) return '';
  const now = new Date();
  const timeStr = date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  const isToday = date.getDate() === now.getDate() && date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  if (isToday) return timeStr;
  return date.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }) + ', ' + timeStr;
}

function formatChatText(text) {
  let html = escapeHtml(text);
  html = html.replace(/@All/gi, '<span class="chat-mention-tag">@All</span>');
  FINANCE_MEMBERS.map(m => m.nickname).filter(Boolean).forEach(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('@' + escaped, 'gi');
    html = html.replace(re, (m) => m.includes('<span') ? m : '<span class="chat-mention-tag">' + m + '</span>');
  });
  return html;
}

function renderChatMessage(msg) {
  const list = document.getElementById('chat-messages-list');
  if (!list) return;
  const emptyState = list.querySelector('.empty-state');
  if (emptyState) emptyState.remove();

  const isMe = !!(CURRENT_USER.id && msg.uid === CURRENT_USER.id);
  const isPinned = !!msg.is_pinned;

  const reactions = msg.reactions || {};
  const counts = {};
  let myReaction = null;
  Object.keys(reactions).forEach(uid => {
    const icon = reactions[uid];
    counts[icon] = (counts[icon] || 0) + 1;
    if (uid === CURRENT_USER.id) myReaction = icon;
  });
  const reactionHtml = Object.keys(counts).length
    ? '<div class="chat-reaction-bar">' + Object.keys(counts).map(icon =>
        '<span class="chat-reaction-bubble' + (icon === myReaction ? ' is-mine' : '') + '" onclick="toggleChatReaction(\'' + msg.id + '\',\'' + icon + '\')">' + icon + ' ' + counts[icon] + '</span>'
      ).join('') + '</div>'
    : '';

  const replyHtml = msg.reply_to
    ? '<div class="chat-reply-quote"><strong>' + escapeHtml(msg.reply_to.name) + '</strong>' + escapeHtml(msg.reply_to.text) + '</div>'
    : '';

  const emojiButtons = CHAT_EMOJI_LIST.map(em => '<span onclick="toggleChatReaction(\'' + msg.id + '\',\'' + em + '\')">' + em + '</span>').join('');

  let div = document.getElementById('chat-msg-' + msg.id);
  if (!div) {
    div = document.createElement('div');
    div.id = 'chat-msg-' + msg.id;
    list.appendChild(div);
  }
  div.className = 'chat-msg-row ' + (isMe ? 'is-me' : 'is-other');

  const senderLabel = !isMe ? '<div class="chat-msg-sender">' + escapeHtml(msg.display_name || '') + '</div>' : '';
  const nameArg = escapeHtml(escapeJs(msg.display_name || ''));
  const textArg = escapeHtml(escapeJs(msg.text || ''));
  const pinIcon = isPinned ? '<i class="fa-solid fa-thumbtack"></i> ' : '';

  div.innerHTML =
    senderLabel +
    '<div class="chat-msg-bubble ' + (isMe ? 'is-me' : 'is-other') + (isPinned ? ' is-pinned' : '') + '">' +
    replyHtml +
    '<span>' + formatChatText(msg.text) + '</span>' +
    '<span class="chat-msg-time">' + pinIcon + formatChatTime(msg.created_at) + '</span>' +
    '</div>' +
    reactionHtml +
    '<div class="chat-msg-actions">' +
    '<div class="chat-emoji-wrap">' +
    '<button type="button" class="icon-btn chat-msg-action-btn" title="Thả cảm xúc" onclick="toggleChatEmojiPicker(\'' + msg.id + '\')"><i class="fa-regular fa-face-smile"></i></button>' +
    '<div class="chat-emoji-popup" id="chat-emoji-' + msg.id + '">' + emojiButtons + '</div>' +
    '</div>' +
    '<button type="button" class="icon-btn chat-msg-action-btn" title="Trả lời" onclick="startChatReply(\'' + msg.id + '\',\'' + nameArg + '\',\'' + textArg + '\')"><i class="fa-solid fa-reply"></i></button>' +
    '<button type="button" class="icon-btn chat-msg-action-btn" title="' + (isPinned ? 'Bỏ ghim' : 'Ghim') + '" onclick="toggleChatPin(\'' + msg.id + '\', ' + isPinned + ')"><i class="fa-solid fa-thumbtack"></i></button>' +
    '</div>';
}

function renderChatPinnedBar() {
  const bar = document.getElementById('chat-pinned-bar');
  const list = document.getElementById('chat-pinned-list');
  if (!bar || !list) return;
  const pinned = chatMessagesCache.filter(m => m.is_pinned).sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  if (!pinned.length) { bar.style.display = 'none'; list.innerHTML = ''; return; }
  bar.style.display = 'flex';
  list.innerHTML = pinned.map(m =>
    '<div class="chat-pinned-item"><span><strong>' + escapeHtml(m.display_name || '') + ':</strong> ' + escapeHtml(m.text || '') + '</span>' +
    '<button type="button" class="icon-btn chat-msg-action-btn" title="Bỏ ghim" onclick="toggleChatPin(\'' + m.id + '\', true)"><i class="fa-solid fa-xmark"></i></button></div>'
  ).join('');
}

function toggleChatEmojiPicker(msgId) {
  document.querySelectorAll('.chat-emoji-popup.open').forEach(el => {
    if (el.id !== 'chat-emoji-' + msgId) el.classList.remove('open');
  });
  const popup = document.getElementById('chat-emoji-' + msgId);
  if (popup) popup.classList.toggle('open');
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.chat-emoji-wrap')) {
    document.querySelectorAll('.chat-emoji-popup.open').forEach(el => el.classList.remove('open'));
  }
});

async function toggleChatReaction(msgId, emoji) {
  if (!CURRENT_USER.id) return;
  const popup = document.getElementById('chat-emoji-' + msgId);
  if (popup) popup.classList.remove('open');
  try {
    const { data, error } = await sbClient.from('messages').select('reactions').eq('id', msgId).single();
    if (error) throw error;
    const reactions = data.reactions || {};
    if (reactions[CURRENT_USER.id] === emoji) delete reactions[CURRENT_USER.id];
    else reactions[CURRENT_USER.id] = emoji;
    const { error: updateError } = await sbClient.from('messages').update({ reactions }).eq('id', msgId);
    if (updateError) throw updateError;
  } catch (err) {
    console.error('Lỗi thả cảm xúc:', err);
  }
}

function startChatReply(id, name, text) {
  currentChatReply = { id, name, text };
  const bar = document.getElementById('chat-reply-preview');
  const nameEl = document.getElementById('chat-reply-name');
  const textEl = document.getElementById('chat-reply-text');
  if (nameEl) nameEl.textContent = 'Trả lời ' + name;
  if (textEl) textEl.textContent = text;
  if (bar) bar.style.display = 'flex';
  const input = document.getElementById('chat-msg-input');
  if (input) input.focus();
}

function cancelChatReply() {
  currentChatReply = null;
  const bar = document.getElementById('chat-reply-preview');
  if (bar) bar.style.display = 'none';
}

async function toggleChatPin(msgId, currentStatus) {
  try {
    const { error } = await sbClient.from('messages').update({ is_pinned: !currentStatus }).eq('id', msgId);
    if (error) throw error;
  } catch (err) {
    console.error('Lỗi ghim tin nhắn:', err);
    showToast('Không thể ghim tin nhắn.', 'error');
  }
}

async function loadChatMessages() {
  const list = document.getElementById('chat-messages-list');
  if (!list || !sbClient) return;
  list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải tin nhắn...</div>';

  const { data, error } = await sbClient.from('messages')
    .select('*')
    .eq('group_key', 'finance')
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    console.error('Lỗi tải tin nhắn:', error);
    list.innerHTML = '<div class="empty-state">Không thể tải tin nhắn. Vui lòng thử lại sau.</div>';
    return;
  }

  chatMessagesCache = (data || []).slice().reverse();
  list.innerHTML = chatMessagesCache.length ? '' : '<div class="empty-state"><i class="fa-solid fa-comment-slash"></i> Chưa có tin nhắn nào. Hãy là người đầu tiên!</div>';
  chatMessagesCache.forEach(msg => renderChatMessage(msg));
  renderChatPinnedBar();
  list.scrollTop = list.scrollHeight;

  renderChatPresenceList();
  loadFinanceMembers().then(() => renderChatPresenceList()).catch(() => {});

  const input = document.getElementById('chat-msg-input');
  const sendBtn = document.getElementById('chat-send-btn');
  if (input) input.disabled = false;
  if (sendBtn) sendBtn.disabled = false;

  if (chatChannel) sbClient.removeChannel(chatChannel);
  chatChannel = sbClient.channel('fin-chat-channel')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: 'group_key=eq.finance' }, payload => {
      if (payload.eventType === 'DELETE') {
        const el = document.getElementById('chat-msg-' + payload.old.id);
        if (el) el.remove();
        chatMessagesCache = chatMessagesCache.filter(m => m.id !== payload.old.id);
        renderChatPinnedBar();
        return;
      }
      const msg = payload.new;
      const idx = chatMessagesCache.findIndex(m => m.id === msg.id);
      const wasAtBottom = (list.scrollHeight - list.scrollTop - list.clientHeight) < 80;
      if (idx >= 0) chatMessagesCache[idx] = msg;
      else chatMessagesCache.push(msg);

      const emptyState2 = list.querySelector('.empty-state');
      if (emptyState2) emptyState2.remove();
      renderChatMessage(msg);
      renderChatPinnedBar();

      if (payload.eventType === 'INSERT' && wasAtBottom) list.scrollTop = list.scrollHeight;
    })
    .subscribe();
}

async function sendChatMessage(event) {
  if (event) event.preventDefault();
  const input = document.getElementById('chat-msg-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !CURRENT_USER.id) return;

  const payload = {
    text,
    uid: CURRENT_USER.id,
    display_name: CURRENT_USER.nickname || CURRENT_USER.email,
    is_pinned: false,
    group_key: 'finance'
  };
  if (currentChatReply) {
    payload.reply_to = { id: currentChatReply.id, name: currentChatReply.name, text: currentChatReply.text };
  }

  input.value = '';
  cancelChatReply();

  try {
    const { error } = await sbClient.from('messages').insert(payload);
    if (error) throw error;
  } catch (err) {
    console.error('Lỗi gửi tin nhắn:', err);
    showToast('Không thể gửi tin nhắn. Vui lòng thử lại.', 'error');
    input.value = text;
  }
}

function renderChatPresenceList() {
  const list = document.getElementById('chat-presence-list');
  const countEl = document.getElementById('chat-presence-online-count');
  if (!list) return;

  if (!FINANCE_MEMBERS.length) {
    list.innerHTML = '<div class="empty-state"><i class="fa-solid fa-user-slash"></i> Chưa có dữ liệu thành viên</div>';
    if (countEl) countEl.textContent = '0';
    return;
  }

  const sorted = FINANCE_MEMBERS.slice().sort((a, b) => (b.isOnline ? 1 : 0) - (a.isOnline ? 1 : 0));
  if (countEl) countEl.textContent = String(sorted.filter(m => m.isOnline).length);

  list.innerHTML = sorted.map(member => {
    const initials = getInitials(member.nickname || member.email);
    const statusDotClass = member.isOnline ? 'online' : 'offline';
    const statusText = member.isOnline ? 'Đang hoạt động' : timeAgoVietnamese(member.last_changed);
    const isMe = (member.email || '').toLowerCase() === (CURRENT_USER.email || '').toLowerCase();

    return `
      <div class="member-item-card chat-presence-item" title="${escapeHtml(member.email)}">
        <div class="member-avatar-box">
          <div class="member-avatar-circle">${escapeHtml(initials)}</div>
          <div class="status-dot-indicator ${statusDotClass}"></div>
        </div>
        <div class="member-content">
          <div class="member-email-title">
            <span>${escapeHtml(member.nickname || member.email)}</span>
            ${isMe ? '<span class="member-badge-pill">Bạn</span>' : ''}
          </div>
          <div class="member-activity-status ${statusDotClass}"><span>${escapeHtml(statusText)}</span></div>
        </div>
      </div>`;
  }).join('');
}

// -------------------- Chat @mention autocomplete --------------------

let chatMentionMatches = [];
let chatMentionActiveIndex = -1;
let chatMentionAtPos = -1;

function chatMentionCandidates() {
  const list = FINANCE_MEMBERS.filter(m => m.nickname).map(m => ({ label: m.nickname }));
  list.unshift({ label: 'All' });
  return list;
}

function updateChatMentionDropdown() {
  const input = document.getElementById('chat-msg-input');
  const dropdown = document.getElementById('chat-mention-dropdown');
  if (!input || !dropdown) return;

  const text = input.value;
  const caret = input.selectionStart;
  const at = text.lastIndexOf('@', caret - 1);

  if (at === -1) { closeChatMentionDropdown(); return; }
  const fragment = text.slice(at + 1, caret);
  if (fragment.includes('\n') || fragment.length > 24) { closeChatMentionDropdown(); return; }

  const query = fragment.toLowerCase();
  const matches = chatMentionCandidates().filter(c => c.label.toLowerCase().includes(query));
  if (!matches.length) { closeChatMentionDropdown(); return; }

  chatMentionMatches = matches;
  chatMentionActiveIndex = 0;
  chatMentionAtPos = at;

  dropdown.innerHTML = matches.map((c, i) =>
    '<div class="chat-mention-item' + (i === 0 ? ' active' : '') + '" onmousedown="event.preventDefault(); pickChatMention(' + i + ')">' +
    '<span class="chat-mention-avatar">' + escapeHtml(getInitials(c.label)) + '</span>' +
    '<span>' + escapeHtml(c.label) + '</span>' +
    '</div>'
  ).join('');
  dropdown.style.display = 'block';
}

function closeChatMentionDropdown() {
  const dropdown = document.getElementById('chat-mention-dropdown');
  if (dropdown) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; }
  chatMentionMatches = [];
  chatMentionActiveIndex = -1;
  chatMentionAtPos = -1;
}

function highlightChatMentionActive() {
  document.querySelectorAll('#chat-mention-dropdown .chat-mention-item').forEach((el, i) => {
    el.classList.toggle('active', i === chatMentionActiveIndex);
  });
}

function pickChatMention(index) {
  const input = document.getElementById('chat-msg-input');
  const match = chatMentionMatches[index];
  if (!input || !match || chatMentionAtPos === -1) { closeChatMentionDropdown(); return; }

  const caret = input.selectionStart;
  const before = input.value.slice(0, chatMentionAtPos);
  const after = input.value.slice(caret);
  const insertion = '@' + match.label + ' ';
  input.value = before + insertion + after;

  const newCaret = (before + insertion).length;
  input.setSelectionRange(newCaret, newCaret);
  input.focus();
  closeChatMentionDropdown();
}

function handleChatMentionKeydown(e) {
  const dropdown = document.getElementById('chat-mention-dropdown');
  if (!dropdown || dropdown.style.display !== 'block' || !chatMentionMatches.length) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    chatMentionActiveIndex = (chatMentionActiveIndex + 1) % chatMentionMatches.length;
    highlightChatMentionActive();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    chatMentionActiveIndex = (chatMentionActiveIndex - 1 + chatMentionMatches.length) % chatMentionMatches.length;
    highlightChatMentionActive();
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault();
    pickChatMention(chatMentionActiveIndex);
  } else if (e.key === 'Escape') {
    closeChatMentionDropdown();
  }
}

const chatInputForm = document.getElementById('chat-input-form');
if (chatInputForm) chatInputForm.addEventListener('submit', sendChatMessage);

const chatMsgInputEl = document.getElementById('chat-msg-input');
if (chatMsgInputEl) {
  chatMsgInputEl.addEventListener('input', updateChatMentionDropdown);
  chatMsgInputEl.addEventListener('keydown', handleChatMentionKeydown);
  chatMsgInputEl.addEventListener('blur', () => setTimeout(closeChatMentionDropdown, 150));
}

// ==========================================
// 5. OBSERVATION LOGS
// ==========================================

let LOCAL_LOGS = [];

async function fetchLiveObservationLogs() {
  const email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || '';
  if (API && API.notification) {
    try {
      const logs = await API.notification.get('finance', 25, email);
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
  if (API && API.system && API.system.logAction) {
    try {
      await API.system.logAction(traceId, action, text, type === 'danger' ? 'error' : 'success', userEmail, 'finance', null);
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
// 7. PROJECT / PROGRESS MODULE ("Tiến Độ")
// ==========================================
// Ported từ app WorkHub anh em (script.js loadProjectOverview/renderProgressTable/...).
// Bỏ nhánh isGeneralPage (activeGroup === 'all') vì app này chỉ có 1 nhóm cố định
// (activeGroup luôn là 'finance') — cột "Chia sẻ" luôn hiện nút share.
// Milestones/Burndown/CSV export KHÔNG được port trong đợt này (xem báo cáo bàn giao).

async function loadProjectOverview(options) {
  const quiet = !!(options && options.quiet);
  const tableBody = document.getElementById('progress-table-body');
  const taskDropdown = document.getElementById('task-project-select');
  const createDropdown = document.getElementById('project-select');
  const filterProjectDropdown = document.getElementById('progress-project-filter');
  const filterOwnerDropdown = document.getElementById('progress-search-input');

  const colSpanCount = 7;

  const prevProjectFilter = filterProjectDropdown ? filterProjectDropdown.value : '';
  const prevOwnerFilter = filterOwnerDropdown ? filterOwnerDropdown.value : '';
  const prevTaskDropdownVal = taskDropdown ? taskDropdown.value : '';

  if (!quiet) {
    if (tableBody) tableBody.innerHTML = skeletonTableRows(colSpanCount, 5);
    const loadingOpt = '<option value="">-- Đang tải... --</option>';
    if (taskDropdown) taskDropdown.innerHTML = loadingOpt;
    if (createDropdown) createDropdown.innerHTML = loadingOpt;
    if (filterProjectDropdown) filterProjectDropdown.innerHTML = loadingOpt;
    if (filterOwnerDropdown) filterOwnerDropdown.innerHTML = loadingOpt;
  }

  try {
    const response = await callGAS("getProjectList", {
      filters: {},
      groupKey: activeGroup,
      archiveScope: showArchivedProjects ? 'archived' : 'active'
    });

    if (response.status === 'success') {
      globalAllProjects = response.data || [];

      if (taskDropdown) taskDropdown.innerHTML = '<option value="">-- Chọn Dự Án để xem Task --</option>';
      if (createDropdown) createDropdown.innerHTML = '<option value="">-- Chọn Dự án đã có hoặc Nhập mới --</option>';
      if (filterProjectDropdown) filterProjectDropdown.innerHTML = '<option value="">-- Tất cả dự án --</option>';
      if (filterOwnerDropdown) filterOwnerDropdown.innerHTML = '<option value="">-- Tất cả --</option>';

      if (!globalAllProjects.length) {
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="${colSpanCount}" class="empty-state">Chưa có dự án nào.</td></tr>`;
        if (typeof loadMemberCheckboxes === 'function') loadMemberCheckboxes();
        if (typeof renderProjectManagerList === 'function') renderProjectManagerList();
        return;
      }

      const uniqueOwners = [...new Set(globalAllProjects.map(p => p.owner))].sort();
      if (filterOwnerDropdown) {
        uniqueOwners.forEach(owner => {
          const opt = document.createElement('option');
          opt.value = owner; opt.textContent = owner;
          filterOwnerDropdown.appendChild(opt);
        });
        if (prevOwnerFilter && uniqueOwners.includes(prevOwnerFilter)) filterOwnerDropdown.value = prevOwnerFilter;
      }
      const uniqueNames = [...new Set(globalAllProjects.map(p => p.name))].sort();
      if (filterProjectDropdown) {
        uniqueNames.forEach(name => {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          filterProjectDropdown.appendChild(opt);
        });
        if (prevProjectFilter && uniqueNames.includes(prevProjectFilter)) filterProjectDropdown.value = prevProjectFilter;
      }

      globalAllProjects.forEach(p => {
        if (taskDropdown) { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.name; taskDropdown.appendChild(opt); }
        if (createDropdown) { const opt = document.createElement('option'); opt.value = p.id; opt.textContent = p.name; createDropdown.appendChild(opt); }
      });

      if (currentTaskProjectID && taskDropdown) {
        const exists = Array.from(taskDropdown.options).some(o => o.value === currentTaskProjectID);
        if (exists) taskDropdown.value = currentTaskProjectID;
      } else if (quiet && prevTaskDropdownVal && taskDropdown &&
        Array.from(taskDropdown.options).some(o => o.value === prevTaskDropdownVal)) {
        taskDropdown.value = prevTaskDropdownVal;
      } else if (typeof restoreSavedTaskProject === 'function') {
        restoreSavedTaskProject(taskDropdown);
      }

      if (typeof loadMemberCheckboxes === 'function') loadMemberCheckboxes();

      renderProgressTable();
      if (typeof renderProjectManagerList === 'function') renderProjectManagerList();

    } else if (!quiet) {
      if (tableBody) tableBody.innerHTML = `<tr><td colspan="${colSpanCount}" class="empty-state" style="color:var(--danger-color);">Lỗi Server: ${response.message}</td></tr>`;
    } else {
      showToast("Lỗi tải dự án: " + response.message, "error");
    }
  } catch (err) {
    console.error("Lỗi tải dự án:", err);
    if (!quiet) {
      if (tableBody) tableBody.innerHTML = `<tr><td colspan="${colSpanCount}" class="empty-state" style="color:var(--danger-color);">Lỗi kết nối: ${err.message}</td></tr>`;
    } else {
      showToast("Lỗi kết nối: " + err.message, "error");
    }
  }
}

// Vẽ lại bảng Tiến độ từ cache (globalAllProjects) theo filter/sort đang chọn trên UI —
// KHÔNG gọi API, dùng cho các sự kiện đổi filter/sort để tránh fetch lại toàn bộ mỗi lần bấm.
function renderProgressTable() {
  const tableBody = document.getElementById('progress-table-body');
  if (!tableBody) return;

  const colSpanCount = 7;

  const filterOwnerDropdown = document.getElementById('progress-search-input');
  const filterProjectDropdown = document.getElementById('progress-project-filter');
  const filterStatusDropdown = document.getElementById('progress-status-filter');
  const nameSearchInput = document.getElementById('progress-name-search');
  const sortSelect = document.getElementById('progress-sort-select');

  const filterOwner = filterOwnerDropdown ? filterOwnerDropdown.value : "";
  const filterProject = filterProjectDropdown ? filterProjectDropdown.value : "";
  const filterStatus = filterStatusDropdown ? filterStatusDropdown.value : "";
  const nameSearch = nameSearchInput ? nameSearchInput.value.trim().toLowerCase() : "";
  const sortVal = sortSelect ? sortSelect.value : "date_desc";

  let projects = (globalAllProjects || []).filter(p => {
    const matchOwner = !filterOwner || p.owner === filterOwner;
    const matchProject = !filterProject || p.name === filterProject;
    const matchStatus = !filterStatus || p.status === filterStatus;
    const matchSearch = !nameSearch
      || (p.name || '').toLowerCase().includes(nameSearch)
      || (p.description || '').toLowerCase().includes(nameSearch);
    return matchOwner && matchProject && matchStatus && matchSearch;
  });

  if (sortVal === 'percent_desc') {
    projects.sort((a, b) => (b.percent || 0) - (a.percent || 0));
  } else if (sortVal === 'percent_asc') {
    projects.sort((a, b) => (a.percent || 0) - (b.percent || 0));
  } else if (sortVal === 'date_asc') {
    projects.sort((a, b) => new Date(a.created_at || a.lastUpdated || 0) - new Date(b.created_at || b.lastUpdated || 0));
  } else {
    projects.sort((a, b) => new Date(b.created_at || b.lastUpdated || 0) - new Date(a.created_at || a.lastUpdated || 0));
  }

  if (!projects.length) {
    tableBody.innerHTML = `<tr><td colspan="${colSpanCount}" class="empty-state">Không tìm thấy kết quả phù hợp.</td></tr>`;
    return;
  }

  tableBody.innerHTML = '';
  projects.forEach(p => {
    const row = tableBody.insertRow();

    const safeName = escapeHtml(p.name);
    const safeNameArg = escapeHtml(escapeJs(p.name));
    const safeIdArg = escapeHtml(escapeJs(p.id));

    const shareBtn = (p.isShared === true || p.isShared === 'true')
      ? `<button class="icon-btn success" onclick="shareProjectAction('${safeIdArg}', '${safeNameArg}')" title="Đã chia sẻ. Bấm để share lại."><i class="fa-solid fa-circle-check"></i></button>`
      : `<button class="icon-btn" onclick="shareProjectAction('${safeIdArg}', '${safeNameArg}')" title="Chia sẻ sang Dashboard Chung"><i class="fa-solid fa-share-from-square"></i></button>`;

    const statusBadge = p.status
      ? `<span class="status-pill pill-neutral" style="margin-left:6px;">${escapeHtml(p.status)}</span>`
      : '';

    let overdueBadge = '';
    if (p.overdueCount > 0) {
      overdueBadge = `<span class="status-pill pill-danger" style="margin-left:6px;" title="${p.overdueCount} công việc quá hạn"><i class="fa-solid fa-triangle-exclamation"></i> ${p.overdueCount}</span>`;
    } else if (p.dueSoonCount > 0) {
      overdueBadge = `<span class="status-pill pill-warning" style="margin-left:6px;" title="${p.dueSoonCount} công việc sắp đến hạn"><i class="fa-regular fa-clock"></i> ${p.dueSoonCount}</span>`;
    }

    const percent = p.percent || 0;
    const barColor = getProgressBarColor(percent);

    row.innerHTML = `
      <td style="font-weight:700; color: var(--gold);">${safeName}${statusBadge}${overdueBadge}</td>
      <td>
        <div class="score-gauge" style="height:10px;">
          <div class="score-gauge-fill" style="width:${percent}%; background:${barColor};"></div>
        </div>
        <div style="font-size:11px; color:var(--text-muted); margin-top:4px; font-family:var(--font-mono);">${percent}%</div>
      </td>
      <td style="font-size:13px; color:var(--text-secondary);">${escapeHtml(p.description || '')}</td>
      <td style="text-align:center;">${shareBtn}</td>
      <td style="font-size:13px;">${escapeHtml(p.lastUpdated || '')}</td>
      <td style="font-size:13px; font-weight:600;">${escapeHtml(p.owner || '')}</td>
      <td style="text-align:center; white-space:nowrap;">
        <button class="icon-btn" onclick="toggleProjectArchive('${safeIdArg}', '${safeNameArg}', ${p.archivedAt ? 'false' : 'true'})" title="${p.archivedAt ? 'Đưa trở lại danh sách đang chạy' : 'Lưu trữ dự án'}">
          <i class="fa-solid ${p.archivedAt ? 'fa-box-open' : 'fa-box-archive'}"></i>
        </button>
        <button class="icon-btn" onclick="openMilestonesModal('${safeIdArg}', '${safeNameArg}')" title="Cột mốc dự án">
          <i class="fa-solid fa-flag-checkered"></i>
        </button>
        <button class="icon-btn" onclick="openBurndownModal('${safeIdArg}', '${safeNameArg}')" title="Biểu đồ tiến độ">
          <i class="fa-solid fa-chart-line"></i>
        </button>
        <button class="icon-btn danger" onclick="deleteProjectAction('${safeIdArg}', '${safeNameArg}')" title="Xóa Dự Án">
          <i class="fa-solid fa-trash"></i>
        </button>
      </td>
    `;
  });
}

// Alias: dùng sau khi dữ liệu đã đổi ở server (xóa/share/tạo/cập nhật) — fetch lại từ đầu
// rồi vẽ lại. Giữ tên cũ để không phải sửa mọi nơi đang gọi loadProgressList().
async function loadProgressList(options) {
  return loadProjectOverview(options);
}

function getProgressBarColor(percent) {
  if (percent == 100) return 'var(--success-color)';
  if (percent >= 50) return 'var(--gold)';
  if (percent > 0) return 'var(--warning-color)';
  return 'var(--border-color)';
}

function exportProjectsCsv() {
  const projects = globalAllProjects || [];
  if (projects.length === 0) { showToast('Không có dự án nào để xuất.', 'error'); return; }

  const rows = [['Tên dự án', 'Trạng thái', 'Tiến độ (%)', 'Mô tả', 'Chủ dự án', 'Quá hạn', 'Sắp đến hạn', 'Cập nhật lần cuối', 'Lưu trữ']];
  projects.forEach(p => rows.push([
    p.name, p.status || '', p.percent || 0, p.description || '', p.owner || '',
    p.overdueCount || 0, p.dueSoonCount || 0, p.lastUpdated || '', p.archivedAt ? 'Có' : ''
  ]));

  downloadCsv(`du-an-${stamp()}.csv`, rows);
  showToast(`Đã xuất ${projects.length} dự án.`, 'success');
}

// -------------------- Cột mốc dự án (Milestones) --------------------

let currentMilestoneProjectId = null;

function openMilestonesModal(projectId, projectName) {
  currentMilestoneProjectId = projectId;
  const nameEl = document.getElementById('milestones-project-name');
  if (nameEl) nameEl.textContent = projectName;
  openAppModal('milestones-modal');
  loadMilestones(projectId);
}

async function loadMilestones(projectId) {
  const list = document.getElementById('milestone-list');
  if (!list) return;
  list.innerHTML = '<div style="padding: 8px; color: var(--text-muted); font-size: 12.5px;">Đang tải...</div>';
  try {
    const response = await callGAS('getMilestones', { projectId });
    if (response.status !== 'success') throw new Error(response.message);
    const milestones = response.data || [];
    if (milestones.length === 0) {
      list.innerHTML = '<div style="padding: 8px; color: var(--text-muted); font-size: 12.5px;">Chưa có cột mốc nào.</div>';
      return;
    }
    list.innerHTML = milestones.map(m => {
      const dateStr = m.target_date ? new Date(m.target_date + 'T00:00:00').toLocaleDateString('vi-VN') : '';
      return `<div class="milestone-item ${m.is_done ? 'milestone-done' : ''}">
        <label style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer; margin:0;">
          <input type="checkbox" ${m.is_done ? 'checked' : ''} onchange="toggleMilestoneStatus('${m.id}', this.checked)">
          <span class="milestone-title">${escapeHtml(m.title)}</span>
          ${dateStr ? `<span style="color:var(--text-muted); font-size:12px; margin-left:auto;">${dateStr}</span>` : ''}
        </label>
        <button class="icon-btn danger" onclick="deleteMilestoneAction('${m.id}')" title="Xóa">
          <i class="fa-solid fa-trash"></i>
        </button>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:var(--danger-color); font-size:12.5px; padding:8px;">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

async function handleMilestoneFormSubmit(e) {
  if (e) e.preventDefault();
  const titleInput = document.getElementById('milestone-title-input');
  const dateInput = document.getElementById('milestone-date-input');
  const title = titleInput ? titleInput.value.trim() : '';
  if (!title || !currentMilestoneProjectId) return;

  try {
    const response = await callGAS('addMilestone', { projectId: currentMilestoneProjectId, title, targetDate: dateInput ? dateInput.value : '', groupKey: activeGroup });
    if (response.status !== 'success') throw new Error(response.message);
    if (titleInput) titleInput.value = '';
    if (dateInput) dateInput.value = '';
    loadMilestones(currentMilestoneProjectId);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function toggleMilestoneStatus(milestoneId, isDone) {
  try {
    const response = await callGAS('toggleMilestone', { milestoneId, isDone });
    if (response.status !== 'success') throw new Error(response.message);
    loadMilestones(currentMilestoneProjectId);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function deleteMilestoneAction(milestoneId) {
  try {
    const response = await callGAS('deleteMilestone', { milestoneId });
    if (response.status !== 'success') throw new Error(response.message);
    loadMilestones(currentMilestoneProjectId);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// -------------------- Biểu đồ tiến độ (Burndown) --------------------

let burndownChartInstance = null;

async function openBurndownModal(projectId, projectName) {
  const nameEl = document.getElementById('burndown-project-name');
  if (nameEl) nameEl.textContent = projectName;
  openAppModal('burndown-modal');

  const canvas = document.getElementById('burndown-chart-canvas');
  if (!canvas) return;

  try {
    const response = await callGAS('getBurndownData', { projectId });
    if (response.status !== 'success') throw new Error(response.message);
    const tasks = response.data || [];

    if (tasks.length === 0 || typeof Chart === 'undefined') {
      if (burndownChartInstance) { burndownChartInstance.destroy(); burndownChartInstance = null; }
      return;
    }

    const allDates = tasks.map(t => new Date(t.created_at));
    let cursor = new Date(Math.min(...allDates));
    cursor.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const labels = [];
    const totalSeries = [];
    const doneSeries = [];

    while (cursor <= today) {
      const dayEnd = new Date(cursor); dayEnd.setHours(23, 59, 59, 999);
      const totalByDay = tasks.filter(t => new Date(t.created_at) <= dayEnd).length;
      const doneByDay = tasks.filter(t => String(t.status).toLowerCase() === 'done' && new Date(t.updated_at) <= dayEnd).length;

      labels.push(cursor.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' }));
      totalSeries.push(totalByDay);
      doneSeries.push(doneByDay);

      cursor.setDate(cursor.getDate() + 1);
    }

    if (burndownChartInstance) burndownChartInstance.destroy();
    burndownChartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Tổng công việc', data: totalSeries, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--warning-color').trim(), backgroundColor: 'transparent', stepped: true },
          { label: 'Đã hoàn thành', data: doneSeries, borderColor: getComputedStyle(document.documentElement).getPropertyValue('--success-color').trim(), backgroundColor: 'transparent', stepped: true }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } }
      }
    });
  } catch (err) {
    showToast('Lỗi tải biểu đồ: ' + err.message, 'error');
  }
}

async function toggleProjectArchive(projectId, projectName, archive) {
  try {
    const response = await callGAS('setProjectArchived', { projectId, archived: archive, groupKey: activeGroup });
    if (response.status !== 'success') throw new Error(response.message);
    showToast(response.data || response.message, 'success');
    loadProjectOverview({ quiet: true });
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

function toggleArchivedProjectsView() {
  showArchivedProjects = !showArchivedProjects;
  const btn = document.getElementById('toggle-archived-btn');
  if (btn) {
    btn.classList.toggle('active', showArchivedProjects);
    btn.innerHTML = showArchivedProjects
      ? '<i class="fa-solid fa-box-open"></i> Đang xem: Kho lưu trữ'
      : '<i class="fa-solid fa-box-archive"></i> Xem kho lưu trữ';
  }
  loadProjectOverview();
}

function deleteProjectAction(projectId, projectName) {
  Swal.fire({
    title: 'CẢNH BÁO XÓA DỰ ÁN!',
    html: `Bạn đang chọn xóa dự án: <b>"${projectName}"</b><br><br>
            Hành động này sẽ xóa vĩnh viễn dự án này <br>
            VÀ <b>TẤT CẢ CÁC TASK CON</b> liên quan!<br><br>
            Không thể khôi phục được!`,
    icon: 'error',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'XÓA LÀ MẤT HẾT ĐÓ NHA!',
    cancelButtonText: 'Nghĩ kỹ lại đi ae!'
  }).then(async (result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: 'Đang xóa dữ liệu...',
        text: 'Vui lòng không tắt trình duyệt',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      try {
        const response = await callGAS("deleteProject", { projectId: projectId, groupKey: activeGroup });

        if (response.status === 'success') {
          Swal.fire('Đã xóa!', response.data || response.message, 'success');

          if (currentTaskProjectID === projectId) {
            currentTaskProjectID = null;
            const taskBody = document.getElementById('task-table-body');
            if (taskBody) taskBody.innerHTML = '';
          }

          loadProgressList({ quiet: true });
        } else {
          Swal.fire('Lỗi!', "Không thể xóa dự án: " + response.message, 'error');
        }
      } catch (err) {
        console.error("Lỗi xóa dự án:", err);
        Swal.fire('Lỗi!', "Lỗi kết nối: " + (err.message || err), 'error');
      }
    }
  });
}

async function handleProjectCreationOrUpdate() {
  const btn = document.getElementById('update-progress-btn');
  const nameInput = document.getElementById('progress-project-name');
  const noteInput = document.getElementById('progress-note-input');
  const statusInput = document.getElementById('progress-status-select');
  const selectInput = document.getElementById('project-select');

  const newName = nameInput.value.trim();
  const note = noteInput.value.trim();
  const status = statusInput ? statusInput.value : '';
  const selectedProjectId = selectInput.value;

  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý...';
  btn.disabled = true;

  try {
    if (!selectedProjectId && newName) {
      const response = await callGAS("createProject", {
        name: newName,
        owner: CURRENT_USER.email || "Unknown",
        status: status || "Planning",
        description: note,
        groupKey: activeGroup
      });

      if (response.status === 'success') {
        showToast(response.data || response.message, "success");
        nameInput.value = '';
        noteInput.value = '';
        if (statusInput) statusInput.value = 'Planning';
        loadProjectOverview({ quiet: true });
      } else {
        showToast("Lỗi: " + response.message, "error");
      }
    } else if (selectedProjectId) {
      const response = await callGAS("updateProject", {
        projectId: selectedProjectId,
        status: status,
        description: note,
        groupKey: activeGroup
      });

      if (response.status === 'success') {
        showToast(response.data || response.message, "success");
        loadProjectOverview({ quiet: true });
      } else {
        showToast("Lỗi cập nhật: " + response.message, "error");
      }
    } else {
      showToast("Vui lòng nhập tên dự án mới hoặc chọn dự án để cập nhật.", "warning");
    }
  } catch (err) {
    console.error("Lỗi xử lý dự án:", err);
    showToast("Lỗi hệ thống: " + (err.message || err), "error");
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

// Chia sẻ dự án sang Dashboard Chung — bật cờ is_shared trên đúng dự án này, không tạo bản sao.
function shareProjectAction(projectId, projectName) {
  Swal.fire({
    title: 'Chia sẻ dự án lên WorkHub Org?',
    html: `Dự án <b>"${projectName}"</b> sẽ được hiển thị trên Dashboard Chung của WorkHub Org.<br><small style="color:var(--text-muted);">Đây là chia sẻ trực tiếp — không tạo bản sao, mọi cập nhật sau này (tiến độ, công việc...) sẽ luôn tự động đồng bộ.</small>`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: 'var(--gold)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Chia sẻ',
    cancelButtonText: 'Huỷ'
  }).then(async (result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: 'Đang share...',
        text: 'Vui lòng chờ trong giây lát',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      try {
        const response = await callGAS("shareProject", { projectId: projectId, groupKey: activeGroup });

        if (response.status === 'success') {
          Swal.fire('Thành công!', response.data || response.message, 'success');
          loadProjectOverview({ quiet: true });
        } else {
          Swal.fire('Lỗi!', "Không thể share: " + response.message, 'error');
        }
      } catch (err) {
        console.error("Lỗi share dự án:", err);
        Swal.fire('Lỗi!', "Lỗi kết nối: " + (err.message || err), 'error');
      }
    }
  });
}

// ==========================================
// 8. TASK MODULE ("Nhiệm Vụ") — chỉ chế độ xem bảng (table)
// ==========================================
// Kanban/card view, kéo-thả, bulk-select, dependency ("bị chặn bởi"), comment/checklist/
// history modal, subtask, file đính kèm, CSV export: KHÔNG port trong đợt này.

async function loadTasksForProject(projectId, options) {
  const quiet = !!(options && options.quiet);
  const tableBody = document.getElementById('task-table-body');
  const modalProjectId = document.getElementById('new-task-project-id');

  currentTaskProjectID = projectId;
  if (modalProjectId) modalProjectId.value = projectId;

  if (!projectId) {
    if (tableBody) tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">Vui lòng chọn dự án để xem công việc.</td></tr>';
    const filesCard = document.getElementById('task-project-files-card');
    if (filesCard) filesCard.style.display = 'none';
    return;
  }

  if (!quiet) {
    if (tableBody) tableBody.innerHTML = skeletonTableRows(7, 6);
  }

  try {
    const response = await callGAS("getTaskList", { projectId: projectId, groupKey: activeGroup });

    if (response.status === 'success') {
      globalAllTasks = response.data || [];

      const taskNameSelect = document.getElementById('filter-task-name');
      if (taskNameSelect) {
        const prevName = taskNameSelect.value;
        taskNameSelect.innerHTML = '<option value="">-- Tất cả công việc --</option>';
        const uniqueNames = [...new Set(globalAllTasks.map(t => t.name))];
        uniqueNames.forEach(name => {
          const opt = document.createElement('option');
          opt.value = name; opt.textContent = name;
          taskNameSelect.appendChild(opt);
        });
        if (prevName && uniqueNames.includes(prevName)) taskNameSelect.value = prevName;
      }

      populateLabelFilter();
      applyPendingTaskFilterRestore();
      applyTaskFilters();
      loadProjectFiles(projectId);

    } else {
      if (!quiet) {
        if (tableBody) tableBody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color:var(--danger-color);">Lỗi: ${response.message}</td></tr>`;
      }
      showToast("Lỗi tải task: " + response.message, "error");
    }
  } catch (err) {
    console.error("Lỗi tải task:", err);
    if (!quiet) {
      if (tableBody) tableBody.innerHTML = `<tr><td colspan="7" class="empty-state" style="color:var(--danger-color);">Lỗi kết nối server!</td></tr>`;
    }
    showToast("Lỗi kết nối: " + err.message, "error");
  }
}

// -------------------- Quản lý dự án (trong section Nhiệm Vụ) --------------------
// Danh sách toàn bộ dự án (không chỉ dự án đang chọn), lọc theo trạng thái/tên,
// để tìm nhanh các dự án đã hoàn thành (Completed) v.v. Đọc từ cache globalAllProjects
// đã được loadProjectOverview() nạp sẵn ngay sau đăng nhập — không gọi API riêng.

let projectManagerPanelCollapsed = false;

function toggleProjectManagerPanel() {
  projectManagerPanelCollapsed = !projectManagerPanelCollapsed;
  const body = document.getElementById('task-project-manager-body');
  const btn = document.getElementById('task-project-manager-toggle-btn');
  if (body) body.style.display = projectManagerPanelCollapsed ? 'none' : 'block';
  if (btn) btn.innerHTML = `<i class="fa-solid ${projectManagerPanelCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>`;
}

function renderProjectManagerList() {
  const tbody = document.getElementById('task-project-manager-body-list');
  const countBadge = document.getElementById('task-project-manager-count');
  if (!tbody) return;

  const statusFilter = document.getElementById('task-project-status-filter');
  const searchInput = document.getElementById('task-project-search');
  const filterStatus = statusFilter ? statusFilter.value : '';
  const search = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const projects = (globalAllProjects || []).filter(p => {
    const matchStatus = !filterStatus || p.status === filterStatus;
    const matchSearch = !search || (p.name || '').toLowerCase().includes(search);
    return matchStatus && matchSearch;
  });

  if (countBadge) countBadge.textContent = String((globalAllProjects || []).length);

  if (projects.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Không tìm thấy dự án phù hợp.</td></tr>';
    return;
  }

  tbody.innerHTML = projects.map(p => {
    const isSelected = p.id === currentTaskProjectID;
    const safeIdArg = escapeHtml(escapeJs(p.id));
    return `
    <tr style="${isSelected ? 'background: var(--hover-bg);' : ''}">
      <td style="font-weight:600;">${escapeHtml(p.name)}</td>
      <td>${p.status ? `<span class="status-pill pill-neutral" style="font-size:10px; padding:1px 8px;">${escapeHtml(p.status)}</span>` : ''}</td>
      <td>
        <div class="score-gauge" style="height:10px;">
          <div class="score-gauge-fill" style="width:${p.percent || 0}%; background:${getProgressBarColor(p.percent)};"></div>
        </div>
        <div style="font-size:10px; color:var(--text-muted); margin-top:2px;">${p.percent || 0}%</div>
      </td>
      <td style="font-size:13px; color: var(--text-secondary);">${escapeHtml(p.lastUpdated || '')}</td>
      <td style="text-align:center;">
        <button type="button" class="btn ${isSelected ? 'btn-secondary' : 'btn-outline'}" style="padding: 4px 10px; font-size:12px;" onclick="selectProjectFromManager('${safeIdArg}')">
          ${isSelected ? 'Đang xem' : 'Chọn'}
        </button>
      </td>
    </tr>`;
  }).join('');
}

function selectProjectFromManager(projectId) {
  const select = document.getElementById('task-project-select');
  if (select) select.value = projectId;
  loadTasksForProject(projectId);
}

// -------------------- Tệp của dự án (upload trực tiếp vào dự án, files.project_id) --------------------

let projectFilesPanelCollapsed = false;

function toggleProjectFilesPanel() {
  projectFilesPanelCollapsed = !projectFilesPanelCollapsed;
  const body = document.getElementById('task-project-files-body');
  const btn = document.getElementById('task-project-files-toggle-btn');
  if (body) body.style.display = projectFilesPanelCollapsed ? 'none' : 'block';
  if (btn) btn.innerHTML = `<i class="fa-solid ${projectFilesPanelCollapsed ? 'fa-chevron-down' : 'fa-chevron-up'}"></i>`;
}

let projectFilesCache = [];

async function loadProjectFiles(projectId) {
  const card = document.getElementById('task-project-files-card');
  const list = document.getElementById('task-project-files-list');
  if (!card || !list) return;

  if (!projectId) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  list.innerHTML = '<div style="padding:8px; color: var(--text-muted); font-size: 12.5px;">Đang tải...</div>';

  try {
    projectFilesCache = await API.file.list(activeGroup, { projectId });
    renderProjectFilesList();
  } catch (err) {
    list.innerHTML = `<div style="padding:8px; color: var(--danger-color); font-size: 12.5px;">Lỗi tải file: ${escapeHtml(err.message)}</div>`;
  }
}

function renderProjectFilesList() {
  const list = document.getElementById('task-project-files-list');
  const countBadge = document.getElementById('task-project-files-count');
  if (!list) return;

  const items = projectFilesCache || [];
  if (countBadge) countBadge.textContent = String(items.length);

  if (items.length === 0) {
    list.innerHTML = '<div style="padding:8px; color: var(--text-muted); font-size: 12.5px;">Chưa có file nào được tải lên dự án này.</div>';
    return;
  }

  list.innerHTML = items.map(f => {
    const relatedTask = f.taskId ? (globalAllTasks || []).find(t => t.id === f.taskId) : null;
    const taskLabel = relatedTask ? `Công việc: ${escapeHtml(relatedTask.name)} · ` : '';
    return `
    <div class="task-attachment-item">
      <div style="min-width:0; flex:1; overflow:hidden;">
        <a href="${escapeHtml(f.url || '#')}" target="_blank" rel="noopener"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(f.name || 'Không tên')}</a>
        <div class="task-attachment-meta">${taskLabel}${escapeHtml((f.uploader || '').split('@')[0])} · ${escapeHtml(f.date || '')}</div>
      </div>
      <button type="button" class="icon-btn danger" title="Xóa file" onclick="deleteProjectFileAction('${escapeHtml(escapeJs(f.id))}', '${escapeHtml(escapeJs(f.name || ''))}')">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `;
  }).join('');
}

async function handleProjectFileUpload() {
  const input = document.getElementById('task-project-file-input');
  const btn = document.getElementById('task-project-file-upload-btn');
  if (!input || !input.files || input.files.length === 0) return;
  if (!currentTaskProjectID) { showToast('Vui lòng chọn dự án trước.', 'error'); return; }

  const file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { showToast('Tệp quá lớn! Vui lòng chọn tệp < 5MB.', 'error'); input.value = ''; return; }

  const originalText = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải...'; }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const base64Data = e.target.result.split(',')[1];
    try {
      const response = await callGAS('uploadFile', {
        fileData: base64Data,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        groupKey: activeGroup,
        description: '',
        email: CURRENT_USER.email,
        folderPath: '',
        projectId: currentTaskProjectID
      });
      if (response.status !== 'success') throw new Error(response.message);
      showToast('Tải file lên thành công!', 'success');
      loadProjectFiles(currentTaskProjectID);
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    } finally {
      input.value = '';
      if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
    }
  };
  reader.readAsDataURL(file);
}

function deleteProjectFileAction(fileId, fileName) {
  Swal.fire({
    title: 'Xóa File?',
    text: `Bạn có chắc muốn xóa file "${fileName}"?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Xóa',
    cancelButtonText: 'Hủy'
  }).then(async (result) => {
    if (!result.isConfirmed) return;
    try {
      const response = await callGAS('deleteFile', { fileId, groupKey: activeGroup });
      if (response.status !== 'success') throw new Error(response.message);
      showToast(response.message, 'success');
      await loadProjectFiles(currentTaskProjectID);
      if (document.getElementById('task-files-modal').classList.contains('open')) renderTaskFilesModalList();
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  });
}

// -------------------- Cửa sổ tệp của từng công việc --------------------

let currentTaskFilesPopupTaskId = null;

function openTaskFilesPopup(taskId, taskName) {
  if (!currentTaskProjectID) { showToast('Vui lòng chọn dự án trước.', 'error'); return; }
  currentTaskFilesPopupTaskId = taskId;
  const nameEl = document.getElementById('task-files-modal-name');
  if (nameEl) nameEl.textContent = taskName || '';
  openAppModal('task-files-modal');
  renderTaskFilesModalList();
}

function renderTaskFilesModalList() {
  const list = document.getElementById('task-files-modal-list');
  if (!list || !currentTaskFilesPopupTaskId) return;

  const items = (projectFilesCache || []).filter(f => f.taskId === currentTaskFilesPopupTaskId);

  if (items.length === 0) {
    list.innerHTML = '<div style="padding:8px; color: var(--text-muted); font-size: 12.5px;">Chưa có file nào cho công việc này.</div>';
    return;
  }

  list.innerHTML = items.map(f => `
    <div class="task-attachment-item">
      <div style="min-width:0; flex:1; overflow:hidden;">
        <a href="${escapeHtml(f.url || '#')}" target="_blank" rel="noopener"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(f.name || 'Không tên')}</a>
        <div class="task-attachment-meta">${escapeHtml((f.uploader || '').split('@')[0])} · ${escapeHtml(f.date || '')}</div>
      </div>
      <button type="button" class="icon-btn danger" title="Xóa file" onclick="deleteProjectFileAction('${escapeHtml(escapeJs(f.id))}', '${escapeHtml(escapeJs(f.name || ''))}')">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>
  `).join('');
}

async function handleTaskModalFileUpload() {
  const input = document.getElementById('task-files-modal-input');
  const btn = document.getElementById('task-files-modal-upload-btn');
  if (!input || !input.files || input.files.length === 0) return;
  const taskId = currentTaskFilesPopupTaskId;
  if (!taskId) return;

  const file = input.files[0];
  if (file.size > 5 * 1024 * 1024) { showToast('Tệp quá lớn! Vui lòng chọn tệp < 5MB.', 'error'); input.value = ''; return; }

  const originalText = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang tải...'; }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const base64Data = e.target.result.split(',')[1];
    try {
      const response = await callGAS('uploadFile', {
        fileData: base64Data,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        groupKey: activeGroup,
        description: '',
        email: CURRENT_USER.email,
        folderPath: '',
        projectId: currentTaskProjectID,
        taskId: taskId
      });
      if (response.status !== 'success') throw new Error(response.message);
      showToast('Tải file lên thành công!', 'success');
      await loadProjectFiles(currentTaskProjectID);
      renderTaskFilesModalList();
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    } finally {
      input.value = '';
      if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
    }
  };
  reader.readAsDataURL(file);
}

function renderTasks(tasks) {
  const tableBody = document.getElementById('task-table-body');
  if (!tableBody) return;
  tableBody.innerHTML = '';

  renderTaskCards(tasks);
  renderKanbanBoard(tasks);

  if (!tasks || tasks.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="8" class="empty-state">Chưa có công việc nào.</td></tr>';
    return;
  }

  // Sắp xếp: task cha trước, subtask (nếu có, từ dữ liệu cũ) nằm ngay sau cha của nó
  const idsInView = new Set(tasks.map(x => x.id));
  const topLevel = tasks.filter(x => !x.parent_task_id || !idsInView.has(x.parent_task_id));
  const orderedTasks = [];
  topLevel.forEach(x => {
    orderedTasks.push(x);
    tasks.filter(c => c.parent_task_id === x.id).forEach(c => orderedTasks.push(c));
  });
  tasks.forEach(x => { if (!orderedTasks.includes(x)) orderedTasks.push(x); });

  orderedTasks.forEach(t => {
    const safeName = escapeHtml(escapeJs(t.name));
    const safeDesc = escapeHtml(escapeJs(t.description || '').replace(/\r?\n/g, "\\n"));
    const safeAssignees = escapeHtml(escapeJs(t.assignees || ''));
    const isSubtask = !!t.parent_task_id && idsInView.has(t.parent_task_id);

    let avatarsHTML = '<div class="avatar-stack">';
    if (t.assigneeNames && t.assigneeNames.length > 0) {
      t.assigneeNames.forEach(name => {
        const short = name.trim().substring(0, 2).toUpperCase();
        avatarsHTML += `<div class="task-avatar" title="${escapeHtml(name)}">${escapeHtml(short)}</div>`;
      });
    } else {
      avatarsHTML += '<span style="font-size:12px; color:var(--text-muted);">--</span>';
    }
    avatarsHTML += '</div>';

    const statusColor = getStatusColor(t.status);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="bulk-select-col" style="display:none;"><input type="checkbox" class="bulk-select-checkbox" data-task-id="${t.id}" onchange="onBulkCheckboxChange('${t.id}', this.checked)" onclick="event.stopPropagation()"></td>
      <td style="border-left: 3px solid ${statusColor}; font-weight: 600; ${isSubtask ? 'padding-left: 30px;' : ''}">
        ${isSubtask ? '<i class="fa-solid fa-turn-up fa-rotate-90" style="color:var(--text-muted); font-size:0.75em; margin-right:4px;"></i>' : ''}${escapeHtml(t.name)}
        ${getBlockedBadge(t)}${getChecklistBadge(t)}
        ${renderLabelChips(t.labels)}
      </td>
      <td>${avatarsHTML}</td>
      <td style="font-size:13px; color:var(--text-secondary); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(t.description || '')}">${escapeHtml(t.description || '')}</td>
      <td>${renderBadge('status', t.status)}</td>
      <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(t.dueDate || '--')}${getDueDateBadge(t.dueDate, t.status)}</td>
      <td>${renderBadge('priority', t.priority)}</td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" title="Bình luận & lịch sử" onclick="openTaskActivity('${t.id}', '${safeName}')">
          <i class="fa-solid fa-comment-dots"></i>
        </button>
        <button class="icon-btn" title="Sửa"
          onclick="openEditTask('${t.id}', '${safeName}', '${escapeHtml(escapeJs(t.status))}', '${escapeHtml(escapeJs(t.priority))}', '${escapeHtml(escapeJs(t.dueDate || ''))}', '${safeAssignees}', '${safeDesc}', '${t.parent_task_id || ''}', '${escapeHtml(escapeJs(t.blocked_by || ''))}')">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="icon-btn" title="Tệp của công việc này" onclick="openTaskFilesPopup('${t.id}', '${safeName}')">
          <i class="fa-solid fa-upload"></i>
        </button>
        <button class="icon-btn danger" title="Xóa" onclick="deleteTaskAction('${t.id}', '${safeName}')">
          <i class="fa-solid fa-trash"></i>
        </button>
      </td>
    `;
    tableBody.appendChild(tr);
  });
}

// -------------------- Task view toggle (Table / Card / Kanban) --------------------

function switchTaskView(view) {
  const tableView = document.getElementById('task-view-table');
  const cardView = document.getElementById('task-view-card');
  const kanbanView = document.getElementById('task-view-kanban');
  if (tableView) tableView.style.display = (view === 'table') ? 'block' : 'none';
  if (cardView) cardView.style.display = (view === 'card') ? 'block' : 'none';
  if (kanbanView) kanbanView.style.display = (view === 'kanban') ? 'block' : 'none';

  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
}

function renderTaskCards(tasks) {
  const container = document.getElementById('task-card-container');
  if (!container) return;
  container.innerHTML = '';

  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<div class="empty-state">Chưa có công việc nào.</div>';
    return;
  }

  tasks.forEach(t => {
    const safeName = escapeHtml(escapeJs(t.name));
    const safeDesc = escapeHtml(escapeJs(t.description || '').replace(/\r?\n/g, "\\n"));
    const safeAssignees = escapeHtml(escapeJs(t.assignees || ''));

    const card = document.createElement('div');
    card.className = 'task-card';
    card.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <input type="checkbox" class="bulk-select-checkbox" data-task-id="${t.id}" onchange="onBulkCheckboxChange('${t.id}', this.checked)" onclick="event.stopPropagation()" style="display:none;">
        <h4 class="task-title" style="flex:1;">${escapeHtml(t.name)}</h4>
      </div>
      <div>${getBlockedBadge(t)}${getChecklistBadge(t)}</div>
      ${renderLabelChips(t.labels)}
      <div class="card-row"><span class="card-label">Trạng thái</span>${renderBadge('status', t.status)}</div>
      <div class="card-row"><span class="card-label">Ưu tiên</span>${renderBadge('priority', t.priority)}</div>
      <div class="card-row"><span class="card-label">Hạn chót</span><span>${escapeHtml(t.dueDate || '--')}${getDueDateBadge(t.dueDate, t.status)}</span></div>
      <div class="card-row"><span class="card-label">Thành viên</span><span>${escapeHtml((t.assigneeNames || []).join(', ') || '--')}</span></div>
      <div style="display:flex; justify-content:flex-end; gap:4px;">
        <button class="icon-btn" title="Bình luận & lịch sử" onclick="event.stopPropagation(); openTaskActivity('${t.id}', '${safeName}')"><i class="fa-solid fa-comment-dots"></i></button>
        <button class="icon-btn" title="Sửa" onclick="event.stopPropagation(); openEditTask('${t.id}', '${safeName}', '${escapeHtml(escapeJs(t.status))}', '${escapeHtml(escapeJs(t.priority))}', '${escapeHtml(escapeJs(t.dueDate || ''))}', '${safeAssignees}', '${safeDesc}', '${t.parent_task_id || ''}', '${escapeHtml(escapeJs(t.blocked_by || ''))}')"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn" title="Tệp của công việc này" onclick="event.stopPropagation(); openTaskFilesPopup('${t.id}', '${safeName}')"><i class="fa-solid fa-upload"></i></button>
        <button class="icon-btn danger" title="Xóa" onclick="event.stopPropagation(); deleteTaskAction('${t.id}', '${safeName}')"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    container.appendChild(card);
  });
}

const KANBAN_STATUSES = ['Not Started', 'Working on it', 'Stuck', 'Done'];
let draggedTaskId = null;

function renderKanbanBoard(tasks) {
  const container = document.getElementById('kanban-board-container');
  if (!container) return;
  container.innerHTML = '';

  KANBAN_STATUSES.forEach(status => {
    const colTasks = (tasks || []).filter(t => (t.status || 'Not Started') === status);

    const col = document.createElement('div');
    col.className = 'kanban-column';
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('kanban-column-dragover'); });
    col.addEventListener('dragleave', () => col.classList.remove('kanban-column-dragover'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('kanban-column-dragover');
      handleKanbanDrop(status);
    });

    const header = document.createElement('div');
    header.className = 'kanban-column-header';
    header.innerHTML = `<span>${escapeHtml(status)}</span><span class="kanban-count">${colTasks.length}</span>`;
    col.appendChild(header);

    const body = document.createElement('div');
    body.className = 'kanban-column-body';

    colTasks.forEach(t => {
      const card = document.createElement('div');
      card.className = 'kanban-card';
      card.draggable = true;
      card.addEventListener('dragstart', () => { draggedTaskId = t.id; card.classList.add('dragging-task'); });
      card.addEventListener('dragend', () => { card.classList.remove('dragging-task'); });
      card.addEventListener('click', () => {
        const safeName = escapeHtml(escapeJs(t.name));
        const safeDesc = escapeHtml(escapeJs(t.description || '').replace(/\r?\n/g, "\\n"));
        const safeAssignees = escapeHtml(escapeJs(t.assignees || ''));
        openEditTask(t.id, safeName, escapeHtml(escapeJs(t.status)), escapeHtml(escapeJs(t.priority)), escapeHtml(escapeJs(t.dueDate || '')), safeAssignees, safeDesc, t.parent_task_id || '', escapeHtml(escapeJs(t.blocked_by || '')));
      });

      const safeNameForActivity = escapeHtml(escapeJs(t.name));
      card.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:6px;">
          <div class="kanban-card-title" style="flex:1;">${escapeHtml(t.name)}</div>
          <button class="icon-btn" title="Bình luận & lịch sử" style="width:26px; height:26px; flex-shrink:0;"
            onclick="event.stopPropagation(); openTaskActivity('${t.id}', '${safeNameForActivity}')"><i class="fa-solid fa-comment-dots" style="font-size:12px;"></i></button>
        </div>
        <div>${getBlockedBadge(t)}${getChecklistBadge(t)}</div>
        ${renderLabelChips(t.labels) ? `<div class="kanban-card-labels">${renderLabelChips(t.labels)}</div>` : ''}
        <div class="kanban-card-meta">
          ${renderBadge('priority', t.priority)}
          ${getDueDateBadge(t.dueDate, t.status)}
        </div>
      `;
      body.appendChild(card);
    });

    col.appendChild(body);
    container.appendChild(col);
  });
}

async function handleKanbanDrop(newStatus) {
  if (!draggedTaskId || !globalAllTasks) return;
  const task = globalAllTasks.find(t => t.id === draggedTaskId);
  draggedTaskId = null;
  if (!task || task.status === newStatus) return;

  const oldStatus = task.status;
  task.status = newStatus;
  applyTaskFilters();

  try {
    const response = await callGAS('saveTask', {
      id: task.id,
      projectId: task.project_id,
      name: task.name,
      status: newStatus,
      priority: task.priority,
      dueDate: task.dueDate,
      assignees: task.assignees,
      description: task.description,
      parentTaskId: task.parent_task_id,
      blockedBy: task.blocked_by,
      expectedVersion: task.version,
      groupKey: activeGroup
    });
    if (response.status !== 'success') throw new Error(response.message);
    showToast(response.data || response.message, 'success');
    if (typeof loadProjectOverview === 'function') loadProjectOverview({ quiet: true });
  } catch (err) {
    task.status = oldStatus;
    applyTaskFilters();
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// -------------------- Chọn nhiều (bulk action) Task --------------------

let bulkSelectMode = false;
let bulkSelectedIds = new Set();

function toggleBulkSelectMode() {
  bulkSelectMode = !bulkSelectMode;
  if (!bulkSelectMode) bulkSelectedIds.clear();

  document.querySelectorAll('.bulk-select-col, .bulk-select-checkbox').forEach(el => {
    if (!bulkSelectMode) { el.style.display = 'none'; return; }
    el.style.display = (el.tagName === 'TH' || el.tagName === 'TD') ? 'table-cell' : 'inline-block';
  });
  document.querySelectorAll('.bulk-select-checkbox').forEach(cb => { if (!bulkSelectMode) cb.checked = false; });

  const toggleBtn = document.getElementById('bulk-select-toggle');
  if (toggleBtn) toggleBtn.classList.toggle('active', bulkSelectMode);

  refreshBulkSelectionUI();
}

function onBulkCheckboxChange(taskId, checked) {
  if (checked) bulkSelectedIds.add(taskId);
  else bulkSelectedIds.delete(taskId);
  document.querySelectorAll(`.bulk-select-checkbox[data-task-id="${taskId}"]`).forEach(cb => cb.checked = checked);
  refreshBulkSelectionUI();
}

function toggleSelectAllTasks(checked) {
  document.querySelectorAll('.bulk-select-checkbox').forEach(cb => {
    cb.checked = checked;
    const id = cb.dataset.taskId;
    if (checked) bulkSelectedIds.add(id); else bulkSelectedIds.delete(id);
  });
  refreshBulkSelectionUI();
}

function refreshBulkSelectionUI() {
  const bar = document.getElementById('bulk-action-bar');
  const countEl = document.getElementById('bulk-selected-count');
  if (countEl) countEl.textContent = `${bulkSelectedIds.size} đã chọn`;
  if (bar) bar.style.display = (bulkSelectMode && bulkSelectedIds.size > 0) ? 'flex' : 'none';
}

async function runBulkTaskAction(action, extraParams) {
  const ids = Array.from(bulkSelectedIds);
  if (ids.length === 0) return null;

  try {
    const response = await callGAS(action, { taskIds: ids, projectId: currentTaskProjectID, groupKey: activeGroup, ...extraParams });
    if (response.status !== 'success') throw new Error(response.message);
    showToast(response.data || response.message, 'success');
    bulkSelectedIds.clear();
    if (typeof loadTasksForProject === 'function' && currentTaskProjectID) loadTasksForProject(currentTaskProjectID, { quiet: true });
    if (typeof loadProjectOverview === 'function') loadProjectOverview({ quiet: true });
    return response;
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
    return null;
  }
}

let bulkAssigneeExpanded = false;
function showBulkAssigneeCheckboxes() {
  const box = document.getElementById('bulk-assignee-checkboxes');
  if (!box) return;
  bulkAssigneeExpanded = !bulkAssigneeExpanded;
  box.style.display = bulkAssigneeExpanded ? 'block' : 'none';
  if (bulkAssigneeExpanded && !box.dataset.loaded) {
    box.dataset.loaded = '1';
    loadBulkAssigneeCheckboxes();
  }
}

async function loadBulkAssigneeCheckboxes() {
  const container = document.getElementById('bulk-assignee-checkboxes');
  if (!container) return;
  container.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">Đang tải...</div>';

  try {
    const response = await callGAS('getAllUsers', { groupKey: activeGroup });
    if (response.status !== 'success') throw new Error(response.message);
    const users = response.data || [];
    if (users.length === 0) {
      container.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">Chưa có thành viên.</div>';
      return;
    }
    container.innerHTML = users.map(u =>
      `<label style="display:block; padding:4px 0; font-size:13px;">
        <input type="checkbox" name="bulk-assignees" value="${escapeHtml(u.email)}"> ${escapeHtml(u.name || u.email)}
      </label>`
    ).join('');
  } catch (err) {
    container.innerHTML = `<div style="font-size:12px; color:var(--danger-color);">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

async function applyBulkAssign() {
  const checked = document.querySelectorAll('input[name="bulk-assignees"]:checked');
  const emails = Array.from(checked).map(cb => cb.value).join(', ');
  if (!emails) { showToast('Chưa chọn người thực hiện.', 'error'); return; }
  await runBulkTaskAction('bulkAssignTasks', { assignees: emails });
  document.querySelectorAll('input[name="bulk-assignees"]:checked').forEach(cb => cb.checked = false);
}

async function applyBulkDueDate() {
  const input = document.getElementById('bulk-duedate-input');
  const dueDate = input ? input.value : '';
  if (!dueDate) { showToast('Chưa chọn ngày.', 'error'); return; }
  await runBulkTaskAction('bulkSetTaskDueDate', { dueDate });
}

async function applyBulkClearDueDate() {
  await runBulkTaskAction('bulkSetTaskDueDate', { dueDate: null });
}

async function applyBulkAddLabel() {
  const input = document.getElementById('bulk-label-input');
  const label = input ? input.value.trim() : '';
  if (!label) { showToast('Chưa nhập nhãn.', 'error'); return; }
  const result = await runBulkTaskAction('bulkAddTaskLabel', { label });
  if (result && input) input.value = '';
}

async function applyBulkStatusChange() {
  const statusSel = document.getElementById('bulk-status-select');
  const status = statusSel ? statusSel.value : null;
  const ids = Array.from(bulkSelectedIds);
  if (!status || ids.length === 0) return;

  try {
    const response = await callGAS('bulkUpdateTaskStatus', { taskIds: ids, status, projectId: currentTaskProjectID, groupKey: activeGroup });
    if (response.status !== 'success') throw new Error(response.message);
    showToast(response.data || response.message, 'success');
    bulkSelectedIds.clear();

    const changed = new Set(ids);
    (globalAllTasks || []).forEach(t => { if (changed.has(t.id)) t.status = status; });
    applyTaskFilters();
    if (typeof loadProjectOverview === 'function') loadProjectOverview({ quiet: true });
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function applyBulkDelete() {
  const ids = Array.from(bulkSelectedIds);
  if (ids.length === 0) return;

  Swal.fire({
    title: `Xóa ${ids.length} công việc?`,
    text: 'Hành động này sẽ đưa các công việc đã chọn vào thùng rác.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Xóa',
    cancelButtonText: 'Hủy'
  }).then(async (result) => {
    if (!result.isConfirmed) return;
    try {
      const response = await callGAS('bulkDeleteTasks', { taskIds: ids, projectId: currentTaskProjectID, groupKey: activeGroup });
      if (response.status !== 'success') throw new Error(response.message);
      showToast(response.data || response.message, 'success');
      bulkSelectedIds.clear();
      if (typeof loadTasksForProject === 'function' && currentTaskProjectID) loadTasksForProject(currentTaskProjectID, { quiet: true });
      if (typeof loadProjectOverview === 'function') loadProjectOverview({ quiet: true });
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  });
}

// -------------------- Xuất công việc ra CSV --------------------

function stamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function downloadCsv(filename, rows) {
  const csvContent = rows.map(row =>
    row.map(cell => {
      const val = (cell === null || cell === undefined) ? '' : String(cell);
      return '"' + val.replace(/"/g, '""') + '"';
    }).join(',')
  ).join('\r\n');

  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function exportTasksCsv() {
  const tasks = globalAllTasks || [];
  if (tasks.length === 0) { showToast('Không có công việc nào để xuất.', 'error'); return; }

  const rows = [['Tên công việc', 'Trạng thái', 'Ưu tiên', 'Hạn chót', 'Người thực hiện', 'Nhãn', 'Mô tả']];
  tasks.forEach(t => {
    rows.push([
      t.name, t.status || '', t.priority || '', t.dueDate || '',
      (t.assigneeNames || []).join('; ') || t.assignees || '',
      t.labels || '', t.description || ''
    ]);
  });

  downloadCsv(`cong-viec-${stamp()}.csv`, rows);
  showToast(`Đã xuất ${tasks.length} công việc.`, 'success');
}

function resetTaskModalUI() {
  const form = document.getElementById('task-form');
  if (form) form.reset();
  editingTaskExpectedVersion = null;
  document.getElementById('task-id').value = '';
  document.getElementById('new-task-parent-id').value = '';
  document.querySelectorAll('input[name="task-assignees"]').forEach(cb => cb.checked = false);
  document.querySelectorAll('input[name="task-blockers"]').forEach(cb => cb.checked = false);

  const submitBtn = document.querySelector('button[form="task-form"]');
  if (submitBtn) submitBtn.innerHTML = "Lưu Công Việc";
}

function openAddTask() {
  resetTaskModalUI();
  if (currentTaskProjectID) {
    document.getElementById('new-task-project-id').value = currentTaskProjectID;
  }
  loadBlockerCheckboxes('');
  openAppModal('add-task-modal');
}

function openEditTask(id, name, status, priority, dueDate, assigneesStr, description, parentTaskId, blockedByStr) {
  const sourceTask = (globalAllTasks || []).find(t => t.id === id);
  editingTaskExpectedVersion = sourceTask && sourceTask.version != null ? sourceTask.version : null;

  const labelsInput = document.getElementById('new-task-labels');
  if (labelsInput) labelsInput.value = sourceTask ? (sourceTask.labels || '') : '';

  document.getElementById('task-id').value = id;
  document.getElementById('new-task-name').value = name;
  document.getElementById('new-task-status').value = status;
  document.getElementById('new-task-priority').value = priority;
  document.getElementById('new-task-duedate').value = dueDate;

  loadBlockerCheckboxes(id);
  const blockerIds = (blockedByStr || '').split(',').map(x => x.trim()).filter(Boolean);
  document.querySelectorAll('input[name="task-blockers"]').forEach(cb => {
    cb.checked = blockerIds.includes(cb.value);
  });
  document.getElementById('new-task-desc').value = description || '';
  document.getElementById('new-task-parent-id').value = parentTaskId || '';

  if (currentTaskProjectID) {
    document.getElementById('new-task-project-id').value = currentTaskProjectID;
  }

  const checkboxes = document.querySelectorAll('input[name="task-assignees"]');
  const assignedEmails = (assigneesStr || '').toLowerCase().split(',').map(e => e.trim());
  checkboxes.forEach(cb => { cb.checked = assignedEmails.includes(cb.value.toLowerCase()); });

  const submitBtn = document.querySelector('button[form="task-form"]');
  if (submitBtn) submitBtn.innerHTML = "Cập nhật";

  openAppModal('add-task-modal');
}

async function handleTaskFormSubmit(e) {
  if (e) e.preventDefault();

  const submitBtn = document.querySelector('button[form="task-form"]');

  const checkboxes = document.querySelectorAll('input[name="task-assignees"]:checked');
  const selectedEmails = Array.from(checkboxes).map(cb => cb.value).join(',');

  const blockerCbs = document.querySelectorAll('input[name="task-blockers"]:checked');
  const selectedBlockers = Array.from(blockerCbs).map(cb => cb.value).join(',');

  const taskData = {
    id: document.getElementById('task-id').value,
    projectId: document.getElementById('new-task-project-id').value,
    name: document.getElementById('new-task-name').value,
    status: document.getElementById('new-task-status').value,
    priority: document.getElementById('new-task-priority').value,
    dueDate: document.getElementById('new-task-duedate').value,
    assignees: selectedEmails,
    description: document.getElementById('new-task-desc').value,
    parentTaskId: document.getElementById('new-task-parent-id').value || null,
    blockedBy: selectedBlockers,
    labels: normalizeLabels(document.getElementById('new-task-labels') ? document.getElementById('new-task-labels').value : ''),
    expectedVersion: editingTaskExpectedVersion
  };

  if (!taskData.projectId) {
    showToast("Lỗi: Không xác định được Dự án! Vui lòng chọn lại dự án.", "error");
    closeAppModal('add-task-modal');
    return;
  }

  const originalText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang lưu...'; }

  try {
    const response = await callGAS("saveTask", { ...taskData, groupKey: activeGroup });

    if (response.status === 'success') {
      showToast(response.data || response.message, "success");
      closeAppModal('add-task-modal');
      resetTaskModalUI();
      loadTasksForProject(taskData.projectId, { quiet: true });
      loadProjectOverview({ quiet: true });
    } else {
      showToast("Lỗi: " + response.message, "error");
    }
  } catch (err) {
    console.error("Lỗi submit task:", err);
    showToast("Lỗi hệ thống: " + (err.message || err), "error");
  } finally {
    if (submitBtn) { submitBtn.innerHTML = originalText; submitBtn.disabled = false; }
  }
}

function deleteTaskAction(taskId, taskName) {
  Swal.fire({
    title: 'Xóa Công Việc?',
    text: `Bạn có chắc chắn muốn xóa công việc: "${taskName}"?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Xóa liền',
    cancelButtonText: 'Nghĩ lại'
  }).then(async (result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: 'Đang xóa công việc...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      try {
        const response = await callGAS("deleteTask", {
          taskId: taskId,
          projectId: currentTaskProjectID,
          groupKey: activeGroup
        });

        if (response.status === 'success') {
          Swal.fire({
            icon: 'success',
            title: 'Thành công',
            text: response.data || response.message,
            timer: 1500,
            showConfirmButton: false
          });

          if (currentTaskProjectID) {
            loadTasksForProject(currentTaskProjectID, { quiet: true });
            loadProjectOverview({ quiet: true });
          }
        } else {
          Swal.fire('Lỗi!', "Không thể xóa: " + response.message, 'error');
        }
      } catch (err) {
        console.error("Lỗi xóa task:", err);
        Swal.fire('Lỗi!', "Lỗi kết nối: " + (err.message || err), 'error');
      }
    }
  });
}

// --- Helper: badge / màu / hạn chót ---
// renderBadge/getDueDateBadge dùng lại .status-pill .pill-* sẵn có của app này thay vì
// port thêm bộ class .status-badge/.bg-done/.bg-critical... riêng của app nguồn.

function renderBadge(type, value) {
  let cls = 'pill-neutral';
  if (type === 'status') {
    if (value === 'Done') cls = 'pill-success';
    else if (value === 'Working on it') cls = 'pill-warning';
    else if (value === 'Stuck') cls = 'pill-danger';
    else cls = 'pill-neutral';
  } else if (type === 'priority') {
    if (value === 'Critical') cls = 'pill-danger';
    else if (value === 'High') cls = 'pill-warning';
    else if (value === 'Medium') cls = 'pill-info';
    else cls = 'pill-neutral';
  }
  return `<span class="status-pill ${cls}">${escapeHtml(value || '')}</span>`;
}

function getStatusColor(status) {
  if (status === 'Done') return '#00c875';
  if (status === 'Working on it') return '#fdab3d';
  if (status === 'Stuck') return '#e2445c';
  return '#c4c4c4';
}

// Badge cảnh báo hạn task: đỏ nếu đã quá hạn, vàng nếu còn <=2 ngày. Ẩn khi task đã Done.
function getDueDateBadge(dueDate, status) {
  if (!dueDate || status === 'Done') return '';
  const due = new Date(dueDate + 'T00:00:00');
  if (isNaN(due.getTime())) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return `<span class="status-pill pill-danger" style="margin-left:6px;"><i class="fa-solid fa-triangle-exclamation"></i> Quá hạn</span>`;
  if (diffDays <= 2) return `<span class="status-pill pill-warning" style="margin-left:6px;"><i class="fa-regular fa-clock"></i> Sắp đến hạn</span>`;
  return '';
}

// --- Nhãn công việc ---
function normalizeLabels(raw) {
  const seen = new Set();
  const out = [];
  String(raw || '').split(',').forEach(part => {
    const label = part.trim();
    if (!label) return;
    const key = label.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(label);
  });
  return out.join(', ');
}

function parseLabels(value) {
  return String(value || '').split(',').map(x => x.trim()).filter(Boolean);
}

// Màu chip suy ra từ chính tên nhãn để cùng một nhãn luôn có cùng màu ở mọi nơi
function labelHue(label) {
  let hash = 0;
  const s = String(label).toLowerCase();
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) % 360;
  return hash;
}

function populateLabelFilter() {
  const select = document.getElementById('filter-label');
  if (!select) return;

  const prevVal = select.value;
  const seen = new Set();
  const labels = [];
  (globalAllTasks || []).forEach(t => {
    parseLabels(t.labels).forEach(l => {
      const key = l.toLowerCase();
      if (!seen.has(key)) { seen.add(key); labels.push(l); }
    });
  });
  labels.sort((a, b) => a.localeCompare(b, 'vi'));

  select.innerHTML = '<option value="all">Tất cả nhãn</option>' +
    labels.map(l => `<option value="${escapeHtml(l.toLowerCase())}">${escapeHtml(l)}</option>`).join('');

  if (labels.some(l => l.toLowerCase() === prevVal)) select.value = prevVal;
}

function renderLabelChips(labelsValue) {
  const labels = parseLabels(labelsValue);
  if (labels.length === 0) return '';
  return labels.map(l => {
    const hue = labelHue(l);
    return `<span class="task-label-chip" style="--label-hue:${hue};">${escapeHtml(l)}</span>`;
  }).join('');
}

// --- Phụ thuộc công việc (dependency / "bị chặn bởi") ---
// Badge "Bị chặn": hiện khi task còn công việc phụ thuộc (blocked_by) chưa Done
function getBlockedBadge(task) {
  if (!task.blocked_by) return '';
  const blockerIds = String(task.blocked_by).split(',').map(x => x.trim()).filter(Boolean);
  if (blockerIds.length === 0) return '';
  const unfinished = blockerIds
    .map(id => (globalAllTasks || []).find(t => t.id === id))
    .filter(b => b && String(b.status).toLowerCase() !== 'done');
  if (unfinished.length === 0) return '';
  const names = unfinished.map(b => escapeHtml(b.name)).join(', ');
  return `<span class="blocked-badge" title="Bị chặn bởi: ${names}"><i class="fa-solid fa-lock"></i> Bị chặn</span>`;
}

// Badge tiến độ checklist, ví dụ "3/5" — chỉ hiện khi task có checklist
function getChecklistBadge(task) {
  const list = Array.isArray(task.checklist) ? task.checklist : [];
  if (list.length === 0) return '';
  const done = list.filter(x => x && x.done).length;
  const allDone = done === list.length;
  return `<span class="checklist-badge${allDone ? ' is-complete' : ''}" title="Danh sách kiểm: ${done}/${list.length} xong"><i class="fa-regular fa-square-check"></i> ${done}/${list.length}</span>`;
}

let blockersExpanded = false;
function showBlockerCheckboxes() {
  const box = document.getElementById('blocker-checkboxes');
  if (!box) return;
  blockersExpanded = !blockersExpanded;
  box.style.display = blockersExpanded ? 'block' : 'none';
}

// Đổ checkbox chọn "công việc chặn" từ các task khác đang có trong bộ nhớ (loại trừ chính task đang sửa)
function loadBlockerCheckboxes(excludeTaskId) {
  const container = document.getElementById('blocker-checkboxes');
  if (!container) return;
  const tasks = (globalAllTasks || []).filter(t => t.id !== excludeTaskId);

  if (tasks.length === 0) {
    container.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có công việc nào khác trong dự án.</div>';
    return;
  }

  container.innerHTML = '';
  tasks.forEach(t => {
    const label = document.createElement('label');
    label.style.display = 'block';
    label.style.padding = '5px 10px';
    label.style.cursor = 'pointer';
    label.onmouseover = function () { this.style.backgroundColor = 'var(--hover-bg)'; };
    label.onmouseout = function () { this.style.backgroundColor = 'transparent'; };
    label.innerHTML = `<input type="checkbox" name="task-blockers" value="${escapeHtml(t.id)}" style="margin-right:8px;"> ${escapeHtml(t.name)}`;
    container.appendChild(label);
  });
}

// --- Danh sách chọn người thực hiện (dùng chung cho modal Task & modal Event) ---
async function loadMemberCheckboxes() {
  const container = document.getElementById('checkboxes');
  if (!container) return;

  container.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';

  try {
    const response = await callGAS("getAllUsers", { groupKey: activeGroup });

    if (response.status === 'success') {
      const users = response.data;
      container.innerHTML = '';

      if (!users || users.length === 0) {
        container.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có thành viên.</div>';
        return;
      }

      users.forEach(u => {
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" name="task-assignees" value="${escapeHtml(u.email)}" /> ${escapeHtml(u.name)}`;
        container.appendChild(label);
      });
    } else {
      container.innerHTML = `<div style="padding:8px; color:var(--danger-color); font-size:12.5px;">Lỗi: ${response.message}</div>`;
    }
  } catch (err) {
    console.error("Lỗi tải thành viên:", err);
    container.innerHTML = '<div style="padding:8px; color:var(--danger-color); font-size:12.5px;">Lỗi kết nối server!</div>';
  }
}

function showCheckboxes() {
  const checkboxes = document.getElementById("checkboxes");
  if (!checkboxes) return;
  expanded = !expanded;
  checkboxes.style.display = expanded ? "block" : "none";
}

async function loadAssigneeDropdown() {
  const assigneeSelect = document.getElementById('filter-assignee');
  if (!assigneeSelect) return;

  try {
    const response = await callGAS("getAllUsers", { groupKey: activeGroup });

    if (response.status === 'success') {
      const members = response.data;
      const prevAssignee = assigneeSelect.value;

      assigneeSelect.innerHTML = '<option value="all">Tất cả thành viên</option>';

      if (members && members.length > 0) {
        members.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.email.toLowerCase().trim();
          opt.textContent = m.name;
          assigneeSelect.appendChild(opt);
        });
      }

      if (prevAssignee && [...assigneeSelect.options].some(o => o.value === prevAssignee)) {
        assigneeSelect.value = prevAssignee;
      }
    } else {
      console.error("Lỗi tải assignee filter:", response.message);
    }
  } catch (err) {
    console.error("Lỗi kết nối assignee filter:", err);
  }
}

// --- Ghi nhớ ngữ cảnh bộ lọc Task (bản rút gọn — không có view-mode vì không có kanban/card) ---
function taskViewStateKey() {
  const email = (CURRENT_USER.email || 'anon').toLowerCase();
  return `wh_task_view_${activeGroup}_${email}`;
}

function saveTaskViewState() {
  try {
    const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
    localStorage.setItem(taskViewStateKey(), JSON.stringify({
      projectId: currentTaskProjectID || '',
      name: val('filter-task-name'),
      status: val('filter-status'),
      priority: val('filter-priority'),
      assignee: val('filter-assignee'),
      label: val('filter-label')
    }));
  } catch (e) {
    // localStorage đầy hoặc bị chặn: bỏ qua, đây chỉ là tiện ích chứ không phải chức năng lõi
  }
}

function restoreSavedTaskProject(taskDropdown) {
  let state = null;
  try {
    const raw = localStorage.getItem(taskViewStateKey());
    state = raw ? JSON.parse(raw) : null;
  } catch (e) { return; }
  if (!state) return;

  pendingTaskFilterRestore = state;

  if (taskDropdown && state.projectId &&
    Array.from(taskDropdown.options).some(o => o.value === state.projectId)) {
    taskDropdown.value = state.projectId;
    loadTasksForProject(state.projectId);
  }
}

function applyPendingTaskFilterRestore() {
  if (!pendingTaskFilterRestore) return;
  const state = pendingTaskFilterRestore;
  pendingTaskFilterRestore = null;

  const set = (id, saved) => {
    const el = document.getElementById(id);
    if (!el || !saved) return;
    if (Array.from(el.options).some(o => o.value === saved)) el.value = saved;
  };
  set('filter-task-name', state.name);
  set('filter-status', state.status);
  set('filter-priority', state.priority);
  set('filter-assignee', state.assignee);
  set('filter-label', state.label);
}

function applyTaskFilters() {
  const nameInput = document.getElementById('filter-task-name');
  const statusInput = document.getElementById('filter-status');
  const priorityInput = document.getElementById('filter-priority');
  const assigneeInput = document.getElementById('filter-assignee');
  const labelInput = document.getElementById('filter-label');

  const nameVal = nameInput ? nameInput.value.toLowerCase() : '';
  const statusVal = statusInput ? statusInput.value : 'all';
  const priorityVal = priorityInput ? priorityInput.value : 'all';
  const assigneeVal = assigneeInput ? assigneeInput.value.toLowerCase() : 'all';
  const labelVal = labelInput ? labelInput.value.toLowerCase() : 'all';

  if (!globalAllTasks) globalAllTasks = [];

  const filteredTasks = globalAllTasks.filter(t => {
    const matchName = t.name.toLowerCase().includes(nameVal);
    const matchStatus = (statusVal === 'all') || (t.status === statusVal);
    const matchPriority = (priorityVal === 'all') || (t.priority === priorityVal);
    const assigneeList = t.assignees ? t.assignees.toLowerCase().split(',').map(e => e.trim()) : [];
    const matchAssignee = (assigneeVal === 'all') || assigneeList.includes(assigneeVal);
    const taskLabels = parseLabels(t.labels).map(l => l.toLowerCase());
    const matchLabel = (labelVal === 'all') || taskLabels.includes(labelVal);
    return matchName && matchStatus && matchPriority && matchAssignee && matchLabel;
  });

  renderTasks(filteredTasks);
  saveTaskViewState();
}

function onProjectChange() {
  const select = document.getElementById('task-project-select');
  const projectId = select.value;
  loadTasksForProject(projectId);
}

// ==========================================
// 9. CALENDAR MODULE ("Lịch")
// ==========================================
// Dashboard mini-widget (renderDashboardCalendar) KHÔNG port — app này không có tab
// Dashboard riêng biệt với view Pipeline.

async function loadCalendarData(options) {
  const quiet = !!(options && options.quiet);
  const calendarToggle = document.getElementById('calendar-toggle');
  if (calendarToggle) currentCalendarType = calendarToggle.value;

  renderCalendarGrid(currentCalendarDate);
  updateSelectedDateHeader();

  const listContainer = document.getElementById('today-event-list');
  if (!quiet && listContainer) listContainer.innerHTML = skeletonListItems(3);

  const year = currentCalendarDate.getFullYear();
  const month = currentCalendarDate.getMonth();
  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0, 23, 59, 59);

  try {
    const response = await callGAS('getEvents', {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      calendarType: currentCalendarType,
      groupKey: activeGroup,
      email: CURRENT_USER.email || null
    });

    if (response.status === 'success') {
      currentMonthEvents = response.data || [];
      renderEventDots();
      renderEventsForSelectedDate();
      renderDashboardCalendar(currentMonthEvents);
    } else {
      handleCalendarError(new Error(response.message));
    }
  } catch (error) {
    handleCalendarError(error);
  }
}

function renderCalendarGrid(date) {
  const container = document.getElementById('full-calendar-display');
  if (!container) return;

  const year = date.getFullYear();
  const month = date.getMonth();
  const monthNames = ["Tháng 1", "Tháng 2", "Tháng 3", "Tháng 4", "Tháng 5", "Tháng 6", "Tháng 7", "Tháng 8", "Tháng 9", "Tháng 10", "Tháng 11", "Tháng 12"];

  let html = `
    <div class="calendar-header">
        <button class="btn-nav-month" onclick="changeMonth(-1)"><i class="fa-solid fa-chevron-left"></i></button>
        <h2>${monthNames[month]} ${year}</h2>
        <button class="btn-nav-month" onclick="changeMonth(1)"><i class="fa-solid fa-chevron-right"></i></button>
    </div>
    <div class="calendar-grid">
        <div class="calendar-day-name">CN</div>
        <div class="calendar-day-name">T2</div>
        <div class="calendar-day-name">T3</div>
        <div class="calendar-day-name">T4</div>
        <div class="calendar-day-name">T5</div>
        <div class="calendar-day-name">T6</div>
        <div class="calendar-day-name">T7</div>
  `;

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  for (let i = 0; i < firstDay; i++) {
    html += `<div class="calendar-day other-month"></div>`;
  }

  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    let isToday = (day === today.getDate() && month === today.getMonth() && year === today.getFullYear()) ? 'today' : '';
    let isSelected = (day === selectedDate.getDate() && month === selectedDate.getMonth() && year === selectedDate.getFullYear()) ? 'selected' : '';
    let dateId = `day-${year}-${month}-${day}`;

    html += `
        <div class="calendar-day ${isToday} ${isSelected}" id="${dateId}" onclick="selectDate(${year}, ${month}, ${day})">
            <span>${day}</span>
            <div class="event-dot"></div>
        </div>
    `;
  }
  html += `</div>`;
  container.innerHTML = html;
}

function renderEventDots() {
  if (!currentMonthEvents || currentMonthEvents.length === 0) return;

  currentMonthEvents.forEach(event => {
    const d = new Date(event.startTime);
    if (d.getMonth() === currentCalendarDate.getMonth() && d.getFullYear() === currentCalendarDate.getFullYear()) {
      const dayId = `day-${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      const dayEl = document.getElementById(dayId);
      if (dayEl) dayEl.classList.add('has-event');
    }
  });
}

window.selectDate = function (year, month, day) {
  selectedDate = new Date(year, month, day);

  const oldSelected = document.querySelector('.calendar-day.selected');
  if (oldSelected) oldSelected.classList.remove('selected');

  const newSelected = document.getElementById(`day-${year}-${month}-${day}`);
  if (newSelected) newSelected.classList.add('selected');

  updateSelectedDateHeader();
  renderEventsForSelectedDate();
};

window.changeMonth = function (step) {
  currentCalendarDate.setMonth(currentCalendarDate.getMonth() + step);
  loadCalendarData();
};

function updateSelectedDateHeader() {
  const widgetTitle = document.querySelector('.today-events-widget h3');
  if (widgetTitle) {
    const dateStr = selectedDate.toLocaleDateString('vi-VN', { weekday: 'long', day: '2-digit', month: '2-digit' });
    widgetTitle.textContent = dateStr;
  }
}

function renderEventsForSelectedDate() {
  const listContainer = document.getElementById('today-event-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';
  selectedEventId = null;

  const dailyEvents = currentMonthEvents.filter(e => {
    const d = new Date(e.startTime);
    return d.getDate() === selectedDate.getDate() &&
      d.getMonth() === selectedDate.getMonth() &&
      d.getFullYear() === selectedDate.getFullYear();
  });

  dailyEvents.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  if (dailyEvents.length === 0) {
    listContainer.innerHTML = '<p style="color:var(--text-muted); text-align:center; margin-top:12px;">Không có sự kiện nào.</p>';
    if (manageEventBtn) manageEventBtn.disabled = true;
    return;
  }

  dailyEvents.forEach(event => {
    // Task có due_date được gộp vào lịch dưới dạng mục riêng (nếu backend trả về) — render
    // khác hẳn sự kiện thật; goToTaskInProject không được port nên chỉ no-op nếu thiếu.
    if (event.type === 'task') {
      const taskDiv = document.createElement('div');
      taskDiv.className = 'event-item task-event-item';
      taskDiv.innerHTML =
        '<div class="event-title"><i class="fa-solid fa-list-check" style="margin-right:6px;"></i>' + escapeHtml(event.title) + '</div>' +
        '<div style="font-size:12px; color:var(--text-muted); margin-bottom:6px;"><i class="fa-solid fa-diagram-project" style="margin-right:6px;"></i>' + escapeHtml(event.projectName || '') + '</div>' +
        '<div class="event-meta">' + (typeof renderBadge === 'function' ? renderBadge('status', event.status) : escapeHtml(event.status || '')) + '</div>';
      taskDiv.addEventListener('click', () => {
        if (typeof goToTaskInProject === 'function') goToTaskInProject(event.projectId);
      });
      listContainer.appendChild(taskDiv);
      return;
    }

    const timeStr = new Date(event.startTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const endTimeStr = new Date(event.endTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const isImportant = event.isImportant ? 'important' : '';

    const div = document.createElement('div');
    div.className = `event-item ${isImportant}`;
    div.setAttribute('data-id', event.id);
    div.setAttribute('data-important', event.isImportant);

    const recurrenceLabel = { daily: 'Lặp hằng ngày', weekly: 'Lặp hằng tuần', monthly: 'Lặp hằng tháng' }[event.recurrence];
    const attendeeCount = (event.attendees || '').split(',').map(x => x.trim()).filter(Boolean).length;

    div.innerHTML =
      '<div class="event-time">' + timeStr + ' - ' + endTimeStr + '</div>' +
      '<div class="event-title">' + escapeHtml(event.title) + (recurrenceLabel ? ' <i class="fa-solid fa-rotate" style="color:var(--text-muted); font-size:0.75em;" title="' + recurrenceLabel + '"></i>' : '') + '</div>' +
      (event.description ? '<div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 5px; font-style: italic;">' + escapeHtml(event.description) + '</div>' : '') +
      '<div class="event-meta">' +
      (event.location ? '<span><i class="fa-solid fa-location-dot"></i> ' + escapeHtml(event.location) + '</span>' : '') +
      (attendeeCount > 0 ? '<span><i class="fa-solid fa-user-group"></i> ' + attendeeCount + '</span>' : '') +
      '</div>' +
      '<button class="btn-edit-event-mini" title="Sửa" onclick="openEditEvent(\'' + event.id + '\', event)">' +
      '<i class="fa-solid fa-pen"></i>' +
      '</button>' +
      '<button class="btn-delete-event-mini" title="Xóa" onclick="quickDeleteEvent(\'' + event.id + '\', \'' + escapeJs(event.title) + '\', event)">' +
      '<i class="fa-solid fa-trash"></i>' +
      '</button>';

    div.addEventListener('click', () => {
      document.querySelectorAll('.event-item').forEach(el => el.style.borderRight = 'none');
      div.style.borderRight = '4px solid var(--gold)';
      selectedEventId = event.id;

      if (manageEventBtn) {
        manageEventBtn.disabled = false;
        manageEventBtn.innerHTML = event.isImportant
          ? '<i class="fa-solid fa-star-half"></i> Bỏ quan trọng'
          : '<i class="fa-solid fa-star"></i> Đánh dấu quan trọng';
      }
    });

    listContainer.appendChild(div);
  });
}

function toggleRecurrenceEndVisibility() {
  const sel = document.getElementById('event-recurrence');
  const group = document.getElementById('recurrence-end-group');
  if (!sel || !group) return;
  group.style.display = sel.value === 'none' ? 'none' : 'block';
}

function showEventAttendeeCheckboxes() {
  const box = document.getElementById('event-attendee-checkboxes');
  if (!box) return;
  eventAttendeesExpanded = !eventAttendeesExpanded;
  box.style.display = eventAttendeesExpanded ? 'block' : 'none';
}

async function loadEventAttendeeCheckboxes() {
  const container = document.getElementById('event-attendee-checkboxes');
  if (!container) return;
  container.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';

  try {
    const response = await callGAS("getAllUsers", { groupKey: activeGroup });
    if (response.status === 'success') {
      const users = response.data;
      container.innerHTML = '';

      if (!users || users.length === 0) {
        container.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có thành viên.</div>';
        return;
      }

      users.forEach(u => {
        const label = document.createElement('label');
        label.innerHTML = `<input type="checkbox" name="event-attendees" value="${escapeHtml(u.email)}" /> ${escapeHtml(u.name)}`;
        container.appendChild(label);
      });
    } else {
      container.innerHTML = `<div style="padding:8px; color:var(--danger-color); font-size:12.5px;">Lỗi: ${response.message}</div>`;
    }
  } catch (err) {
    console.error("Lỗi tải danh sách mời:", err);
    container.innerHTML = '<div style="padding:8px; color:var(--danger-color); font-size:12.5px;">Lỗi kết nối server!</div>';
  }
}

function resetEventModalUI() {
  document.getElementById('event-id').value = '';

  const modalTitle = document.getElementById('event-modal-title');
  if (modalTitle && eventModalDefaultTitleHTML !== null) modalTitle.innerHTML = eventModalDefaultTitleHTML;

  const submitBtn = document.querySelector('button[form="event-form"]');
  if (submitBtn && eventModalDefaultSubmitHTML !== null) submitBtn.innerHTML = eventModalDefaultSubmitHTML;

  document.querySelectorAll('input[name="event-attendees"]').forEach(cb => cb.checked = false);
  toggleRecurrenceEndVisibility();
}

window.openEditEvent = function (id, e) {
  if (e && e.stopPropagation) e.stopPropagation();

  const event = (currentMonthEvents || []).find(ev => ev.id === id);
  if (!event) return;

  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const pad = n => String(n).padStart(2, '0');
  const toDateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const toTimeStr = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

  document.getElementById('event-id').value = event.id;
  document.getElementById('event-title').value = event.title || '';
  document.getElementById('start-date').value = toDateStr(start);
  document.getElementById('start-time').value = toTimeStr(start);
  document.getElementById('end-date').value = toDateStr(end);
  document.getElementById('end-time').value = toTimeStr(end);
  document.getElementById('location').value = event.location || '';
  document.getElementById('description').value = event.description || '';

  const recurrenceSel = document.getElementById('event-recurrence');
  if (recurrenceSel) recurrenceSel.value = event.recurrence || 'none';
  const recurrenceEndInput = document.getElementById('event-recurrence-end');
  if (recurrenceEndInput) recurrenceEndInput.value = event.recurrenceEnd || '';
  toggleRecurrenceEndVisibility();

  const attendeeEmails = (event.attendees || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  document.querySelectorAll('input[name="event-attendees"]').forEach(cb => {
    cb.checked = attendeeEmails.includes(cb.value.toLowerCase());
  });

  const modalTitle = document.getElementById('event-modal-title');
  if (modalTitle) modalTitle.innerHTML = '<i class="fa-solid fa-pen" style="margin-right:8px; color: var(--gold);"></i> Sửa Sự Kiện';

  const submitBtn = document.querySelector('button[form="event-form"]');
  if (submitBtn) submitBtn.innerHTML = 'Cập Nhật';

  openAppModal('add-event-modal');
};

window.quickDeleteEvent = function (id, title, e) {
  if (e && e.stopPropagation) e.stopPropagation();

  Swal.fire({
    title: 'Xóa nhanh?',
    text: `Bạn muốn xóa sự kiện "${title}" ngay lập tức?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Xóa luôn',
    cancelButtonText: 'Nghĩ lại'
  }).then(async (result) => {
    if (result.isConfirmed) {
      Swal.fire({
        title: 'Đang xóa...',
        allowOutsideClick: false,
        didOpen: () => Swal.showLoading()
      });

      try {
        const response = await callGAS('deleteEvent', {
          eventId: id,
          calendarType: currentCalendarType,
          groupKey: activeGroup,
          email: CURRENT_USER.email || null
        });

        if (response.status !== 'success') {
          throw new Error(response.message || "Xóa thất bại từ phía Server");
        }

        Swal.fire({
          icon: 'success',
          title: 'Đã xóa!',
          text: response.message,
          showConfirmButton: false,
          timer: 1000
        });

        loadCalendarData({ quiet: true });

        if (selectedEventId === id) {
          selectedEventId = null;
        }
      } catch (err) {
        Swal.fire('Lỗi!', err.message || err, 'error');
      }
    }
  });
};

function handleCalendarError(error) {
  console.error(error);
  showToast('Lỗi lịch: ' + (error && error.message ? error.message : error), 'error');
}

// --- Handlers cho modal Thêm/Sửa sự kiện + nút Quản Lý Sự Kiện ---
// Tách thành hàm riêng (thay vì inline trong DOMContentLoaded như app nguồn) vì luồng
// init của app này đơn giản hơn — xem gọi ở cuối file (mục 6. INITIALIZATION).

function handleAddEventClick() {
  const form = document.getElementById('event-form');
  if (form) form.reset();
  resetEventModalUI();
  openAppModal('add-event-modal');
}

function handleCalendarToggleChange() {
  const calendarToggle = document.getElementById('calendar-toggle');
  currentCalendarType = calendarToggle ? calendarToggle.value : 'group';
  loadCalendarData();
}

async function handleEventFormSubmit(e) {
  if (e) e.preventDefault();
  const form = document.getElementById('event-form');
  if (!form) return;

  const submitBtn = document.getElementById('event-form-submit-btn');
  const formData = new FormData(form);
  const eventData = {};
  for (const [key, value] of formData.entries()) eventData[key] = value;

  const attendeeCbs = document.querySelectorAll('input[name="event-attendees"]:checked');
  eventData.attendees = Array.from(attendeeCbs).map(cb => cb.value).join(',');

  if (!eventData.title || !eventData.startDate || !eventData.startTime || !eventData.endDate || !eventData.endTime) {
    showToast("Vui lòng điền đầy đủ thông tin!", "error");
    return;
  }

  const startObj = new Date(`${eventData.startDate}T${eventData.startTime}`);
  const endObj = new Date(`${eventData.endDate}T${eventData.endTime}`);
  if (endObj <= startObj) {
    showToast("Thời gian kết thúc phải sau thời gian bắt đầu!", "warning");
    return;
  }

  const editingId = document.getElementById('event-id').value;
  const isEditing = !!editingId;

  const originalBtnText = submitBtn ? submitBtn.innerHTML : '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> ' + (isEditing ? 'Đang cập nhật...' : 'Đang tạo...');
  }

  try {
    const response = await callGAS(isEditing ? 'updateEvent' : 'createEvent', {
      ...eventData,
      eventId: editingId,
      calendarType: currentCalendarType,
      groupKey: activeGroup,
      email: CURRENT_USER.email || null
    });

    if (response.status !== 'success') throw new Error(response.message || 'Không thể lưu sự kiện.');

    showToast(response.data || response.message, "success");
    logPipelineEvent(`${isEditing ? 'Cập nhật' : 'Tạo'} sự kiện lịch: ${eventData.title}`, 'success', 'CALENDAR_EVENT');
    closeAppModal('add-event-modal');
    form.reset();
    resetEventModalUI();
    loadCalendarData({ quiet: true });

  } catch (error) {
    showToast("Lỗi: " + (error.message || error), "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnText || (isEditing ? 'Cập Nhật' : 'Tạo Sự Kiện');
    }
  }
}

async function handleToggleImportantClick() {
  if (!selectedEventId) { showToast("Vui lòng chọn sự kiện trước!", "error"); return; }

  const selectedItem = todayEventList ? todayEventList.querySelector(`[data-id="${selectedEventId}"]`) : null;
  if (!selectedItem) return;

  const isCurrentlyImportant = selectedItem.getAttribute('data-important') === 'true';
  const newImportant = !isCurrentlyImportant;

  const originalBtnText = manageEventBtn ? manageEventBtn.innerHTML : '';
  if (manageEventBtn) {
    manageEventBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang xử lý...';
    manageEventBtn.disabled = true;
  }

  try {
    const response = await callGAS('toggleImportant', {
      eventId: selectedEventId,
      isImportant: newImportant,
      calendarType: currentCalendarType,
      groupKey: activeGroup,
      email: CURRENT_USER.email || null
    });

    if (response.status !== 'success') throw new Error(response.message);

    showToast(response.data || response.message, "success");
    loadCalendarData({ quiet: true });

  } catch (err) {
    showToast("Lỗi: " + (err.message || err), "error");
  } finally {
    if (manageEventBtn) {
      manageEventBtn.innerHTML = originalBtnText || '<i class="fa-solid fa-pen-to-square"></i> Quản Lý Sự Kiện';
      manageEventBtn.disabled = false;
    }
  }
}

// ==========================================
// 5.5 DRIVE / UPLOAD FILE MODULE (ported từ WorkHub org)
// ==========================================

function handleUploadSuccess(message) {
  const uploadStatus = document.getElementById('upload-status');
  const submitUploadBtn = document.getElementById('submit-upload-btn');
  const fileNameDisplay = document.getElementById('file-name-display');
  const descriptionTextarea = document.querySelector('#upload-file-form textarea[name="description"]');

  if (uploadStatus) {
    uploadStatus.className = 'status-message success-message';
    let content = message;
    if (typeof message === 'object' && message !== null) {
      content = message.message || message.data || JSON.stringify(message);
    }
    uploadStatus.textContent = content;
  }

  if (submitUploadBtn) {
    submitUploadBtn.disabled = false;
    submitUploadBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Tải Lên Drive';
  }

  if (descriptionTextarea) descriptionTextarea.value = '';

  const fileInput = document.getElementById('file-input');
  if (fileInput) fileInput.value = '';
  if (fileNameDisplay) fileNameDisplay.textContent = ' (Chưa có file nào)';

  loadFileList(false, { quiet: true });
}

function handleUploadFailure(error) {
  const uploadStatus = document.getElementById('upload-status');
  const submitUploadBtn = document.getElementById('submit-upload-btn');

  let errorMsg = error;
  if (typeof error === 'object' && error !== null) {
    errorMsg = error.message || error.error || error.data || JSON.stringify(error);
  }

  if (uploadStatus) {
    uploadStatus.className = 'status-message error-message';
    uploadStatus.textContent = 'Lỗi tải lên: ' + errorMsg;
  }

  if (submitUploadBtn) {
    submitUploadBtn.disabled = false;
    submitUploadBtn.innerHTML = '<i class="fa-solid fa-upload"></i> Tải Lên Drive';
  }
}

function populateUploaderFilter(fileData) {
  const filterUploader = document.getElementById('filter-uploader');
  if (!filterUploader) return;

  const uploaderEmails = new Set();
  if (Array.isArray(fileData)) {
    fileData.forEach(file => {
      if (file.uploader) uploaderEmails.add(file.uploader);
    });
  }

  const prevUploader = filterUploader.value;

  filterUploader.innerHTML = '<option value="">Tất cả Người Tải</option>';
  uploaderEmails.forEach(email => {
    const option = document.createElement('option');
    option.value = email;
    option.textContent = email.split('@')[0];
    filterUploader.appendChild(option);
  });

  // Giữ lại lựa chọn cũ để bộ lọc không tự reset sau mỗi lần tải lại
  if (prevUploader && uploaderEmails.has(prevUploader)) filterUploader.value = prevUploader;
}

// quiet = true: tải lại sau khi upload/xóa/chia sẻ một file, không xóa trắng bảng ra
// placeholder — cùng mẫu đã dùng cho Task và Progress. Lưu ý: API.file.list hiện chỉ lọc
// theo groupKey ở server, các filter còn lại (tên/loại/người tải/ngày/sắp xếp) chưa được
// Supabase backend áp dụng — giữ nguyên hành vi hiện có của api.js, không tự ý mở rộng.
async function loadFileList(isFiltering = false, options) {
  const quiet = !!(options && options.quiet);
  const fileTableBody = document.querySelector('#file-table tbody');
  if (!fileTableBody) return;

  const searchInput = document.getElementById('search-name');
  const filterSelect = document.getElementById('filter-type');
  const filterUploaderSelect = document.getElementById('filter-uploader');
  const filterDateInput = document.getElementById('filter-date');
  const filterSortSelect = document.getElementById('filter-sort');

  const filters = {
    searchName: searchInput ? searchInput.value : '',
    mimeType: filterSelect ? filterSelect.value : '',
    uploader: filterUploaderSelect ? filterUploaderSelect.value : '',
    date: filterDateInput ? filterDateInput.value : '',
    sortBy: filterSortSelect ? filterSortSelect.value : 'date_desc'
  };

  if (!quiet) {
    fileTableBody.innerHTML = skeletonTableRows(7, 6);
  }

  try {
    const fileData = await API.file.list(CURRENT_USER.groupKey, filters);

    if (!isFiltering) populateUploaderFilter(fileData);

    renderFileTable(fileData);
    renderFileStats(fileData);

  } catch (error) {
    console.error("Lỗi tải file:", error);
    if (!quiet) {
      handleFileLoadFailure(error);
    } else {
      showToast("Lỗi kết nối: " + (error.message || error), "error");
    }
  }
}

function renderFileTable(fileData) {
  const fileTableBody = document.querySelector('#file-table tbody');
  const fileTableHeadRow = document.querySelector('#file-table thead tr');

  if (!fileTableBody || !fileTableHeadRow) return;

  fileTableBody.innerHTML = '';

  const showGroupCol = CURRENT_USER.groupKey === 'all' || CURRENT_USER.groupKey === 'admin';

  let headerHTML = '<th>Tên File</th><th>Đường dẫn</th><th>Mô tả</th>';
  if (showGroupCol) headerHTML += '<th style="text-align:center;">Nhóm</th>';
  headerHTML += '<th>Người Tải</th><th>Ngày Tải</th><th style="text-align:center;">Xem</th>';
  if (!showGroupCol) headerHTML += '<th style="text-align:center;">Share</th>';
  headerHTML += '<th style="text-align:center;">Xóa</th>';

  fileTableHeadRow.innerHTML = headerHTML;

  if (!fileData || fileData.length === 0) {
    const colCount = fileTableHeadRow.children.length;
    fileTableBody.innerHTML = `<tr><td colspan="${colCount}" class="empty-state">Không tìm thấy tài liệu nào phù hợp.</td></tr>`;
    return;
  }

  fileData.forEach(file => {
    const row = fileTableBody.insertRow();

    row.insertCell().textContent = file.name;
    row.insertCell().textContent = file.folderPath || '/';
    row.insertCell().textContent = file.description || '';

    if (showGroupCol) {
      const groupCell = row.insertCell();
      groupCell.style.textAlign = 'center';
      groupCell.innerHTML = `<span class="status-pill pill-info">${escapeHtml(file.groupKey || 'finance')}</span>`;
    }

    row.insertCell().textContent = (file.uploader || 'Unknown').split('@')[0];
    row.insertCell().textContent = file.date;

    const viewCell = row.insertCell();
    viewCell.style.textAlign = 'center';
    const viewLink = document.createElement('a');
    viewLink.href = file.url;
    viewLink.target = '_blank';
    viewLink.title = 'Xem file';
    viewLink.innerHTML = '<i class="fa-solid fa-eye"></i>';
    viewCell.appendChild(viewLink);

    if (!showGroupCol) {
      const shareCell = row.insertCell();
      shareCell.style.textAlign = 'center';

      const shareBtn = document.createElement('button');
      shareBtn.className = 'icon-btn' + (file.isShared ? ' success' : '');
      shareBtn.onclick = () => shareFileAction(file.id, file.name);

      if (file.isShared) {
        shareBtn.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
        shareBtn.title = 'Đã chia sẻ. Bấm để chia sẻ lại';
      } else {
        shareBtn.innerHTML = '<i class="fa-solid fa-share-from-square"></i>';
        shareBtn.title = 'Chia sẻ ra toàn hệ thống';
      }

      shareCell.appendChild(shareBtn);
    }

    const deleteCell = row.insertCell();
    deleteCell.style.textAlign = 'center';
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'icon-btn danger';
    deleteBtn.title = 'Xóa file';
    deleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i>';
    deleteBtn.onclick = () => deleteFileAction(file.id, file.name);
    deleteCell.appendChild(deleteBtn);
  });
}

function handleFileLoadFailure(error) {
  const fileTableBody = document.querySelector('#file-table tbody');
  const fileTableHeadRow = document.querySelector('#file-table thead tr');
  if (fileTableBody) {
    let msg = error;
    if (typeof error === 'object' && error !== null) {
      msg = error.message || error.data || JSON.stringify(error);
    }
    const colCount = fileTableHeadRow ? fileTableHeadRow.children.length : 7;
    fileTableBody.innerHTML = `<tr><td colspan="${colCount}" style="color: var(--danger-color); text-align: center;">Lỗi tải dữ liệu: ${escapeHtml(msg)}</td></tr>`;
  }
  console.error('Lỗi Drive API:', error);
}

function handleDeleteSuccess(message) {
  console.log(message);
  loadFileList(false, { quiet: true });
  showToast(message);
}

function handleDeleteFailure(error) {
  console.error("Lỗi xóa file:", error);

  let msg = error;
  if (typeof error === 'object' && error !== null) {
    msg = error.message || error.data || JSON.stringify(error);
  }

  showToast("Lỗi xóa file: " + msg, 'error');
}

function deleteFileAction(fileId, fileName) {
  Swal.fire({
    title: 'Xóa File?',
    text: `Bạn có chắc muốn xóa file "${fileName}"?`,
    icon: 'warning',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Xóa',
    cancelButtonText: 'Hủy'
  }).then(async (result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: 'Đang xóa...',
      didOpen: () => Swal.showLoading()
    });

    try {
      const message = await API.file.delete(fileId, CURRENT_USER.groupKey);
      Swal.close();
      handleDeleteSuccess(message);
    } catch (err) {
      Swal.close();
      handleDeleteFailure(err);
    }
  });
}

// Dùng cho widget tổng quan (nếu có #myfiles-list-view trong DOM) — hiện app này chưa có
// dashboard widget riêng nên hàm này an toàn no-op, giữ lại để tương thích khi cần dùng sau.
function renderRecentFiles(fileData) {
  const fileView = document.getElementById('myfiles-list-view');
  if (!fileView) return;

  if (!fileData || fileData.length === 0) {
    fileView.innerHTML = '<p style="color:var(--text-secondary);">Chưa có tài liệu nào được tải lên.</p>';
    return;
  }

  let html = '<ul style="list-style: none; padding: 0;">';
  fileData.forEach(file => {
    const fileNameLower = (file.name || '').toLowerCase();

    let icon = 'fa-file';
    if (fileNameLower.endsWith('.pdf')) icon = 'fa-file-pdf';
    else if (fileNameLower.endsWith('.docx')) icon = 'fa-file-word';
    else if (fileNameLower.endsWith('.xlsx')) icon = 'fa-file-excel';
    else if (fileNameLower.endsWith('.pptx')) icon = 'fa-file-powerpoint';
    else if (file.mimeType && file.mimeType.includes('image/')) icon = 'fa-file-image';
    else if (fileNameLower.endsWith('.zip') || fileNameLower.endsWith('.rar')) icon = 'fa-file-zipper';

    html += `
      <li style="display: flex; align-items: center; margin-bottom: 8px;">
        <i class="fa-solid ${icon}" style="color: var(--info-color); margin-right: 8px;"></i>
        <a href="${file.url}" target="_blank" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</a>
      </li>`;
  });
  html += '</ul>';
  fileView.innerHTML = html;
}

function renderFileStats(fileData) {
  if (!Array.isArray(fileData)) {
    console.error("Dữ liệu không phải là mảng:", fileData);
    return;
  }
  const totalFiles = fileData.length;

  const stats = fileData.reduce((acc, file) => {
    if (!file) return acc;

    const mime = file.mimeType || file.mime_type || file.type || file.fileType || '';
    const fileName = file.name || file.title || 'Không rõ tên';
    const fileNameLower = fileName.toLowerCase();

    if (mime.includes('pdf') || fileNameLower.endsWith('.pdf')) {
      acc.pdf++;
    } else if (
      mime.includes('word') || mime.includes('google-apps.document') ||
      fileNameLower.endsWith('.doc') || fileNameLower.endsWith('.docx')
    ) {
      acc.word++;
    } else if (
      mime.includes('spreadsheet') || mime.includes('excel') || mime.includes('google-apps.spreadsheet') ||
      fileNameLower.endsWith('.xls') || fileNameLower.endsWith('.xlsx')
    ) {
      acc.excel++;
    } else if (
      mime.includes('image/') || /\.(jpg|jpeg|png|gif|bmp|webp)$/i.test(fileNameLower)
    ) {
      acc.image++;
    } else if (
      mime.includes('presentation') || mime.includes('powerpoint') || mime.includes('google-apps.presentation') ||
      fileNameLower.endsWith('.ppt') || fileNameLower.endsWith('.pptx')
    ) {
      acc.pptx++;
    } else if (
      mime.includes('zip') || mime.includes('rar') ||
      fileNameLower.endsWith('.zip') || fileNameLower.endsWith('.rar')
    ) {
      acc.zip++;
    }

    return acc;
  }, { pdf: 0, word: 0, excel: 0, image: 0, pptx: 0, zip: 0 });

  const setContent = (id, count) => {
    const el = document.getElementById(id);
    if (el) el.textContent = count;
  };

  setContent('word-cnt', stats.word);
  setContent('excel-cnt', stats.excel);
  setContent('pdf-cnt', stats.pdf);
  setContent('image-cnt', stats.image);
  setContent('pptx-cnt', stats.pptx);
  setContent('zip-cnt', stats.zip);
  setContent('total-cnt', totalFiles);
}

// -------------------- Dashboard overview (Tổng Quan) --------------------

async function loadDashboardOverview() {
  if (!CURRENT_USER.email) return;

  try {
    const files = await API.file.getRecentFilesForDashboard(CURRENT_USER.groupKey);
    renderFileStats(files || []);
    renderRecentFiles((files || []).slice(0, 9));
  } catch (error) {
    console.error("Lỗi tải file dashboard:", error);
  }

  loadCalendarData();
  loadDashboardTopProgress();
}

function renderDashboardCalendar(events) {
  const container = document.getElementById('today-calendar-view');
  if (!container) return;

  const today = new Date();
  const todayEvents = (events || []).filter(e => {
    const d = new Date(e.startTime);
    return d.getDate() === today.getDate() &&
      d.getMonth() === today.getMonth() &&
      d.getFullYear() === today.getFullYear();
  });

  todayEvents.sort((a, b) => (b.isImportant === true) - (a.isImportant === true));

  if (todayEvents.length === 0) {
    container.innerHTML = `<p style="color: var(--text-secondary);">Hôm nay không có lịch.</p>`;
    return;
  }

  let html = '<ul style="list-style: none; padding: 0; margin: 0;">';
  todayEvents.slice(0, 4).forEach(e => {
    const time = e.type === 'task' ? 'Hạn chót' : new Date(e.startTime).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const iconColor = e.isImportant ? 'var(--danger-color)' : 'var(--info-color)';
    const iconClass = e.type === 'task' ? 'fa-list-check' : (e.isImportant ? 'fa-star' : 'fa-circle');

    html += `
      <li style="padding: 8px 12px; border-radius: var(--radius-sm); margin-bottom: 6px; background: var(--hover-bg); border-left: 3px solid ${iconColor}; display: flex; align-items: center; gap: 10px;">
        <i class="fa-solid ${iconClass}" style="color: ${iconColor}; font-size: 0.75em;"></i>
        <span style="flex: 1;">${escapeHtml(e.title || '')}</span>
        <span style="color: var(--text-muted); font-size: 0.85em;">${time}</span>
      </li>`;
  });
  html += '</ul>';
  container.innerHTML = html;
}

async function loadDashboardTopProgress() {
  const container = document.getElementById('project-progress-view');
  if (!container) return;

  container.innerHTML = skeletonListItems(3);

  try {
    const response = await callGAS("getProjectListWithTaskStats", { filters: {}, groupKey: activeGroup });

    if (response.status !== 'success') {
      container.innerHTML = `<p style="color: var(--danger-color); font-size: 0.9em;">Lỗi tải: ${escapeHtml(response.message || '')}</p>`;
      return;
    }

    const projects = response.data;
    if (!projects || projects.length === 0) {
      container.innerHTML = `<p style="color: var(--text-secondary);">Chưa có dự án nào.</p>`;
      return;
    }

    let html = '<div style="display: flex; flex-direction: column; gap: 16px;">';
    projects.slice(0, 5).forEach(p => {
      const percent = p.percent || 0;
      const barColor = getProgressBarColor(percent);
      const stats = p.taskStats || { done: 0, working: 0, stuck: 0, notStarted: 0 };

      html += `
        <div style="border-bottom: 1px solid var(--border-color); padding-bottom: 12px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
            <strong style="font-size: 0.9rem;">${escapeHtml(p.name || '')}</strong>
            <span class="status-pill pill-neutral">${percent}%</span>
          </div>
          <div class="score-gauge" style="height: 6px; margin-bottom: 8px;">
            <div class="score-gauge-fill" style="width: ${percent}%; background: ${barColor};"></div>
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <span class="status-pill pill-success" title="Done"><i class="fa-solid fa-check"></i> ${stats.done}</span>
            <span class="status-pill pill-warning" title="Working on it"><i class="fa-solid fa-spinner"></i> ${stats.working}</span>
            <span class="status-pill pill-danger" title="Stuck"><i class="fa-solid fa-triangle-exclamation"></i> ${stats.stuck}</span>
            <span class="status-pill pill-neutral" title="Not Started"><i class="fa-solid fa-pause"></i> ${stats.notStarted}</span>
          </div>
        </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (err) {
    console.error("Lỗi Dashboard Progress:", err);
    container.innerHTML = `<p style="color: var(--danger-color); font-size: 0.9em;">Lỗi kết nối!</p>`;
  }
}

function shareFileAction(fileId, fileName) {
  Swal.fire({
    title: 'Chia sẻ file?',
    html: `Bạn muốn chia sẻ file <b>"${escapeHtml(fileName)}"</b> ra toàn hệ thống?<br>
            <small style="color:var(--text-muted);">Tất cả thành viên sẽ nhìn thấy file này.</small>`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: 'var(--gold)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Chia sẻ',
    cancelButtonText: 'Hủy'
  }).then(async (result) => {
    if (!result.isConfirmed) return;

    Swal.fire({
      title: 'Đang xử lý...',
      didOpen: () => Swal.showLoading()
    });

    try {
      const message = await API.file.share(fileId, CURRENT_USER.groupKey);
      Swal.fire('Thành công!', message, 'success');
      loadFileList(false, { quiet: true });
    } catch (err) {
      Swal.fire('Lỗi!', err.message || String(err), 'error');
    }
  });
}

// ==========================================
// 5.6 VIỆC CỦA TÔI (My Tasks + khối lượng công việc nhóm) — ported từ WorkHub org
// ==========================================

async function loadMyTasks() {
  const container = document.getElementById('mytasks-list');
  if (!container) return;
  container.innerHTML = skeletonListItems(4);

  if (!CURRENT_USER.email) {
    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding: 40px 0; grid-column: 1 / -1;">Chưa đăng nhập.</div>';
    return;
  }

  try {
    const tasks = await API.task.listMine(CURRENT_USER.email, CURRENT_USER.groupKey);
    renderMyTasks(tasks || []);
  } catch (err) {
    container.innerHTML = `<div style="text-align:center; color:var(--danger-color); padding: 40px 0; grid-column: 1 / -1;">Lỗi: ${escapeHtml(err.message || String(err))}</div>`;
  }

  loadWorkload();
}

async function loadWorkload() {
  const tbody = document.getElementById('workload-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding: 14px 0;"><i class="fa-solid fa-spinner fa-spin"></i></td></tr>';

  try {
    const rows = await API.task.workload(CURRENT_USER.groupKey);
    renderWorkload(rows || []);
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="7" style="color: var(--danger-color); text-align:center; padding: 14px 0;">Lỗi: ${escapeHtml(err.message || String(err))}</td></tr>`;
  }
}

function renderWorkload(rows) {
  const tbody = document.getElementById('workload-table-body');
  if (!tbody) return;

  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Không có công việc nào đang mở.</td></tr>';
    return;
  }

  const busiest = Math.max(...rows.map(r => r.total), 1);

  tbody.innerHTML = rows.map(r => {
    // Thanh nền thể hiện tương quan với người đang ôm nhiều việc nhất
    const share = Math.round((r.total / busiest) * 100);
    return `<tr>
      <td style="font-weight:700;">
        ${escapeHtml(r.name)}
        <div class="workload-bar"><span style="width:${share}%"></span></div>
      </td>
      <td style="text-align:center; font-weight:700;">${r.total}</td>
      <td style="text-align:center; color:var(--text-muted);">${r.notStarted}</td>
      <td style="text-align:center;">${r.working}</td>
      <td style="text-align:center; ${r.stuck > 0 ? 'color:var(--danger-color); font-weight:700;' : 'color:var(--text-muted);'}">${r.stuck}</td>
      <td style="text-align:center; ${r.overdue > 0 ? 'color:var(--danger-color); font-weight:700;' : 'color:var(--text-muted);'}">${r.overdue}</td>
      <td style="text-align:center; ${r.highPriority > 0 ? 'color:var(--warning-color); font-weight:700;' : 'color:var(--text-muted);'}">${r.highPriority}</td>
    </tr>`;
  }).join('');
}

function renderMyTasks(tasks) {
  const container = document.getElementById('mytasks-list');
  if (!container) return;

  if (!tasks || tasks.length === 0) {
    container.innerHTML = '<div style="text-align:center; color:var(--text-muted); padding: 40px 0; grid-column: 1 / -1;">Bạn không có công việc nào đang được giao.</div>';
    return;
  }

  container.innerHTML = tasks.map(t => {
    const safeName = escapeHtml(t.name);
    const safeProjectId = escapeHtml(escapeJs(t.project_id));
    const statusColor = getStatusColor(t.status);
    return `
      <div class="task-card" style="border-left-color:${statusColor};" onclick="goToTaskInProject('${safeProjectId}')">
        <div class="card-row" style="align-items:flex-start;">
          <span class="task-title" style="margin:0;">${safeName}</span>
          ${renderBadge('priority', t.priority)}
        </div>
        <div style="font-size:12.5px; color:var(--text-muted);"><i class="fa-solid fa-diagram-project" style="margin-right:6px;"></i>${escapeHtml(t.projectName || '')}</div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          ${renderBadge('status', t.status)}
          ${t.dueDate ? `<span style="font-size:12px; color:var(--text-muted);">Hạn: ${escapeHtml(t.dueDate)}</span>` : ''}
          ${getDueDateBadge(t.dueDate, t.status)}
        </div>
      </div>`;
  }).join('');
}

// Nhảy từ "Việc của tôi" sang màn Task của đúng dự án chứa task đó
function goToTaskInProject(projectId) {
  const taskNavItem = document.querySelector('.nav-item[data-section="task"]');
  if (taskNavItem) taskNavItem.click();

  let attempts = 0;
  const tryPick = () => {
    const select = document.getElementById('task-project-select');
    const hasOption = select && Array.from(select.options).some(o => o.value === projectId);
    if (hasOption) {
      select.value = projectId;
      select.dispatchEvent(new Event('change'));
    } else if (attempts < 20) {
      attempts++;
      setTimeout(tryPick, 200);
    }
  };
  setTimeout(tryPick, 200);
}

// ==========================================
// 5b. CHI TIẾT CÔNG VIỆC: Bình luận / Danh sách kiểm / Tệp đính kèm / Lịch sử
// ported từ WorkHub org (custom-modal -> modal-overlay/modal-card của app này)
// ==========================================

let currentActivityTaskId = null;
let taskActivityUserMap = {};
const TASK_ACTION_LABELS = {
  saveTask: 'Đã lưu / cập nhật công việc',
  deleteTask: 'Đã xóa công việc',
  addTaskComment: 'Đã thêm bình luận',
  uploadFileToTask: 'Đã tải tệp lên',
  deleteFileFromTask: 'Đã xóa tệp'
};

async function openTaskActivity(taskId, taskName) {
  currentActivityTaskId = taskId;
  const nameEl = document.getElementById('task-activity-name');
  if (nameEl) nameEl.textContent = taskName || '';
  switchTaskActivityTab('comments');
  openAppModal('task-activity-modal');

  const mentionContainer = document.getElementById('comment-mention-checkboxes');
  if (mentionContainer) mentionContainer.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';

  try {
    const userResp = await callGAS('getAllUsers', { groupKey: activeGroup });
    taskActivityUserMap = {};
    if (userResp.status === 'success' && Array.isArray(userResp.data)) {
      userResp.data.forEach(u => { taskActivityUserMap[u.email] = u.name; });

      if (mentionContainer) {
        mentionContainer.innerHTML = '';
        userResp.data.forEach(u => {
          const label = document.createElement('label');
          label.style.display = 'block';
          label.style.padding = '5px 10px';
          label.style.cursor = 'pointer';
          label.onmouseover = function () { this.style.backgroundColor = 'var(--hover-bg)'; };
          label.onmouseout = function () { this.style.backgroundColor = 'transparent'; };
          label.innerHTML = `<input type="checkbox" name="comment-mentions" value="${escapeHtml(u.email)}" style="margin-right:8px;"> ${escapeHtml(u.name)}`;
          mentionContainer.appendChild(label);
        });
      }
    }
  } catch (err) { taskActivityUserMap = {}; }

  loadTaskComments(taskId);
  loadTaskHistory(taskId);
  loadTaskChecklist(taskId);
  loadTaskAttachments(taskId);
}

let mentionCheckboxesExpanded = false;
function showMentionCheckboxes() {
  const box = document.getElementById('comment-mention-checkboxes');
  if (!box) return;
  mentionCheckboxesExpanded = !mentionCheckboxesExpanded;
  box.style.display = mentionCheckboxesExpanded ? 'block' : 'none';
}

function switchTaskActivityTab(tab) {
  document.querySelectorAll('.task-activity-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  const panels = {
    comments: document.getElementById('task-activity-comments-panel'),
    checklist: document.getElementById('task-activity-checklist-panel'),
    attachments: document.getElementById('task-activity-attachments-panel'),
    history: document.getElementById('task-activity-history-panel')
  };
  Object.keys(panels).forEach(key => {
    if (panels[key]) panels[key].style.display = key === tab ? 'block' : 'none';
  });
}

// --- Bình luận ---
async function loadTaskComments(taskId) {
  const list = document.getElementById('task-comment-list');
  if (!list) return;
  list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';
  try {
    const response = await callGAS('getTaskComments', { taskId });
    if (response.status !== 'success') throw new Error(response.message);
    const comments = response.data || [];
    if (comments.length === 0) {
      list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có bình luận nào.</div>';
      return;
    }
    list.innerHTML = comments.map(c => {
      const authorName = taskActivityUserMap[c.author_email] || c.author_email;
      const time = new Date(c.created_at).toLocaleString('vi-VN');
      return `<div class="task-comment-item">
        <div class="task-comment-meta"><strong>${escapeHtml(authorName)}</strong> · ${time}</div>
        <div class="task-comment-content">${escapeHtml(c.content)}</div>
      </div>`;
    }).join('');
    list.scrollTop = list.scrollHeight;
  } catch (err) {
    list.innerHTML = `<div style="color:var(--danger-color); font-size:12.5px; padding:8px;">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

async function handleTaskCommentSubmit(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('task-comment-input');
  const content = input ? input.value.trim() : '';
  if (!content || !currentActivityTaskId) return;

  const mentionCbs = document.querySelectorAll('input[name="comment-mentions"]:checked');
  const mentionedEmails = Array.from(mentionCbs).map(cb => cb.value).join(',');

  try {
    const response = await callGAS('addTaskComment', {
      taskId: currentActivityTaskId,
      content: content,
      mentionedEmails: mentionedEmails,
      groupKey: activeGroup,
      email: CURRENT_USER.email || null
    });
    if (response.status !== 'success') throw new Error(response.message);
    if (input) input.value = '';
    document.querySelectorAll('input[name="comment-mentions"]:checked').forEach(cb => cb.checked = false);
    loadTaskComments(currentActivityTaskId);
    loadTaskHistory(currentActivityTaskId);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// --- Lịch sử ---
async function loadTaskHistory(taskId) {
  const list = document.getElementById('task-history-list');
  if (!list) return;
  list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';
  try {
    const response = await callGAS('getTaskHistory', { taskId });
    if (response.status !== 'success') throw new Error(response.message);
    const logs = response.data || [];
    if (logs.length === 0) {
      list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có lịch sử.</div>';
      return;
    }
    list.innerHTML = logs.map(l => {
      const authorName = taskActivityUserMap[l.user_email] || l.user_email || 'unknown';
      const time = new Date(l.created_at).toLocaleString('vi-VN');
      const actionLabel = TASK_ACTION_LABELS[l.action] || l.action;
      return `<div class="task-history-item">
        <div class="task-history-meta"><strong>${escapeHtml(authorName)}</strong> · ${time}</div>
        <div class="task-history-content">${escapeHtml(actionLabel)}</div>
      </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div style="color:var(--danger-color); font-size:12.5px; padding:8px;">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

// --- Danh sách kiểm (checklist) ---
async function loadTaskChecklist(taskId) {
  const list = document.getElementById('task-checklist-list');
  if (!list) return;
  list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';
  try {
    const response = await callGAS('getChecklist', { taskId });
    if (response.status !== 'success') throw new Error(response.message);
    renderTaskChecklist(response.data || []);
  } catch (err) {
    list.innerHTML = `<div style="color:var(--danger-color); font-size:12.5px; padding:8px;">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

function renderTaskChecklist(items) {
  const list = document.getElementById('task-checklist-list');
  if (!list) return;

  if (!items || items.length === 0) {
    list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có mục nào.</div>';
    return;
  }

  const doneCount = items.filter(x => x.done).length;
  const header = `<div style="font-size:12px; color:var(--text-muted); margin-bottom:8px;">${doneCount}/${items.length} đã xong</div>`;

  list.innerHTML = header + items.map(it => {
    const safeId = escapeHtml(escapeJs(it.id));
    return `<div class="checklist-item${it.done ? ' is-done' : ''}">
      <label style="display:flex; align-items:center; gap:8px; flex:1; cursor:pointer; margin:0;">
        <input type="checkbox" ${it.done ? 'checked' : ''} onchange="toggleChecklistItemAction('${safeId}', this.checked)">
        <span class="checklist-item-text">${escapeHtml(it.text)}</span>
      </label>
      <button class="icon-btn danger" title="Xóa" onclick="deleteChecklistItemAction('${safeId}')">
        <i class="fa-solid fa-trash"></i>
      </button>
    </div>`;
  }).join('');
}

async function handleChecklistFormSubmit(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('task-checklist-input');
  const text = input ? input.value.trim() : '';
  if (!text || !currentActivityTaskId) return;

  try {
    const response = await callGAS('addChecklistItem', { taskId: currentActivityTaskId, text });
    if (response.status !== 'success') throw new Error(response.message);
    if (input) input.value = '';
    renderTaskChecklist(response.data || []);
    refreshTaskListAfterChecklistChange(response.data || []);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function toggleChecklistItemAction(itemId, done) {
  if (!currentActivityTaskId) return;
  try {
    const response = await callGAS('toggleChecklistItem', { taskId: currentActivityTaskId, itemId, done });
    if (response.status !== 'success') throw new Error(response.message);
    renderTaskChecklist(response.data || []);
    refreshTaskListAfterChecklistChange(response.data || []);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
    loadTaskChecklist(currentActivityTaskId);
  }
}

async function deleteChecklistItemAction(itemId) {
  if (!currentActivityTaskId) return;
  try {
    const response = await callGAS('deleteChecklistItem', { taskId: currentActivityTaskId, itemId });
    if (response.status !== 'success') throw new Error(response.message);
    renderTaskChecklist(response.data || []);
    refreshTaskListAfterChecklistChange(response.data || []);
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// Vá thẳng checklist mới vào task đang giữ trong bộ nhớ để cập nhật badge "x/y" trên
// danh sách task mà không phải tải lại cả trang; chỉ tải lại (im lặng) nếu không tìm thấy.
function refreshTaskListAfterChecklistChange(newChecklist) {
  const task = (globalAllTasks || []).find(t => t.id === currentActivityTaskId);
  if (task && Array.isArray(newChecklist)) {
    task.checklist = newChecklist;
    if (typeof applyTaskFilters === 'function') applyTaskFilters();
    return;
  }
  if (typeof loadTasksForProject === 'function' && currentTaskProjectID) {
    loadTasksForProject(currentTaskProjectID, { quiet: true });
  }
}

// --- Tệp đính kèm ---
async function loadTaskAttachments(taskId) {
  const task = (globalAllTasks || []).find(t => t.id === taskId);
  let attachments = task ? task.attachments : [];
  if (typeof attachments === 'string') {
    try { attachments = JSON.parse(attachments || '[]'); } catch (err) { attachments = []; }
  }
  if (!Array.isArray(attachments)) attachments = [];
  renderTaskAttachments(attachments);
}

function renderTaskAttachments(attachments) {
  const list = document.getElementById('task-attachment-list');
  if (!list) return;
  if (!attachments || attachments.length === 0) {
    list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Chưa có tệp đính kèm.</div>';
    return;
  }
  list.innerHTML = attachments.map(f => `
    <div class="task-attachment-item">
      <a href="${escapeHtml(f.url)}" target="_blank" rel="noopener" class="task-attachment-name"><i class="fa-solid fa-paperclip"></i> ${escapeHtml(f.name)}</a>
      <span class="task-attachment-meta">${escapeHtml(f.uploader || '')}${f.date ? ' · ' + escapeHtml(f.date) : ''}</span>
      <button class="icon-btn danger" title="Xóa" onclick="deleteTaskAttachmentAction('${escapeHtml(escapeJs(f.id))}')"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');
}

async function handleTaskAttachmentUpload(e) {
  if (e) e.preventDefault();
  const input = document.getElementById('task-attachment-input');
  if (!input || !input.files || !input.files.length || !currentActivityTaskId) return;
  const file = input.files[0];

  const readFileAsBase64 = (f) => new Promise((resolve) => {
    const r = new FileReader();
    r.onload = (ev) => resolve(ev.target.result.split(',')[1]);
    r.readAsDataURL(f);
  });

  try {
    const base64Data = await readFileAsBase64(file);
    const response = await callGAS('uploadFileToTask', {
      fileData: base64Data,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      taskId: currentActivityTaskId,
      groupKey: activeGroup,
      description: '',
      email: CURRENT_USER.email || null
    });
    if (response.status !== 'success') throw new Error(response.message);
    input.value = '';
    renderTaskAttachments(response.data || []);
    const task = (globalAllTasks || []).find(t => t.id === currentActivityTaskId);
    if (task) task.attachments = response.data || [];
    showToast('Đã tải tệp lên!', 'success');
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

async function deleteTaskAttachmentAction(fileId) {
  if (!currentActivityTaskId) return;
  try {
    const response = await callGAS('deleteFileFromTask', { taskId: currentActivityTaskId, fileId, groupKey: activeGroup });
    if (response.status !== 'success') throw new Error(response.message);
    renderTaskAttachments(response.data || []);
    const task = (globalAllTasks || []).find(t => t.id === currentActivityTaskId);
    if (task) task.attachments = response.data || [];
    showToast('Đã xóa tệp.', 'success');
  } catch (err) {
    showToast('Lỗi: ' + err.message, 'error');
  }
}

// ==========================================
// 5c. TÌM KIẾM TOÀN CỤC (Ctrl/Cmd + K)
// ported từ WorkHub org — mở/đóng qua openAppModal/closeAppModal riêng của app này
// ==========================================

let searchPaletteResults = [];
let searchPaletteIndex = -1;
let searchDebounceTimer = null;
let searchRequestSeq = 0;
let searchPaletteReturnFocus = null;

function openSearchPalette() {
  const input = document.getElementById('search-palette-input');
  if (!input) return;
  searchPaletteReturnFocus = document.activeElement;
  openAppModal('search-palette-modal');
  input.value = '';
  searchPaletteResults = [];
  searchPaletteIndex = -1;
  renderSearchHint('Gõ ít nhất 2 ký tự để tìm.');
  setTimeout(() => input.focus(), 30);
}

function closeSearchPalette() {
  closeAppModal('search-palette-modal');
  clearTimeout(searchDebounceTimer);
  searchPaletteResults = [];
  searchPaletteIndex = -1;
  if (searchPaletteReturnFocus && document.body.contains(searchPaletteReturnFocus) && typeof searchPaletteReturnFocus.focus === 'function') {
    searchPaletteReturnFocus.focus();
  }
  searchPaletteReturnFocus = null;
}

function renderSearchHint(text) {
  const box = document.getElementById('search-palette-results');
  if (box) box.innerHTML = `<div class="search-palette-hint">${escapeHtml(text)}</div>`;
}

function onSearchPaletteInput(value) {
  clearTimeout(searchDebounceTimer);
  const q = String(value || '').trim();

  if (q.length < 2) {
    searchPaletteResults = [];
    searchPaletteIndex = -1;
    renderSearchHint('Gõ ít nhất 2 ký tự để tìm.');
    return;
  }

  renderSearchHint('Đang tìm...');
  searchDebounceTimer = setTimeout(async () => {
    const mySeq = ++searchRequestSeq;
    try {
      const response = await callGAS('globalSearch', { query: q, groupKey: activeGroup });
      if (mySeq !== searchRequestSeq) return;
      if (response.status !== 'success') throw new Error(response.message);
      renderSearchResults(response.data || { projects: [], tasks: [], files: [], events: [], comments: [], milestones: [] });
    } catch (err) {
      if (mySeq !== searchRequestSeq) return;
      renderSearchHint('Lỗi tìm kiếm: ' + err.message);
    }
  }, 250);
}

function renderSearchResults(data) {
  const box = document.getElementById('search-palette-results');
  if (!box) return;

  searchPaletteResults = [
    ...(data.projects || []).map(x => ({ ...x, type: 'project' })),
    ...(data.tasks || []).map(x => ({ ...x, type: 'task' })),
    ...(data.milestones || []).map(x => ({ ...x, type: 'milestone' })),
    ...(data.events || []).map(x => ({ ...x, type: 'event' })),
    ...(data.comments || []).map(x => ({ ...x, type: 'comment' })),
    ...(data.files || []).map(x => ({ ...x, type: 'file' }))
  ];
  searchPaletteIndex = searchPaletteResults.length > 0 ? 0 : -1;

  if (searchPaletteResults.length === 0) {
    renderSearchHint('Không tìm thấy kết quả nào.');
    return;
  }

  const GROUP_META = {
    project: { label: 'Dự án', icon: 'fa-diagram-project' },
    task: { label: 'Công việc', icon: 'fa-list-check' },
    milestone: { label: 'Cột mốc', icon: 'fa-flag-checkered' },
    event: { label: 'Sự kiện', icon: 'fa-calendar-check' },
    comment: { label: 'Bình luận', icon: 'fa-comment-dots' },
    file: { label: 'Tệp', icon: 'fa-file' }
  };

  let html = '';
  let flatIndex = 0;
  ['project', 'task', 'milestone', 'event', 'comment', 'file'].forEach(type => {
    const items = searchPaletteResults.filter(r => r.type === type);
    if (items.length === 0) return;
    html += `<div class="search-palette-group">${GROUP_META[type].label}</div>`;
    items.forEach(item => {
      const idx = flatIndex++;
      const dueBadge = item.type === 'task' ? getDueDateBadge(item.dueDate, item.status) : '';
      html += `
        <div class="search-palette-item${idx === 0 ? ' is-active' : ''}" data-index="${idx}"
             onclick="activateSearchResult(${idx})" onmouseenter="setSearchActiveIndex(${idx})">
          <i class="fa-solid ${GROUP_META[type].icon}"></i>
          <div class="search-palette-item-text">
            <div class="search-palette-item-title">${escapeHtml(item.title || '')}${dueBadge}</div>
            ${item.subtitle ? `<div class="search-palette-item-sub">${escapeHtml(item.subtitle)}</div>` : ''}
          </div>
        </div>`;
    });
  });

  box.innerHTML = html;
}

function setSearchActiveIndex(idx) {
  searchPaletteIndex = idx;
  document.querySelectorAll('.search-palette-item').forEach(el => {
    el.classList.toggle('is-active', Number(el.dataset.index) === idx);
  });
}

function moveSearchSelection(step) {
  if (searchPaletteResults.length === 0) return;
  let next = searchPaletteIndex + step;
  if (next < 0) next = searchPaletteResults.length - 1;
  if (next >= searchPaletteResults.length) next = 0;
  setSearchActiveIndex(next);
  const el = document.querySelector(`.search-palette-item[data-index="${next}"]`);
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
}

function activateSearchResult(idx) {
  const item = searchPaletteResults[idx];
  if (!item) return;
  closeSearchPalette();

  if (item.type === 'file') {
    if (item.url) openExternalUrl(item.url);
    return;
  }
  if (item.type === 'task') {
    if (typeof goToTaskInProject === 'function') goToTaskInProject(item.projectId);
    return;
  }
  if (item.type === 'comment') {
    // Bình luận thuộc về 1 task cụ thể — mở thẳng modal "Chi tiết công việc" của task đó
    if (typeof openTaskActivity === 'function') openTaskActivity(item.taskId, '');
    return;
  }
  if (item.type === 'milestone' || item.type === 'project') {
    switchSection('progress');
    if (item.type === 'milestone' && typeof openMilestonesModal === 'function') {
      setTimeout(() => openMilestonesModal(item.projectId, item.subtitle || ''), 250);
    }
    return;
  }
  if (item.type === 'event') {
    switchSection('calendar');
    if (item.startTime && typeof window.selectDate === 'function') {
      const d = new Date(item.startTime);
      setTimeout(() => window.selectDate(d.getFullYear(), d.getMonth(), d.getDate()), 250);
    }
  }
}

document.addEventListener('keydown', function (e) {
  const key = (e.key || '').toLowerCase();
  if ((e.ctrlKey || e.metaKey) && key === 'k') {
    e.preventDefault();
    const palette = document.getElementById('search-palette-modal');
    if (palette && palette.classList.contains('open')) closeSearchPalette();
    else openSearchPalette();
  }
});

// ==========================================
// 5d. ĐỒNG BỘ THỜI GIAN THỰC (Realtime)
// Chỉ tải lại đúng phần đang hiển thị, gom nhiều thay đổi liên tiếp thành 1 lần tải,
// và không báo "vừa cập nhật" cho chính thao tác của mình vừa gây ra.
// KHÔNG port kênh chat/pin/presence của org — app này không có tính năng chat.
// ==========================================

let realtimePendingTables = new Set();
let realtimeDebounceTimer = null;

function initRealtimeSync() {
  if (typeof API === 'undefined' || !API.realtime) return;

  API.realtime.subscribe(
    (change) => {
      realtimePendingTables.add(change.table);
      clearTimeout(realtimeDebounceTimer);
      realtimeDebounceTimer = setTimeout(flushRealtimeChanges, 400);
    },
    (status) => {
      setRealtimeIndicator(status === 'SUBSCRIBED');
    }
  );
}

function stopRealtimeSync() {
  if (typeof API !== 'undefined' && API.realtime) API.realtime.unsubscribe();
  clearTimeout(realtimeDebounceTimer);
  realtimePendingTables.clear();
  setRealtimeIndicator(false);
}

function flushRealtimeChanges() {
  const tables = new Set(realtimePendingTables);
  realtimePendingTables.clear();
  if (tables.size === 0) return;

  // Thay đổi do chính mình vừa gây ra thì các hàm lưu đã tự tải lại rồi — bỏ qua để
  // không tải chồng và không hiện thông báo thừa.
  const isOwnChange = (Date.now() - (window.lastLocalMutationAt || 0)) < 2500;
  if (isOwnChange) return;

  const touchedTasks = tables.has('tasks');
  const touchedProjects = tables.has('projects') || tables.has('project_milestones');
  const touchedEvents = tables.has('events');

  if (currentSectionKey === 'task' && touchedTasks) {
    if (typeof loadTasksForProject === 'function' && currentTaskProjectID) loadTasksForProject(currentTaskProjectID, { quiet: true });
  } else if (currentSectionKey === 'mytasks' && (touchedTasks || touchedProjects)) {
    if (typeof loadMyTasks === 'function') loadMyTasks();
  } else if (currentSectionKey === 'progress' && (touchedTasks || touchedProjects)) {
    if (typeof loadProjectOverview === 'function') loadProjectOverview({ quiet: true });
  } else if (currentSectionKey === 'calendar' && touchedEvents) {
    if (typeof loadCalendarData === 'function') loadCalendarData({ quiet: true });
  } else if (currentSectionKey === 'dashboard' && (touchedTasks || touchedProjects || touchedEvents)) {
    if (typeof loadDashboardOverview === 'function') loadDashboardOverview();
  } else {
    return; // phần đang xem không liên quan tới bảng vừa đổi
  }

  showToast('Dữ liệu vừa được người khác cập nhật.', 'info');
}

// Chấm nhỏ trên chuông thông báo: xanh = đang đồng bộ trực tiếp, xám = mất kết nối
function setRealtimeIndicator(isLive) {
  const anchor = document.getElementById('observation-toggle-btn');
  if (!anchor) return;
  let dot = document.getElementById('realtime-indicator');
  if (!dot) {
    dot = document.createElement('span');
    dot.id = 'realtime-indicator';
    dot.className = 'realtime-indicator';
    anchor.appendChild(dot);
  }
  dot.classList.toggle('is-live', !!isLive);
  dot.title = isLive ? 'Đang đồng bộ trực tiếp' : 'Mất kết nối đồng bộ';
}

// ==========================================
// 5e. THÙNG RÁC (khôi phục / dọn dữ liệu đã xóa mềm)
// ==========================================

const TRASH_RETENTION_DAYS = 30;

function openTrashModal() {
  openAppModal('trash-modal');
  loadTrashItems();
}

function getTrashAgeDays(deletedAt) {
  if (!deletedAt) return null;
  const t = new Date(deletedAt).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function getTrashAgeInfo(deletedAt) {
  const days = getTrashAgeDays(deletedAt);
  if (days === null) return '';
  if (days >= TRASH_RETENTION_DAYS) {
    return `<span class="trash-age is-old"><i class="fa-solid fa-triangle-exclamation"></i> Đã ${days} ngày — nên dọn</span>`;
  }
  if (days >= 1) return `<span class="trash-age">${days} ngày trước</span>`;
  return '';
}

// quiet = true: tải lại sau khôi phục/xóa vĩnh viễn/dọn rác quá hạn, không xóa trắng danh sách ra placeholder
async function loadTrashItems(options) {
  const quiet = !!(options && options.quiet);
  const list = document.getElementById('trash-list');
  const categorySelect = document.getElementById('trash-category');
  const category = categorySelect ? categorySelect.value : 'tasks';
  if (!list) return;

  if (!quiet) list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Đang tải...</div>';

  try {
    const response = await callGAS('getDeletedItems', { tableName: category, groupKey: activeGroup });
    if (response.status !== 'success') throw new Error(response.message);
    const items = response.data || [];

    if (items.length === 0) {
      list.innerHTML = '<div style="padding:8px; color:var(--text-muted); font-size:12.5px;">Thùng rác trống.</div>';
      return;
    }

    let html = items.map(item => {
      const name = item.name || item.title || 'Không có tên';
      let sub = item.deleted_at ? new Date(item.deleted_at).toLocaleString('vi-VN') : '';
      if (category === 'tasks' && item.projectName) sub += ` · Dự án: ${item.projectName}`;
      const ageInfo = getTrashAgeInfo(item.deleted_at);
      return `<div class="trash-item">
        <div class="trash-item-info">
          <div class="trash-item-name">${escapeHtml(name)}</div>
          <div class="trash-item-sub">${escapeHtml(sub)} ${ageInfo}</div>
        </div>
        <div class="trash-item-actions">
          <button class="btn btn-success btn-sm" onclick="restoreTrashItemAction('${category}', '${escapeHtml(escapeJs(item.id))}')"><i class="fa-solid fa-clock-rotate-left"></i> Khôi phục</button>
          <button class="btn btn-danger btn-sm" onclick="hardDeleteTrashItemAction('${category}', '${escapeHtml(escapeJs(item.id))}')"><i class="fa-solid fa-trash"></i> Xóa hẳn</button>
        </div>
      </div>`;
    }).join('');

    const oldItems = items.filter(x => (getTrashAgeDays(x.deleted_at) || 0) >= TRASH_RETENTION_DAYS);
    if (oldItems.length > 0) {
      const ids = oldItems.map(x => x.id).join('|');
      html += `<div class="trash-purge-row">
        <span>${oldItems.length} mục đã ở thùng rác quá ${TRASH_RETENTION_DAYS} ngày.</span>
        <button type="button" class="btn btn-outline btn-sm" onclick="purgeOldTrash('${category}', '${ids}')"><i class="fa-solid fa-broom"></i> Dọn hết</button>
      </div>`;
    }

    list.innerHTML = html;
  } catch (err) {
    list.innerHTML = `<div style="color:var(--danger-color); font-size:12.5px; padding:8px;">Lỗi: ${escapeHtml(err.message)}</div>`;
  }
}

function restoreTrashItemAction(category, id) {
  Swal.fire({
    title: 'Khôi phục mục này?',
    icon: 'question',
    showCancelButton: true,
    confirmButtonText: 'Khôi phục',
    cancelButtonText: 'Hủy',
    confirmButtonColor: 'var(--success-color)',
    cancelButtonColor: 'var(--text-muted)'
  }).then(async (result) => {
    if (!result.isConfirmed) return;
    try {
      const response = await callGAS('restoreItem', { tableName: category, id, groupKey: activeGroup });
      if (response.status !== 'success') throw new Error(response.message);
      showToast(response.data || 'Khôi phục thành công!', 'success');
      loadTrashItems({ quiet: true });
      if (category === 'files' && typeof loadFileList === 'function') loadFileList(false, { quiet: true });
      else if ((category === 'projects' || category === 'tasks') && typeof loadProjectOverview === 'function') loadProjectOverview({ quiet: true });
      else if (category === 'events' && typeof loadCalendarData === 'function') loadCalendarData({ quiet: true });
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  });
}

function hardDeleteTrashItemAction(category, id) {
  Swal.fire({
    title: 'Xóa vĩnh viễn?',
    text: 'Không thể hoàn tác.',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Xóa vĩnh viễn',
    cancelButtonText: 'Hủy',
    confirmButtonColor: 'var(--danger-color)',
    cancelButtonColor: 'var(--text-muted)'
  }).then(async (result) => {
    if (!result.isConfirmed) return;
    try {
      const response = await callGAS('hardDeleteItem', { tableName: category, id, groupKey: activeGroup });
      if (response.status !== 'success') throw new Error(response.message);
      showToast('Đã xóa vĩnh viễn!', 'success');
      loadTrashItems({ quiet: true });
    } catch (err) {
      showToast('Lỗi: ' + err.message, 'error');
    }
  });
}

async function purgeOldTrash(category, idsJoined) {
  const ids = String(idsJoined || '').split('|').filter(Boolean);
  if (ids.length === 0) return;

  const result = await Swal.fire({
    title: `Xóa vĩnh viễn ${ids.length} mục?`,
    html: `Các mục này đã ở thùng rác quá ${TRASH_RETENTION_DAYS} ngày.<br><b>Không thể hoàn tác.</b><br>Gõ <code>XOA</code> để xác nhận:`,
    icon: 'warning',
    input: 'text',
    inputPlaceholder: 'XOA',
    showCancelButton: true,
    confirmButtonColor: 'var(--danger-color)',
    confirmButtonText: 'Xóa vĩnh viễn',
    cancelButtonText: 'Hủy',
    inputValidator: (value) => (value || '').trim().toUpperCase() !== 'XOA' ? 'Gõ đúng chữ XOA để xác nhận.' : null
  });
  if (!result.isConfirmed) return;

  let ok = 0, fail = 0;
  for (const id of ids) {
    try {
      const r = await callGAS('hardDeleteItem', { tableName: category, id, groupKey: activeGroup });
      if (r.status === 'success') ok++; else fail++;
    } catch (err) { fail++; }
  }
  showToast(fail === 0 ? `Đã dọn ${ok} mục.` : `Đã dọn ${ok} mục, ${fail} mục lỗi.`, fail === 0 ? 'success' : 'error');
  loadTrashItems({ quiet: true });
}

// ==========================================
// 6. INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  setupThemeToggle();
  renderObservationLogs();
  updateStageUI('e1');

  // Sidebar điều hướng: mặc định mở rộng trên desktop, thu gọn trên mobile
  const sidebarEl = document.getElementById('app-sidebar');
  const hamburgerBtn = document.getElementById('hamburger-menu');
  if (sidebarEl && window.innerWidth > 768) sidebarEl.classList.add('expanded');
  if (hamburgerBtn && sidebarEl) {
    hamburgerBtn.addEventListener('click', () => sidebarEl.classList.toggle('expanded'));
  }

  // ----- Task / Progress / Calendar module: DOM refs + wiring một lần duy nhất -----
  todayEventList = document.getElementById('today-event-list');
  manageEventBtn = document.getElementById('manage-event-btn');
  addEventBtn = document.getElementById('add-event-btn');
  eventForm = document.getElementById('event-form');

  // Ghi nhớ tiêu đề/label mặc định của modal sự kiện để khôi phục đúng trạng thái
  // "Tạo mới" sau khi dùng modal này để sửa một sự kiện đã có (xem resetEventModalUI).
  const eventModalTitleEl = document.getElementById('event-modal-title');
  if (eventModalTitleEl) eventModalDefaultTitleHTML = eventModalTitleEl.innerHTML;
  const eventSubmitBtnEl = document.getElementById('event-form-submit-btn');
  if (eventSubmitBtnEl) eventModalDefaultSubmitHTML = eventSubmitBtnEl.innerHTML;

  if (addEventBtn) addEventBtn.addEventListener('click', handleAddEventClick);
  const calendarToggleEl = document.getElementById('calendar-toggle');
  if (calendarToggleEl) calendarToggleEl.addEventListener('change', handleCalendarToggleChange);

  // Progress: filter/sort dropdowns lọc lại từ cache (globalAllProjects), không gọi lại API
  ['progress-search-input', 'progress-project-filter', 'progress-status-filter', 'progress-sort-select'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => renderProgressTable());
  });
  const progressNameSearchEl = document.getElementById('progress-name-search');
  if (progressNameSearchEl) progressNameSearchEl.addEventListener('input', () => renderProgressTable());
  if (manageEventBtn) manageEventBtn.addEventListener('click', handleToggleImportantClick);

  // Đóng modal Task/Event khi bấm ra ngoài (auth-modal bị khóa nên không áp dụng ở đây)
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    if (overlay.id === 'auth-modal') return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  // Tìm kiếm toàn cục: điều hướng bằng phím trong ô nhập
  const searchPaletteInput = document.getElementById('search-palette-input');
  if (searchPaletteInput) {
    searchPaletteInput.addEventListener('input', function () {
      onSearchPaletteInput(this.value);
    });
    searchPaletteInput.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchSelection(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchSelection(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); if (searchPaletteIndex >= 0) activateSearchResult(searchPaletteIndex); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearchPalette(); }
    });
  }

  await initAuth();

  const notiBtn = document.getElementById('observation-toggle-btn');
  if (notiBtn) notiBtn.addEventListener('click', toggleObservationDrawer);

  // ----- Drive / Upload File: wiring một lần duy nhất -----
  const uploadForm = document.getElementById('upload-file-form');
  if (uploadForm) {
    const driveFileInput = document.getElementById('file-input');
    const driveFolderInput = document.getElementById('folder-input');
    const uploadLabel = document.getElementById('upload-label');
    const submitUploadBtn = document.getElementById('submit-upload-btn');
    const uploadTypeRadios = uploadForm.querySelectorAll('input[name="uploadType"]');

    uploadTypeRadios.forEach(radio => {
      radio.addEventListener('change', function () {
        if (this.value === 'folder') {
          if (uploadLabel) {
            uploadLabel.setAttribute('for', 'folder-input');
            uploadLabel.innerHTML = '<i class="fa-solid fa-folder-tree"></i> Chọn thư mục từ máy tính<span id="file-name-display"> (Chưa chọn thư mục)</span>';
          }
        } else {
          if (uploadLabel) {
            uploadLabel.setAttribute('for', 'file-input');
            uploadLabel.innerHTML = '<i class="fa-solid fa-cloud-arrow-up"></i> Chọn file từ máy tính<span id="file-name-display"> (Chưa có file nào)</span>';
          }
        }
        const preview = document.getElementById('file-icon-preview');
        if (preview) preview.innerHTML = '';
      });
    });

    const handleDriveFileInputChange = function () {
      if (this.files.length > 0) {
        const fileNameDisplay = document.getElementById('file-name-display');
        const fileIconPreview = document.getElementById('file-icon-preview');

        if (this.files.length === 1) {
          const file = this.files[0];
          const fileName = file.name.toLowerCase();
          if (fileNameDisplay) fileNameDisplay.textContent = ' (' + file.name + ')';

          let iconClass = 'fa-file';
          if (fileName.endsWith('.pdf')) iconClass = 'fa-file-pdf';
          else if (fileName.endsWith('.docx')) iconClass = 'fa-file-word';
          else if (file.type && file.type.startsWith('image/')) iconClass = 'fa-file-image';
          else if (fileName.endsWith('.xlsx')) iconClass = 'fa-file-excel';

          if (fileIconPreview) fileIconPreview.innerHTML = `<i class="fa-solid ${iconClass}" style="font-size: 36px; color: var(--text-secondary);"></i>`;
        } else {
          if (fileNameDisplay) fileNameDisplay.textContent = ' (Đã chọn ' + this.files.length + ' files)';
          if (fileIconPreview) fileIconPreview.innerHTML = `<i class="fa-solid fa-copy" style="font-size: 36px; color: var(--text-secondary);"></i>`;
        }
        if (submitUploadBtn) submitUploadBtn.disabled = false;
      }
    };

    if (driveFileInput) driveFileInput.addEventListener('change', handleDriveFileInputChange);
    if (driveFolderInput) driveFolderInput.addEventListener('change', handleDriveFileInputChange);

    uploadForm.addEventListener('submit', async function (e) {
      e.preventDefault();

      const checkedTypeRadio = document.querySelector('input[name="uploadType"]:checked');
      const uploadType = checkedTypeRadio ? checkedTypeRadio.value : 'file';
      const inputElement = uploadType === 'folder' ? driveFolderInput : driveFileInput;

      if (!inputElement || !inputElement.files.length) {
        showToast('Vui lòng chọn file/thư mục để tải lên!', 'error');
        return;
      }

      if (submitUploadBtn) submitUploadBtn.disabled = true;
      const originalBtnText = submitUploadBtn ? submitUploadBtn.innerHTML : '';

      const descInput = uploadForm.querySelector('[name="description"]');
      const descriptionValue = descInput ? descInput.value : "";
      const totalFiles = inputElement.files.length;
      let successCount = 0;

      const readFileAsBase64 = (f) => new Promise((resolve) => {
        const r = new FileReader();
        r.onload = (ev) => resolve(ev.target.result.split(',')[1]);
        r.readAsDataURL(f);
      });

      try {
        for (let i = 0; i < totalFiles; i++) {
          const file = inputElement.files[i];
          if (submitUploadBtn) submitUploadBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Đang tải ${i + 1}/${totalFiles}...`;

          const base64Data = await readFileAsBase64(file);

          let folderPath = "";
          if (uploadType === 'folder' && file.webkitRelativePath) {
            const parts = file.webkitRelativePath.split('/');
            parts.pop();
            folderPath = parts.join('/');
          }

          await API.file.upload(base64Data, file.name, file.type || 'application/octet-stream', CURRENT_USER.groupKey, descriptionValue, CURRENT_USER.email, folderPath);
          successCount++;
        }

        showToast(`Tải lên thành công ${successCount} file!`, "success");
        uploadForm.reset();
        loadFileList(false, { quiet: true });

        const checkedRadioAfter = document.querySelector('input[name="uploadType"]:checked');
        if (checkedRadioAfter) {
          checkedRadioAfter.dispatchEvent(new Event('change'));
        } else {
          const displaySpan = document.getElementById('file-name-display');
          if (displaySpan) displaySpan.textContent = ' (Chưa có file nào)';
        }

        const iconPreviewEl = document.getElementById('file-icon-preview');
        if (iconPreviewEl) iconPreviewEl.innerHTML = '';

      } catch (err) {
        handleUploadFailure(err);
        showToast("Lỗi tải file: " + (err.message || err), "error");
      } finally {
        if (submitUploadBtn) {
          submitUploadBtn.disabled = false;
          submitUploadBtn.innerHTML = originalBtnText;
        }
      }
    });
  }

  // ----- Drive / Bộ lọc: wiring một lần duy nhất -----
  const driveSearchInput = document.getElementById('search-name');
  let driveSearchTimeout = null;
  if (driveSearchInput) {
    driveSearchInput.addEventListener('input', () => {
      if (driveSearchTimeout) clearTimeout(driveSearchTimeout);
      driveSearchTimeout = setTimeout(() => loadFileList(true), 500);
    });
  }

  [
    document.getElementById('filter-sort'),
    document.getElementById('filter-type'),
    document.getElementById('filter-uploader'),
    document.getElementById('filter-date')
  ].forEach(el => {
    if (el) el.addEventListener('change', () => loadFileList(true));
  });

  const applyFilterBtn = document.getElementById('apply-filter-btn');
  if (applyFilterBtn) {
    applyFilterBtn.addEventListener('click', () => loadFileList(true));
  }

});
