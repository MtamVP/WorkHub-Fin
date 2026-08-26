window.openExternalUrl = function (url) {
    if (window.__TAURI__ && window.__TAURI__.opener) {
        window.__TAURI__.opener.openUrl(url).catch(function (err) {
            console.error('Không mở được link trong app desktop:', err);
        });
        return;
    }
    window.open(url, '_blank', 'noopener');
};

window.escapeHtml = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, function (ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
};

window.escapeJs = function (value) {
    return String(value === null || value === undefined ? '' : value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
};

const SUPABASE_URL = "https://gqsbsqaxzpzcloaopzvv.supabase.co";
const SUPABASE_KEY = "sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR";

const TOOLS_SUPABASE_URL = "https://jbibxrhorqmbbyjuxcgo.supabase.co";
const TOOLS_SUPABASE_KEY = "sb_publishable_RgXnbjszBBJJUswXTzlpSA_ixYR3nJ-";

const sbClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const toolsSbClient = window.supabase ? window.supabase.createClient(TOOLS_SUPABASE_URL, TOOLS_SUPABASE_KEY) : null;

window.supabaseClient = sbClient;
window.toolsSupabaseClient = toolsSbClient;
window.WORKHUB_CONFIG = {
    main: {
        url: SUPABASE_URL,
        key: SUPABASE_KEY
    },
    tools: {
        url: TOOLS_SUPABASE_URL,
        key: TOOLS_SUPABASE_KEY
    }
};

// --- MinIO (TrueNAS) file storage, proxied through the Supabase Edge Function
// "storage-proxy" so the MinIO root credential never reaches the client. ---
const STORAGE_PROXY_URL = `${SUPABASE_URL}/functions/v1/storage-proxy`;
const NEW_MINIO_BUCKETS = new Set(['wh-fin-files', 'wh-sci-files', 'wh-org-files']);
let _whAccessToken = null;
if (sbClient) {
    sbClient.auth.getSession().then(({ data }) => { _whAccessToken = data && data.session ? data.session.access_token : null; });
    sbClient.auth.onAuthStateChange((_event, session) => { _whAccessToken = session ? session.access_token : null; });
}
async function getAccessToken() {
    if (_whAccessToken) return _whAccessToken;
    if (!sbClient) return null;
    const { data } = await sbClient.auth.getSession();
    return data && data.session ? data.session.access_token : null;
}
async function storageProxyUpload(bucket, path, blob, contentType) {
    const token = await getAccessToken();
    if (!token) throw new Error("Chưa đăng nhập, không thể tải file lên.");
    const form = new FormData();
    form.append('bucket', bucket);
    form.append('path', path);
    form.append('file', blob, path.split('/').pop());
    const res = await fetch(`${STORAGE_PROXY_URL}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: form
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Tải file lên MinIO thất bại');
    return json;
}
async function storageProxyDelete(bucket, path) {
    const token = await getAccessToken();
    if (!token) throw new Error("Chưa đăng nhập, không thể xoá file.");
    const res = await fetch(`${STORAGE_PROXY_URL}/delete`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket, path })
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) console.error("Lỗi xoá file MinIO:", json.error || res.status);
    return json;
}
function storageProxyUrl(bucket, path) {
    return `${STORAGE_PROXY_URL}/download?bucket=${encodeURIComponent(bucket)}&path=${encodeURIComponent(path)}&token=${encodeURIComponent(_whAccessToken || '')}`;
}
function buildFileUrl(storagePath) {
    if (!storagePath) return '';
    const parts = storagePath.split('/');
    const bucket = parts[0];
    const objectPath = parts.slice(1).join('/');
    if (!bucket || !objectPath) return '';
    // File cũ chưa migrate sang MinIO vẫn còn nằm ở Supabase Storage (bucket cũ dạng
    // "*_bucket") -- chỉ route qua storage-proxy cho file đã thật sự nằm ở MinIO.
    if (NEW_MINIO_BUCKETS.has(bucket)) {
        return storageProxyUrl(bucket, objectPath);
    }
    return `${SUPABASE_URL}/storage/v1/object/public/${storagePath}`;
}

function b64toBlob(b64Data, contentType = '', sliceSize = 512) {
    const byteCharacters = atob(b64Data);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
        const slice = byteCharacters.slice(offset, offset + sliceSize);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
            byteNumbers[i] = slice.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
    }
    return new Blob(byteArrays, { type: contentType });
}

async function getUserId(emailOrUsername) {
    if (!sbClient) return null;
    const { data } = await sbClient.from('users')
        .select('id').or(`nickname.eq.${emailOrUsername},email.eq.${emailOrUsername}`).maybeSingle();
    return data ? data.id : null;
}

function genId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

const API = {
    auth: {
        getRealEmail: async (username) => {
            if (!sbClient) return null;
            const { data, error } = await sbClient.from('users')
                .select('email').or(`nickname.eq.${username},email.eq.${username}`).maybeSingle();
            if (error || !data) return null;
            return data.email;
        },
        getUserGroup: async (email) => {
            if (!sbClient) return 'guest';
            const { data, error } = await sbClient.from('users').select('group_key').eq('email', email).maybeSingle();
            if (error || !data) return 'guest';
            return data.group_key;
        },
        getUserMap: async () => {
            if (!sbClient) return {};
            const { data, error } = await sbClient.from('users').select('email, nickname');
            if (error) return {};
            let map = {};
            data.forEach(u => map[u.email] = u.nickname);
            return map;
        },
        getAllUsers: async (groupKey) => {
            if (!sbClient) return [];
            let query = sbClient.from('users').select('email, name:nickname');
            if (groupKey && groupKey !== 'all' && groupKey !== 'admin') query = query.eq('group_key', groupKey);
            const { data } = await query;
            return data || [];
        },
        getUserInfo: async (email) => {
            if (!sbClient) return { group: 'guest', name: '' };
            const { data, error } = await sbClient.from('users').select('name:nickname, group:group_key').eq('email', email).maybeSingle();
            if (error || !data) return { group: 'guest', name: '' };
            return data;
        },
        updateNickname: async (email, newNickname) => {
            const { error } = await sbClient.from('users').update({ nickname: newNickname }).eq('email', email);
            if (error) throw error;
            return "Success";
        },
        getWallpaper: async (email) => {
            if (!sbClient) return null;
            const { data } = await sbClient.from('users').select('wallpaper').eq('email', email).maybeSingle();
            return data ? data.wallpaper : null;
        },
        updateWallpaper: async (email, wallpaperUrl) => {
            const { error } = await sbClient.from('users').update({ wallpaper: wallpaperUrl }).eq('email', email);
            if (error) throw error;
            return "Đã cập nhật ảnh nền";
        }
    },

    presence: {
        setOnline: async (email, nickname, groupKey = 'finance') => {
            if (!sbClient || !email) return;
            const cleanEmail = email.trim().toLowerCase();
            const displayName = nickname || cleanEmail.split('@')[0];
            try {
                // uid PHẢI là auth.uid() thật (không phải email) -- RLS "Insert/Update own presence"
                // kiểm tra đúng uid = auth.uid(), gửi email vào đây khiến mọi lần ping presence bị
                // chặn im lặng (catch nuốt lỗi) nên trạng thái online/offline không bao giờ cập nhật thật.
                const { data: authData } = await sbClient.auth.getUser();
                const authUid = authData && authData.user ? authData.user.id : null;
                if (!authUid) return;
                await sbClient.from('user_status').upsert({
                    uid: authUid,
                    email: cleanEmail,
                    display_name: displayName,
                    state: 'online',
                    last_changed: new Date().toISOString(),
                    current_group: groupKey,
                    photo_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=C9A84C&color=1A1407&bold=true`
                });
            } catch (err) {
                console.warn("Không thể cập nhật presence online:", err);
            }
        },
        setOffline: async (email) => {
            if (!sbClient || !email) return;
            const cleanEmail = email.trim().toLowerCase();
            try {
                await sbClient.from('user_status').update({
                    state: 'offline',
                    last_changed: new Date().toISOString()
                }).eq('email', cleanEmail);
            } catch (err) {
                console.warn("Không thể cập nhật presence offline:", err);
            }
        },
        getFinanceMembers: async () => {
            if (!sbClient) return [];
            try {
                // 1. Get users belonging to finance, admin, or all
                const { data: usersData, error: userErr } = await sbClient
                    .from('users')
                    .select('email, nickname, group_key, created_at')
                    .eq('group_key', 'finance')
                    .order('created_at', { ascending: false });

                if (userErr) console.warn("Lỗi lấy users:", userErr);

                // 2. Get status for all active users
                const { data: statusData, error: statusErr } = await sbClient
                    .from('user_status')
                    .select('*')
                    .order('last_changed', { ascending: false });

                if (statusErr) console.warn("Lỗi lấy user_status:", statusErr);

                const statusMap = {};
                (statusData || []).forEach(st => {
                    if (st.email) statusMap[st.email.toLowerCase()] = st;
                    if (st.uid) statusMap[st.uid.toLowerCase()] = st;
                });

                const memberMap = new Map();

                // Add from users table
                (usersData || []).forEach(u => {
                    const email = (u.email || '').toLowerCase();
                    if (!email) return;
                    const st = statusMap[email];
                    memberMap.set(email, {
                        email: u.email,
                        nickname: u.nickname || (st ? st.display_name : '') || email.split('@')[0],
                        group_key: u.group_key || 'finance',
                        last_changed: st ? st.last_changed : u.created_at,
                        state: st ? st.state : 'offline',
                        photo_url: st ? st.photo_url : null
                    });
                });

                // Also add any status users whose current_group is finance or who aren't yet in memberMap
                (statusData || []).forEach(st => {
                    const email = (st.email || st.uid || '').toLowerCase();
                    if (email && !memberMap.has(email) && (st.current_group === 'finance' || !st.current_group)) {
                        memberMap.set(email, {
                            email: st.email || st.uid,
                            nickname: st.display_name || email.split('@')[0],
                            group_key: st.current_group || 'finance',
                            last_changed: st.last_changed,
                            state: st.state || 'offline',
                            photo_url: st.photo_url
                        });
                    }
                });

                const now = new Date().getTime();
                const ONLINE_THRESHOLD = 3 * 60 * 1000; // 3 mins

                const members = Array.from(memberMap.values()).map(m => {
                    const lastSeenDate = m.last_changed ? new Date(m.last_changed) : new Date(0);
                    const timeDiff = now - lastSeenDate.getTime();
                    const isOnline = m.state === 'online' && timeDiff < ONLINE_THRESHOLD;
                    return {
                        ...m,
                        isOnline,
                        lastSeenDate,
                        timeDiff
                    };
                });

                // Sort: Online users first, then by latest active, then alphabetical
                members.sort((a, b) => {
                    if (a.isOnline && !b.isOnline) return -1;
                    if (!a.isOnline && b.isOnline) return 1;
                    return b.lastSeenDate.getTime() - a.lastSeenDate.getTime();
                });

                return members;
            } catch (err) {
                console.error("Lỗi getFinanceMembers:", err);
                return [];
            }
        }
    },

    user: {
        listAll: async () => {
            if (!sbClient) return [];
            const { data, error } = await sbClient.from('users').select('email, nickname, group_key, created_at').order('created_at', { ascending: false }).limit(1000);
            if (error) throw error;
            return data;
        },
        provision: async (email, nickname, groupKey) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const cleanEmail = String(email || '').trim().toLowerCase();
            if (!cleanEmail || !cleanEmail.includes('@')) throw new Error("Email không hợp lệ.");

            const { error } = await sbClient.from('users').insert({
                email: cleanEmail,
                nickname: nickname && nickname.trim() ? nickname.trim() : cleanEmail.split('@')[0],
                group_key: groupKey || 'guest'
            });
            if (error) {
                if (error.code === '23505') throw new Error("Email này đã có hồ sơ quyền trong hệ thống rồi.");
                throw error;
            }
            return `Đã cấp quyền trước cho ${cleanEmail}. Người này cần tự đăng ký tài khoản đăng nhập bằng đúng email này.`;
        },
        updateGroup: async (email, groupKey) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('users').update({ group_key: groupKey }).eq('email', email);
            if (error) throw error;
            return `Đã đổi quyền của ${email} thành "${groupKey}"!`;
        },
        remove: async (email) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('users').delete().eq('email', email);
            if (error) throw error;
            return `Đã thu hồi quyền truy cập của ${email}. (Tài khoản đăng nhập Firebase của họ vẫn còn tồn tại nếu có — không tự xóa được từ đây.)`;
        }
    },
    project: {

        list: async (groupKey, searchName = "", archiveScope = 'active') => {
            if (!sbClient) return [];
            let query = sbClient.from('projects').select('*, users!owner_id(nickname)').is('deleted_at', null).order('updated_at', { ascending: false }).limit(300);

            if (archiveScope === 'active') query = query.is('archived_at', null);
            else if (archiveScope === 'archived') query = query.not('archived_at', 'is', null);

            if (groupKey === 'admin') {
                // 'admin' là quyền của TÀI KHOẢN (admin xem trực tiếp trong Fin), không phải app
                // đang chạy -- chỉ ORG mới được phép gộp is_shared từ app khác vào. Trong Fin,
                // admin chỉ nên thấy dự án CỦA Fin (cả group_key cũ 'workhub-fin' lẫn 'finance'
                // mới, xem MTamVP's rename commit), không kéo theo dự án share từ Sci hay dự
                // án riêng của ORG. Fin's own UI luôn gọi bằng activeGroup cố định nên nhánh
                // này hiện không có call site nào kích hoạt, nhưng vẫn khoá chặt để phòng xa.
                query = query.in('group_key', ['finance', 'workhub-fin']);
            } else {
                query = query.eq('group_key', groupKey);
            }
            if (searchName) {
                query = query.ilike('name', `%${searchName}%`);
            }
            query = query.order('updated_at', { ascending: false });

            const { data, error } = await query;
            if (error) throw error;

            const projects = data.map(p => ({
                id: p.id,
                name: p.name,
                owner: p.users ? p.users.nickname : 'Unknown',
                percent: p.percent,
                status: p.status,
                description: p.description,
                lastUpdated: p.updated_at,
                isShared: p.is_shared,
                originGroup: p.group_key,
                archivedAt: p.archived_at,
                overdueCount: 0,
                dueSoonCount: 0
            }));

            if (projects.length > 0) {
                const projectIds = projects.map(p => p.id);
                const { data: openTasks } = await sbClient.from('tasks')
                    .select('project_id, due_date')
                    .in('project_id', projectIds)
                    .is('deleted_at', null)
                    .not('status', 'eq', 'Done')
                    .not('due_date', 'is', null);

                if (openTasks && openTasks.length > 0) {
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    const projectMap = {};
                    projects.forEach(p => { projectMap[p.id] = p; });

                    openTasks.forEach(t => {
                        const p = projectMap[t.project_id];
                        if (!p) return;
                        const due = new Date(t.due_date);
                        due.setHours(0, 0, 0, 0);
                        const diffDays = Math.round((due - today) / 86400000);
                        if (diffDays < 0) p.overdueCount++;
                        else if (diffDays <= 2) p.dueSoonCount++;
                    });
                }
            }

            return projects;
        },
        create: async (projectData, groupKey) => {
            const id = genId("PJ");
            const ownerId = await getUserId(projectData.owner);
            // Cùng lý do như list() ở trên: không stamp thẳng 'admin' vào group_key.
            const effectiveGroupKey = groupKey === 'admin' ? 'finance' : groupKey;

            const { error } = await sbClient.from('projects').insert({
                id: id,
                name: projectData.name,
                owner_id: ownerId,
                status: projectData.status || "Planning",
                description: projectData.description || '',
                group_key: effectiveGroupKey
            });
            if (error) throw error;
            return `Đã tạo dự án ${projectData.name}!`;
        },
        updateNote: async (projectId, payload, groupKey) => {
            const updates = { updated_at: new Date().toISOString() };
            if (payload && payload.status) updates.status = payload.status;
            if (payload && payload.description !== undefined) updates.description = payload.description;

            const expectedVersion = payload && payload.expectedVersion;
            let query = sbClient.from('projects').update(updates).eq('id', projectId);
            if (expectedVersion !== undefined && expectedVersion !== null) {
                query = query.eq('version', expectedVersion);
            }
            const { data, error } = await query.select('name').maybeSingle();
            if (error) throw error;
            if (expectedVersion !== undefined && expectedVersion !== null && !data) {
                throw new Error("Người khác vừa sửa dự án này. Hãy đóng cửa sổ, xem lại nội dung mới rồi sửa lại để không ghi đè lên thay đổi của họ.");
            }
            return `Đã cập nhật dự án "${data ? data.name : ''}" thành công!`;
        },
        share: async (projectId, groupKey) => {
            const { data, error } = await sbClient.from('projects').update({ is_shared: true }).eq('id', projectId).select('name').maybeSingle();
            if (error) throw error;
            return `Đã chia sẻ ${data.name} thành công!`;
        },

        setArchived: async (projectId, archived) => {
            const { data, error } = await sbClient.from('projects')
                .update({ archived_at: archived ? new Date().toISOString() : null })
                .eq('id', projectId).select('name').maybeSingle();
            if (error) throw error;
            return archived ? `Đã lưu trữ "${data.name}".` : `Đã đưa "${data.name}" trở lại danh sách đang chạy.`;
        },
        delete: async (projectId, groupKey) => {

            await sbClient.from('tasks')
                .update({ deleted_at: new Date().toISOString(), deleted_by_cascade: true })
                .eq('project_id', projectId)
                .is('deleted_at', null);

            const { data, error } = await sbClient.from('projects').update({ deleted_at: new Date().toISOString() }).eq('id', projectId).select('name').maybeSingle();
            if (error) throw error;
            return `Đã đưa ${data.name} vào thùng rác!`;
        },
        listWithStats: async (groupKey, searchName = "", archiveScope = 'active') => {
            const projects = await API.project.list(groupKey, searchName, archiveScope);
            if (!projects || projects.length === 0) return [];

            const projectIds = projects.map(p => p.id);
            const { data: tasks } = await sbClient.from('tasks').select('project_id, status, updated_at').is('deleted_at', null).in('project_id', projectIds);

            for (let p of projects) {
                p.taskStats = { done: 0, working: 0, stuck: 0, notStarted: 0 };
                p.latestActivity = p.lastUpdated || new Date(0).toISOString();
                const dbPercent = p.percent || 0;

                if (tasks) {
                    const pTasks = tasks.filter(t => t.project_id === p.id);
                    pTasks.forEach(t => {
                        let st = String(t.status).toLowerCase();
                        if (st === 'done') p.taskStats.done++;
                        else if (st === 'working on it') p.taskStats.working++;
                        else if (st === 'stuck') p.taskStats.stuck++;
                        else p.taskStats.notStarted++;

                        if (t.updated_at && new Date(t.updated_at) > new Date(p.latestActivity)) {
                            p.latestActivity = t.updated_at;
                        }
                    });

                    if (pTasks.length > 0) {
                        p.percent = Math.round((p.taskStats.done / pTasks.length) * 100);
                    } else {
                        p.percent = 0;
                    }
                } else {
                    p.percent = 0;
                }

                if (p.percent !== dbPercent) {
                    sbClient.from('projects').update({ percent: p.percent }).eq('id', p.id).then(({error}) => {
                        if (error) console.error("Lỗi tự động cập nhật percent:", error);
                    });
                }
            }

            projects.sort((a, b) => new Date(b.latestActivity) - new Date(a.latestActivity));

            return projects;
        },
        // recalculate() bị xóa: projects.percent giờ được trigger
        // trg_tasks_recalc_project_percent trên bảng tasks tự tính lại ngay trong cùng
        // transaction mỗi khi task được thêm/sửa/xóa -- không còn phụ thuộc việc gọi đúng
        // hàm này ở đúng chỗ sau mỗi mutation nữa (lớp lỗi "quên gọi recalculate" đã hết).
        getMilestones: async (projectId) => {
            const { data, error } = await sbClient.from('project_milestones').select('*').eq('project_id', projectId).order('target_date', { ascending: true, nullsFirst: false });
            if (error) throw error;
            return data;
        },
        addMilestone: async (projectId, title, targetDate) => {
            if (!title || !title.trim()) throw new Error("Tên cột mốc không được để trống.");
            const { error } = await sbClient.from('project_milestones').insert({
                id: genId("MS"),
                project_id: projectId,
                title: title.trim(),
                target_date: targetDate || null
            });
            if (error) throw error;
            return "Đã thêm cột mốc!";
        },
        toggleMilestone: async (milestoneId, isDone) => {
            const { error } = await sbClient.from('project_milestones').update({ is_done: isDone }).eq('id', milestoneId);
            if (error) throw error;
            return "Đã cập nhật cột mốc!";
        },
        deleteMilestone: async (milestoneId) => {
            const { error } = await sbClient.from('project_milestones').delete().eq('id', milestoneId);
            if (error) throw error;
            return "Đã xóa cột mốc!";
        },
        getBurndownData: async (projectId) => {
            const { data, error } = await sbClient.from('tasks').select('status, created_at, updated_at').is('deleted_at', null).eq('project_id', projectId);
            if (error) throw error;
            return data;
        }
    },
    task: {

        _fetchAssigneeMap: async (taskIds) => {
            const map = {};
            if (!sbClient || !Array.isArray(taskIds) || taskIds.length === 0) return map;
            const { data, error } = await sbClient.from('task_assignees')
                .select('task_id, user_email').in('task_id', taskIds);
            if (error) throw error;
            (data || []).forEach(row => {
                if (!map[row.task_id]) map[row.task_id] = [];
                map[row.task_id].push(row.user_email);
            });
            return map;
        },

        _writeAssignees: async (taskId, emails) => {
            if (!sbClient || !taskId) return [];
            const clean = (Array.isArray(emails)
                ? emails
                : String(emails || '').split(','))
                .map(e => String(e).trim().toLowerCase())
                .filter(Boolean);
            const unique = Array.from(new Set(clean));

            const { error: delErr } = await sbClient.from('task_assignees').delete().eq('task_id', taskId);
            if (delErr) throw delErr;
            if (unique.length > 0) {
                const { error: insErr } = await sbClient.from('task_assignees')
                    .insert(unique.map(email => ({ task_id: taskId, user_email: email })));
                if (insErr) throw insErr;
            }
            return unique;
        },
        list: async (projectId, groupKey) => {
            const { data, error } = await sbClient.from('tasks').select('*').is('deleted_at', null).eq('project_id', projectId)
                .order('sort_order', { ascending: true }).order('created_at', { ascending: true }).limit(1000);
            if (error) throw error;

            const { data: users } = await sbClient.from('users').select('email, nickname');
            if (data) {
                const assigneeMap = await API.task._fetchAssigneeMap(data.map(t => t.id));
                data.forEach(task => {
                    task.dueDate = task.due_date ? task.due_date.slice(0, 10) : '';
                    const emails = assigneeMap[task.id] || [];

                    task.assignees = emails.join(', ');
                    task.assigneeEmails = emails;
                    if (users && emails.length > 0) {
                        task.assigneeNames = emails.map(email => {
                            const u = users.find(user => user.email && user.email.toLowerCase() === email);
                            return (u && u.nickname) ? u.nickname : email.split('@')[0];
                        });
                    }
                });
            }
            return data;
        },

        listMine: async (email, groupKey) => {
            if (!sbClient || !email) return [];
            const targetEmail = String(email).trim().toLowerCase();

            let projectQuery = sbClient.from('projects').select('id, name').is('deleted_at', null);
            if (groupKey && groupKey !== 'all' && groupKey !== 'admin') projectQuery = projectQuery.eq('group_key', groupKey);
            const { data: projects } = await projectQuery;
            if (!projects || projects.length === 0) return [];

            const projectMap = {};
            projects.forEach(p => { projectMap[p.id] = p.name; });
            const projectIds = projects.map(p => p.id);

            const { data: rows, error: aErr } = await sbClient.from('task_assignees')
                .select('task_id').eq('user_email', targetEmail).limit(2000);
            if (aErr) throw aErr;
            const myTaskIds = (rows || []).map(r => r.task_id);
            if (myTaskIds.length === 0) return [];

            const { data, error } = await sbClient.from('tasks').select('*')
                .is('deleted_at', null)
                .in('project_id', projectIds)
                .in('id', myTaskIds)
                .limit(2000);
            if (error) throw error;

            const mine = data || [];
            const assigneeMap = await API.task._fetchAssigneeMap(mine.map(t => t.id));
            mine.forEach(task => {
                task.dueDate = task.due_date ? task.due_date.slice(0, 10) : '';
                task.projectName = projectMap[task.project_id] || '';
                const emails = assigneeMap[task.id] || [];
                task.assignees = emails.join(', ');
                task.assigneeEmails = emails;
            });

            mine.sort((a, b) => {
                if (!a.dueDate && !b.dueDate) return 0;
                if (!a.dueDate) return 1;
                if (!b.dueDate) return -1;
                return a.dueDate.localeCompare(b.dueDate);
            });

            return mine;
        },

        workload: async (groupKey) => {
            if (!sbClient) return [];

            let projectQuery = sbClient.from('projects').select('id').is('deleted_at', null).is('archived_at', null);
            // admin ở Fin chỉ nên thấy khối lượng công việc của dự án THUỘC Fin, không kéo
            // theo dự án của Sci/ORG -- cùng quy tắc app-scoped visibility như project.list.
            projectQuery = groupKey === 'admin'
                ? projectQuery.in('group_key', ['finance', 'workhub-fin'])
                : projectQuery.eq('group_key', groupKey);
            const { data: projects } = await projectQuery;
            if (!projects || projects.length === 0) return [];
            const projectIds = projects.map(p => p.id);

            const { data: tasks, error } = await sbClient.from('tasks')
                .select('id, status, priority, due_date')
                .is('deleted_at', null)
                .in('project_id', projectIds)
                .not('status', 'eq', 'Done')
                .limit(2000);
            if (error) throw error;

            const wlAssigneeMap = await API.task._fetchAssigneeMap((tasks || []).map(t => t.id));

            const { data: users } = await sbClient.from('users').select('email, nickname');
            const nameByEmail = {};
            (users || []).forEach(u => { if (u.email) nameByEmail[u.email.toLowerCase()] = u.nickname; });

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const buckets = {};

            (tasks || []).forEach(t => {
                const emails = wlAssigneeMap[t.id] || [];
                const targets = emails.length > 0 ? emails : ['__unassigned__'];

                targets.forEach(email => {
                    if (!buckets[email]) {
                        buckets[email] = {
                            email: email === '__unassigned__' ? '' : email,
                            name: email === '__unassigned__' ? 'Chưa giao ai' : (nameByEmail[email] || email.split('@')[0]),
                            total: 0, notStarted: 0, working: 0, stuck: 0, overdue: 0, highPriority: 0
                        };
                    }
                    const b = buckets[email];
                    b.total++;

                    const status = String(t.status || '').toLowerCase();
                    if (status === 'working on it') b.working++;
                    else if (status === 'stuck') b.stuck++;
                    else b.notStarted++;

                    if (t.priority === 'Critical' || t.priority === 'High') b.highPriority++;

                    if (t.due_date && new Date(t.due_date.slice(0, 10) + 'T00:00:00') < today) b.overdue++;
                });
            });

            return Object.values(buckets).sort((a, b) => b.total - a.total);
        },
        delete: async (taskId, projectId, groupKey) => {

            await sbClient.from('tasks')
                .update({ deleted_at: new Date().toISOString(), deleted_by_cascade: true })
                .eq('parent_task_id', taskId)
                .is('deleted_at', null);
            const { data, error } = await sbClient.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', taskId).select('name').maybeSingle();
            if (error) throw error;
            return `Đã đưa ${data.name} vào thùng rác!`;
        },
        deleteFile: async (taskId, fileId, groupKey) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");

            const { data: task, error: fetchError } = await sbClient.from('tasks').select('attachments').eq('id', taskId).maybeSingle();
            if (fetchError) throw fetchError;

            let attachments = typeof task.attachments === 'string' ? JSON.parse(task.attachments || '[]') : task.attachments;
            if (!Array.isArray(attachments)) attachments = [];

            const fileToDelete = attachments.find(f => f.id === fileId);
            if (!fileToDelete) throw new Error("Không tìm thấy file trong task này.");

            if (fileToDelete.id.startsWith("TF_")) {
                if (fileToDelete.bucket && fileToDelete.path) {
                    await storageProxyDelete(fileToDelete.bucket, fileToDelete.path);
                } else if (fileToDelete.url) {
                    const urlParts = fileToDelete.url.split('/general_bucket/');
                    if (urlParts.length > 1) {
                        const filePath = decodeURIComponent(urlParts[1]);
                        const { error: deleteError } = await sbClient.storage.from('general_bucket').remove([filePath]);
                        if (deleteError) console.error("Lỗi xóa file storage:", deleteError);
                    }
                }
            }

            const newAttachments = attachments.filter(f => f.id !== fileId);
            const { error: updateError } = await sbClient.from('tasks').update({ attachments: newAttachments }).eq('id', taskId);
            if (updateError) throw updateError;

            return newAttachments;
        },
        save: async (taskData, groupKey) => {
            const isNew = !taskData.id;
            taskData.id = taskData.id || genId("T");

            // Vòng lặp phụ thuộc và "không thể Done khi còn blocker" từng được kiểm tra
            // ở đây (đọc trước rồi mới ghi) -- giờ do trigger validate_task_dependencies
            // trên chính bảng tasks đảm nhiệm, chặn ở tầng DB cho MỌI đường ghi chứ không
            // chỉ đường này. Lỗi ném ra từ if (error) throw error phía dưới đã đúng nguyên
            // văn tiếng Việt của trigger, không cần map lại.
            const payload = {
                project_id: taskData.projectId,
                name: taskData.name,
                status: taskData.status,
                priority: taskData.priority,
                due_date: taskData.dueDate,
                description: taskData.description,
                attachments: typeof taskData.attachments === 'string' ? JSON.parse(taskData.attachments || '[]') : taskData.attachments,
                assignees: Array.isArray(taskData.assignees) ? taskData.assignees.join(', ') : taskData.assignees,
                parent_task_id: taskData.parentTaskId || null,
                blocked_by: taskData.blockedBy || null,
                labels: taskData.labels || null
            };

            if (isNew) {
                const { error } = await sbClient.from('tasks').insert({ id: taskData.id, ...payload });
                if (error) throw error;
            } else {
                // version = optimistic-lock token (see [[workhub-group-key-privesc-fixed]]-style fix:
                // tasks.version auto-increments via DB trigger on every UPDATE). Matching it in the
                // WHERE clause makes the whole check-and-write atomic in one statement -- no separate
                // read-then-compare round trip that a concurrent writer could slip in between.
                const expectedVersion = taskData.expectedVersion;
                let query = sbClient.from('tasks').update(payload).eq('id', taskData.id);
                if (expectedVersion !== undefined && expectedVersion !== null) {
                    query = query.eq('version', expectedVersion);
                }
                const { data, error } = await query.select('id');
                if (error) throw error;
                if (expectedVersion !== undefined && expectedVersion !== null && (!data || data.length === 0)) {
                    throw new Error("Người khác vừa sửa công việc này. Hãy đóng cửa sổ, xem lại nội dung mới rồi sửa lại để không ghi đè lên thay đổi của họ.");
                }
            }
            await API.task._writeAssignees(taskData.id, taskData.assignees);
            return `Đã lưu task "${taskData.name}"!`;
        },

        getChecklist: async (taskId) => {
            const { data, error } = await sbClient.from('tasks').select('checklist').eq('id', taskId).maybeSingle();
            if (error) throw error;
            return Array.isArray(data.checklist) ? data.checklist : [];
        },
        addChecklistItem: async (taskId, text) => {
            if (!text || !text.trim()) throw new Error("Nội dung mục không được để trống.");
            const current = await API.task.getChecklist(taskId);
            current.push({ id: genId("CL"), text: text.trim(), done: false });
            const { error } = await sbClient.from('tasks').update({ checklist: current }).eq('id', taskId);
            if (error) throw error;
            return current;
        },
        toggleChecklistItem: async (taskId, itemId, done) => {
            const current = await API.task.getChecklist(taskId);
            const next = current.map(it => it.id === itemId ? { ...it, done: !!done } : it);
            const { error } = await sbClient.from('tasks').update({ checklist: next }).eq('id', taskId);
            if (error) throw error;
            return next;
        },
        deleteChecklistItem: async (taskId, itemId) => {
            const current = await API.task.getChecklist(taskId);
            const next = current.filter(it => it.id !== itemId);
            const { error } = await sbClient.from('tasks').update({ checklist: next }).eq('id', taskId);
            if (error) throw error;
            return next;
        },
        reorder: async (orderedIds) => {
            if (!sbClient || !Array.isArray(orderedIds)) return "OK";
            await Promise.all(orderedIds.map((id, idx) =>
                sbClient.from('tasks').update({ sort_order: idx }).eq('id', id)
            ));
            return "Đã cập nhật thứ tự!";
        },
        bulkUpdateStatus: async (taskIds, status, projectId, groupKey) => {
            if (!Array.isArray(taskIds) || taskIds.length === 0) return "Không có công việc nào được chọn.";
            const { error } = await sbClient.from('tasks').update({ status, updated_at: new Date().toISOString() }).in('id', taskIds);
            if (error) throw error;
            return `Đã cập nhật trạng thái cho ${taskIds.length} công việc!`;
        },

        bulkAssign: async (taskIds, assignees, projectId, groupKey) => {
            if (!Array.isArray(taskIds) || taskIds.length === 0) return "Không có công việc nào được chọn.";
            const { error } = await sbClient.from('tasks')
                .update({ assignees: assignees || null, updated_at: new Date().toISOString() })
                .in('id', taskIds);
            if (error) throw error;

            await Promise.all(taskIds.map(id => API.task._writeAssignees(id, assignees)));
            return `Đã gán người thực hiện cho ${taskIds.length} công việc!`;
        },
        bulkSetDueDate: async (taskIds, dueDate, projectId, groupKey) => {
            if (!Array.isArray(taskIds) || taskIds.length === 0) return "Không có công việc nào được chọn.";
            const { error } = await sbClient.from('tasks')
                .update({ due_date: dueDate || null, updated_at: new Date().toISOString() })
                .in('id', taskIds);
            if (error) throw error;
            return dueDate
                ? `Đã đặt hạn chót cho ${taskIds.length} công việc!`
                : `Đã xóa hạn chót của ${taskIds.length} công việc!`;
        },

        bulkAddLabel: async (taskIds, label, projectId, groupKey) => {
            if (!Array.isArray(taskIds) || taskIds.length === 0) return "Không có công việc nào được chọn.";
            const cleanLabel = String(label || '').trim();
            if (!cleanLabel) throw new Error("Chưa nhập nhãn cần gắn.");

            const { data: rows, error: fetchError } = await sbClient.from('tasks').select('id, labels').in('id', taskIds);
            if (fetchError) throw fetchError;

            await Promise.all((rows || []).map(row => {
                const existing = String(row.labels || '').split(',').map(x => x.trim()).filter(Boolean);
                const alreadyHas = existing.some(l => l.toLowerCase() === cleanLabel.toLowerCase());
                const merged = alreadyHas ? existing : [...existing, cleanLabel];
                return sbClient.from('tasks').update({ labels: merged.join(', '), updated_at: new Date().toISOString() }).eq('id', row.id);
            }));

            return `Đã gắn nhãn "${cleanLabel}" cho ${taskIds.length} công việc!`;
        },
        bulkDelete: async (taskIds, projectId, groupKey) => {
            if (!Array.isArray(taskIds) || taskIds.length === 0) return "Không có công việc nào được chọn.";
            await sbClient.from('tasks')
                .update({ deleted_at: new Date().toISOString(), deleted_by_cascade: true })
                .in('parent_task_id', taskIds)
                .is('deleted_at', null);
            const { error } = await sbClient.from('tasks').update({ deleted_at: new Date().toISOString() }).in('id', taskIds);
            if (error) throw error;
            return `Đã xóa ${taskIds.length} công việc!`;
        },
        getComments: async (taskId) => {
            const { data, error } = await sbClient.from('task_comments').select('*').eq('task_id', taskId).order('created_at', { ascending: true });
            if (error) throw error;
            return data;
        },
        addComment: async (taskId, content, authorEmail, mentionedEmails) => {
            if (!content || !content.trim()) throw new Error("Bình luận không được để trống.");
            const { error } = await sbClient.from('task_comments').insert({
                task_id: taskId,
                author_email: authorEmail || 'unknown',
                content: content.trim(),
                mentioned_emails: mentionedEmails || null
            });
            if (error) throw error;
            return "Đã thêm bình luận!";
        },
        getHistory: async (taskId) => {
            const { data, error } = await sbClient.from('system_logs').select('*').eq('entity_id', taskId).order('created_at', { ascending: true });
            if (error) throw error;
            return data;
        },
        uploadFile: async (fileData, fileName, mimeType, taskId, groupKey, description, uploaderEmail) => {
            if (!sbClient) return { success: false, message: "Chưa setup Supabase" };

            if (fileData.includes('base64,')) fileData = fileData.split('base64,')[1];
            const blob = b64toBlob(fileData, mimeType);
            const fileId = genId("TF");
            const safeFileName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
            const filePath = `tasks/${taskId}/${fileId}_${safeFileName}`;
            const bucketName = 'wh-org-files';

            await storageProxyUpload(bucketName, filePath, blob, mimeType);

            const { data: task, error: fetchError } = await sbClient.from('tasks').select('attachments').eq('id', taskId).maybeSingle();
            if (fetchError) throw fetchError;

            let attachments = typeof task.attachments === 'string' ? JSON.parse(task.attachments || '[]') : task.attachments;
            if (!Array.isArray(attachments)) attachments = [];

            attachments.push({
                id: fileId,
                name: fileName,
                bucket: bucketName,
                path: filePath,
                url: storageProxyUrl(bucketName, filePath),
                mimeType: mimeType,
                uploader: uploaderEmail || "unknown",
                date: new Date().toLocaleString('vi-VN')
            });

            await sbClient.from('tasks').update({ attachments }).eq('id', taskId);
            return attachments;
        }
    },
    file: {
        list: async (groupKey, filters) => {
            if (!sbClient) return [];
            let query = sbClient.from('files').select('*, users!uploader_id(email)').is('deleted_at', null).order('created_at', { ascending: false }).limit(500);
            if (groupKey === 'admin') {
                // Cùng lý do như project.list(): admin xem trực tiếp trong Fin chỉ nên thấy
                // file CỦA Fin, không kéo theo file share từ Sci hay file riêng của ORG.
                query = query.in('group_key', ['finance', 'workhub-fin']);
            } else {
                query = query.eq('group_key', groupKey);
            }
            if (filters && filters.projectId) {
                query = query.eq('project_id', filters.projectId);
            }
            const { data, error } = await query;
            if (error) throw error;

            return data.map(f => {
                let folderPath = "/";
                if (f.storage_path) {
                    const parts = f.storage_path.split('/');
                    let startIndex = 1;
                    if (parts.length > 1 && parts[1] === 'bronze') {
                        startIndex = 2;
                    }
                    if (parts.length > startIndex + 1) {
                        folderPath = parts.slice(startIndex, -1).join('/') + '/';
                    }
                }
                return {
                    id: f.id,
                    name: f.name,
                    description: f.description,
                    folderPath: folderPath,
                    projectId: f.project_id,
                    taskId: f.task_id,
                    uploader: f.users ? f.users.email : 'Unknown',
                    date: new Date(f.created_at).toLocaleString('vi-VN'),
                    url: buildFileUrl(f.storage_path),
                    mimeType: f.mime_type,
                    isShared: f.is_shared,
                    groupKey: f.group_key
                };
            });
        },
        delete: async (fileId, groupKey) => {
            const { data, error } = await sbClient.from('files').update({ deleted_at: new Date().toISOString() }).eq('id', fileId).select('name').maybeSingle();
            if (error) throw error;
            return `Đã đưa ${data.name} vào thùng rác!`;
        },
        share: async (fileId, groupKey) => {
            const { data, error } = await sbClient.from('files').update({ is_shared: true }).eq('id', fileId).select('name').maybeSingle();
            if (error) throw error;
            return `Đã share ${data.name} thành công!`;
        },
        getRecentFilesForDashboard: async (groupKey) => {
            return API.file.list(groupKey, {});
        },
        upload: async (fileData, fileName, mimeType, groupKey, description, uploaderEmail, folderPath = "", projectId = null, taskId = null) => {
            if (!sbClient) throw new Error("Supabase chưa được cấu hình.");

            if (fileData.includes('base64,')) fileData = fileData.split('base64,')[1];

            const blob = b64toBlob(fileData, mimeType);
            const fileId = "F_" + Date.now() + Math.floor(Math.random()*1000);
            
            // Xử lý giữ nguyên chữ tiếng Việt không dấu thay vì xóa trắng
            let normalizedName = fileName.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
            const safeFileName = normalizedName.replace(/[^a-zA-Z0-9.\-_ ]/g, '_').replace(/\s+/g, '_');
            
            const filePath = `${fileId}_${safeFileName}`;
            const bucketName = groupKey === 'finance' ? 'wh-fin-files' :
                (groupKey === 'science' ? 'wh-sci-files' : 'wh-org-files');
            // Admin tải file trực tiếp trong Fin ('admin') vẫn phải là file của Fin, không
            // stamp thẳng 'admin' (cùng lý do như project.create()).
            const effectiveGroupKey = groupKey === 'admin' ? 'finance' : groupKey;

            const fullStoragePath = `bronze/${folderPath ? folderPath + '/' : ''}${filePath}`;

            await storageProxyUpload(bucketName, fullStoragePath, blob, mimeType);

            const uploaderId = await getUserId(uploaderEmail);
            const { error: dbError } = await sbClient.from('files').insert({
                id: fileId,
                name: fileName,
                storage_path: `${bucketName}/${fullStoragePath}`,
                mime_type: mimeType,
                uploader_id: uploaderId,
                group_key: effectiveGroupKey,
                description: description || '',
                project_id: projectId || null,
                task_id: taskId || null
            });

            if (dbError) throw dbError;
            return `File "${fileName}" đã được tải lên thành công!`;
        }
    },
    calendar: {
        getEvents: async (startDate, endDate, calendarType, groupKey, email) => {

            let query = sbClient.from('events')
                .select('*')
                .is('deleted_at', null)
                .eq('group_key', groupKey)
                .limit(2000);

            if (calendarType) {
                query = query.eq('calendar_type', calendarType);
                if (calendarType === 'personal' && email) {
                    query = query.eq('created_by', email);
                }
            }

            const { data, error } = await query;
            if (error) throw error;

            const rangeStart = new Date(startDate);
            const rangeEnd = new Date(endDate);
            const results = [];

            const advance = (date, unit, n) => {
                const d = new Date(date);
                if (unit === 'daily') d.setDate(d.getDate() + n);
                else if (unit === 'weekly') d.setDate(d.getDate() + n * 7);
                else if (unit === 'monthly') d.setMonth(d.getMonth() + n);
                return d;
            };

            data.forEach(ev => {
                const baseStart = new Date(ev.start_time);
                const baseEnd = new Date(ev.end_time);
                const duration = baseEnd - baseStart;
                const recurrence = ev.recurrence || 'none';

                const pushInstance = (s) => results.push({
                    id: ev.id,
                    title: ev.title,
                    startTime: s.toISOString(),
                    endTime: new Date(s.getTime() + duration).toISOString(),
                    isImportant: ev.is_important,
                    location: ev.location,
                    description: ev.description,
                    recurrence: recurrence,
                    recurrenceEnd: ev.recurrence_end,
                    attendees: ev.attendees,
                    createdBy: ev.created_by
                });

                if (recurrence === 'none') {
                    if (baseEnd >= rangeStart && baseStart <= rangeEnd) pushInstance(baseStart);
                    return;
                }

                const recEnd = ev.recurrence_end ? new Date(ev.recurrence_end + 'T23:59:59') : null;
                if (recEnd && recEnd < rangeStart) return;
                if (baseStart > rangeEnd) return;

                let cursor = new Date(baseStart);
                if (cursor < rangeStart) {
                    const periodMs = recurrence === 'daily' ? 86400000 : recurrence === 'weekly' ? 7 * 86400000 : 30 * 86400000;
                    const approxN = Math.floor((rangeStart - cursor) / periodMs);
                    if (approxN > 0) cursor = advance(cursor, recurrence, approxN);
                    cursor = advance(cursor, recurrence, -2);
                    if (cursor < baseStart) cursor = new Date(baseStart);
                }

                let guard = 0;
                while (cursor <= rangeEnd && (!recEnd || cursor <= recEnd) && guard < 60) {
                    guard++;
                    const instEnd = new Date(cursor.getTime() + duration);
                    if (instEnd >= rangeStart && cursor <= rangeEnd) pushInstance(cursor);
                    cursor = advance(cursor, recurrence, 1);
                }
            });

            if (calendarType !== 'personal') {
                let projQuery = sbClient.from('projects').select('id, name').is('deleted_at', null);
                projQuery = groupKey === 'admin'
                    ? projQuery.in('group_key', ['finance', 'workhub-fin'])
                    : projQuery.eq('group_key', groupKey);
                const { data: projectsForTasks } = await projQuery;

                if (projectsForTasks && projectsForTasks.length > 0) {
                    const projMap = {};
                    projectsForTasks.forEach(p => { projMap[p.id] = p.name; });
                    const projIds = projectsForTasks.map(p => p.id);

                    const { data: dueTasks } = await sbClient.from('tasks')
                        .select('id, name, due_date, status, priority, project_id')
                        .is('deleted_at', null)
                        .in('project_id', projIds)
                        .not('due_date', 'is', null)
                        .gte('due_date', rangeStart.toISOString().slice(0, 10))
                        .lte('due_date', rangeEnd.toISOString().slice(0, 10));

                    (dueTasks || []).forEach(t => {
                        if (String(t.status).toLowerCase() === 'done') return;

                        const dueDay = String(t.due_date).slice(0, 10);
                        results.push({
                            id: 'TASK_' + t.id,
                            taskId: t.id,
                            title: t.name,
                            startTime: dueDay + 'T00:00:00',
                            endTime: dueDay + 'T23:59:59',
                            isImportant: t.priority === 'Critical' || t.priority === 'High',
                            location: '',
                            description: '',
                            recurrence: 'none',
                            recurrenceEnd: null,
                            attendees: null,
                            createdBy: null,
                            type: 'task',
                            projectId: t.project_id,
                            projectName: projMap[t.project_id] || '',
                            status: t.status
                        });
                    });
                }
            }

            return results;
        },
        create: async (eventData, calendarType, groupKey, email) => {
            const { error } = await sbClient.from('events').insert({
                id: genId("EV"),
                title: eventData.title,
                start_time: eventData.startDate + ' ' + eventData.startTime,
                end_time: eventData.endDate + ' ' + eventData.endTime,
                description: eventData.description,
                location: eventData.location,
                calendar_type: calendarType,
                group_key: groupKey,
                created_by: email,
                recurrence: eventData.recurrence || 'none',
                recurrence_end: eventData.recurrenceEnd || null,
                attendees: eventData.attendees || null
            });
            if (error) throw error;
            return `Tạo sự kiện "${eventData.title}" thành công!`;
        },
        updateEvent: async (eventId, eventData, calendarType, groupKey, email) => {
            let query = sbClient.from('events').update({
                title: eventData.title,
                start_time: eventData.startDate + ' ' + eventData.startTime,
                end_time: eventData.endDate + ' ' + eventData.endTime,
                description: eventData.description,
                location: eventData.location,
                recurrence: eventData.recurrence || 'none',
                recurrence_end: eventData.recurrenceEnd || null,
                attendees: eventData.attendees || null
            }).eq('id', eventId);
            if (calendarType === 'personal' && email) {
                query = query.eq('created_by', email);
            }
            const expectedVersion = eventData.expectedVersion;
            if (expectedVersion !== undefined && expectedVersion !== null) {
                query = query.eq('version', expectedVersion);
            }
            const { data, error } = await query.select('title').maybeSingle();
            if (error) throw error;
            if (expectedVersion !== undefined && expectedVersion !== null && !data) {
                throw new Error("Người khác vừa sửa sự kiện này. Hãy đóng cửa sổ, xem lại nội dung mới rồi sửa lại để không ghi đè lên thay đổi của họ.");
            }
            return `Đã cập nhật sự kiện "${data ? data.title : ''}" thành công!`;
        },
        deleteEvent: async (eventId, calendarType, groupKey, email) => {
            let query = sbClient.from('events').update({ deleted_at: new Date().toISOString() }).eq('id', eventId);
            if (calendarType === 'personal' && email) {
                query = query.eq('created_by', email);
            }
            const { data, error } = await query.select('title').maybeSingle();
            if (error) throw error;
            return `Đã đưa sự kiện "${data.title}" vào thùng rác!`;
        },
        toggleImportant: async (eventId, isImportant, calendarType, groupKey, email) => {
            let query = sbClient.from('events').update({ is_important: isImportant }).eq('id', eventId);
            if (calendarType === 'personal' && email) {
                query = query.eq('created_by', email);
            }
            const { data, error } = await query.select('title').maybeSingle();
            if (error) throw error;
            return `Đã cập nhật trạng thái quan trọng của sự kiện "${data.title}" thành công!`;
        }
    },
    asset: {
        // --- Sổ lệnh (transaction ledger) — nguồn sự thật duy nhất cho khối lượng/giá vốn ---
        listTransactions: async (email) => {
            const userId = await getUserId(email);
            const { data, error } = await sbClient.from('finance_transactions')
                .select('*').eq('user_id', userId).is('deleted_at', null)
                .order('trade_date', { ascending: false }).order('created_at', { ascending: false });
            if (error) throw error;
            return data || [];
        },
        // Sổ lệnh FIFO chuẩn kế toán: lô cũ nhất bán trước. Hành động doanh nghiệp (tách/gộp,
        // cổ tức cổ phiếu) được replay xen kẽ theo đúng ex_date để điều chỉnh khối lượng/giá vốn hồi tố.
        // Trả về map { symbol: [{quantity, cost}, ...] } — thứ tự mảng = thứ tự mua (lô cũ nhất ở đầu).
        computeLots: async (userId) => {
            const { data: txns, error } = await sbClient.from('finance_transactions')
                .select('*').eq('user_id', userId).is('deleted_at', null)
                .order('trade_date', { ascending: true }).order('created_at', { ascending: true });
            if (error) throw error;
            const { data: actions } = await sbClient.from('finance_corporate_actions')
                .select('*').eq('user_id', userId).is('deleted_at', null);

            const events = [
                ...(txns || []).map(t => ({ ...t, _kind: 'txn', _date: t.trade_date, _ts: t.created_at })),
                ...(actions || []).map(a => ({ ...a, _kind: 'action', _date: a.ex_date, _ts: a.created_at }))
            ].sort((a, b) => (new Date(a._date) - new Date(b._date)) || (new Date(a._ts) - new Date(b._ts)));

            const lotsBySymbol = {};
            events.forEach(ev => {
                if (ev._kind === 'action') {
                    const lots = lotsBySymbol[ev.symbol];
                    if (!lots || !lots.length) return;
                    // split: ratio = số cổ phiếu mới / cũ (vd 2:1 -> 2). stock_dividend: ratio = % thưởng (vd 10% -> 0.1, hệ số 1.1)
                    const multiplier = ev.action_type === 'split' ? Number(ev.ratio) : (1 + Number(ev.ratio));
                    if (multiplier > 0) lots.forEach(lot => { lot.quantity *= multiplier; lot.cost /= multiplier; });
                    return;
                }
                const symbol = ev.symbol;
                if (!lotsBySymbol[symbol]) lotsBySymbol[symbol] = [];
                const lots = lotsBySymbol[symbol];
                const qty = Number(ev.quantity) || 0;
                if (ev.type === 'buy') {
                    lots.push({ quantity: qty, cost: Number(ev.price) || 0 });
                } else {
                    let remaining = qty;
                    while (remaining > 1e-9 && lots.length) {
                        const lot = lots[0];
                        const consumed = Math.min(lot.quantity, remaining);
                        lot.quantity -= consumed; remaining -= consumed;
                        if (lot.quantity <= 1e-9) lots.shift();
                    }
                }
            });
            return lotsBySymbol;
        },
        // Tổng hợp lô FIFO thành khối lượng + giá vốn bình quân hiện tại của từng mã (để hiển thị danh mục)
        computeHoldings: async (userId) => {
            const lotsBySymbol = await API.asset.computeLots(userId);
            return Object.entries(lotsBySymbol).map(([symbol, lots]) => {
                const quantity = lots.reduce((s, l) => s + l.quantity, 0);
                const totalCost = lots.reduce((s, l) => s + l.quantity * l.cost, 0);
                return { symbol, quantity, avgCost: quantity > 0 ? totalCost / quantity : 0 };
            }).filter(p => p.quantity > 1e-9);
        },
        addTransaction: async (email, txn) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const symbol = String(txn.symbol || '').trim().toUpperCase();
            if (!symbol) throw new Error("Thiếu mã danh mục");
            const quantity = Number(txn.quantity) || 0;
            const price = Number(txn.price) || 0;
            if (quantity <= 0) throw new Error("Khối lượng phải lớn hơn 0");

            let realizedPnl = null;
            if (txn.type === 'sell') {
                // Lãi/lỗ đã chốt tính theo FIFO: tiêu thụ lô cũ nhất trước, không phải giá vốn bình quân
                const lotsBySymbol = await API.asset.computeLots(userId);
                const lots = (lotsBySymbol[symbol] || []).map(l => ({ ...l }));
                const totalAvail = lots.reduce((s, l) => s + l.quantity, 0);
                if (totalAvail < quantity - 1e-9) throw new Error(`Không đủ khối lượng "${symbol}" để bán (đang có ${totalAvail})`);
                let remaining = quantity, realized = 0;
                while (remaining > 1e-9 && lots.length) {
                    const lot = lots[0];
                    const consumed = Math.min(lot.quantity, remaining);
                    realized += (price - lot.cost) * consumed;
                    lot.quantity -= consumed; remaining -= consumed;
                    if (lot.quantity <= 1e-9) lots.shift();
                }
                realizedPnl = realized;
            }

            const { error } = await sbClient.from('finance_transactions').insert({
                user_id: userId, symbol, type: txn.type === 'sell' ? 'sell' : 'buy', quantity, price,
                fee: Number(txn.fee) || 0,
                trade_date: txn.tradeDate || new Date().toISOString().slice(0, 10),
                note: txn.note || null, realized_pnl: realizedPnl, created_by: email
            });
            if (error) throw error;
            await API.asset.recomputeAndSnapshot(email);
            return "Đã lưu lệnh giao dịch!";
        },
        deleteTransaction: async (email, id) => {
            const userId = await getUserId(email);
            const { error } = await sbClient.from('finance_transactions')
                .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
            if (error) throw error;
            await API.asset.recomputeAndSnapshot(email);
            return "Đã xóa lệnh giao dịch!";
        },

        // --- Giá thị trường hiện tại (nhập tay, tách khỏi sổ lệnh vì đây không phải giao dịch) ---
        setMarketPrice: async (email, symbol, price) => {
            const userId = await getUserId(email);
            const cleanSymbol = String(symbol || '').trim().toUpperCase();
            if (!cleanSymbol) throw new Error("Thiếu mã danh mục");
            const { error } = await sbClient.from('finance_holdings_price').upsert({
                user_id: userId, symbol: cleanSymbol, market_price: Number(price) || 0, updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,symbol' });
            if (error) throw error;
            await API.asset.recomputeAndSnapshot(email);
            return "Đã cập nhật giá thị trường!";
        },

        // --- Danh mục hiện tại: khối lượng + giá vốn (từ sổ lệnh) ghép với giá TT (nhập tay) ---
        getHoldingsView: async (email) => {
            const userId = await getUserId(email);
            const holdings = await API.asset.computeHoldings(userId);
            const { data: prices } = await sbClient.from('finance_holdings_price').select('symbol, market_price').eq('user_id', userId);
            const priceMap = {};
            (prices || []).forEach(p => { priceMap[p.symbol] = Number(p.market_price) || 0; });

            return holdings.map(h => {
                const marketPrice = priceMap[h.symbol] || 0;
                const costValue = h.avgCost * h.quantity;
                const marketValue = marketPrice * h.quantity;
                return {
                    symbol: h.symbol, quantity: h.quantity, avgCost: h.avgCost, marketPrice,
                    costValue, marketValue,
                    unrealizedPnl: marketValue - costValue,
                    unrealizedPct: costValue > 0 ? ((marketValue - costValue) / costValue) * 100 : 0
                };
            });
        },

        // --- Tiền mặt / dư nợ (vẫn dùng bảng finance_assets, chỉ 2 cột này còn "thủ công") ---
        getCashDebt: async (email) => {
            const userId = await getUserId(email);
            const { data } = await sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle();
            return { cash: data ? Number(data.cash) || 0 : 0, debt: data ? Number(data.debt) || 0 : 0 };
        },
        setCashDebt: async (email, cash, debt) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const { error } = await sbClient.from('finance_assets').upsert({
                user_id: userId, cash: Number(cash) || 0, debt: Number(debt) || 0
            }, { onConflict: 'user_id' });
            if (error) throw error;
            await API.asset.recomputeAndSnapshot(email);
            return "Đã cập nhật tiền mặt/dư nợ!";
        },

        // --- Dòng tiền phi giao dịch: nạp vốn / rút vốn / cổ tức tiền — tách khỏi lãi/lỗ đầu tư ---
        cashFlow: {
            list: async (email) => {
                const userId = await getUserId(email);
                const { data, error } = await sbClient.from('finance_cash_flows')
                    .select('*').eq('user_id', userId).is('deleted_at', null)
                    .order('flow_date', { ascending: false }).order('created_at', { ascending: false });
                if (error) throw error;
                return data || [];
            },
            add: async (email, flow) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const amount = Number(flow.amount) || 0;
                if (amount <= 0) throw new Error("Số tiền phải lớn hơn 0");
                const flowType = ['deposit', 'withdrawal', 'dividend'].includes(flow.flowType) ? flow.flowType : 'deposit';
                const { error } = await sbClient.from('finance_cash_flows').insert({
                    user_id: userId, flow_type: flowType, amount,
                    flow_date: flow.flowDate || new Date().toISOString().slice(0, 10),
                    symbol: flow.symbol ? String(flow.symbol).trim().toUpperCase() : null,
                    note: flow.note || null, created_by: email
                });
                if (error) throw error;

                const { data: cd } = await sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle();
                const cash = cd ? Number(cd.cash) || 0 : 0;
                const debt = cd ? Number(cd.debt) || 0 : 0;
                const delta = flowType === 'withdrawal' ? -amount : amount;
                await sbClient.from('finance_assets').upsert({ user_id: userId, cash: cash + delta, debt }, { onConflict: 'user_id' });

                await API.asset.recomputeAndSnapshot(email);
                return "Đã ghi nhận dòng tiền!";
            },
            delete: async (email, id) => {
                const userId = await getUserId(email);
                const { data: flow } = await sbClient.from('finance_cash_flows').select('*').eq('id', id).eq('user_id', userId).maybeSingle();
                if (!flow) throw new Error("Không tìm thấy dòng tiền");
                const { error } = await sbClient.from('finance_cash_flows')
                    .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
                if (error) throw error;

                // Hoàn tác đúng số tiền đã cộng/trừ khi ghi nhận dòng tiền này
                const { data: cd } = await sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle();
                const cash = cd ? Number(cd.cash) || 0 : 0;
                const debt = cd ? Number(cd.debt) || 0 : 0;
                const delta = flow.flow_type === 'withdrawal' ? Number(flow.amount) : -Number(flow.amount);
                await sbClient.from('finance_assets').upsert({ user_id: userId, cash: cash + delta, debt }, { onConflict: 'user_id' });

                await API.asset.recomputeAndSnapshot(email);
                return "Đã xóa dòng tiền!";
            }
        },

        // --- Hành động doanh nghiệp: tách/gộp cổ phiếu, cổ tức cổ phiếu — điều chỉnh FIFO hồi tố ---
        corporateAction: {
            list: async (email) => {
                const userId = await getUserId(email);
                const { data, error } = await sbClient.from('finance_corporate_actions')
                    .select('*').eq('user_id', userId).is('deleted_at', null)
                    .order('ex_date', { ascending: false });
                if (error) throw error;
                return data || [];
            },
            add: async (email, action) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const symbol = String(action.symbol || '').trim().toUpperCase();
                if (!symbol) throw new Error("Thiếu mã cổ phiếu");
                const ratio = Number(action.ratio) || 0;
                if (ratio <= 0) throw new Error("Tỷ lệ phải lớn hơn 0");
                const actionType = action.actionType === 'stock_dividend' ? 'stock_dividend' : 'split';
                const { error } = await sbClient.from('finance_corporate_actions').insert({
                    user_id: userId, symbol, action_type: actionType, ratio,
                    ex_date: action.exDate || new Date().toISOString().slice(0, 10),
                    note: action.note || null, created_by: email
                });
                if (error) throw error;
                await API.asset.recomputeAndSnapshot(email);
                return "Đã ghi nhận hành động doanh nghiệp!";
            },
            delete: async (email, id) => {
                const userId = await getUserId(email);
                const { error } = await sbClient.from('finance_corporate_actions')
                    .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
                if (error) throw error;
                await API.asset.recomputeAndSnapshot(email);
                return "Đã xóa hành động doanh nghiệp!";
            }
        },

        // --- Giá đóng cửa VN-Index/VN30: dữ liệu tham chiếu dùng chung, nhập tay bởi asset_manager ---
        benchmark: {
            list: async (indexCode, days) => {
                let query = sbClient.from('finance_benchmark_prices').select('*').order('price_date', { ascending: true });
                if (indexCode) query = query.eq('index_code', indexCode);
                if (days) {
                    const from = new Date(); from.setDate(from.getDate() - Number(days));
                    query = query.gte('price_date', from.toISOString().slice(0, 10));
                }
                const { data, error } = await query;
                if (error) throw error;
                return data || [];
            },
            upsert: async (indexCode, priceDate, closeValue, email) => {
                const value = Number(closeValue) || 0;
                if (value <= 0) throw new Error("Giá trị phải lớn hơn 0");
                const code = ['VNINDEX', 'VN30'].includes(indexCode) ? indexCode : 'VNINDEX';
                const { error } = await sbClient.from('finance_benchmark_prices').upsert({
                    index_code: code, price_date: priceDate || new Date().toISOString().slice(0, 10),
                    close_value: value, created_by: email
                }, { onConflict: 'index_code,price_date' });
                if (error) throw error;
                return "Đã cập nhật giá chỉ số!";
            }
        },

        // --- Tính lại NAV hiện tại (lưu vào finance_assets) + chốt 1 điểm snapshot/ngày (finance_nav_history) ---
        recomputeAndSnapshot: async (email) => {
            const userId = await getUserId(email);
            if (!userId) return 0;
            const holdings = await API.asset.getHoldingsView(email);
            const marketValue = holdings.reduce((s, h) => s + h.marketValue, 0);
            const { data: cd } = await sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle();
            const cash = cd ? Number(cd.cash) || 0 : 0;
            const debt = cd ? Number(cd.debt) || 0 : 0;
            const nav = marketValue + cash - debt;

            await sbClient.from('finance_assets').upsert({ user_id: userId, cash, debt, nav }, { onConflict: 'user_id' });

            // Vốn ròng đã nạp lũy kế (nạp - rút, KHÔNG gồm cổ tức) — dùng để tách lợi nhuận đầu tư
            // thực khỏi tiền góp thêm khi tính các chỉ số rủi ro/hiệu suất.
            const { data: flows } = await sbClient.from('finance_cash_flows')
                .select('flow_type, amount').eq('user_id', userId).is('deleted_at', null)
                .in('flow_type', ['deposit', 'withdrawal']);
            const netContributed = (flows || []).reduce((s, f) =>
                s + (f.flow_type === 'withdrawal' ? -Number(f.amount) : Number(f.amount)), 0);

            const today = new Date().toISOString().slice(0, 10);
            await sbClient.from('finance_nav_history').upsert({
                user_id: userId, snapshot_date: today, nav, cash, debt, market_value: marketValue,
                net_contributed: netContributed
            }, { onConflict: 'user_id,snapshot_date' });

            return nav;
        },

        // --- Lịch sử NAV cho biểu đồ hiệu suất ---
        getNavHistory: async (email, days) => {
            const userId = await getUserId(email);
            let query = sbClient.from('finance_nav_history').select('*').eq('user_id', userId).order('snapshot_date', { ascending: true });
            if (days) {
                const from = new Date(); from.setDate(from.getDate() - Number(days));
                query = query.gte('snapshot_date', from.toISOString().slice(0, 10));
            }
            const { data, error } = await query;
            if (error) throw error;
            return data || [];
        },

        // --- KPI tổng hợp cho tab Hiệu Suất ---
        getSummaryKpis: async (email) => {
            const userId = await getUserId(email);
            const holdings = await API.asset.getHoldingsView(email);
            const unrealizedPnl = holdings.reduce((s, h) => s + h.unrealizedPnl, 0);
            const { data: sells } = await sbClient.from('finance_transactions')
                .select('realized_pnl').eq('user_id', userId).eq('type', 'sell').is('deleted_at', null);
            const realizedPnl = (sells || []).reduce((s, t) => s + (Number(t.realized_pnl) || 0), 0);
            const marketValue = holdings.reduce((s, h) => s + h.marketValue, 0);
            const { data: cd } = await sbClient.from('finance_assets').select('cash, debt, nav').eq('user_id', userId).maybeSingle();
            return {
                nav: cd ? Number(cd.nav) || 0 : marketValue,
                cash: cd ? Number(cd.cash) || 0 : 0,
                debt: cd ? Number(cd.debt) || 0 : 0,
                marketValue, unrealizedPnl, realizedPnl
            };
        },

        // --- Rủi ro & hiệu suất: Sharpe, Max Drawdown, biến động hóa năm, so sánh VN-Index ---
        getPerformanceMetrics: async (email) => {
            const history = await API.asset.getNavHistory(email);
            if (!history || history.length < 2) {
                return { sharpe: null, maxDrawdown: null, volatility: null, annualizedReturn: null, dataPoints: history ? history.length : 0, benchmark: null };
            }

            // Lợi nhuận ngày "sạch": bỏ qua các ngày có nạp/rút vốn vì NAV bị méo bởi tiền góp
            // thêm, không phản ánh lãi/lỗ đầu tư thực sự trong ngày đó.
            const dailyReturns = [];
            for (let i = 1; i < history.length; i++) {
                const prev = history[i - 1], cur = history[i];
                const flowChanged = Math.abs((Number(cur.net_contributed) || 0) - (Number(prev.net_contributed) || 0)) > 1;
                const prevNav = Number(prev.nav) || 0;
                if (flowChanged || prevNav <= 0) continue;
                dailyReturns.push((Number(cur.nav) - prevNav) / prevNav);
            }

            const n = dailyReturns.length;
            const meanReturn = n > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / n : 0;
            const variance = n > 1 ? dailyReturns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / (n - 1) : 0;
            const annualizedVol = Math.sqrt(variance) * Math.sqrt(252);
            const annualizedReturn = meanReturn * 252;
            // Sharpe giả định lãi suất phi rủi ro = 0 — đơn giản hóa hợp lý cho một portfolio nội bộ
            const sharpe = annualizedVol > 0 ? annualizedReturn / annualizedVol : null;

            // Max Drawdown trên chuỗi NAV thực tế (không loại ngày có dòng tiền — đây là mức sụt
            // giá trị tài khoản nhà đầu tư thực sự trải qua, kể cả khi có rút vốn giữa chừng)
            let peak = Number(history[0].nav) || 0, maxDD = 0;
            history.forEach(h => {
                const nav = Number(h.nav) || 0;
                if (nav > peak) peak = nav;
                if (peak > 0) { const dd = (nav - peak) / peak; if (dd < maxDD) maxDD = dd; }
            });

            // So sánh benchmark: chỉ số hóa NAV và VN-Index về gốc 100 tại ngày đầu tiên có dữ liệu chung
            let benchmark = null;
            try {
                const idxData = await API.asset.benchmark.list('VNINDEX');
                if (idxData && idxData.length) {
                    const idxByDate = {};
                    idxData.forEach(d => { idxByDate[d.price_date] = Number(d.close_value); });
                    const overlap = history.filter(h => idxByDate[h.snapshot_date] !== undefined);
                    if (overlap.length >= 2) {
                        const baseNav = Number(overlap[0].nav) || 1;
                        const baseIdx = idxByDate[overlap[0].snapshot_date] || 1;
                        benchmark = overlap.map(h => ({
                            date: h.snapshot_date,
                            portfolioIndexed: baseNav > 0 ? (Number(h.nav) / baseNav) * 100 : 100,
                            benchmarkIndexed: baseIdx > 0 ? (idxByDate[h.snapshot_date] / baseIdx) * 100 : 100
                        }));
                    }
                }
            } catch (e) { /* chưa có dữ liệu VN-Index — bỏ qua phần benchmark, không chặn các chỉ số khác */ }

            return { sharpe, maxDrawdown: maxDD, volatility: annualizedVol, annualizedReturn, dataPoints: n, benchmark };
        },

        // --- Trang "Tổng hợp" của cả team ---
        getTeamSummary: async () => {
            const { data, error } = await sbClient.from('finance_assets').select('*, users!inner(nickname, email)');
            if (error) throw error;

            const totalNav = data.reduce((sum, row) => sum + Number(row.nav), 0);

            let result = data.map(row => ({
                name: row.users.nickname || row.users.email,
                nav: Number(row.nav).toLocaleString('en-US'),
                percent: totalNav > 0 ? ((Number(row.nav) / totalNav) * 100).toFixed(1) + '%' : '0%'
            }));

            result.push({
                name: "TỔNG CỘNG",
                nav: totalNav.toLocaleString('en-US'),
                percent: "100%"
            });
            return result;
        },
        getMemberList: async () => {
            const { data } = await sbClient.from('users').select('email').in('group_key', ['finance', 'admin']);
            return data ? data.map(d => d.email) : [];
        },
        getMemberDetail: async (email) => {
            const userId = await getUserId(email);
            const holdings = await API.asset.computeHoldings(userId);
            const { data: prices } = await sbClient.from('finance_holdings_price').select('symbol, market_price').eq('user_id', userId);
            const priceMap = {};
            (prices || []).forEach(p => { priceMap[p.symbol] = Number(p.market_price) || 0; });
            const { data: cd } = await sbClient.from('finance_assets').select('cash, debt, nav').eq('user_id', userId).maybeSingle();

            let table = [];
            table.push([email, "", "", "", "", "", "", "", "", ""]);
            table.push(["STT", "Danh mục", "Vol", "Giá vốn", "", "", "Giá TT", "GT vốn", "GTTT", "Lãi/lỗ"]);

            let totalGtVon = 0, totalGtTT = 0;
            holdings.forEach((h, idx) => {
                const marketPrice = priceMap[h.symbol] || 0;
                const gtVon = h.avgCost * h.quantity;
                const gtTT = marketPrice * h.quantity;
                totalGtVon += gtVon; totalGtTT += gtTT;
                table.push([
                    idx + 1, h.symbol, h.quantity.toLocaleString('en-US'),
                    h.avgCost.toLocaleString('en-US'), "", "", marketPrice.toLocaleString('en-US'),
                    gtVon.toLocaleString('en-US'), gtTT.toLocaleString('en-US'), (gtTT - gtVon).toLocaleString('en-US')
                ]);
            });

            const cash = cd ? Number(cd.cash) || 0 : 0;
            const debt = cd ? Number(cd.debt) || 0 : 0;
            const nav = cd ? Number(cd.nav) || 0 : (totalGtTT + cash - debt);
            table.push(["TỔNG DANH MỤC", "", "", "", "", "", "", totalGtVon.toLocaleString('en-US'), totalGtTT.toLocaleString('en-US'), (totalGtTT - totalGtVon).toLocaleString('en-US')]);
            table.push(["Tiền mặt", "", "", "", "", "", "", cash.toLocaleString('en-US'), "", ""]);
            table.push(["Dư nợ", "", "", "", "", "", "", debt.toLocaleString('en-US'), "", ""]);
            table.push(["NAV", "", "", "", "", "", "", nav.toLocaleString('en-US'), "", ""]);
            return table;
        }
    },
    finRoles: {
        // Vai trò tầng 2 riêng của Fin — không liên quan group_key của org.
        getMyRoles: async (email) => {
            const userId = await getUserId(email);
            const { data, error } = await sbClient.from('fin_roles').select('role').eq('user_id', userId);
            if (error) throw error;
            return (data || []).map(r => r.role);
        },
        listAll: async () => {
            const { data: members, error: mErr } = await sbClient.from('users').select('id, email, nickname').in('group_key', ['finance', 'admin']);
            if (mErr) throw mErr;
            const { data: roles, error: rErr } = await sbClient.from('fin_roles').select('user_id, role');
            if (rErr) throw rErr;
            return (members || []).map(m => ({
                email: m.email,
                nickname: m.nickname || m.email,
                roles: (roles || []).filter(r => r.user_id === m.id).map(r => r.role)
            }));
        },
        grantRole: async (targetEmail, role, byEmail) => {
            const targetId = await getUserId(targetEmail);
            const byId = await getUserId(byEmail);
            const { error } = await sbClient.from('fin_roles').insert({ user_id: targetId, role, granted_by: byId });
            if (error) throw error;
            return { success: true };
        },
        revokeRole: async (targetEmail, role) => {
            const targetId = await getUserId(targetEmail);
            const { error } = await sbClient.from('fin_roles').delete().eq('user_id', targetId).eq('role', role);
            if (error) throw error;
            return { success: true };
        }
    },
    note: {
        getFinanceUsers: async () => {
            const { data } = await sbClient.from('users').select('email, nickname').in('group_key', ['finance', 'admin']);
            return data ? data.map(d => ({ name: d.nickname || d.email, email: d.email })) : [];
        },
        addFinanceNote: async (payload) => {
            const authorId = await getUserId(payload.author);
            const { error } = await sbClient.from('finance_notes').insert({
                id: genId("FN"),
                author_id: authorId,
                title: payload.title || 'Note',
                content: payload.content,
                color: payload.color
            });
            if (error) throw error;
            return "Thêm ghi chú thành công!";
        },
        getFinanceNotes: async () => {
            const startOfDay = new Date();
            startOfDay.setHours(0, 0, 0, 0);
            const { data, error } = await sbClient.from('finance_notes')
                .select('*, users!inner(email, nickname)')
                .gte('created_at', startOfDay.toISOString())
                .order('created_at', { ascending: false });
            if (error) throw error;
            return data.map(n => ({
                id: n.id,
                author: n.users.nickname || n.users.email,
                title: n.title,
                content: n.content,
                color: n.color,
                time: new Date(n.created_at).toLocaleString('vi-VN', {hour: '2-digit', minute:'2-digit', day:'2-digit', month:'2-digit'})
            }));
        },
        deleteFinanceNote: async (id) => {
            const { error } = await sbClient.from('finance_notes').delete().eq('id', id);
            if (error) throw error;
            return "Đã xóa note thành công!";
        }
    },
    // Personal Hub: single flexible table (personal_items), scoped by auth.uid() via RLS —
    // not group_key. Same table/rows are shared across wh-fin/wh-sci/wh-org (one Supabase
    // project), so this is intentionally app-agnostic: never filter by source_app, it's
    // display metadata only.
    personal: {
        list: async (type) => {
            let query = sbClient.from('personal_items').select('*').eq('archived', false)
                .order('pinned', { ascending: false }).order('updated_at', { ascending: false });
            if (type) query = query.eq('type', type);
            const { data, error } = await query;
            if (error) throw error;
            return data || [];
        },
        upsert: async (item) => {
            const row = {
                type: item.type,
                title: item.title || null,
                data: item.data || {},
                pinned: !!item.pinned,
                source_app: 'fin'
            };
            if (item.id) {
                const { data, error } = await sbClient.from('personal_items').update(row).eq('id', item.id).select().single();
                if (error) throw error;
                return data;
            }
            const { data, error } = await sbClient.from('personal_items').insert(row).select().single();
            if (error) throw error;
            return data;
        },
        remove: async (id) => {
            const { error } = await sbClient.from('personal_items').delete().eq('id', id);
            if (error) throw error;
            return "Đã xoá";
        }
    },
    stock: {
        getStockList: async () => {
            const { data } = await sbClient.from('finance_stock_valuations').select('symbol').order('symbol');
            const seen = new Set(); const list = [];
            (data || []).forEach(d => { if (!seen.has(d.symbol)) { seen.add(d.symbol); list.push(d.symbol); } });
            return list;
        },
        getStockYears: async (symbol) => {
            const { data } = await sbClient.from('finance_stock_valuations').select('year').eq('symbol', symbol).order('year', { ascending: false });
            return data ? data.map(d => d.year) : [];
        },
        // Không truyền year -> lấy năm mới nhất
        getStockDetail: async (symbol, year) => {
            let query = sbClient.from('finance_stock_valuations').select('*').eq('symbol', symbol);
            query = year ? query.eq('year', Number(year)) : query.order('year', { ascending: false }).limit(1);
            const { data, error } = await query.maybeSingle();
            if (error) throw error;
            return data ? data.data : {};
        },
        // Toàn bộ lịch sử định giá theo năm, dùng để vẽ biểu đồ xu hướng
        getStockHistory: async (symbol) => {
            const { data, error } = await sbClient.from('finance_stock_valuations').select('year, data').eq('symbol', symbol).order('year', { ascending: true });
            if (error) throw error;
            return data || [];
        },
        saveStockValuation: async (payload, email) => {
            const symbol = String(payload.symbol || '').trim().toUpperCase();
            const year = Number(payload.year) || new Date().getFullYear();
            if (!symbol) throw new Error("Thiếu mã cổ phiếu");
            const { error } = await sbClient.from('finance_stock_valuations').upsert({
                symbol, year, data: { ...payload, symbol, year }, updated_by: email || null, updated_at: new Date().toISOString()
            }, { onConflict: 'symbol,year' });
            if (error) throw error;
            return `Lưu định giá "${symbol}" (${year}) thành công!`;
        }
    },
    settings: {
        getSetting: async (key) => {
            if (!sbClient) return null;
            const { data } = await sbClient.from('app_settings').select('value').eq('key', key).maybeSingle();
            return data ? data.value : null;
        },
        updateSetting: async (key, value, userEmail) => {
            const { error } = await sbClient.from('app_settings').upsert({
                key: key,
                value: value,
                updated_by: userEmail,
                updated_at: new Date().toISOString()
            });
            if (error) throw error;
        },
        getColors: async () => ({})
    },
    system: {
        logAction: async (traceId, action, details, status, email, groupKey, entityId) => {
            if (!sbClient) return;
            const { error } = await sbClient.from('system_logs').insert({
                trace_id: traceId,
                action: action,
                details: typeof details === 'object' ? JSON.stringify(details) : details,
                status: status,
                user_email: email || 'unknown',
                group_key: groupKey || 'general',
                entity_id: entityId || null
            });
            if (error) console.error("System Log Error", error);
        },
        getDeletedItems: async (tableName, groupKey) => {
            if (!sbClient) return [];
            let query = sbClient.from(tableName).select('*').not('deleted_at', 'is', null)
                .order('deleted_at', { ascending: false }).limit(300);

            if (tableName === 'tasks' && groupKey) {
                const { data: projects } = await sbClient.from('projects').select('id, name').eq('group_key', groupKey);
                if (!projects || projects.length === 0) return [];
                const projectIds = projects.map(p => p.id);
                query = query.in('project_id', projectIds);

                const { data, error } = await query;
                if (error) throw error;
                if (data) {
                    data.forEach(task => {
                        const proj = projects.find(p => p.id === task.project_id);
                        if (proj) task.projectName = proj.name;
                    });
                }
                return data;
            } else {
                if (groupKey && tableName !== 'users') {
                    query = query.eq('group_key', groupKey);
                }
                const { data, error } = await query;
                if (error) throw error;
                return data;
            }
        },
        restoreItem: async (tableName, id) => {
            if (!sbClient) return false;

            if (tableName === 'projects') {

                await sbClient.from('tasks')
                    .update({ deleted_at: null, deleted_by_cascade: false })
                    .eq('project_id', id)
                    .eq('deleted_by_cascade', true);
            }

            const { data, error } = await sbClient.from(tableName).update({ deleted_at: null }).eq('id', id).select('*').maybeSingle();
            if (error) throw error;

            if (tableName === 'tasks') {
                await sbClient.from('tasks')
                    .update({ deleted_at: null, deleted_by_cascade: false })
                    .eq('parent_task_id', id)
                    .eq('deleted_by_cascade', true);
                if (data.project_id) {
                    await sbClient.from('projects').update({ deleted_at: null }).eq('id', data.project_id);
                }
            }

            const itemName = data.name || data.title || "dữ liệu";
            return `Đã khôi phục "${itemName}" thành công!`;
        },
        hardDeleteItem: async (tableName, id) => {
            if (!sbClient) return false;

            if (tableName === 'files') {
                const { data: fileData } = await sbClient.from('files').select('storage_path').eq('id', id).maybeSingle();
                if (fileData && fileData.storage_path) {
                    const parts = fileData.storage_path.split('/');
                    const bucketName = parts[0];
                    const storagePath = parts.slice(1).join('/');
                    if (bucketName && storagePath) {
                        if (NEW_MINIO_BUCKETS.has(bucketName)) {
                            await storageProxyDelete(bucketName, storagePath);
                        } else {
                            await sbClient.storage.from(bucketName).remove([storagePath]);
                        }
                    }
                }
            } else if (tableName === 'tasks') {
                const { data: taskData } = await sbClient.from('tasks').select('attachments, project_id').eq('id', id).maybeSingle();
                if (taskData && taskData.attachments) {
                    let attachments = typeof taskData.attachments === 'string' ? JSON.parse(taskData.attachments) : taskData.attachments;
                    for (let file of (attachments || [])) {
                        if (file.id && file.id.startsWith("TF_")) {
                            if (file.bucket && file.path) {
                                await storageProxyDelete(file.bucket, file.path);
                            } else if (file.url) {
                                const urlParts = file.url.split('/general_bucket/');
                                if (urlParts.length > 1) {
                                    const filePath = decodeURIComponent(urlParts[1]);
                                    await sbClient.storage.from('general_bucket').remove([filePath]);
                                }
                            }
                        }
                    }
                }
            } else if (tableName === 'projects') {
                const { data: projTasks } = await sbClient.from('tasks').select('id, attachments').eq('project_id', id);
                if (projTasks && projTasks.length > 0) {
                    for (let t of projTasks) {
                        let attachments = typeof t.attachments === 'string' ? JSON.parse(t.attachments) : t.attachments;
                        for (let file of (attachments || [])) {
                            if (file.id && file.id.startsWith("TF_")) {
                                if (file.bucket && file.path) {
                                    await storageProxyDelete(file.bucket, file.path);
                                } else if (file.url) {
                                    const urlParts = file.url.split('/general_bucket/');
                                    if (urlParts.length > 1) {
                                        const filePath = decodeURIComponent(urlParts[1]);
                                        await sbClient.storage.from('general_bucket').remove([filePath]);
                                    }
                                }
                            }
                        }
                    }
                    await sbClient.from('tasks').delete().eq('project_id', id);
                }
            }

            let itemName = "dữ liệu";
            const { data: itemData } = await sbClient.from(tableName).select('*').eq('id', id).maybeSingle();
            if (itemData) itemName = itemData.name || itemData.title || "dữ liệu";

            const { error } = await sbClient.from(tableName).delete().eq('id', id);
            if (error) throw error;
            return `Đã xóa vĩnh viễn "${itemName}"!`;
        }
    },
    notification: {
        get: async (groupKey, limit = 50, viewerEmail) => {
            if (!sbClient) return [];
            let query = sbClient.from('system_logs')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(limit);

            if (groupKey) {
                query = query.eq('group_key', groupKey);
            }

            const { data, error } = await query;
            if (error) {
                console.error("Notification Error", error);
                return [];
            }

            const logItems = data.map(log => ({
                id: log.id,
                timestamp: new Date(log.created_at).getTime(),
                creator: log.user_email,
                action: log.action,
                status: log.status,
                details: log.details,
                message: `Đã thực hiện ${log.status === 'success' ? 'thành công' : 'nhưng thất bại'} ${log.action}: ${log.details}`,
                link: '#'
            }));

            let mentionItems = [];
            if (viewerEmail) {
                const { data: mentions } = await sbClient.from('task_comments')
                    .select('id, task_id, author_email, content, mentioned_emails, created_at')
                    .not('mentioned_emails', 'is', null)
                    .ilike('mentioned_emails', `%${viewerEmail}%`)
                    .order('created_at', { ascending: false })
                    .limit(limit);

                mentionItems = (mentions || [])
                    .filter(m => (m.mentioned_emails || '').split(',').map(e => e.trim().toLowerCase()).includes(viewerEmail.toLowerCase()))
                    .map(m => ({
                        id: 'mention_' + m.id,
                        timestamp: new Date(m.created_at).getTime(),
                        creator: m.author_email,
                        action: 'mention',
                        status: 'success',
                        details: m.content,
                        taskId: m.task_id,
                        message: `${m.author_email} đã nhắc đến bạn: "${m.content}"`,
                        link: '#'
                    }));
            }

            return [...logItems, ...mentionItems].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
        }
    },
    lounge: {
        sync: async (payload) => {
            if (!sbClient) return [];

            if (payload && payload.email) {
                const { error } = await sbClient.from('lounge_players').upsert({
                    email: payload.email,
                    name: payload.name || 'Unknown',
                    group_key: payload.group || 'guest',
                    status: payload.status || 'in-lounge',
                    color: payload.color || '#3498db',
                    x: payload.x || 0,
                    y: payload.y || 0,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'email' });

                if (error) console.error("Lỗi upsert lounge_players:", error);
            }

            const oneMinuteAgo = new Date(Date.now() - 60000).toISOString();
            const { data, error: selectError } = await sbClient.from('lounge_players')
                .select('*')
                .gte('updated_at', oneMinuteAgo);

            if (selectError) {
                console.error("Lỗi lấy danh sách lounge:", selectError);
                return [];
            }

            return data.map(p => ({
                email: p.email,
                name: p.name,
                group: p.group_key,
                status: p.status,
                color: p.color,
                x: p.x,
                y: p.y
            }));
        }
    },

    search: {
        global: async (query, groupKey) => {
            const EMPTY = { projects: [], tasks: [], files: [], events: [], comments: [], milestones: [] };
            if (!sbClient) return EMPTY;
            const q = String(query || '').trim();
            if (q.length < 2) return EMPTY;

            const safe = q.replace(/[%_,()]/g, ' ').trim();
            if (!safe) return EMPTY;
            const pattern = `%${safe}%`;

            let projQuery = sbClient.from('projects').select('id, name, description, group_key').is('deleted_at', null);
            projQuery = groupKey === 'admin'
                ? projQuery.in('group_key', ['finance', 'workhub-fin'])
                : projQuery.eq('group_key', groupKey);
            const { data: allProjects } = await projQuery;

            const projectMap = {};
            (allProjects || []).forEach(p => { projectMap[p.id] = p.name; });
            const projectIds = Object.keys(projectMap);

            const lowered = safe.toLowerCase();
            const projects = (allProjects || [])
                .filter(p => (p.name || '').toLowerCase().includes(lowered) || (p.description || '').toLowerCase().includes(lowered))
                .slice(0, 8)
                .map(p => ({ id: p.id, title: p.name, subtitle: p.description || '', type: 'project' }));

            let tasks = [];
            if (projectIds.length > 0) {
                const { data: taskRows } = await sbClient.from('tasks')
                    .select('id, name, description, status, project_id, due_date')
                    .is('deleted_at', null)
                    .in('project_id', projectIds)
                    .or(`name.ilike.${pattern},description.ilike.${pattern}`)
                    .limit(12);
                tasks = (taskRows || []).map(t => ({
                    id: t.id,
                    title: t.name,
                    subtitle: projectMap[t.project_id] || '',
                    status: t.status,
                    dueDate: t.due_date ? t.due_date.slice(0, 10) : '',
                    projectId: t.project_id,
                    type: 'task'
                }));
            }

            let fileQuery = sbClient.from('files').select('id, name, description, storage_path, group_key').is('deleted_at', null);
            fileQuery = groupKey === 'admin'
                ? fileQuery.in('group_key', ['finance', 'workhub-fin'])
                : fileQuery.eq('group_key', groupKey);
            const { data: fileRows } = await fileQuery.or(`name.ilike.${pattern},description.ilike.${pattern}`).limit(8);
            const files = (fileRows || []).map(f => ({
                id: f.id,
                title: f.name,
                subtitle: f.description || '',
                url: buildFileUrl(f.storage_path),
                type: 'file'
            }));

            let eventQuery = sbClient.from('events').select('id, title, description, location, start_time').is('deleted_at', null);
            if (groupKey) eventQuery = eventQuery.eq('group_key', groupKey);
            const { data: eventRows } = await eventQuery
                .or(`title.ilike.${pattern},description.ilike.${pattern},location.ilike.${pattern}`)
                .limit(8);
            const events = (eventRows || []).map(e => ({
                id: e.id,
                title: e.title,
                subtitle: e.start_time ? new Date(e.start_time).toLocaleDateString('vi-VN') : (e.location || ''),
                startTime: e.start_time,
                type: 'event'
            }));

            let taskLookup = {};
            if (projectIds.length > 0) {
                const { data: allTaskRows } = await sbClient.from('tasks')
                    .select('id, name, project_id').is('deleted_at', null).in('project_id', projectIds);
                (allTaskRows || []).forEach(t => { taskLookup[t.id] = { name: t.name, projectId: t.project_id }; });
            }
            const taskIdsInScope = Object.keys(taskLookup);

            let comments = [];
            if (taskIdsInScope.length > 0) {
                const { data: commentRows } = await sbClient.from('task_comments')
                    .select('id, task_id, content')
                    .in('task_id', taskIdsInScope)
                    .ilike('content', pattern)
                    .limit(8);
                comments = (commentRows || []).map(c => {
                    const taskInfo = taskLookup[c.task_id] || {};
                    const content = c.content || '';
                    return {
                        id: c.id,
                        title: content.length > 80 ? content.slice(0, 80) + '…' : content,
                        subtitle: taskInfo.name ? `Bình luận trong: ${taskInfo.name}` : '',
                        taskId: c.task_id,
                        type: 'comment'
                    };
                });
            }

            let milestones = [];
            if (projectIds.length > 0) {
                const { data: msRows } = await sbClient.from('project_milestones')
                    .select('id, title, project_id')
                    .in('project_id', projectIds)
                    .ilike('title', pattern)
                    .limit(8);
                milestones = (msRows || []).map(m => ({
                    id: m.id,
                    title: m.title,
                    subtitle: projectMap[m.project_id] || '',
                    projectId: m.project_id,
                    type: 'milestone'
                }));
            }

            return { projects, tasks, files, events, comments, milestones };
        }
    },

    realtime: {
        _channel: null,
        WATCHED_TABLES: ['tasks', 'projects', 'events', 'task_comments', 'project_milestones'],
        subscribe: function (handler, onStatus) {
            if (!sbClient || typeof handler !== 'function') return null;
            if (API.realtime._channel) API.realtime.unsubscribe();

            const channel = sbClient.channel('workhub-core-changes');
            API.realtime.WATCHED_TABLES.forEach(table => {
                channel.on('postgres_changes', { event: '*', schema: 'public', table }, (payload) => {
                    try {
                        handler({
                            table: table,
                            eventType: payload.eventType,
                            row: payload.new || payload.old || null
                        });
                    } catch (err) {
                        console.error('Realtime handler error:', err);
                    }
                });
            });

            channel.subscribe((status) => {
                if (typeof onStatus === 'function') onStatus(status);
            });

            API.realtime._channel = channel;
            return channel;
        },
        unsubscribe: function () {
            if (!sbClient || !API.realtime._channel) return;
            try { sbClient.removeChannel(API.realtime._channel); } catch (err) {  }
            API.realtime._channel = null;
        }
    }
};

