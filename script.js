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

const ALLOWED_GROUPS = ['workhub-fin', 'admin', 'all'];

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
let activeGroup = 'workhub-fin';

// ===== Project / Task / Calendar module globals (ported từ app WorkHub anh em) =====
let currentTaskProjectID = null;
let globalAllProjects = [];
let globalAllTasks = [];
let showArchivedProjects = false;
let editingTaskBaseUpdatedAt = null;
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

// Section navigation (Pipeline / Nhiệm Vụ / Tiến Độ / Lịch)
const SECTION_KEYS = ['pipeline', 'task', 'progress', 'calendar'];
let currentSectionKey = 'pipeline';
const SECTION_LOADED = { projects: false, calendar: false };

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
          window.location.href = 'https://workhub-ai.pages.dev/';
        }
      });
    }
    return false;
  }

  unlockApp();
  updateUserProfileUI();
  startPresenceSystem();

  if (!window.__financeSessionBootstrapped) {
    window.__financeSessionBootstrapped = true;
    fetchLiveObservationLogs();
    loadFinanceMembers();
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
      CURRENT_USER = { email: '', nickname: '', groupKey: '' };
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
      await API.presence.setOnline(CURRENT_USER.email, CURRENT_USER.nickname, 'workhub-fin');
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

    // Default fallback members if database returned empty
    if (!members || members.length === 0) {
      members = [
        {
          email: 'vophucminhtam@gmail.com',
          nickname: 'Minh Tâm',
          group_key: 'workhub-fin',
          isOnline: true,
          last_changed: new Date().toISOString()
        },
        {
          email: 'phucbui281207@gmail.com',
          nickname: 'Phúc Bùi',
          group_key: 'workhub-fin',
          isOnline: false,
          last_changed: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'id-test-1785592017660@gmail.com',
          nickname: 'Finance QA Bot',
          group_key: 'workhub-fin',
          isOnline: false,
          last_changed: new Date(Date.now() - 4 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'ta-test-1785580354510@gmail.com',
          nickname: 'Analytics Engine',
          group_key: 'workhub-fin',
          isOnline: false,
          last_changed: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'fn-test-1785579721390@gmail.com',
          nickname: 'Reporting Daemon',
          group_key: 'workhub-fin',
          isOnline: false,
          last_changed: new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
        },
        {
          email: 'rt-test-1785370194902@gmail.com',
          nickname: 'Realtime Auditor',
          group_key: 'workhub-fin',
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
        group_key: CURRENT_USER.groupKey || 'workhub-fin',
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
      <div class="member-item-card" title="${member.email} (${member.group_key || 'workhub-fin'})">
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

  document.querySelectorAll('.section-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-section') === sectionKey);
  });
  document.querySelectorAll('.app-section').forEach(sec => sec.classList.remove('active'));
  const target = document.getElementById(sectionKey + '-section');
  if (target) target.classList.add('active');

  if (!CURRENT_USER.email) return; // chưa đăng nhập: chỉ đổi giao diện, không gọi API

  if ((sectionKey === 'task' || sectionKey === 'progress') && !SECTION_LOADED.projects) {
    SECTION_LOADED.projects = true;
    loadProjectOverview();
    if (typeof loadAssigneeDropdown === 'function') loadAssigneeDropdown();
  }

  if (sectionKey === 'calendar' && !SECTION_LOADED.calendar) {
    SECTION_LOADED.calendar = true;
    loadCalendarData();
    if (typeof loadEventAttendeeCheckboxes === 'function') loadEventAttendeeCheckboxes();
  }
}

// ==========================================
// 5. OBSERVATION LOGS
// ==========================================

let LOCAL_LOGS = [];

async function fetchLiveObservationLogs() {
  const email = localStorage.getItem('userEmail') || localStorage.getItem('currentUser') || '';
  if (API && API.notification) {
    try {
      const logs = await API.notification.get('workhub-fin', 25, email);
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
      await API.system.logAction(traceId, action, text, type === 'danger' ? 'error' : 'success', userEmail, 'workhub-fin', null);
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
// (activeGroup luôn là 'workhub-fin') — cột "Chia sẻ" luôn hiện nút share.
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
  const sortSelect = document.getElementById('progress-sort-select');

  const filterOwner = filterOwnerDropdown ? filterOwnerDropdown.value : "";
  const filterProject = filterProjectDropdown ? filterProjectDropdown.value : "";
  const sortVal = sortSelect ? sortSelect.value : "date_desc";

  let projects = (globalAllProjects || []).filter(p => {
    const matchOwner = !filterOwner || p.owner === filterOwner;
    const matchProject = !filterProject || p.name === filterProject;
    return matchOwner && matchProject;
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

// Chia sẻ dự án sang Dashboard Chung — sao chép dự án + toàn bộ task sang app tổng.
function shareProjectAction(projectId, projectName) {
  Swal.fire({
    title: 'Chia sẻ Dự án?',
    html: `Bạn có muốn sao chép dự án <b>"${projectName}"</b> và toàn bộ công việc sang Dashboard Chung không?<br><small style="color:var(--text-muted);">(Sẽ tạo một bản sao mới)</small>`,
    icon: 'question',
    showCancelButton: true,
    confirmButtonColor: 'var(--gold)',
    cancelButtonColor: 'var(--text-muted)',
    confirmButtonText: 'Chia sẻ ngay',
    cancelButtonText: 'Thôi'
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

function renderTasks(tasks) {
  const tableBody = document.getElementById('task-table-body');
  if (!tableBody) return;
  tableBody.innerHTML = '';

  if (!tasks || tasks.length === 0) {
    tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">Chưa có công việc nào.</td></tr>';
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
      <td style="border-left: 3px solid ${statusColor}; font-weight: 600; ${isSubtask ? 'padding-left: 30px;' : ''}">
        ${isSubtask ? '<i class="fa-solid fa-turn-up fa-rotate-90" style="color:var(--text-muted); font-size:0.75em; margin-right:4px;"></i>' : ''}${escapeHtml(t.name)}
        ${renderLabelChips(t.labels)}
      </td>
      <td>${avatarsHTML}</td>
      <td style="font-size:13px; color:var(--text-secondary); max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${escapeHtml(t.description || '')}">${escapeHtml(t.description || '')}</td>
      <td>${renderBadge('status', t.status)}</td>
      <td style="font-size:13px; color:var(--text-muted);">${escapeHtml(t.dueDate || '--')}${getDueDateBadge(t.dueDate, t.status)}</td>
      <td>${renderBadge('priority', t.priority)}</td>
      <td style="white-space:nowrap;">
        <button class="icon-btn" title="Sửa"
          onclick="openEditTask('${t.id}', '${safeName}', '${escapeHtml(escapeJs(t.status))}', '${escapeHtml(escapeJs(t.priority))}', '${escapeHtml(escapeJs(t.dueDate || ''))}', '${safeAssignees}', '${safeDesc}', '${t.parent_task_id || ''}')">
          <i class="fa-solid fa-pen"></i>
        </button>
        <button class="icon-btn danger" title="Xóa" onclick="deleteTaskAction('${t.id}', '${safeName}')">
          <i class="fa-solid fa-trash"></i>
        </button>
      </td>
    `;
    tableBody.appendChild(tr);
  });
}

function resetTaskModalUI() {
  const form = document.getElementById('task-form');
  if (form) form.reset();
  editingTaskBaseUpdatedAt = null;
  document.getElementById('task-id').value = '';
  document.getElementById('new-task-parent-id').value = '';
  document.querySelectorAll('input[name="task-assignees"]').forEach(cb => cb.checked = false);

  const submitBtn = document.querySelector('button[form="task-form"]');
  if (submitBtn) submitBtn.innerHTML = "Lưu Công Việc";
}

function openAddTask() {
  resetTaskModalUI();
  if (currentTaskProjectID) {
    document.getElementById('new-task-project-id').value = currentTaskProjectID;
  }
  openAppModal('add-task-modal');
}

function openEditTask(id, name, status, priority, dueDate, assigneesStr, description, parentTaskId) {
  const sourceTask = (globalAllTasks || []).find(t => t.id === id);
  editingTaskBaseUpdatedAt = sourceTask ? (sourceTask.updated_at || null) : null;

  const labelsInput = document.getElementById('new-task-labels');
  if (labelsInput) labelsInput.value = sourceTask ? (sourceTask.labels || '') : '';

  document.getElementById('task-id').value = id;
  document.getElementById('new-task-name').value = name;
  document.getElementById('new-task-status').value = status;
  document.getElementById('new-task-priority').value = priority;
  document.getElementById('new-task-duedate').value = dueDate;
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
    labels: normalizeLabels(document.getElementById('new-task-labels') ? document.getElementById('new-task-labels').value : ''),
    baseUpdatedAt: editingTaskBaseUpdatedAt
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
// 6. INITIALIZATION
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
  setupThemeToggle();
  renderObservationLogs();
  updateStageUI('e1');

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
  if (manageEventBtn) manageEventBtn.addEventListener('click', handleToggleImportantClick);

  // Đóng modal Task/Event khi bấm ra ngoài (auth-modal bị khóa nên không áp dụng ở đây)
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    if (overlay.id === 'auth-modal') return;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('open');
    });
  });

  await initAuth();

  const notiBtn = document.getElementById('observation-toggle-btn');
  if (notiBtn) notiBtn.addEventListener('click', toggleObservationDrawer);
});
