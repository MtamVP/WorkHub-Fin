/* --- FILE: /roles/script.js --- */

let currentUserEmail = '';
let isFinAdmin = false;

const ROLE_LABELS = { asset_manager: 'Quản lý & đầu tư tài sản', fin_admin: 'Quản trị phân quyền' };

document.addEventListener('DOMContentLoaded', async function () {
    currentUserEmail = localStorage.getItem('userEmail') || '';

    try {
        const myRolesResp = await callGAS('getMyFinRoles', { email: currentUserEmail });
        isFinAdmin = (myRolesResp.data || []).includes('fin_admin');
    } catch (e) {
        console.error('Lỗi getMyFinRoles:', e);
    }

    const adminPanel = document.getElementById('admin-panel');
    if (adminPanel) adminPanel.style.display = isFinAdmin ? 'block' : 'none';

    const grantForm = document.getElementById('grant-form');
    if (grantForm) grantForm.addEventListener('submit', handleGrant);

    await loadRoles();
});

async function loadRoles() {
    const tbody = document.getElementById('roles-table-body');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="3" class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i> Đang tải...</td></tr>';

    try {
        const response = await callGAS('listFinRoles');
        const members = response.data || [];

        if (members.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="empty-state">Chưa có thành viên nào trong nhóm Finance.</td></tr>';
            return;
        }

        tbody.innerHTML = members.map(m => `
            <tr>
                <td>
                    <div class="member-name">${escapeRolesHtml(m.nickname)}</div>
                    <div class="member-email">${escapeRolesHtml(m.email)}</div>
                </td>
                <td>${renderRoleBadges(m)}</td>
                <td class="text-right">${renderRevokeButtons(m)}</td>
            </tr>`).join('');

        if (isFinAdmin) populateMemberSelect(members);
    } catch (e) {
        console.error('Lỗi loadRoles:', e);
        tbody.innerHTML = `<tr><td colspan="3" class="empty-state text-danger">Lỗi: ${escapeRolesHtml(e.message)}</td></tr>`;
    }
}

function renderRoleBadges(member) {
    if (!member.roles || member.roles.length === 0) {
        return '<span class="role-badge role-badge-none">Chưa có vai trò</span>';
    }
    return member.roles.map(r => `<span class="role-badge"><i class="fa-solid fa-shield-halved"></i>${escapeRolesHtml(ROLE_LABELS[r] || r)}</span>`).join('');
}

function renderRevokeButtons(member) {
    if (!isFinAdmin || !member.roles || member.roles.length === 0) return '';
    return member.roles.map(r => `
        <button class="btn-revoke" data-email="${escapeRolesHtml(member.email)}" data-role="${escapeRolesHtml(r)}"
            onclick="handleRevoke(this)" title="Gỡ vai trò: ${escapeRolesHtml(ROLE_LABELS[r] || r)}">
            <i class="fa-solid fa-xmark"></i>
        </button>`).join('');
}

function populateMemberSelect(members) {
    const select = document.getElementById('grant-member');
    if (!select) return;
    select.innerHTML = '<option value="">-- Chọn --</option>' +
        members.map(m => `<option value="${escapeRolesHtml(m.email)}">${escapeRolesHtml(m.nickname)} (${escapeRolesHtml(m.email)})</option>`).join('');
}

async function handleGrant(e) {
    e.preventDefault();
    const targetEmail = document.getElementById('grant-member').value;
    const role = document.getElementById('grant-role').value;

    if (!targetEmail) {
        showToast('Vui lòng chọn thành viên', 'error');
        return;
    }

    try {
        await callGAS('grantFinRole', { targetEmail, role, byEmail: currentUserEmail });
        showToast('Đã gán vai trò thành công', 'success');
        await loadRoles();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

async function handleRevoke(btn) {
    const targetEmail = btn.dataset.email;
    const role = btn.dataset.role;
    try {
        await callGAS('revokeFinRole', { targetEmail, role });
        showToast('Đã gỡ vai trò', 'success');
        await loadRoles();
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
    }
}

function escapeRolesHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

function showToast(message, type = 'success') {
    const existing = document.querySelector('.toast-notification');
    if (existing) existing.remove();
    const toast = document.createElement('div');
    toast.className = `toast-notification toast-${type}`;
    const icon = type === 'success' ? '<i class="fa-solid fa-circle-check"></i>' : '<i class="fa-solid fa-circle-exclamation"></i>';
    toast.innerHTML = `${icon} <span>${message}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}