const MUTATING_ACTIONS = new Set([
    'saveTask', 'deleteTask', 'reorderTasks', 'bulkUpdateTaskStatus', 'bulkDeleteTasks',
    'bulkAssignTasks', 'bulkSetTaskDueDate', 'bulkAddTaskLabel',
    'uploadFileToTask', 'deleteFileFromTask', 'addTaskComment',
    'addChecklistItem', 'toggleChecklistItem', 'deleteChecklistItem',
    'createProject', 'updateProject', 'shareProject', 'deleteProject', 'setProjectArchived',
    'addMilestone', 'toggleMilestone', 'deleteMilestone',
    'createEvent', 'updateEvent', 'deleteEvent', 'toggleImportant',
    'uploadFile', 'deleteFile', 'shareFile',
    'restoreItem', 'hardDeleteItem',
    'provisionUser', 'updateUserGroup', 'removeUser', 'updateNickname',
    'addAssetTransaction', 'deleteAssetTransaction', 'setMarketPrice', 'setCashDebt', 'saveStockValuation',
    'grantFinRole', 'revokeFinRole',
    'addCashFlow', 'deleteCashFlow', 'addCorporateAction', 'deleteCorporateAction', 'upsertBenchmarkPrice',
    'savePersonalItem', 'deletePersonalItem'
]);
window.MUTATING_ACTIONS = MUTATING_ACTIONS;

// callGAS is now a thin wrapper: it hands off to WorkHubSync (offline cache/queue layer,
// sync-engine.js) when present, else dispatches straight through. _dispatchAction is exposed
// so sync-engine.js can replay queued writes through the exact same ~90-case switch below,
// with no per-action porting needed for the offline write path.
window.callGAS = async function(action, params = {}) {
    if (window.WorkHubSync) return window.WorkHubSync.handle(action, params, _dispatchAction);
    return _dispatchAction(action, params);
};

async function _dispatchAction(action, params = {}) {
    if (!params.email || params.email === 'unknown' || params.email === 'Khách') {
        const storedEmail = localStorage.getItem('userEmail') || localStorage.getItem('currentUser');
        if (storedEmail) {
            params.email = storedEmail;
        }
    }

    if (MUTATING_ACTIONS.has(action)) window.lastLocalMutationAt = Date.now();

    const traceId = "TRC_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    try {
        let result = null;
        switch (action) {
            case 'updateNickname': result = await API.auth.updateNickname(params.email, params.newNickname); break;
            case 'getAllUsers': result = await API.auth.getAllUsers(params.groupKey); break;
            case 'getUserGroup': result = await API.auth.getUserGroup(params.email); break;
            case 'listAllUsers': result = await API.user.listAll(); break;
            case 'provisionUser': result = await API.user.provision(params.email, params.nickname, params.groupKey); break;
            case 'updateUserGroup': result = await API.user.updateGroup(params.email, params.groupKey); break;
            case 'removeUser': result = await API.user.remove(params.email); break;

            case 'getRecentFilesForDashboard': result = await API.file.getRecentFilesForDashboard(params.groupKey); break;
            case 'getFileList': result = await API.file.list(params.groupKey, params); break;
            case 'deleteFile': result = await API.file.delete(params.fileId, params.groupKey); break;
            case 'uploadFile': result = await API.file.upload(params.fileData, params.fileName, params.mimeType, params.groupKey, params.description, params.email, params.folderPath, params.projectId, params.taskId); break;
            case 'shareFile': result = await API.file.share(params.fileId, params.groupKey); break;

            case 'getEvents': result = await API.calendar.getEvents(params.startDate, params.endDate, params.calendarType, params.groupKey, params.email); break;
            case 'createEvent': result = await API.calendar.create(params, params.calendarType, params.groupKey, params.email); break;
            case 'updateEvent': result = await API.calendar.updateEvent(params.eventId, params, params.calendarType, params.groupKey, params.email); break;
            case 'deleteEvent': result = await API.calendar.deleteEvent(params.eventId, params.calendarType, params.groupKey, params.email); break;
            case 'toggleImportant': result = await API.calendar.toggleImportant(params.eventId, params.isImportant, params.calendarType, params.groupKey, params.email); break;

            case 'getProjectList': result = await API.project.list(params.groupKey, params.searchName, params.archiveScope); break;
            case 'getProjectListWithTaskStats': result = await API.project.listWithStats(params.groupKey, params.searchName, params.archiveScope); break;
            case 'setProjectArchived': result = await API.project.setArchived(params.projectId, params.archived); break;
            case 'createProject': result = await API.project.create(params, params.groupKey); break;
            case 'updateProject': result = await API.project.updateNote(params.projectId, { status: params.status, description: params.description, expectedVersion: params.expectedVersion }, params.groupKey); break;
            case 'shareProject': result = await API.project.share(params.projectId, params.groupKey); break;
            case 'deleteProject': result = await API.project.delete(params.projectId, params.groupKey); break;
            case 'getMilestones': result = await API.project.getMilestones(params.projectId); break;
            case 'addMilestone': result = await API.project.addMilestone(params.projectId, params.title, params.targetDate); break;
            case 'toggleMilestone': result = await API.project.toggleMilestone(params.milestoneId, params.isDone); break;
            case 'deleteMilestone': result = await API.project.deleteMilestone(params.milestoneId); break;
            case 'getBurndownData': result = await API.project.getBurndownData(params.projectId); break;

            case 'getTaskList': result = await API.task.list(params.projectId, params.groupKey); break;
            case 'listMyTasks': result = await API.task.listMine(params.email, params.groupKey); break;
            case 'getWorkload': result = await API.task.workload(params.groupKey); break;
            case 'globalSearch': result = await API.search.global(params.query, params.groupKey); break;
            case 'getChecklist': result = await API.task.getChecklist(params.taskId); break;
            case 'addChecklistItem': result = await API.task.addChecklistItem(params.taskId, params.text); break;
            case 'toggleChecklistItem': result = await API.task.toggleChecklistItem(params.taskId, params.itemId, params.done); break;
            case 'deleteChecklistItem': result = await API.task.deleteChecklistItem(params.taskId, params.itemId); break;
            case 'saveTask': result = await API.task.save(params, params.groupKey); break;
            case 'deleteTask': result = await API.task.delete(params.taskId, params.projectId, params.groupKey); break;
            case 'deleteFileFromTask': result = await API.task.deleteFile(params.taskId, params.fileId, params.groupKey); break;
            case 'uploadFileToTask': result = await API.task.uploadFile(params.fileData, params.fileName, params.mimeType, params.taskId, params.groupKey, params.description, params.email); break;
            case 'reorderTasks': result = await API.task.reorder(params.orderedIds); break;
            case 'getTaskComments': result = await API.task.getComments(params.taskId); break;
            case 'addTaskComment': result = await API.task.addComment(params.taskId, params.content, params.email, params.mentionedEmails); break;
            case 'bulkUpdateTaskStatus': result = await API.task.bulkUpdateStatus(params.taskIds, params.status, params.projectId, params.groupKey); break;
            case 'bulkAssignTasks': result = await API.task.bulkAssign(params.taskIds, params.assignees, params.projectId, params.groupKey); break;
            case 'bulkSetTaskDueDate': result = await API.task.bulkSetDueDate(params.taskIds, params.dueDate, params.projectId, params.groupKey); break;
            case 'bulkAddTaskLabel': result = await API.task.bulkAddLabel(params.taskIds, params.label, params.projectId, params.groupKey); break;
            case 'bulkDeleteTasks': result = await API.task.bulkDelete(params.taskIds, params.projectId, params.groupKey); break;
            case 'getTaskHistory': result = await API.task.getHistory(params.taskId); break;

            case 'getTeamSummary': result = await API.asset.getTeamSummary(); break;
            case 'getMemberList': result = await API.asset.getMemberList(); break;
            case 'getMemberDetail': result = await API.asset.getMemberDetail(params.email); break;
            case 'listAssetTransactions': result = await API.asset.listTransactions(params.email); break;
            case 'addAssetTransaction': result = await API.asset.addTransaction(params.email, params.txn); break;
            case 'deleteAssetTransaction': result = await API.asset.deleteTransaction(params.email, params.id); break;
            case 'getHoldingsView': result = await API.asset.getHoldingsView(params.email); break;
            case 'setMarketPrice': result = await API.asset.setMarketPrice(params.email, params.symbol, params.price); break;
            case 'getCashDebt': result = await API.asset.getCashDebt(params.email); break;
            case 'setCashDebt': result = await API.asset.setCashDebt(params.email, params.cash, params.debt); break;
            case 'getNavHistory': result = await API.asset.getNavHistory(params.email, params.days); break;
            case 'getAssetSummaryKpis': result = await API.asset.getSummaryKpis(params.email); break;
            case 'listCashFlows': result = await API.asset.cashFlow.list(params.email); break;
            case 'addCashFlow': result = await API.asset.cashFlow.add(params.email, params.flow); break;
            case 'deleteCashFlow': result = await API.asset.cashFlow.delete(params.email, params.id); break;
            case 'listCorporateActions': result = await API.asset.corporateAction.list(params.email); break;
            case 'addCorporateAction': result = await API.asset.corporateAction.add(params.email, params.action); break;
            case 'deleteCorporateAction': result = await API.asset.corporateAction.delete(params.email, params.id); break;
            case 'listBenchmarkPrices': result = await API.asset.benchmark.list(params.indexCode, params.days); break;
            case 'upsertBenchmarkPrice': result = await API.asset.benchmark.upsert(params.indexCode, params.priceDate, params.closeValue, params.email); break;
            case 'getPerformanceMetrics': result = await API.asset.getPerformanceMetrics(params.email); break;

            case 'getFinanceUsers': result = await API.note.getFinanceUsers(); break;
            case 'getFinanceNotes': result = await API.note.getFinanceNotes(); break;
            case 'addFinanceNote': result = await API.note.addFinanceNote(params); break;
            case 'deleteFinanceNote': result = await API.note.deleteFinanceNote(params.id); break;

            case 'getStockList': result = await API.stock.getStockList(); break;
            case 'getStockYears': result = await API.stock.getStockYears(params.symbol); break;
            case 'getStockDetail': result = await API.stock.getStockDetail(params.symbol, params.year); break;
            case 'getStockHistory': result = await API.stock.getStockHistory(params.symbol); break;
            case 'saveStockValuation': result = await API.stock.saveStockValuation(params, params.email); break;

            case 'getMyFinRoles': result = await API.finRoles.getMyRoles(params.email); break;
            case 'listFinRoles': result = await API.finRoles.listAll(); break;
            case 'grantFinRole': result = await API.finRoles.grantRole(params.targetEmail, params.role, params.byEmail); break;
            case 'revokeFinRole': result = await API.finRoles.revokeRole(params.targetEmail, params.role); break;

            case 'getDeletedItems': result = await API.system.getDeletedItems(params.tableName, params.groupKey); break;
            case 'restoreItem': result = await API.system.restoreItem(params.tableName, params.id); break;
            case 'hardDeleteItem': result = await API.system.hardDeleteItem(params.tableName, params.id); break;

            case 'getNotifications': result = await API.notification.get(params.groupKey, params.limit, params.email); break;
            case 'syncLounge': result = await API.lounge.sync(params); break;

            case 'getPersonalItems': result = await API.personal.list(params.type); break;
            case 'savePersonalItem': result = await API.personal.upsert(params); break;
            case 'deletePersonalItem': result = await API.personal.remove(params.id); break;

            default:
                console.warn(`Supabase chưa hỗ trợ action: ${action}`);
                return { status: 'success', data: [], message: `Chưa cấu hình hành động ${action}` };
        }
        let finalMessage = typeof result === 'string' ? result : 'OK';
        const entityId = params.taskId || params.id || params.eventId || params.projectId || null;

        if (MUTATING_ACTIONS.has(action)) window.lastLocalMutationAt = Date.now();

        if (action !== 'getNotifications' && action !== 'syncLounge' && !action.startsWith('get')) {
            API.system.logAction(traceId, action, finalMessage, 'success', params.email, params.groupKey, entityId);
        }

        return { status: 'success', data: result, message: finalMessage };
    } catch (error) {
        console.error(`Supabase lỗi tại ${action}:`, error);
        const entityId = params.taskId || params.id || params.eventId || params.projectId || null;

        if (action !== 'getNotifications' && action !== 'syncLounge' && !action.startsWith('get')) {
            API.system.logAction(traceId, action, error.message || String(error), 'error', params.email, params.groupKey, entityId);
        }

        return { status: 'error', data: null, message: error.message || String(error) };
    }
};

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('Đã kích hoạt thành công. Phạm vi:', reg.scope))
            .catch(err => console.error('Lỗi kích hoạt:', err));
    });
}

(function initPwaInstallPrompt() {
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    if (isStandalone) return;

    let deferredPrompt = null;
    let btn = null;

    function showButton() {
        if (btn) { btn.style.display = 'flex'; return; }
        btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'pwa-install-btn';
        btn.innerHTML = '<i class="fa-solid fa-download"></i> Cài đặt ứng dụng';
        btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:9999;display:flex;align-items:center;gap:8px;' +
            'background:#C9A84C;color:#0A0A0F;border:none;border-radius:999px;padding:12px 18px;' +
            'font-weight:600;font-size:14px;font-family:inherit;box-shadow:0 6px 20px rgba(0,0,0,0.4);cursor:pointer;';
        btn.addEventListener('click', async () => {
            if (!deferredPrompt) return;
            btn.style.display = 'none';
            deferredPrompt.prompt();
            await deferredPrompt.userChoice;
            deferredPrompt = null;
        });
        document.body.appendChild(btn);
    }

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e;
        showButton();
    });

    window.addEventListener('appinstalled', () => {
        if (btn) btn.style.display = 'none';
        deferredPrompt = null;
    });
})();
