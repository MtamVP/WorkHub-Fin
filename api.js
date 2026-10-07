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
    // \n/\r và 2 ký tự phân đoạn ít ai để ý (U+2028/U+2029) đều kết thúc 1 chuỗi JS
    // literal dù đang nằm trong dấu nháy đơn/kép -- trước đây thiếu, phải vá thủ công ở
    // từng nơi gọi (task description dùng .replace(/\r?\n/g, "\\n") RIÊNG sau khi gọi
    // escapeJs) -- gộp về đúng 1 chỗ để mọi caller tự động an toàn.
    return String(value === null || value === undefined ? '' : value)
        .replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"')
        .replace(/\r\n/g, '\\n').replace(/[\r\n\u2028\u2029]/g, '\\n');
};

const SUPABASE_URL = "https://gqsbsqaxzpzcloaopzvv.supabase.co";
const SUPABASE_KEY = "sb_publishable_sl9uOpcIzfzN9NZ5D_ZdsQ_FQZchyUR";

const TOOLS_SUPABASE_URL = "https://jbibxrhorqmbbyjuxcgo.supabase.co";
const TOOLS_SUPABASE_KEY = "sb_publishable_RgXnbjszBBJJUswXTzlpSA_ixYR3nJ-";

const sbClient = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY) : null;
// Dự án Supabase "tools" (dùng chung với các công cụ khác): Fin hiện không gọi tới, nên chỉ tạo client khi có nơi đọc
// window.toolsSupabaseClient lần đầu -- trước đây mỗi lần mở trang đều tạo thêm một client (thêm một bộ quản lý phiên chạy nền).
let toolsSbClient = null;
Object.defineProperty(window, 'toolsSupabaseClient', {
    configurable: true,
    get() { if (!toolsSbClient && window.supabase) toolsSbClient = window.supabase.createClient(TOOLS_SUPABASE_URL, TOOLS_SUPABASE_KEY); return toolsSbClient; }
});

window.supabaseClient = sbClient;
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
// Tạm tắt (2026-08-26): storage-proxy đang treo khi upload thật (đang debug), nên
// upload mới tạm quay lại Supabase Storage cũ. Đọc/xoá vẫn tự nhận diện đúng backend
// theo tên bucket nên không cần đổi gì khi bật lại -- chỉ cần set true.
const USE_MINIO_STORAGE = false;
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
async function deleteFromStorage(bucket, path) {
    if (NEW_MINIO_BUCKETS.has(bucket)) {
        await storageProxyDelete(bucket, path);
    } else {
        const { error } = await sbClient.storage.from(bucket).remove([path]);
        if (error) console.error("Lỗi xóa file storage:", error);
    }
}

async function uploadToStorage(newBucket, oldBucket, path, blob, mimeType) {
    if (USE_MINIO_STORAGE) {
        await storageProxyUpload(newBucket, path, blob, mimeType);
        return newBucket;
    }
    const { error } = await sbClient.storage.from(oldBucket).upload(path, blob, { contentType: mimeType });
    if (error) throw error;
    return oldBucket;
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
    // Thoát ký tự có nghĩa đặc biệt trong toán tử .or() của PostgREST -- ",", "(" ")" cho
    // phép chèn thêm điều kiện lọc tuỳ ý nếu không lọc, khai thác được cả khi CHƯA đăng
    // nhập (hàm này gọi được từ trang login, trước khi có phiên xác thực).
    const safe = String(emailOrUsername || '').replace(/[,()]/g, '');
    if (!safe) return null;
    const { data } = await sbClient.from('users')
        .select('id').or(`nickname.eq.${safe},email.eq.${safe}`).maybeSingle();
    return data ? data.id : null;
}

// Giờ nhập trong form là GIỜ ĐỊA PHƯƠNG của người dùng. events.start_time/end_time là timestamptz và DB chạy UTC, nên chuỗi
// trần 'YYYY-MM-DD HH:mm' bị hiểu là UTC => giờ lệch đúng bằng độ lệch múi giờ của máy (và đẩy sai giờ lên Google Calendar).
// Gửi mốc tuyệt đối (ISO, có 'Z') thì mọi múi giờ đều đúng. Không parse được thì giữ nguyên chuỗi như cũ.
function toEventInstant(dateStr, timeStr) {
    const d = new Date(dateStr + 'T' + timeStr);
    return isNaN(d.getTime()) ? (dateStr + ' ' + timeStr) : d.toISOString();
}

// Khoá Supabase Storage chỉ nhận ASCII an toàn -- tên file tiếng Việt phải mã hoá (lib/sync-decision.js). Chưa nạp lib thì giữ nguyên.
function personalStorageKey(relativePath) {
    return typeof encodeSyncStorageKey === 'function' ? encodeSyncStorageKey(relativePath) : relativePath;
}

function genId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

const API = {
    auth: {
        getRealEmail: async (username) => {
            if (!sbClient) return null;
            const safe = String(username || '').replace(/[,()]/g, '');
            if (!safe) return null;
            const { data, error } = await sbClient.from('users')
                .select('email').or(`nickname.eq.${safe},email.eq.${safe}`).maybeSingle();
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
            let query = sbClient.from('users').select('id, email, name:nickname');
            if (groupKey && groupKey !== 'all' && groupKey !== 'admin') query = query.eq('group_key', groupKey);
            const { data } = await query;
            return data || [];
        },
        getUserInfo: async (email) => {
            if (!sbClient) return { group: 'guest', name: '' };
            const { data, error } = await sbClient.from('users').select('name:nickname, group:group_key, active').eq('email', email).maybeSingle();
            if (error || !data) return { group: 'guest', name: '' };
            return data;
        },
        // Phase B RBAC: resolves the caller's effective role (viewer/editor/admin) for a
        // group via the DB function current_user_role() -- cosmetic-only on the client
        // (used to hide/disable UI), RLS is the real backstop regardless of what this
        // returns. Fails open to 'editor' (today's default behavior) on any error, since a
        // false negative here never grants more access than RLS itself would allow.
        getMyRole: async (groupKey) => {
            if (!sbClient) return 'editor';
            const { data, error } = await sbClient.rpc('current_user_role', { p_group_key: groupKey });
            if (error) { console.warn('getMyRole thất bại, mặc định Editor:', error); return 'editor'; }
            return data || 'editor';
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
            const { data, error } = await sbClient.from('users').select('email, nickname, group_key, active, created_at').order('created_at', { ascending: false }).limit(1000);
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
        // Hard delete. Không còn UI nào trong 3 app gọi hàm này nữa -- setActive(email,
        // false) là luồng chuẩn. Giữ nguyên (không xoá) làm lối thoát khẩn cấp (xoá kiểu
        // GDPR thật), RLS DELETE (admin-only) vẫn là chốt chặn thật sự như trước.
        remove: async (email) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('users').delete().eq('email', email);
            if (error) throw error;
            return `Đã thu hồi quyền truy cập của ${email}. (Tài khoản đăng nhập Firebase của họ vẫn còn tồn tại nếu có — không tự xóa được từ đây.)`;
        },
        // Vô hiệu hoá thay cho xoá cứng. Chỉ patch đúng cột `active`, không đi qua upsert
        // nguyên hàng (mẫu giống API.personal.setFlags). RLS + trg_prevent_self_active_change
        // (user-deactivation-migration.sql) là chốt chặn thật -- chỉ admin đổi được cột này
        // dù ai gọi hàm này.
        setActive: async (email, active) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { data, error } = await sbClient.from('users').update({ active: !!active }).eq('email', email).select().single();
            if (error) throw error;
            return active
                ? `Đã kích hoạt lại tài khoản ${email}.`
                : `Đã vô hiệu hóa tài khoản ${email}. Người này sẽ bị đăng xuất và không đăng nhập lại được cho tới khi được kích hoạt lại.`;
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
                group_key: effectiveGroupKey,
                org_unit_id: projectData.orgUnitId || null
            });
            if (error) throw error;
            return `Đã tạo dự án ${projectData.name}!`;
        },
        updateNote: async (projectId, payload, groupKey) => {
            const updates = { updated_at: new Date().toISOString() };
            if (payload && payload.status) updates.status = payload.status;
            if (payload && payload.description !== undefined) updates.description = payload.description;
            if (payload && payload.orgUnitId !== undefined) updates.org_unit_id = payload.orgUnitId || null;

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
                    await deleteFromStorage(fileToDelete.bucket, fileToDelete.path);
                } else if (fileToDelete.url) {
                    const urlParts = fileToDelete.url.split('/general_bucket/');
                    if (urlParts.length > 1) {
                        const filePath = decodeURIComponent(urlParts[1]);
                        await deleteFromStorage('general_bucket', filePath);
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
            const bucketName = await uploadToStorage('wh-org-files', 'general_bucket', filePath, blob, mimeType);

            const { data: task, error: fetchError } = await sbClient.from('tasks').select('attachments').eq('id', taskId).maybeSingle();
            if (fetchError) throw fetchError;

            let attachments = typeof task.attachments === 'string' ? JSON.parse(task.attachments || '[]') : task.attachments;
            if (!Array.isArray(attachments)) attachments = [];

            attachments.push({
                id: fileId,
                name: fileName,
                bucket: bucketName,
                path: filePath,
                url: buildFileUrl(`${bucketName}/${filePath}`),
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
                    groupKey: f.group_key,
                    storagePath: f.storage_path
                };
            });
        },
        delete: async (fileId, groupKey) => {
            const { data, error } = await sbClient.from('files').update({ deleted_at: new Date().toISOString() }).eq('id', fileId).select('name').maybeSingle();
            if (error) throw error;
            return `Đã đưa ${data.name} vào thùng rác!`;
        },
        permanentDelete: async (fileId, groupKey) => {
            const { data: fileData, error: fetchErr } = await sbClient.from('files').select('storage_path, name').eq('id', fileId).maybeSingle();
            if (fetchErr || !fileData) return "Không tìm thấy file";
            
            if (fileData.storage_path) {
                const parts = fileData.storage_path.split('/');
                if (parts.length >= 2) {
                    const bucketName = parts[0];
                    const filePath = parts.slice(1).join('/');
                    if (NEW_MINIO_BUCKETS.has(bucketName)) {
                        await storageProxyDelete(bucketName, filePath);
                    } else {
                        await sbClient.storage.from(bucketName).remove([filePath]);
                    }
                }
            }

            await sbClient.from('files').delete().eq('id', fileId);
            return `Đã xóa vĩnh viễn ${fileData.name}`;
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
            const newBucketName = groupKey === 'finance' ? 'wh-fin-files' :
                (groupKey === 'science' ? 'wh-sci-files' : 'wh-org-files');
            const oldBucketName = groupKey === 'finance' ? 'finance_bucket' :
                (groupKey === 'science' ? 'science_bucket' : 'general_bucket');
            // Admin tải file trực tiếp trong Fin ('admin') vẫn phải là file của Fin, không
            // stamp thẳng 'admin' (cùng lý do như project.create()).
            const effectiveGroupKey = groupKey === 'admin' ? 'finance' : groupKey;

            // Sửa lỗi: Nếu folderPath được truyền vào, dùng luôn nó làm thư mục gốc thay vì nhét vào bronze/
            const fullStoragePath = `${folderPath ? folderPath + '/' : 'bronze/'}${filePath}`;

            const bucketName = await uploadToStorage(newBucketName, oldBucketName, fullStoragePath, blob, mimeType);

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
                    createdBy: ev.created_by,
                    source: ev.source,
                    googleEventId: ev.google_event_id
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
                start_time: toEventInstant(eventData.startDate, eventData.startTime),
                end_time: toEventInstant(eventData.endDate, eventData.endTime),
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
                start_time: toEventInstant(eventData.startDate, eventData.startTime),
                end_time: toEventInstant(eventData.endDate, eventData.endTime),
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
            if (!data) throw new Error('Không tìm thấy sự kiện (đã bị xoá hoặc không thuộc quyền của bạn).');
            return `Đã đưa sự kiện "${data.title}" vào thùng rác!`;
        },
        toggleImportant: async (eventId, isImportant, calendarType, groupKey, email) => {
            let query = sbClient.from('events').update({ is_important: isImportant }).eq('id', eventId);
            if (calendarType === 'personal' && email) {
                query = query.eq('created_by', email);
            }
            const { data, error } = await query.select('title').maybeSingle();
            if (error) throw error;
            if (!data) throw new Error('Không tìm thấy sự kiện (đã bị xoá hoặc không thuộc quyền của bạn).');
            return `Đã cập nhật trạng thái quan trọng của sự kiện "${data.title}" thành công!`;
        },
        // Đồng bộ Google Calendar (1 chiều, chỉ đọc) -- dùng bởi calendar-connect.js.
        upsertGoogleEvents: async (rows) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            if (!rows || !rows.length) return 0;
            const { error } = await sbClient.from('events').upsert(rows, { onConflict: 'google_event_id' });
            if (error) throw error;
            return rows.length;
        },
        // Dọn các sự kiện đã đồng bộ trước đó nhưng không còn xuất hiện trong lần kéo
        // mới nhất (đã bị xoá/huỷ bên phía Google) -- Google API không trả "danh sách
        // xoá" nên phải suy luận bằng khác biệt tập hợp, cùng kiểu đối chiếu local/remote
        // đã dùng ở personal-sync.js's fullReconcile().
        // Đợt 3 (2 chiều): bỏ điều kiện source='google' -- giờ đây 1 sự kiện gốc tạo trong
        // WorkHub cũng có thể đã liên kết với Google (google_event_id khác null); nếu người
        // dùng xoá nó thẳng trên Google, lần đồng bộ tiếp theo phải phản ánh đúng (dọn luôn),
        // không chỉ dọn các dòng gốc từ Google như đợt "chỉ kéo về" trước đây.
        // Đợt 4 (đa lịch): thêm tham số calendarId -- CHỈ dọn trong phạm vi đúng 1 lịch, không
        // gộp activeIds của lịch khác vào, nếu không 1 sự kiện còn sống ở lịch A sẽ bị hiểu
        // nhầm là "đã xoá bên Google" khi so với danh sách hoạt động của lịch B. Các dòng cũ
        // (tạo trước khi có cột google_calendar_id) coi như thuộc 'primary'.
        pruneGoogleEvents: async (email, groupKey, calendarId, activeGoogleIds, windowStart, windowEnd) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            let query = sbClient.from('events')
                .update({ deleted_at: new Date().toISOString() })
                .eq('created_by', email).eq('group_key', groupKey)
                .not('google_event_id', 'is', null)
                .is('deleted_at', null)
                .gte('start_time', windowStart).lte('start_time', windowEnd);
            query = (calendarId === 'primary' || !calendarId)
                ? query.or('google_calendar_id.eq.primary,google_calendar_id.is.null')
                : query.eq('google_calendar_id', calendarId);
            if (activeGoogleIds && activeGoogleIds.length) {
                query = query.not('google_event_id', 'in', `(${activeGoogleIds.map(id => `"${id}"`).join(',')})`);
            }
            const { data, error } = await query.select('id');
            if (error) throw error;
            const prunedIds = (data || []).map(r => r.id);
            if (prunedIds.length) {
                await sbClient.from('calendar_google_sync').delete().in('event_id', prunedIds);
            }
        },
        // -------------------- Đồng bộ Google Calendar 2 CHIỀU (đợt 3) --------------------
        // Các hàm dưới đây phục vụ chiều WorkHub -> Google (đẩy lên) + xử lý xung đột khi
        // CẢ 2 bên đều đổi. Bookkeeping (synced_version/google_updated_at) nằm ở bảng riêng
        // calendar_google_sync, KHÔNG lưu trên chính dòng events -- xem comment trong
        // google-calendar-2way-sync-migration.sql: events có trigger tăng version vô điều
        // kiện trên mọi UPDATE, gộp chung 1 bảng sẽ khiến việc ghi "đã đồng bộ xong" tự làm
        // version tăng thêm, gây đẩy/kéo lặp vô ích mãi mãi.

        // Sự kiện cá nhân có version MỚI HƠN lần đồng bộ gần nhất (hoặc chưa từng đồng bộ) --
        // ứng viên cần đẩy lên Google. Không lọc theo deleted_at: sự kiện vừa bị xoá cục bộ
        // (soft-delete cũng là 1 UPDATE, cũng bump version) vẫn cần đẩy lệnh xoá tương ứng lên
        // Google, không được bỏ qua.
        // Đợt 4: gồm CẢ sự kiện lặp (recurrence != 'none', đẩy kèm RRULE -- xem buildRRule()
        // trong calendar-connect.js). Vì WorkHub chỉ lưu 1 DÒNG MASTER cho cả chuỗi lặp (không
        // materialize từng lần lặp), lọc theo start_time như sự kiện lẻ sẽ bỏ sót 1 chuỗi lặp
        // bắt đầu từ rất lâu nhưng vẫn đang diễn ra (vd tạo cách đây 3 tháng, lặp hằng tuần,
        // không có ngày kết) -- nên xét riêng: còn "sống" nếu bắt đầu trước khi cửa sổ kết
        // thúc, VÀ (không có ngày kết hoặc) chưa kết thúc trước khi cửa sổ bắt đầu.
        getPersonalEventsForPush: async (email, groupKey, windowStart, windowEnd) => {
            if (!sbClient) return [];
            const baseSelect = 'id, title, start_time, end_time, description, location, deleted_at, google_event_id, google_calendar_id, version, recurrence, recurrence_end';

            const { data: onceEvents, error: onceErr } = await sbClient.from('events')
                .select(baseSelect)
                .eq('calendar_type', 'personal').eq('created_by', email).eq('group_key', groupKey)
                .eq('recurrence', 'none')
                .gte('start_time', windowStart).lte('start_time', windowEnd)
                .limit(1000);
            if (onceErr) throw onceErr;

            const { data: recurringEvents, error: recErr } = await sbClient.from('events')
                .select(baseSelect)
                .eq('calendar_type', 'personal').eq('created_by', email).eq('group_key', groupKey)
                .neq('recurrence', 'none')
                .lte('start_time', windowEnd)
                .or(`recurrence_end.is.null,recurrence_end.gte.${windowStart.slice(0, 10)}`)
                .limit(1000);
            if (recErr) throw recErr;

            const events = [...(onceEvents || []), ...(recurringEvents || [])];
            if (!events.length) return [];

            const linkedIds = events.filter(e => e.google_event_id).map(e => e.id);
            let syncedMap = {};
            if (linkedIds.length) {
                const { data: syncRows, error: syncErr } = await sbClient.from('calendar_google_sync')
                    .select('event_id, synced_version').in('event_id', linkedIds);
                if (syncErr) throw syncErr;
                (syncRows || []).forEach(r => { syncedMap[r.event_id] = r.synced_version; });
            }
            return events.filter(e => {
                if (!e.google_event_id) return !e.deleted_at; // chưa từng đồng bộ -- ứng viên tạo mới bên Google (đã xoá thì bỏ qua)
                const syncedVersion = syncedMap[e.id];
                return syncedVersion === undefined || e.version > syncedVersion;
            });
        },
        // Tra bookkeeping đồng bộ theo google_event_id (dùng khi kéo về, để biết dòng nào
        // Google thật sự đổi so với lần đồng bộ trước, tránh kéo về đè lên chỉnh sửa cục bộ
        // chưa kịp đẩy lên).
        getGoogleSyncState: async (googleEventIds) => {
            if (!sbClient || !googleEventIds || !googleEventIds.length) return {};
            const { data, error } = await sbClient.from('calendar_google_sync')
                .select('*').in('google_event_id', googleEventIds);
            if (error) throw error;
            const map = {};
            (data || []).forEach(r => { map[r.google_event_id] = r; });
            return map;
        },
        // Version hiện tại của các dòng events đã liên kết với 1 google_event_id -- dùng
        // cùng với getGoogleSyncState() để phát hiện xung đột thật (cả 2 bên đều đổi kể từ
        // lần đồng bộ trước).
        getEventsVersionsByGoogleId: async (googleEventIds) => {
            if (!sbClient || !googleEventIds || !googleEventIds.length) return {};
            const { data, error } = await sbClient.from('events')
                .select('id, google_event_id, version').in('google_event_id', googleEventIds).is('deleted_at', null);
            if (error) throw error;
            const map = {};
            (data || []).forEach(r => { map[r.google_event_id] = r; });
            return map;
        },
        // Ghi nhận "đã đồng bộ xong" cho 1 loạt dòng (sau khi đẩy lên HOẶC kéo về thành
        // công) -- upsert theo lô vào bảng bookkeeping riêng, không đụng bảng events.
        markGoogleSyncedBatch: async (entries) => {
            if (!sbClient || !entries || !entries.length) return;
            const rows = entries.map(e => ({
                event_id: e.eventId, google_event_id: e.googleEventId,
                synced_version: e.syncedVersion, google_updated_at: e.googleUpdatedAt || null,
                updated_at: new Date().toISOString()
            }));
            const { error } = await sbClient.from('calendar_google_sync').upsert(rows, { onConflict: 'event_id' });
            if (error) throw error;
        },
        // Gắn google_event_id vào 1 dòng events lần ĐẦU TIÊN đẩy lên Google thành công (sự
        // kiện tạo mới trong WorkHub, chưa từng liên kết) -- dùng .is('google_event_id',null)
        // để chỉ thật sự UPDATE (và chỉ thật sự bump version qua trigger) đúng 1 lần lúc liên
        // kết ban đầu, không phải mỗi lần đồng bộ. Trả về version MỚI NHẤT của dòng (sau khi
        // trigger đã chạy, nếu có) để caller ghi đúng vào bookkeeping.
        linkGoogleEventId: async (eventId, googleEventId, googleCalendarId) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            await sbClient.from('events').update({ google_event_id: googleEventId, google_calendar_id: googleCalendarId || 'primary' })
                .eq('id', eventId).is('google_event_id', null);
            const { data, error } = await sbClient.from('events').select('version').eq('id', eventId).maybeSingle();
            if (error) throw error;
            return data ? data.version : null;
        },
        // Trong danh sách google_event_id (recurringEventId của các instance Google tự khai
        // triển), trả về tập con nào là MASTER của 1 sự kiện lặp tạo từ WorkHub (recurrence !=
        // 'none') -- dùng khi kéo về để bỏ qua các instance lẻ đó, tránh tạo trùng với dòng
        // master đã có sẵn (xem comment đầu calendar-connect.js, mục "Sự kiện lặp").
        getRecurringMasterGoogleIds: async (googleEventIds) => {
            if (!sbClient || !googleEventIds || !googleEventIds.length) return [];
            const { data, error } = await sbClient.from('events')
                .select('google_event_id').in('google_event_id', googleEventIds).neq('recurrence', 'none').is('deleted_at', null);
            if (error) throw error;
            return (data || []).map(r => r.google_event_id);
        },
        // Áp bản cập nhật từ Google vào 1 dòng events ĐÃ liên kết sẵn -- caller (chiều kéo
        // về trong calendar-connect.js) đã tự xác định chỉ Google đổi (không phải xung đột
        // cần chặn) trước khi gọi hàm này, nên update thẳng không cần expectedVersion.
        applyGooglePullUpdate: async (eventId, fields) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { data, error } = await sbClient.from('events').update(fields).eq('id', eventId).select('version').maybeSingle();
            if (error) throw error;
            return data ? data.version : null;
        },
        // Xoá dòng bookkeeping sau khi 1 sự kiện đã bị xoá (mềm) cục bộ VÀ đã đẩy lệnh xoá
        // tương ứng lên Google thành công -- không còn cần theo dõi trạng thái đồng bộ nữa.
        deleteGoogleSyncRow: async (eventId) => {
            if (!sbClient) return;
            const { error } = await sbClient.from('calendar_google_sync').delete().eq('event_id', eventId);
            if (error) throw error;
        }
    },
    _fetchAllRows: async (build) => API.asset._fetchAll(build),
    asset: {
        // --- Sổ lệnh (transaction ledger) — nguồn sự thật duy nhất cho khối lượng/giá vốn ---
        listTransactions: async (email) => {
            const userId = await getUserId(email);
            // Đọc theo trang: máy chủ trả tối đa 1.000 dòng mỗi lần, quá thì phần còn lại bị cắt im lặng. Thứ tự có thêm id để phân trang ổn định.
            return API.asset._fetchAll(() => sbClient.from('finance_transactions')
                .select('*').eq('user_id', userId).is('deleted_at', null)
                .order('trade_date', { ascending: false }).order('created_at', { ascending: false }).order('id'));
        },
        // Sổ lệnh FIFO chuẩn kế toán: lô cũ nhất bán trước. Hành động doanh nghiệp (tách/gộp,
        // cổ tức cổ phiếu) được replay xen kẽ theo đúng ex_date để điều chỉnh khối lượng/giá vốn hồi tố.
        // Dùng chung bởi computeLots (trạng thái lô hiện tại) và recomputeRealizedPnl (lãi/lỗ đã chốt
        // của MỌI lệnh bán) — 1 lượt replay duy nhất theo đúng thứ tự thời gian thực (trade_date rồi
        // created_at), để sửa/xóa lệnh cũ (thêm lệnh mua lùi ngày, xóa hành động doanh nghiệp, v.v.)
        // không để lại số liệu đã lưu bị lỗi thời ở các lệnh bán khác.
        _replayFifo: async (userId) => {
            // Đọc ĐỦ sổ lệnh theo trang: đây là nguồn sự thật của khối lượng/giá vốn/lãi lỗ đã chốt; nếu bị cắt ở 1.000 dòng thì
            // danh mục, NAV và lãi lỗ ghi ngược vào sổ đều sai mà không báo lỗi gì.
            const txns = await API.asset._fetchAll(() => sbClient.from('finance_transactions')
                .select('*').eq('user_id', userId).is('deleted_at', null)
                .order('trade_date', { ascending: true }).order('created_at', { ascending: true }).order('id'));
            const actions = await API.asset._fetchAll(() => sbClient.from('finance_corporate_actions')
                .select('*').eq('user_id', userId).is('deleted_at', null).order('ex_date').order('id'));

            const events = [
                ...(txns || []).map(t => ({ ...t, _kind: 'txn', _date: t.trade_date, _ts: t.created_at })),
                ...(actions || []).map(a => ({ ...a, _kind: 'action', _date: a.ex_date, _ts: a.created_at }))
            ].sort((a, b) => (new Date(a._date) - new Date(b._date)) || ((a._kind === 'action' ? 0 : 1) - (b._kind === 'action' ? 0 : 1)) || (new Date(a._ts) - new Date(b._ts)));   // cùng ngày: sự kiện doanh nghiệp trước lệnh (xem lib/portfolio-calc.js sortEvents)

            const lotsBySymbol = {};
            const realizedPnlByTxnId = {};
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
                    let remaining = qty, realized = 0;
                    const price = Number(ev.price) || 0;
                    while (remaining > 1e-9 && lots.length) {
                        const lot = lots[0];
                        const consumed = Math.min(lot.quantity, remaining);
                        realized += (price - lot.cost) * consumed;
                        lot.quantity -= consumed; remaining -= consumed;
                        if (lot.quantity <= 1e-9) lots.shift();
                    }
                    realizedPnlByTxnId[ev.id] = realized;
                }
            });
            return { lotsBySymbol, realizedPnlByTxnId };
        },
        // Trả về map { symbol: [{quantity, cost}, ...] } — thứ tự mảng = thứ tự mua (lô cũ nhất ở đầu).
        computeLots: async (userId) => {
            const { lotsBySymbol } = await API.asset._replayFifo(userId);
            return lotsBySymbol;
        },
        // Replay lại toàn bộ lịch sử và ghi đè realized_pnl cho MỌI lệnh bán theo đúng FIFO thời gian
        // thực — gọi sau mỗi lần thêm/xóa giao dịch hoặc hành động doanh nghiệp, để lệnh bán cũ không
        // bao giờ "đứng yên" với số lãi/lỗ tính từ trạng thái lô đã lỗi thời.
        recomputeRealizedPnl: async (userId) => {
            const { realizedPnlByTxnId } = await API.asset._replayFifo(userId);
            const ids = Object.keys(realizedPnlByTxnId);
            for (const id of ids) {
                await sbClient.from('finance_transactions').update({ realized_pnl: realizedPnlByTxnId[id] }).eq('id', id);
            }
            return ids.length;
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

            if (txn.type === 'sell') {
                // Chặn bán vượt khối lượng đang có, theo trạng thái lô hiện tại — đủ cho use-case
                // thông thường (nhập đúng thứ tự thời gian). Lãi/lỗ đã chốt CHÍNH XÁC của lệnh này
                // (và mọi lệnh bán khác) được tính lại ngay dưới qua recomputeRealizedPnl(), không
                // tính tay ở đây — tránh bị sai nếu lệnh được nhập lùi ngày so với các lệnh đã có.
                const lotsBySymbol = await API.asset.computeLots(userId);
                const totalAvail = (lotsBySymbol[symbol] || []).reduce((s, l) => s + l.quantity, 0);
                if (totalAvail < quantity - 1e-9) throw new Error(`Không đủ khối lượng "${symbol}" để bán (đang có ${totalAvail})`);
            }

            const tradeDate = txn.tradeDate || new Date().toISOString().slice(0, 10);
            // Danh sách hạn chế: mã bị cấm mua/bán thì không ghi được, kể cả quản lý (phải gỡ hạn chế trước). Lệnh điều chỉnh đối soát (việc đã xảy ra) bỏ qua; máy chủ ghi dòng kiểm tra.
            if (!txn.skipRestrictedCheck) {
                const rs = await API.asset.restricted.find(userId, symbol);
                if (rs) throw new Error('RESTRICTED: Mã ' + symbol + ' đang trong danh sách hạn chế của nhóm (' + rs.reason + '); không được mua hoặc bán. Quản lý cần gỡ hạn chế trước.');
            }
            // Giới hạn đầu tư: lệnh vượt giới hạn phải kèm lý do, hoặc bị chặn (chỉ quản lý ghi đè). Bỏ qua khi không có giới hạn nào đang bật.
            let gatedViolations = [], overrideUsed = false;
            if (!txn.skipLimitCheck && typeof LimitsCalc !== 'undefined') {
                const chk = await API.asset.limits.checkTrade(email, { type: txn.type === 'sell' ? 'sell' : 'buy', symbol, quantity, price, fee: Number(txn.fee) || 0, tax: txn.type === 'sell' ? (Number(txn.tax) || 0) : 0 });
                gatedViolations = chk.violations.filter(v => v.mode !== 'warn');
                if (gatedViolations.length) {
                    const reason = String((txn.exception && txn.exception.reason) || '').trim();
                    const actor = await API.asset.limits._actor(email);
                    if (chk.blocked) {
                        if (!(actor.isManager && reason.length >= 3)) throw new Error('LIMIT_BLOCKED: ' + chk.violations.filter(v => v.mode === 'block').map(v => v.text).join('; '));
                        overrideUsed = true;
                    } else if (reason.length < 3) {
                        throw new Error('LIMIT_REASON_REQUIRED: ' + gatedViolations.map(v => v.text).join('; '));
                    }
                }
            }
            // Duyệt lệnh lớn: lệnh vượt ngưỡng phải có đề xuất đã duyệt, còn hạn, khớp người/mã/chiều/khối lượng. Không có quy định nào đang bật thì bỏ qua.
            // Đây là kiểm trước để báo lỗi sớm và rõ ràng; chốt chặn thật là trigger fn_finance_transactions_enforce ở DB (lặp lại đúng luật này, không lách được bằng gọi API trực tiếp).
            let approvalReq = null;
            if (!txn.skipApprovalCheck && typeof ApprovalCalc !== 'undefined') {
                const ap = await API.asset.orders.checkTrade(email, { type: txn.type === 'sell' ? 'sell' : 'buy', symbol, quantity, price });
                if (ap.needed) {
                    if (!ap.match) throw new Error('APPROVAL_REQUIRED: Lệnh ' + (txn.type === 'sell' ? 'bán ' : 'mua ') + symbol + ' trị giá ' + Math.round(ap.value).toLocaleString('vi-VN') + ' đ'
                        + (ap.pct !== null ? ' (' + (Math.round(ap.pct * 10) / 10) + '% NAV)' : '') + ' vượt ngưỡng duyệt lệnh; cần đề xuất đã được quản lý duyệt (còn hạn) trước khi ghi.');
                    approvalReq = ap.match;
                }
            }
            const { data: inserted, error } = await sbClient.from('finance_transactions').insert({
                user_id: userId, symbol, type: txn.type === 'sell' ? 'sell' : 'buy', quantity, price,
                fee: Number(txn.fee) || 0,
                tax: txn.type === 'sell' ? (Number(txn.tax) || 0) : 0,
                trade_date: tradeDate,
                note: txn.note || null, realized_pnl: null, created_by: email
            }).select('id').single();
            if (error) throw error;
            // Luôn replay lại (kể cả lệnh mua) — 1 lệnh mua lùi ngày trước các lệnh bán đã có cũng
            // làm thay đổi thứ tự tiêu thụ lô FIFO của những lệnh bán đó.
            await API.asset.recomputeRealizedPnl(userId);
            await API.asset.recomputeAndSnapshot(email);
            // Đề xuất đã duyệt được dùng: trigger DB (finance-approval-enforce-migration.sql) đã tiêu thụ nó ngay khi ghi lệnh; chỉ khi chưa có đề xuất nào gắn lệnh này mới đánh dấu tại đây
            // (lỗi ở đây KHÔNG làm hỏng lệnh đã lưu)
            if (approvalReq && inserted) {
                try {
                    const { data: used } = await sbClient.from('finance_order_requests').select('id').eq('txn_id', inserted.id).limit(1);
                    if (!used || !used.length) await API.asset.orders.markExecuted(approvalReq.id, inserted.id);
                } catch (e) { return "Đã lưu lệnh giao dịch, nhưng chưa đánh dấu được đề xuất đã thực hiện: " + e.message; }
            }
            // Ghi nhận ngoại lệ giới hạn (lý do bắt buộc đã kiểm ở trên): lỗi ở đây KHÔNG làm hỏng lệnh đã lưu
            if (gatedViolations.length && inserted) {
                try {
                    const reason = String(txn.exception.reason).trim();
                    const { error: exErr } = await sbClient.from('finance_limit_exceptions').insert(gatedViolations.map(v => ({
                        user_id: userId, limit_id: v.limitId || null, kind: v.kind, symbol: ['max_symbol_pct', 'max_position_vnd', 'blocked_symbol'].includes(v.kind) ? v.subject : symbol,
                        txn_id: inserted.id, trade_date: tradeDate, mode: v.mode, reason, override: overrideUsed && v.mode === 'block',
                        metrics: { subject: v.subject, before: v.before, after: v.after, threshold: v.threshold, text: v.text }
                    })));
                    if (exErr) throw exErr;
                } catch (e) {
                    return "Đã lưu lệnh giao dịch, nhưng chưa ghi được ngoại lệ giới hạn: " + e.message;
                }
            }
            // Kế hoạch & lý do đi kèm lệnh (nhật ký quyết định): lỗi ở đây KHÔNG làm hỏng lệnh đã lưu
            if (txn.decision && inserted) {
                try {
                    await API.asset.journal.save(email, Object.assign({}, txn.decision, {
                        symbol, action: txn.type === 'sell' ? 'sell' : 'buy', date: tradeDate, price, quantity, txnId: inserted.id
                    }));
                } catch (e) {
                    return "Đã lưu lệnh giao dịch, nhưng chưa lưu được nhật ký quyết định: " + e.message;
                }
            }
            return "Đã lưu lệnh giao dịch!";
        },
        deleteTransaction: async (email, id) => {
            const userId = await getUserId(email);
            const { error } = await sbClient.from('finance_transactions')
                .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
            if (error) throw error;
            // Xóa 1 lệnh mua có thể làm đổi hẳn lô FIFO mà các lệnh bán sau đó đã tiêu thụ.
            await API.asset.recomputeRealizedPnl(userId);
            await API.asset.recomputeAndSnapshot(email);
            return "Đã xóa lệnh giao dịch!";
        },

        // --- Nhập sổ lệnh hàng loạt từ sao kê của công ty chứng khoán (dòng đã chuẩn hoá bởi lib/statement-import.js) ---
        // rows: [{date, symbol, type:'buy'|'sell', quantity, price, fee, tax, ref, note}]. KHÔNG ghi gì -- chỉ cho biết sẽ nhập gì:
        //  fresh: lệnh sẽ được nhập; duplicates: đã có trong sổ (nhập lại cùng file không tạo trùng);
        //  blocked: lệnh bán sẽ vượt khối lượng đang có (thiếu lệnh mua trước đó) -- không nhập, kèm lý do.
        previewImport: async (email, rows) => {
            if (typeof StatementImport === 'undefined' || typeof PortfolioCalc === 'undefined') throw new Error("Thiếu thư viện nhập sao kê (lib/statement-import.js, lib/portfolio-calc.js)");
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const existing = await API.asset.listTransactions(email);
            const { data: actions } = await sbClient.from('finance_corporate_actions')
                .select('*').eq('user_id', userId).is('deleted_at', null);
            const { fresh, duplicates } = StatementImport.dedupe(existing, rows);
            let candidates = StatementImport.orderForInsert(fresh);
            const blocked = [];
            // Mô phỏng sổ lệnh sau khi nhập. Bỏ 1 lệnh bán thiếu hàng chỉ làm các lệnh bán SAU nó dư hàng thêm -> lặp tối đa vài lượt là ổn định.
            for (let pass = 0; pass < 4; pass++) {
                const base = Date.now();
                const sim = existing.concat(candidates.map((e, i) => ({
                    id: 'NEW_' + i, symbol: e.symbol, type: e.type, quantity: e.quantity, price: e.price, fee: e.fee, tax: e.tax,
                    trade_date: e.date, created_at: new Date(base + i * 1000).toISOString()
                })));
                const { sales } = PortfolioCalc.replayLedger(sim, actions || []);
                const bad = new Set(sales.filter(x => x.shortfall > 1e-9 && String(x.txnId).startsWith('NEW_')).map(x => x.txnId));
                if (!bad.size) break;
                const keep = [];
                candidates.forEach((e, i) => {
                    if (bad.has('NEW_' + i)) blocked.push(Object.assign({}, e, { blockReason: 'Bán vượt khối lượng đang có — thiếu lệnh mua trước đó (hãy nhập lệnh mua hoặc số dư đầu kỳ trước)' }));
                    else keep.push(e);
                });
                candidates = keep;
            }
            let limitCheck = null;
            if (typeof LimitsCalc !== 'undefined' && candidates.length) {
                try { limitCheck = await API.asset.limits.checkImport(email, candidates.map(e => ({ symbol: e.symbol, type: e.type, quantity: e.quantity, price: e.price, date: e.date }))); }
                catch (e) { limitCheck = null; }   // không kiểm được: để importTransactions kiểm lại (lúc đó lỗi mới chặn)
            }
            return { fresh: candidates, duplicates, blocked, limitCheck };
        },

        // Nhập thật. dividends: [{date, symbol, amount}] (cổ tức tiền từ sao kê) -- ghi vào Dòng Tiền, KHÔNG đổi số dư tiền mặt trừ khi adjustCash.
        importTransactions: async (email, rows, opts) => {
            const o = Object.assign({ dividends: [], adjustCash: false, fileName: '' }, opts || {});
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const preview = await API.asset.previewImport(email, rows);
            const toInsert = preview.fresh;
            // Giới hạn đầu tư: lô nhập làm vượt giới hạn phải kèm lý do (hoặc bị chặn; chỉ quản lý ghi đè) -- cùng luật với addTransaction, không lách được bằng nhập hàng loạt.
            let gatedViolations = [], overrideUsed = false;
            const importReason = String((o.exception && o.exception.reason) || '').trim();
            if (!o.skipLimitCheck && typeof LimitsCalc !== 'undefined' && toInsert.length) {
                const chk = preview.limitCheck || await API.asset.limits.checkImport(email, toInsert.map(e => ({ symbol: e.symbol, type: e.type, quantity: e.quantity, price: e.price, date: e.date })));
                gatedViolations = chk.violations.filter(v => v.mode !== 'warn');
                if (gatedViolations.length) {
                    const actor = await API.asset.limits._actor(email);
                    if (chk.blocked) {
                        if (!(actor.isManager && importReason.length >= 3)) throw new Error('LIMIT_BLOCKED: ' + chk.violations.filter(v => v.mode === 'block').map(v => v.text).join('; '));
                        overrideUsed = true;
                    } else if (importReason.length < 3) {
                        throw new Error('LIMIT_REASON_REQUIRED: ' + gatedViolations.map(v => v.text).join('; '));
                    }
                }
            }
            const batchId = 'IMP_' + Date.now().toString(36);
            let inserted = 0;
            if (toInsert.length) {
                // created_at tăng dần theo đúng thứ tự đã sắp (cùng ngày: mua trước bán sau) để FIFO replay đúng thứ tự khi trade_date trùng nhau
                const base = Date.now() - (toInsert.length + 5) * 1000;
                const payload = toInsert.map((e, i) => ({
                    user_id: userId, symbol: e.symbol, type: e.type, quantity: e.quantity, price: e.price,
                    fee: Number(e.fee) || 0, tax: e.type === 'sell' ? (Number(e.tax) || 0) : 0,
                    trade_date: e.date, note: e.note || null, realized_pnl: null, created_by: email,
                    created_at: new Date(base + i * 1000).toISOString(), external_ref: e.externalRef || null, import_batch: batchId
                }));
                try {
                    for (let i = 0; i < payload.length; i += 100) {
                        const { error } = await sbClient.from('finance_transactions').insert(payload.slice(i, i + 100));
                        if (error) throw error;
                        inserted += Math.min(100, payload.length - i);
                    }
                } catch (err) {
                    // Hoàn tác phần đã chèn để không để lại nửa lô
                    await sbClient.from('finance_transactions').update({ deleted_at: new Date().toISOString() }).eq('user_id', userId).eq('import_batch', batchId);
                    throw new Error('Nhập thất bại, đã hoàn tác: ' + (err.message || err));
                }
            }

            let dividendsAdded = 0, dividendsSkipped = 0;
            if (o.dividends && o.dividends.length) {
                const flows = await API.asset.cashFlow.list(email);
                const seen = new Set(flows.filter(f => f.flow_type === 'dividend').map(f => [f.flow_date, f.symbol, Math.round(Number(f.amount))].join('|')));
                let cashDelta = 0;
                for (const d of o.dividends) {
                    const amount = Number(d.amount) || 0;
                    const key = [d.date, d.symbol, Math.round(amount)].join('|');
                    if (amount <= 0 || seen.has(key)) { dividendsSkipped++; continue; }
                    const { error } = await sbClient.from('finance_cash_flows').insert({
                        user_id: userId, flow_type: 'dividend', amount, flow_date: d.date, symbol: d.symbol,
                        note: 'Nhập từ sao kê', created_by: email
                    });
                    if (error) throw error;
                    seen.add(key); dividendsAdded++; cashDelta += amount;
                }
                if (o.adjustCash && cashDelta > 0) {
                    const { data: cd } = await sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle();
                    await sbClient.from('finance_assets').upsert({ user_id: userId, cash: (cd ? Number(cd.cash) || 0 : 0) + cashDelta, debt: cd ? Number(cd.debt) || 0 : 0 }, { onConflict: 'user_id' });
                }
            }

            // 1 lần duy nhất cho cả lô (không tính lại sau từng lệnh như addTransaction)
            await API.asset.recomputeRealizedPnl(userId);
            await API.asset.recomputeAndSnapshot(email);
            // Ghi nhận ngoại lệ của cả lô (lỗi ở đây KHÔNG làm hỏng lô đã nhập; báo lại trong kết quả)
            let limitExceptions = 0, limitExceptionError = null;
            if (gatedViolations.length && inserted) {
                try {
                    const lastDate = toInsert.reduce((m, e) => (e.date > m ? e.date : m), '');
                    const { error: exErr } = await sbClient.from('finance_limit_exceptions').insert(gatedViolations.map(v => ({
                        user_id: userId, limit_id: v.limitId || null, kind: v.kind, symbol: ['max_symbol_pct', 'max_position_vnd', 'blocked_symbol'].includes(v.kind) ? v.subject : null,
                        txn_id: null, trade_date: lastDate || null, mode: v.mode, reason: importReason, override: overrideUsed && v.mode === 'block',
                        metrics: { subject: v.subject, before: v.before, after: v.after, threshold: v.threshold, text: v.text, importBatch: batchId, source: 'statement-import' }
                    })));
                    if (exErr) throw exErr;
                    limitExceptions = gatedViolations.length;
                } catch (e) { limitExceptionError = e.message || String(e); }
            }
            return { batchId, imported: inserted, duplicates: preview.duplicates.length, blocked: preview.blocked, dividendsAdded, dividendsSkipped, limitExceptions, limitExceptionError };
        },

        undoImportBatch: async (email, batchId) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            if (!batchId) throw new Error("Thiếu mã lô nhập");
            const { data, error } = await sbClient.from('finance_transactions')
                .update({ deleted_at: new Date().toISOString() }).eq('user_id', userId).eq('import_batch', batchId).is('deleted_at', null).select('id');
            if (error) throw error;
            await API.asset.recomputeRealizedPnl(userId);
            await API.asset.recomputeAndSnapshot(email);
            return `Đã hoàn tác ${(data || []).length} lệnh của lần nhập này`;
        },

        // --- Báo cáo lãi/lỗ ĐÃ CHỐT theo năm: FIFO có phí & thuế (lib/portfolio-calc.js), cộng cổ tức tiền của năm ---
        getRealizedReport: async (email, year) => {
            if (typeof PortfolioCalc === 'undefined') throw new Error("Thiếu thư viện lib/portfolio-calc.js");
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const [txns, flows] = await Promise.all([API.asset.listTransactions(email), API.asset.cashFlow.list(email)]);
            const { data: actions } = await sbClient.from('finance_corporate_actions')
                .select('*').eq('user_id', userId).is('deleted_at', null);
            const { sales } = PortfolioCalc.replayLedger(txns, actions || []);
            const dividends = flows.filter(f => f.flow_type === 'dividend');
            const years = PortfolioCalc.realizedReport(sales, dividends, 0).years;
            const pick = Number(year) || (years[0] || new Date().getFullYear());
            const report = PortfolioCalc.realizedReport(sales, dividends, pick);
            report.shortfalls = sales.filter(x => x.shortfall > 1e-9).length;
            return report;
        },

        // Giá đóng cửa lịch sử từ máy chủ (Edge Function stock-history, nguồn VNDirect). Trả về { SYMBOL: [[YYYY-MM-DD, giá], ...] } (VND; VNINDEX là điểm).
        getPriceHistory: async (symbols, from, to) => {
            const { data, error } = await sbClient.functions.invoke('stock-history', { body: { symbols, from, to } });
            if (error) {
                let detail = error.message;
                try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                throw new Error(detail);
            }
            if (!data || !data.ok) throw new Error((data && data.error) || 'Không lấy được giá lịch sử');
            return data.series || {};
        },

        // --- Giá thị trường hiện tại (nhập tay, tách khỏi sổ lệnh vì đây không phải giao dịch) ---
        setMarketPrice: async (email, symbol, price) => {
            const userId = await getUserId(email);
            const cleanSymbol = String(symbol || '').trim().toUpperCase();
            if (!cleanSymbol) throw new Error("Thiếu mã danh mục");
            const { error } = await sbClient.from('finance_holdings_price').upsert({
                user_id: userId, symbol: cleanSymbol, market_price: Number(price) || 0, updated_at: new Date().toISOString(),
                price_date: null, price_source: null // giá nhập tay -> không còn là giá tự động
            }, { onConflict: 'user_id,symbol' });
            if (error) throw error;
            await API.asset.recomputeAndSnapshot(email);
            return "Đã cập nhật giá thị trường!";
        },

        // --- Khóa/mở khóa giá 1 mã: khi khóa, cron fetch-stock-prices (lấy giá tự động từ VNDirect)
        // sẽ bỏ qua mã này ở lần chạy sau, không ghi đè giá người dùng vừa tự nhập -- không ảnh
        // hưởng việc sửa giá tay qua setMarketPrice, chỉ chặn riêng phần tự động.
        togglePriceLock: async (email, symbol, locked) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const cleanSymbol = String(symbol || '').trim().toUpperCase();
            if (!cleanSymbol) throw new Error("Thiếu mã danh mục");
            const { data: existing } = await sbClient.from('finance_holdings_price')
                .select('market_price').eq('user_id', userId).eq('symbol', cleanSymbol).maybeSingle();
            const { error } = await sbClient.from('finance_holdings_price').upsert({
                user_id: userId, symbol: cleanSymbol,
                market_price: existing ? existing.market_price : 0,
                locked: !!locked, updated_at: new Date().toISOString()
            }, { onConflict: 'user_id,symbol' });
            if (error) throw error;
            return locked ? "Đã khóa giá — tự động sẽ không ghi đè" : "Đã mở khóa — tự động sẽ cập nhật lại";
        },

        // --- Danh mục hiện tại: khối lượng + giá vốn (từ sổ lệnh) ghép với giá TT (nhập tay/tự động) ---
        // Giá mục tiêu suy ra từ trang Định Giá CP: trung bình các giá theo P/E và P/B mục tiêu (chỉ lấy
        // phần dương). EPS/BVPS dùng đúng công thức của stocksheet/autosheet/script.js (mệnh giá 10.000).
        // Hồ sơ lưu từ máy tính định giá mới có sẵn fair_value (giá hợp lý theo mẫu ngành + kịch bản cơ sở) -> dùng luôn.
        // Hồ sơ cũ chưa có: tính lại như trước, đọc cả khoá v1/v2/v3 lẫn snake_case của dữ liệu thời Google Sheet.
        _valuationTarget: (d) => {
            const fair = Number(d && d.fair_value);
            if (fair > 0) return fair;
            const v1 = Number(d && (d.v1 || d.charter_capital)) || 0;
            if (!v1) return null;
            const eps = (Number(d.v3 || d.lnst) || 0) / v1 * 10000;
            const bvps = (Number(d.v2 || d.equity) || 0) / v1 * 10000;
            const parts = [(Number(d.targetPE || d.target_pe) || 0) * eps, (Number(d.targetPB || d.target_pb) || 0) * bvps].filter(p => p > 0);
            return parts.length ? parts.reduce((s, p) => s + p, 0) / parts.length : null;
        },

        // Độ tươi của giá: 'auto' (cron lấy, có price_date) | 'manual' (nhập tay, tính theo updated_at) | 'none'.
        // stale: giá tự động quá 4 ngày lịch chưa đổi (cuối tuần + 1 ngày nghỉ vẫn chưa tính là cũ), hoặc giá nhập
        // tay quá 7 ngày mà chưa khóa (giá khóa là chủ ý của người dùng nên không cảnh báo).
        _priceMeta: (entry, marketPrice) => {
            if (!entry || !(marketPrice > 0)) return { kind: 'none', date: null, ageDays: null, stale: false, source: null };
            const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
            const ageOf = (iso) => Math.max(0, Math.round((dayStart(new Date()) - dayStart(iso)) / 86400000));
            if (entry.priceDate) {
                const ageDays = ageOf(entry.priceDate + 'T00:00:00');
                return { kind: 'auto', date: entry.priceDate, ageDays, stale: ageDays > 4, source: entry.priceSource };
            }
            const date = entry.updatedAt ? String(entry.updatedAt).slice(0, 10) : null;
            const ageDays = entry.updatedAt ? ageOf(entry.updatedAt) : null;
            return { kind: 'manual', date, ageDays, stale: !entry.locked && ageDays !== null && ageDays > 7, source: null };
        },

        // Trạng thái lần chạy gần nhất của cron lấy giá (Edge Function ghi vào app_settings).
        getPriceFetchStatus: async () => {
            const { data } = await sbClient.from('app_settings').select('value').eq('key', 'price_fetch_status').maybeSingle();
            if (!data || !data.value) return null;
            try { return JSON.parse(data.value); } catch (e) { return null; }
        },

        getHoldingsView: async (email) => {
            await API.asset.market.ensureMeta();
            const userId = await getUserId(email);
            const holdings = await API.asset.computeHoldings(userId);
            const { data: prices } = await sbClient.from('finance_holdings_price')
                .select('symbol, market_price, locked, target_price, stop_loss, price_date, price_source, updated_at').eq('user_id', userId);
            const priceMap = {};
            (prices || []).forEach(p => {
                priceMap[p.symbol] = {
                    price: Number(p.market_price) || 0, locked: !!p.locked,
                    target: Number(p.target_price) || 0, stop: Number(p.stop_loss) || 0,
                    priceDate: p.price_date || null, priceSource: p.price_source || null, updatedAt: p.updated_at || null
                };
            });

            // Định giá mới nhất theo từng mã đang nắm giữ (bảng dùng chung, mỗi mã nhiều năm -> lấy năm lớn nhất)
            const valuationBySymbol = {};
            const symbols = holdings.map(h => h.symbol);
            if (symbols.length) {
                const { data: vals } = await sbClient.from('finance_stock_valuations')
                    .select('symbol, year, data').in('symbol', symbols).order('year', { ascending: false });
                (vals || []).forEach(v => {
                    if (valuationBySymbol[v.symbol]) return;
                    const t = API.asset._valuationTarget(v.data);
                    if (t) valuationBySymbol[v.symbol] = { target: t, year: v.year };
                });
            }

            return holdings.map(h => {
                const entry = priceMap[h.symbol];
                const marketPrice = entry ? entry.price : 0;
                const costValue = h.avgCost * h.quantity;
                const marketValue = marketPrice * h.quantity;
                const manualTarget = entry ? entry.target : 0;
                const valuation = valuationBySymbol[h.symbol];
                const targetPrice = manualTarget || (valuation ? Math.round(valuation.target) : 0);
                const targetSource = manualTarget ? 'manual' : (valuation ? 'valuation' : null);
                const stopLoss = entry ? entry.stop : 0;
                return {
                    symbol: h.symbol, quantity: h.quantity, avgCost: h.avgCost, marketPrice,
                    priceLocked: entry ? entry.locked : false,
                    priceMeta: API.asset._priceMeta(entry, marketPrice),
                    targetPrice, targetSource, targetYear: targetSource === 'valuation' ? valuation.year : null,
                    stopLoss,
                    upsidePct: targetPrice > 0 && marketPrice > 0 ? ((targetPrice - marketPrice) / marketPrice) * 100 : null,
                    stopDistancePct: stopLoss > 0 && marketPrice > 0 ? ((stopLoss - marketPrice) / marketPrice) * 100 : null,
                    costValue, marketValue,
                    unrealizedPnl: marketValue - costValue,
                    unrealizedPct: costValue > 0 ? ((marketValue - costValue) / costValue) * 100 : 0
                };
            });
        },

        // XIRR (lãi suất quy năm của chuỗi dòng tiền không đều). flows: [{t: Date, amt: number}], tiền ra < 0, tiền vào > 0.
        // Tìm nghiệm bằng chia đôi (chắc chắn hội tụ khi có cả dòng âm lẫn dương); null nếu không xác định được.
        _xirr: (flows) => {
            if (!flows.length || !flows.some(f => f.amt < 0) || !flows.some(f => f.amt > 0)) return null;
            const t0 = Math.min(...flows.map(f => f.t.getTime()));
            const npv = (r) => flows.reduce((s, f) => s + f.amt / Math.pow(1 + r, (f.t.getTime() - t0) / (365 * 86400000)), 0);
            let lo = -0.9999, hi = 1000;
            let fLo = npv(lo), fHi = npv(hi);
            if (!isFinite(fLo) || !isFinite(fHi) || fLo * fHi > 0) return null;
            for (let i = 0; i < 200; i++) {
                const mid = (lo + hi) / 2, fMid = npv(mid);
                if (Math.abs(fMid) < 1e-6) return mid;
                if (fLo * fMid < 0) { hi = mid; fHi = fMid; } else { lo = mid; fLo = fMid; }
            }
            return (lo + hi) / 2;
        },

        // Hiệu quả đầu tư theo từng mã, gồm cả mã đã bán hết: lãi đã chốt (FIFO) + chưa chốt + cổ tức tiền - phí,
        // và XIRR từ dòng tiền thực (mua/bán/cổ tức + giá trị hiện tại nếu còn giữ). Lãi/lỗ tổng cộng khớp với
        // tiền thực thu - tiền thực chi (tách/gộp, cổ tức cổ phiếu không đổi dòng tiền nên không ảnh hưởng).
        getSymbolPerformance: async (email) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const [txns, flows, holdings] = await Promise.all([
                API.asset.listTransactions(email),
                API.asset.cashFlow.list(email),
                API.asset.getHoldingsView(email)
            ]);
            const holdingBySymbol = {};
            holdings.forEach(h => { holdingBySymbol[h.symbol] = h; });

            const bySymbol = {};
            const get = (symbol) => bySymbol[symbol] || (bySymbol[symbol] = {
                symbol, bought: 0, sold: 0, fees: 0, realized: 0, dividends: 0, cashFlows: [], firstDate: null
            });
            const noteDate = (row, iso) => { if (!row.firstDate || iso < row.firstDate) row.firstDate = iso; };

            txns.forEach(t => {
                const row = get(t.symbol);
                const gross = (Number(t.quantity) || 0) * (Number(t.price) || 0);
                const fee = (Number(t.fee) || 0) + (Number(t.tax) || 0); // thuế bán tính chung vào chi phí giao dịch
                row.fees += fee;
                noteDate(row, t.trade_date);
                const when = new Date(t.trade_date + 'T00:00:00');
                if (t.type === 'buy') { row.bought += gross; row.cashFlows.push({ t: when, amt: -(gross + fee) }); }
                else { row.sold += gross; row.realized += Number(t.realized_pnl) || 0; row.cashFlows.push({ t: when, amt: gross - fee }); }
            });
            flows.forEach(f => {
                if (f.flow_type !== 'dividend' || !f.symbol || !bySymbol[f.symbol]) return;
                const row = bySymbol[f.symbol];
                const amt = Number(f.amount) || 0;
                row.dividends += amt;
                row.cashFlows.push({ t: new Date(f.flow_date + 'T00:00:00'), amt });
            });

            const today = new Date(); today.setHours(0, 0, 0, 0);
            const rows = Object.values(bySymbol).map(row => {
                const h = holdingBySymbol[row.symbol];
                const held = !!h;
                const noPrice = held && !(h.marketPrice > 0);
                const unrealized = held && !noPrice ? h.unrealizedPnl : 0;
                const marketValue = held && !noPrice ? h.marketValue : 0;
                const totalPnl = row.realized + unrealized + row.dividends - row.fees;
                const flowsForXirr = marketValue > 0 ? [...row.cashFlows, { t: today, amt: marketValue }] : row.cashFlows;
                const spanDays = row.firstDate ? Math.round((today - new Date(row.firstDate + 'T00:00:00')) / 86400000) : 0;
                const xirr = spanDays >= 90 ? API.asset._xirr(flowsForXirr) : null;
                return {
                    symbol: row.symbol, held, noPrice,
                    quantity: held ? h.quantity : 0,
                    bought: row.bought, sold: row.sold, fees: row.fees,
                    realized: row.realized, unrealized, dividends: row.dividends, marketValue,
                    totalPnl,
                    returnPct: row.bought > 0 ? (totalPnl / row.bought) * 100 : null,
                    xirrPct: xirr === null ? null : xirr * 100,
                    spanDays
                };
            });
            rows.sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl));
            return rows;
        },

        // Email cảnh báo giá khi app tắt (Edge Function send-price-alerts gửi tới email đăng nhập của chính người dùng).
        getAlertPrefs: async (email) => {
            const userId = await getUserId(email);
            if (!userId) return { emailEnabled: false };
            const { data } = await sbClient.from('finance_alert_prefs').select('email_enabled').eq('user_id', userId).maybeSingle();
            return { emailEnabled: !!(data && data.email_enabled) };
        },
        setAlertPrefs: async (email, enabled) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const { error } = await sbClient.from('finance_alert_prefs').upsert({
                user_id: userId, email_enabled: !!enabled, updated_at: new Date().toISOString()
            }, { onConflict: 'user_id' });
            if (error) throw error;
            return enabled ? "Đã bật email cảnh báo giá" : "Đã tắt email cảnh báo giá";
        },
        // Gửi 1 email thử tới chính email đăng nhập (máy chủ tự lấy người nhận từ phiên đăng nhập, không nhận từ client)
        sendTestAlertEmail: async () => {
            const { data, error } = await sbClient.functions.invoke('send-price-alerts', { body: { test: true } });
            if (error) {
                let detail = error.message;
                try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                throw new Error(detail);
            }
            if (!data || !data.ok) throw new Error((data && data.error) || 'Không gửi được email thử');
            return `Đã gửi email thử tới ${data.to}`;
        },

        // kind: 'target' (giá mục tiêu thủ công, ghi đè giá từ Định Giá CP) | 'stop' (ngưỡng cắt lỗ).
        // value rỗng/0 = xoá. Chỉ ghi đúng 1 cột nên không đụng giá TT/khóa giá do cron quản lý.
        setHoldingLevel: async (email, symbol, kind, value) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const cleanSymbol = String(symbol || '').trim().toUpperCase();
            if (!cleanSymbol) throw new Error("Thiếu mã danh mục");
            const column = kind === 'target' ? 'target_price' : (kind === 'stop' ? 'stop_loss' : null);
            if (!column) throw new Error("Loại ngưỡng không hợp lệ");
            const num = Number(value);
            if (value !== null && value !== '' && (!isFinite(num) || num < 0)) throw new Error("Giá không hợp lệ");
            const { error } = await sbClient.from('finance_holdings_price').upsert({
                user_id: userId, symbol: cleanSymbol,
                [column]: num > 0 ? num : null
            }, { onConflict: 'user_id,symbol' });
            if (error) throw error;
            const label = kind === 'target' ? 'giá mục tiêu' : 'ngưỡng cắt lỗ';
            return num > 0 ? `Đã lưu ${label} của ${cleanSymbol}` : `Đã xoá ${label} của ${cleanSymbol}`;
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
                return API.asset._fetchAll(() => sbClient.from('finance_cash_flows')
                    .select('*').eq('user_id', userId).is('deleted_at', null)
                    .order('flow_date', { ascending: false }).order('created_at', { ascending: false }).order('id'));
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
                // Split/cổ tức CP làm đổi hệ số quy đổi của mọi lô mua trước ex_date -> lãi/lỗ đã
                // chốt của các lệnh bán sau đó (tính theo giá vốn/lô đã điều chỉnh) cần tính lại.
                await API.asset.recomputeRealizedPnl(userId);
                await API.asset.recomputeAndSnapshot(email);
                return "Đã ghi nhận hành động doanh nghiệp!";
            },
            delete: async (email, id) => {
                const userId = await getUserId(email);
                const { error } = await sbClient.from('finance_corporate_actions')
                    .update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
                if (error) throw error;
                await API.asset.recomputeRealizedPnl(userId);
                await API.asset.recomputeAndSnapshot(email);
                return "Đã xóa hành động doanh nghiệp!";
            }
        },

        // --- Sự kiện doanh nghiệp tự gợi ý (cổ tức tiền, cổ phiếu thưởng/cổ tức CP, quyền mua): nguồn VNDirect qua Edge Function stock-events,
        //     đối chiếu với sổ lệnh bằng lib/corporate-events.js. App KHÔNG tự ghi: người dùng bấm xác nhận từng sự kiện. ---
        events: {
            _fetchEvents: async (symbols, since) => {
                const events = [], errors = {};
                for (let i = 0; i < symbols.length; i += 30) {
                    const { data, error } = await sbClient.functions.invoke('stock-events', { body: { symbols: symbols.slice(i, i + 30), since } });
                    if (error) {
                        let detail = error.message;
                        try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                        throw new Error(detail);
                    }
                    if (!data || !data.ok) throw new Error((data && data.error) || 'Không lấy được sự kiện doanh nghiệp');
                    events.push(...(data.events || []));
                    Object.assign(errors, data.errors || {});
                }
                return { events, errors };
            },
            _context: async (email) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const [txns, actions, cashFlows, dis] = await Promise.all([
                    API.asset.listTransactions(email),
                    API.asset.corporateAction.list(email),
                    API.asset.cashFlow.list(email),
                    sbClient.from('finance_event_dismissals').select('event_id').eq('user_id', userId)
                ]);
                if (dis.error) throw dis.error;
                return { userId, txns, actions, cashFlows, dismissed: new Set((dis.data || []).map(r => r.event_id)) };
            },
            // Tải sự kiện mới + đối chiếu. Trả { items, summary, errors, fetchedAt, events } (events = bản thô để truyền lại cho apply).
            load: async (email) => {
                if (typeof CorporateEvents === 'undefined') throw new Error("Thiếu thư viện sự kiện doanh nghiệp (lib/corporate-events.js)");
                const ctx = await API.asset.events._context(email);
                const scope = CorporateEvents.queryScope(ctx.txns);
                if (!scope.symbols.length) return { items: [], summary: CorporateEvents.suggest([], ctx).summary, errors: {}, events: [], fetchedAt: new Date().toISOString(), empty: true };
                const { events, errors } = await API.asset.events._fetchEvents(scope.symbols, scope.since);
                const res = CorporateEvents.suggest(events, Object.assign({ today: new Date().toISOString().slice(0, 10) }, ctx));
                return { items: res.items, summary: res.summary, errors, events, fetchedAt: new Date().toISOString() };
            },
            // Ghi các sự kiện được chọn. events = bản thô từ load(); ids = id sự kiện muốn ghi; opts.afterTax (mặc định true: cổ tức ghi sau thuế 5%).
            // Luôn tính lại trên sổ lệnh MỚI NHẤT và chỉ ghi sự kiện còn ở trạng thái 'pending' (chống ghi trùng khi bấm 2 lần / 2 thiết bị).
            apply: async (email, events, ids, opts) => {
                const ctx = await API.asset.events._context(email);
                const res = CorporateEvents.suggest(events || [], Object.assign({ today: new Date().toISOString().slice(0, 10) }, ctx));
                const want = new Set(ids || []);
                const todo = res.items.filter(p => p.status === 'pending' && want.has(p.event.id) && p.kind !== 'rights')
                    .sort((a, b) => (a.event.exDate < b.event.exDate ? -1 : (a.event.exDate > b.event.exDate ? 1 : 0)));
                let cash = 0, stock = 0;
                const skipped = (ids || []).length - todo.length;
                for (const p of todo) {
                    const rec = CorporateEvents.toRecord(p, opts);
                    if (!rec) continue;
                    if (rec.type === 'cashFlow') { await API.asset.cashFlow.add(email, rec.flow); cash++; }
                    else { await API.asset.corporateAction.add(email, rec.action); stock++; }
                }
                return { cash, stock, skipped, message: `Đã ghi ${cash} khoản cổ tức tiền và ${stock} sự kiện cổ phiếu${skipped ? ` (bỏ qua ${skipped} sự kiện đã ghi hoặc chưa tới hạn)` : ''}.` };
            },
            dismiss: async (email, event) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const { error } = await sbClient.from('finance_event_dismissals').upsert({
                    user_id: userId, event_id: String(event.id), symbol: event.symbol, kind: event.kind, note: event.note || null
                }, { onConflict: 'user_id,event_id' });
                if (error) throw error;
                return "Đã ẩn sự kiện này!";
            },
            restore: async (email, eventId) => {
                const userId = await getUserId(email);
                const { error } = await sbClient.from('finance_event_dismissals').delete().eq('user_id', userId).eq('event_id', String(eventId));
                if (error) throw error;
                return "Đã hiện lại sự kiện!";
            }
        },

        // --- Giới hạn đầu tư của nhóm (lib/limits-calc.js): chung cho mọi thành viên (quản lý đặt), cá nhân tự đặt, và cho danh mục gộp.
        //     Lệnh vượt giới hạn phải kèm lý do (chế độ 'reason') hoặc bị chặn (chế độ 'block', chỉ quản lý ghi đè kèm lý do); mọi ngoại lệ được lưu lại. ---
        limits: {
            list: async () => {
                const { data, error } = await sbClient.from('finance_limits').select('*').order('created_at', { ascending: true });
                if (error) throw error;
                return data || [];
            },
            save: async (email, input) => {
                if (typeof LimitsCalc === 'undefined') throw new Error("Thiếu thư viện giới hạn (lib/limits-calc.js)");
                const v = LimitsCalc.validate(input || {});
                if (!v.ok) throw new Error(v.error);
                const l = v.limit;
                const actor = await API.asset.limits._actor(email);
                if (l.scope !== 'user' && !actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin mới đặt được giới hạn chung của nhóm");
                const ownerId = l.scope === 'user' ? ((input && input.userId) || actor.targetId) : null;
                if (l.scope === 'user' && ownerId !== actor.actorId && !actor.isManager) throw new Error("Chỉ đặt được giới hạn cá nhân cho chính mình");
                const row = { scope: l.scope, user_id: ownerId, kind: l.kind, symbol: l.symbol, sector: l.sector, value: l.value, mode: l.mode, note: l.note || null, active: l.active, updated_at: new Date().toISOString() };
                if (input && input.id) {
                    const { error } = await sbClient.from('finance_limits').update(row).eq('id', input.id);
                    if (error) throw error;
                    return "Đã cập nhật giới hạn!";
                }
                const { error } = await sbClient.from('finance_limits').insert(Object.assign({}, row, { created_by: actor.actorId }));
                if (error) throw error;
                return "Đã thêm giới hạn!";
            },
            remove: async (id) => {
                const { error } = await sbClient.from('finance_limits').delete().eq('id', id);
                if (error) throw error;
                return "Đã xoá giới hạn!";
            },
            setActive: async (id, active) => {
                const { error } = await sbClient.from('finance_limits').update({ active: !!active, updated_at: new Date().toISOString() }).eq('id', id);
                if (error) throw error;
                return active ? "Đã bật giới hạn!" : "Đã tắt giới hạn!";
            },
            // Người đang thao tác (đăng nhập thật) khác với `email` (chủ danh mục) khi quản lý nhập hộ lệnh.
            _actor: async (email) => {
                const targetId = await getUserId(email);
                let actorId = targetId, actorEmail = email;
                try {
                    const { data } = await sbClient.auth.getUser();
                    if (data && data.user && data.user.email) { actorEmail = data.user.email; actorId = (await getUserId(actorEmail)) || targetId; }
                } catch (e) { /* không đọc được phiên: coi như chính chủ */ }
                let isManager = false, isAdmin = false;
                if (actorId) {
                    const [{ data: roles }, { data: u }] = await Promise.all([
                        sbClient.from('fin_roles').select('role').eq('user_id', actorId),
                        sbClient.from('users').select('group_key').eq('id', actorId).maybeSingle()
                    ]);
                    isAdmin = !!(u && u.group_key === 'admin');
                    isManager = (roles || []).some(r => r.role === 'asset_manager') || isAdmin;
                }
                return { targetId, actorId, actorEmail, isManager, isAdmin };
            },
            // Kiểm tra 1 lệnh TRƯỚC khi ghi. trade: { type, symbol, quantity, price, fee, tax }. Không có giới hạn nào đang bật thì trả nhanh, không tải danh mục.
            checkTrade: async (email, trade) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const rows = await API.asset.limits.list();
                const limits = LimitsCalc.applicable(rows, userId, 'member');
                if (!limits.length) return { ok: true, violations: [], near: [], blocked: false, needsReason: false, maxMode: null, none: true };
                const [holdings, cd] = await Promise.all([
                    API.asset.getHoldingsView(email),
                    sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle()
                ]);
                const pf = { holdings: holdings.map(h => ({ symbol: h.symbol, value: h.marketValue })), cash: cd && cd.data ? Number(cd.data.cash) || 0 : 0, debt: cd && cd.data ? Number(cd.data.debt) || 0 : 0 };
                const c = LimitsCalc.checkTrade(limits, pf, trade);
                return { ok: c.ok, violations: c.violations, near: c.near, blocked: c.blocked, needsReason: c.needsReason, maxMode: c.maxMode, nav: c.before.nav };
            },
            // Kiểm tra cả LÔ lệnh nhập từ sao kê (lệnh quá khứ) theo thay đổi khối lượng ròng từng mã x giá hiện tại; tiền mặt giữ nguyên. rows: [{ symbol, type, quantity, price, date }]
            checkImport: async (email, rows) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const limits = LimitsCalc.applicable(await API.asset.limits.list(), userId, 'member');
                if (!limits.length || !(rows || []).length) return { ok: true, violations: [], near: [], blocked: false, needsReason: false, maxMode: null, none: !limits.length };
                const [holdings, cd] = await Promise.all([
                    API.asset.getHoldingsView(email),
                    sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle()
                ]);
                const pf = { holdings: holdings.map(h => ({ symbol: h.symbol, value: h.marketValue })), cash: cd && cd.data ? Number(cd.data.cash) || 0 : 0, debt: cd && cd.data ? Number(cd.data.debt) || 0 : 0 };
                const prices = {}; holdings.forEach(h => { if (h.marketPrice > 0) prices[h.symbol] = h.marketPrice; });
                const c = LimitsCalc.checkImport(limits, pf, rows, prices);
                return { ok: c.ok, violations: c.violations, near: c.near, blocked: c.blocked, needsReason: c.needsReason, maxMode: c.maxMode, nav: c.before.nav };
            },
            // Nhật ký tuân thủ theo ngày do Edge Function check-limits ghi (xem finance-compliance-log-migration.sql); mới nhất cuối.
            complianceLog: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 120) * 86400000).toISOString().slice(0, 10);
                const { data, error } = await sbClient.from('finance_compliance_log').select('log_date, user_id, nav, limit_count, breaches, warns').gte('log_date', since).order('log_date', { ascending: true }).limit(5000);
                if (error) throw error;
                return data || [];
            },
            exceptions: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 180) * 86400000).toISOString();
                const { data, error } = await sbClient.from('finance_limit_exceptions').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(500);
                if (error) throw error;
                return data || [];
            }
        },

        // --- Danh mục chuẩn chiến lược của nhóm (tỷ trọng mục tiêu theo ngành; phần còn lại là tiền mặt) dùng cho phân tích Brinson (lib/brinson-calc.js).
        //     Mọi thành viên finance/admin đọc được; chỉ quản lý danh mục / admin sửa (RLS + kiểm tra ở đây). ---
        policy: {
            list: async () => {
                const { data, error } = await sbClient.from('finance_policy_weights').select('sector, target_pct, updated_at, updated_by');
                if (error) throw error;
                const weights = {};
                (data || []).forEach(r => { weights[r.sector] = Number(r.target_pct) || 0; });
                const updatedAt = (data || []).reduce((m, r) => (r.updated_at && r.updated_at > m ? r.updated_at : m), '');
                return { weights, updatedAt: updatedAt || null };
            },
            // Thay toàn bộ bộ tỷ trọng bằng weights = { ngành: % }
            save: async (email, weights) => {
                if (typeof BrinsonCalc === 'undefined') throw new Error("Thiếu thư viện Brinson (lib/brinson-calc.js)");
                const v = BrinsonCalc.validatePolicy(weights || {});
                if (!v.ok) throw new Error(v.error);
                const actor = await API.asset.limits._actor(email);
                if (!actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin mới đặt được danh mục chuẩn chiến lược của nhóm");
                const keep = Object.keys(v.weights);
                const { data: existing, error: listErr } = await sbClient.from('finance_policy_weights').select('sector');
                if (listErr) throw listErr;
                const toDelete = (existing || []).map(r => r.sector).filter(sec => !keep.includes(sec));
                if (toDelete.length) {
                    const { error: delErr } = await sbClient.from('finance_policy_weights').delete().in('sector', toDelete);
                    if (delErr) throw delErr;
                }
                if (keep.length) {
                    const { error } = await sbClient.from('finance_policy_weights').upsert(
                        keep.map(sector => ({ sector, target_pct: v.weights[sector], updated_by: actor.actorId, updated_at: new Date().toISOString() })), { onConflict: 'sector' });
                    if (error) throw error;
                }
                return "Đã lưu danh mục chuẩn chiến lược (tiền mặt chuẩn " + (Math.round(v.cashPct * 10) / 10) + "%)";
            },
        },

        // --- Dữ liệu thị trường miễn phí + giám sát vận hành (finance-market-data-migration.sql; Edge Function market-data-sync):
        //     phân ngành ICB cho toàn bộ mã niêm yết, lợi suất trái phiếu chính phủ theo ngày (lãi phi rủi ro), cảnh báo chất lượng dữ liệu giá, nhật ký chạy của các hàm định kỳ. ---
        market: {
            _p: null, _at: 0, _uni: null, _uniAt: 0,
            // Nạp phân ngành ICB một lần mỗi phiên (cache localStorage 24 giờ) rồi đăng ký vào FinCalc; lỗi nào cũng chỉ bỏ qua (bảng tự gõ vẫn dùng được).
            ensureMeta: async (force) => {
                const M = API.asset.market;
                if (typeof SectorMap === 'undefined' || typeof FinCalc === 'undefined') return 0;
                if (!force && M._p && Date.now() - M._at < 300000) return M._p;
                M._at = Date.now();
                M._p = (async () => {
                    const KEY = 'wh_sector_meta_v1', TTL = 24 * 3600 * 1000;
                    let cached = null;
                    try { cached = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { /* không có cache */ }
                    if (!force && cached && cached.map && Date.now() - cached.ts < TTL) { if (FinCalc.registerListings && cached.ls) FinCalc.registerListings(cached.ls); return FinCalc.registerSectors(cached.map); }
                    try {
                        const rows = await API.asset._fetchAll(() => sbClient.from('finance_stock_meta').select('symbol, icb2_code, exchange, type').order('symbol'));
                        const map = SectorMap.buildMap(rows || []);
                        const ls = {}; (rows || []).forEach(r => { if (r.symbol && r.exchange) ls[String(r.symbol).toUpperCase()] = { exchange: r.exchange, type: r.type }; });
                        if (Object.keys(map).length) {
                            try { localStorage.setItem(KEY, JSON.stringify({ ts: Date.now(), map, ls })); } catch (e) { /* cache đầy: bỏ qua */ }
                            if (FinCalc.registerListings) FinCalc.registerListings(ls);
                            return FinCalc.registerSectors(map);
                        }
                    } catch (e) { /* không đọc được: dùng cache cũ nếu có */ }
                    if (cached && cached.map) { if (FinCalc.registerListings && cached.ls) FinCalc.registerListings(cached.ls); return FinCalc.registerSectors(cached.map); }
                    return 0;
                })();
                return M._p;
            },
            listMeta: async () => API.asset._fetchAll(() => sbClient.from('finance_stock_meta').select('*').order('symbol')),
            // Giá tham chiếu và biên độ/bước giá cho một mã (lib/vn-market.js). Tham chiếu = giá đóng cửa phiên gần nhất TRƯỚC phiên đang đặt: trước 15:05 giờ VN là phiên trước hôm nay, sau đó là phiên hôm nay.
            // sessions = các phiên giao dịch gần đây theo VN-Index (để đếm T+2 đúng cả khi nghỉ lễ). UPCoM: trần/sàn xấp xỉ vì giá tham chiếu của sàn này là bình quân gia quyền.
            reference: async (symbol) => {
                if (typeof VnMarket === 'undefined') throw new Error("Thiếu thư viện quy định thị trường (lib/vn-market.js)");
                const sym = String(symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
                await API.asset.market.ensureMeta();
                const listing = (typeof FinCalc !== 'undefined' && FinCalc.listingOf) ? FinCalc.listingOf(sym) : { exchange: 'HOSE', type: 'STOCK', known: false };
                const vn = new Date(Date.now() + 7 * 3600000), today = vn.toISOString().slice(0, 10), afterClose = vn.getUTCHours() * 60 + vn.getUTCMinutes() >= 15 * 60 + 5;
                const from = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
                const hist = await API.asset.getPriceHistory([sym, 'VNINDEX'], from, today);
                const series = (hist[sym] || []).filter(x => afterClose ? x[0] <= today : x[0] < today);
                const last = series.length ? series[series.length - 1] : null;
                const sessions = (hist.VNINDEX || []).map(x => x[0]);
                const L = last ? VnMarket.limits(last[1], listing.exchange, listing.type) : null;
                return { symbol: sym, exchange: listing.exchange, type: listing.type, listingKnown: listing.known, ref: last ? last[1] : null, refDate: last ? last[0] : null, limits: L, sessions, today };
            },
            // Cổ phiếu mua chưa về tài khoản (T+2), tiền bán chưa về và số cổ phiếu bán được hôm nay theo từng mã
            settlement: async (email) => {
                if (typeof VnMarket === 'undefined') throw new Error("Thiếu thư viện quy định thị trường (lib/vn-market.js)");
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const vn = new Date(Date.now() + 7 * 3600000), today = vn.toISOString().slice(0, 10);
                const from = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
                const [txns, holdings, hist] = await Promise.all([
                    API.asset.listTransactions(email), API.asset.computeHoldings(userId),
                    API.asset.getPriceHistory(['VNINDEX'], from, today).catch(() => ({}))
                ]);
                const sessions = (hist.VNINDEX || []).map(x => x[0]);
                const un = VnMarket.unsettled(txns, today, sessions);
                const held = {}; (holdings || []).forEach(h => { held[String(h.symbol).toUpperCase()] = Number(h.quantity) || 0; });
                const sellable = {}; Object.keys(held).forEach(s => { sellable[s] = VnMarket.sellable(s, held[s], un); });
                return { today, sessions, unsettled: un, held, sellable };
            },
            // Lợi suất trái phiếu chính phủ các kỳ hạn trong `days` ngày gần nhất (cũ -> mới)
            rates: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 400) * 86400000).toISOString().slice(0, 10);
                const { data, error } = await sbClient.from('finance_rates').select('rate_date, tenor, yield_pct, source').gte('rate_date', since).order('rate_date', { ascending: true }).limit(5000);
                if (error) throw error;
                return data || [];
            },
            // Chỉ số cơ bản và thị trường (P/E, P/B, beta, ROE, biên lợi nhuận, đòn bẩy, tăng trưởng, 52 tuần, thanh khoản, khối ngoại) của các mã: đọc cache finance_stock_ratios;
            // mã thiếu hoặc cũ quá 20 giờ thì nhờ Edge Function market-data-sync (mode ratios) lấy từ VNDirect rồi đọc lại. Trả { SYMBOL: { metrics, dailyDate, quarterDate, updatedAt } }.
            ratios: async (symbols) => {
                const list = [...new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 15);
                if (!list.length) return {};
                const read = async () => {
                    const { data, error } = await sbClient.from('finance_stock_ratios').select('symbol, daily_date, quarter_date, metrics, updated_at').in('symbol', list);
                    if (error) throw error;
                    const out = {}; (data || []).forEach(r => { out[r.symbol] = { metrics: r.metrics || {}, dailyDate: r.daily_date, quarterDate: r.quarter_date, updatedAt: r.updated_at }; });
                    return out;
                };
                let out = await read();
                const stale = list.filter(s => !out[s] || Date.now() - Date.parse(out[s].updatedAt) > 20 * 3600 * 1000);
                if (stale.length) {
                    try {
                        const { error } = await sbClient.functions.invoke('market-data-sync', { body: { mode: 'ratios', symbols: stale } });
                        if (!error) out = await read();
                    } catch (e) { /* không lấy mới được: dùng bản cache cũ nếu có */ }
                }
                return out;
            },
            // Định giá tương đối so với ngành: thống kê ngành ICB + toàn thị trường (finance_sector_stats) và các mã cùng ngành (finance_market_snapshot), do Edge Function market-data-sync (mode snapshot) cập nhật hằng ngày.
            // null nếu mã chưa có trong ảnh chụp (hoặc bảng chưa tạo). Trả { symbol, icb2_code, sectorName, sector: {n, as_of, stats}, market, rows: [{symbol, metrics}], self }.
            peers: async (symbol) => {
                const sym = String(symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
                const me = await sbClient.from('finance_market_snapshot').select('symbol, icb2_code, daily_date, metrics').eq('symbol', sym).maybeSingle();
                if (me.error || !me.data) return null;
                const icb = me.data.icb2_code || null;
                const [st, rows] = await Promise.all([
                    sbClient.from('finance_sector_stats').select('icb2_code, n, as_of, stats').in('icb2_code', icb ? [icb, 'ALL'] : ['ALL']),
                    icb ? API.asset._fetchAll(() => sbClient.from('finance_market_snapshot').select('symbol, metrics').eq('icb2_code', icb).order('symbol')) : Promise.resolve([]),
                ]);
                if (st.error) return null;
                const by = {}; (st.data || []).forEach(r => { by[r.icb2_code] = r; });
                const sector = icb ? by[icb] : null;
                if (!sector) return null;
                const sectorName = (typeof SectorMap !== 'undefined' && SectorMap.icbName(icb)) || ('ICB ' + icb);
                return { symbol: sym, icb2_code: icb, sectorName, sector, market: by.ALL || null, rows: rows || [], self: { symbol: sym, metrics: me.data.metrics || {} } };
            },
            // Thống kê ngành cho nhiều mã một lần (bảng Định Lượng của Toàn Nhóm): { bySymbol: {SYM: {icb2_code, metrics}}, stats: {icb2_code: {n, as_of, stats}}, asOf }. Rỗng nếu chưa có ảnh chụp thị trường.
            peerStats: async (symbols) => {
                const list = [...new Set((symbols || []).map(s => String(s).trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 120);
                if (!list.length) return { bySymbol: {}, stats: {}, asOf: null };
                const [snap, st] = await Promise.all([
                    sbClient.from('finance_market_snapshot').select('symbol, icb2_code, metrics').in('symbol', list),
                    sbClient.from('finance_sector_stats').select('icb2_code, n, as_of, stats'),
                ]);
                if (snap.error || st.error) return { bySymbol: {}, stats: {}, asOf: null };
                const bySymbol = {}; (snap.data || []).forEach(r => { bySymbol[r.symbol] = { icb2_code: r.icb2_code, metrics: r.metrics || {} }; });
                const stats = {}; let asOf = null; (st.data || []).forEach(r => { stats[r.icb2_code] = { n: r.n, as_of: r.as_of, stats: r.stats || {} }; if (r.as_of && (!asOf || r.as_of > asOf)) asOf = r.as_of; });
                return { bySymbol, stats, asOf };
            },
            // Toàn bộ ảnh chụp thị trường cho sàng lọc (lib/market-screener.js): { snapshot: [{symbol, icb2_code, metrics}], stats: {icb2_code: {n, as_of, stats}}, meta: {SYM: {name, exchange}}, asOf }.
            // Cache trong phiên 30 phút (khoảng 1.500 dòng, vài trăm KB). Rỗng nếu chưa có ảnh chụp.
            marketUniverse: async (force) => {
                const M = API.asset.market;
                if (!force && M._uni && Date.now() - M._uniAt < 30 * 60000) return M._uni;
                const [snap, st, meta] = await Promise.all([
                    API.asset._fetchAll(() => sbClient.from('finance_market_snapshot').select('symbol, icb2_code, daily_date, metrics').order('symbol')),
                    sbClient.from('finance_sector_stats').select('icb2_code, n, as_of, stats'),
                    API.asset._fetchAll(() => sbClient.from('finance_stock_meta').select('symbol, name, exchange').order('symbol')).catch(() => []),
                ]);
                if (st.error) throw st.error;
                const stats = {}; let asOf = null; (st.data || []).forEach(r => { stats[r.icb2_code] = { n: r.n, as_of: r.as_of, stats: r.stats || {} }; if (r.as_of && (!asOf || r.as_of > asOf)) asOf = r.as_of; });
                const metaBy = {}; (meta || []).forEach(r => { metaBy[r.symbol] = { name: r.name || '', exchange: r.exchange || '' }; });
                M._uni = { snapshot: (snap || []).map(r => ({ symbol: r.symbol, icb2_code: r.icb2_code, metrics: r.metrics || {} })), stats, meta: metaBy, asOf };
                M._uniAt = Date.now();
                return M._uni;
            },
            // Giá khớp trực tiếp từ bảng giá VCI qua Edge Function live-quotes (chỉ đọc, không ghi CSDL). Trả { ok, quotes: {SYM: {price (đồng), ref, ceil, floor, ...}}, missing, asOf }; lỗi thì ném để bên gọi quay về nguồn VNDirect.
            liveQuotes: async (symbols) => {
                const list = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 80);
                if (!list.length) return { ok: true, quotes: {}, missing: [], asOf: new Date().toISOString() };
                const { data, error } = await sbClient.functions.invoke('live-quotes', { body: { symbols: list } });
                if (error) {
                    let detail = error.message;
                    try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                    throw new Error(detail);
                }
                if (!data || data.ok === false) throw new Error((data && data.error) || 'Không lấy được giá trực tiếp');
                return data;
            },
            // Lịch sử định giá thị trường + ngành (finance_valuation_history) trong `years` năm gần nhất, kèm lợi suất trái phiếu 10 năm mới nhất. Rỗng nếu bảng chưa có dữ liệu.
            valuationHistory: async (years) => {
                const since = new Date(Date.now() - (Number(years) > 0 ? Number(years) : 6) * 366 * 86400000).toISOString().slice(0, 10);
                let rows = [];
                try { rows = await API.asset._fetchAll(() => sbClient.from('finance_valuation_history').select('as_of, scope, n, n_pe, n_pb, pe_median, pb_median, pe_agg, pb_agg, mcap_total').gte('as_of', since).order('as_of').order('scope')); } catch (e) { rows = []; }
                let bond10y = null, bondDate = null;
                try { const r = await API.asset.market.rates(15); const t = (r || []).filter(x => x.tenor === '10Y'); if (t.length) { bond10y = Number(t[t.length - 1].yield_pct); bondDate = t[t.length - 1].rate_date; } } catch (e) { /* không có lợi suất */ }
                return { rows: rows || [], bond10y, bondDate };
            },
            healthList: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 60) * 86400000).toISOString();
                // chưa xử lý (bất kể cũ) + đã xử lý trong khoảng gần đây
                const [open, done] = await Promise.all([
                    sbClient.from('finance_data_health').select('*').eq('resolved', false).order('detected_at', { ascending: false }).limit(300),
                    sbClient.from('finance_data_health').select('*').eq('resolved', true).gte('detected_at', since).order('detected_at', { ascending: false }).limit(300)
                ]);
                if (open.error) throw open.error;
                if (done.error) throw done.error;
                return (open.data || []).concat(done.data || []).sort((x, y) => (x.detected_at < y.detected_at ? 1 : -1));
            },
            healthResolve: async (email, id, note) => {
                const actor = await API.asset.limits._actor(email);
                if (!actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin được đánh dấu đã xử lý cảnh báo dữ liệu");
                const text = String(note || '').trim();
                if (text.length < 3) throw new Error("Ghi chú xử lý cần ít nhất 3 ký tự");
                const { data, error } = await sbClient.from('finance_data_health').update({ resolved: true, resolve_note: text.slice(0, 500) }).eq('id', id).eq('resolved', false).select('id');
                if (error) throw error;
                if (!data || !data.length) throw new Error("Cảnh báo đã được xử lý");
                return "Đã đánh dấu đã xử lý";
            },
            runs: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 14) * 86400000).toISOString();
                const { data, error } = await sbClient.from('finance_function_runs').select('id, fn, mode, run_at, ok, duration_ms, detail').neq('fn', 'source-watch').gte('run_at', since).order('run_at', { ascending: false }).limit(400);   // thăm dò nguồn (source-watch) có bảng riêng: không để chúng đẩy các lần chạy hằng ngày/tuần ra khỏi 400 dòng
                if (error) throw error;
                return data || [];
            },
            // Thăm dò nguồn dữ liệu trong phiên của Edge Function source-watch (mỗi 30 phút, 3 nguồn): { mode: 'probe:vci'|'probe:finfo'|'probe:dchart', run_at, ok, duration_ms, detail }. Lỗi/chưa có bảng thì trả mảng rỗng.
            sourceProbes: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 7) * 86400000).toISOString();
                const { data, error } = await sbClient.from('finance_function_runs').select('mode, run_at, ok, duration_ms, detail').eq('fn', 'source-watch').like('mode', 'probe:%').gte('run_at', since).order('run_at', { ascending: false }).limit(1200);
                if (error) throw error;
                return data || [];
            }
        },

        // --- Danh sách hạn chế mã (finance-restricted-migration.sql): quản lý / admin cấm cả MUA lẫn BÁN một mã cho mọi thành viên hoặc một người (thông tin chưa công bố, xung đột lợi ích...).
        //     Trigger DB chặn thật; ở đây kiểm trước để báo lỗi sớm. Không xoá, chỉ tắt (danh sách là dấu vết). ---
        restricted: {
            list: async () => {
                const { data, error } = await sbClient.from('finance_restricted_symbols').select('*').order('created_at', { ascending: false });
                if (error) throw error;
                return data || [];
            },
            // Hạn chế đang bật áp dụng cho `userId` với mã `symbol` (null nếu không có)
            find: async (userId, symbol) => {
                const sym = String(symbol || '').trim().toUpperCase();
                if (!sym) return null;
                const { data, error } = await sbClient.from('finance_restricted_symbols').select('*').eq('symbol', sym).eq('active', true);
                if (error) throw error;
                return (data || []).find(r => !r.user_id || r.user_id === userId) || null;
            },
            // input: { symbol, reason, userId (tuỳ chọn: bỏ trống = mọi thành viên) }
            add: async (email, input) => {
                const actor = await API.asset.limits._actor(email);
                if (!actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin mới đặt được danh sách hạn chế");
                const symbol = String((input && input.symbol) || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error("Mã không hợp lệ");
                const reason = String((input && input.reason) || '').trim();
                if (reason.length < 5) throw new Error("Ghi lý do hạn chế (ít nhất 5 ký tự)");
                const row = { symbol, reason: reason.slice(0, 500), user_id: (input && input.userId) || null, active: true };
                const { error } = await sbClient.from('finance_restricted_symbols').insert(row);
                if (error) {
                    if (error.code === '23505') {
                        // đã có (có thể đang tắt): bật lại với lý do mới
                        let q = sbClient.from('finance_restricted_symbols').update({ active: true, reason: row.reason }).eq('symbol', symbol);
                        q = row.user_id ? q.eq('user_id', row.user_id) : q.is('user_id', null);
                        const { error: e2 } = await q;
                        if (e2) throw e2;
                        return "Đã bật lại hạn chế " + symbol;
                    }
                    throw error;
                }
                return "Đã đưa " + symbol + " vào danh sách hạn chế";
            },
            setActive: async (email, id, active) => {
                const actor = await API.asset.limits._actor(email);
                if (!actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin mới sửa được danh sách hạn chế");
                const { error } = await sbClient.from('finance_restricted_symbols').update({ active: !!active }).eq('id', id);
                if (error) throw error;
                return active ? "Đã bật hạn chế" : "Đã gỡ hạn chế";
            }
        },

        // --- Duyệt lệnh lớn trước khi đặt (lib/approval-calc.js). Quy tắc hai người và hạn dùng được trigger DB (finance-approval-migration.sql) ép thật;
        //     việc GHI lệnh có cần đề xuất đã duyệt hay không do addTransaction kiểm (kiểm soát phía ứng dụng, như giới hạn đầu tư). ---
        approvalPolicy: {
            get: async () => {
                if (typeof ApprovalCalc === 'undefined') throw new Error("Thiếu thư viện duyệt lệnh (lib/approval-calc.js)");
                const { data, error } = await sbClient.from('finance_approval_policy').select('*').eq('id', 1).maybeSingle();
                if (error) throw error;
                return Object.assign(ApprovalCalc.normalizePolicy(data), { updatedAt: data ? data.updated_at : null, selfApprovers: data && Array.isArray(data.self_approvers) ? data.self_approvers : [] });
            },
            // Danh sách người được miễn nguyên tắc hai người (tự duyệt lệnh của mình, vẫn phải ghi lý do). Chỉ admin đặt được (trigger DB cũng chặn người khác).
            setSelfApprovers: async (email, ids) => {
                const actor = await API.asset.limits._actor(email);
                if (!actor.isAdmin) throw new Error("Chỉ admin được đặt danh sách người miễn nguyên tắc hai người");
                const list = [...new Set((ids || []).map(String))];
                const { error } = await sbClient.from('finance_approval_policy').upsert({ id: 1, self_approvers: list, updated_by: actor.actorId, updated_at: new Date().toISOString() }, { onConflict: 'id' });
                if (error) throw error;
                return list.length ? "Đã lưu danh sách người được tự duyệt (" + list.length + ")" : "Đã bỏ mọi ngoại lệ: không ai được tự duyệt ngoài admin";
            },
            save: async (email, policy) => {
                if (typeof ApprovalCalc === 'undefined') throw new Error("Thiếu thư viện duyệt lệnh (lib/approval-calc.js)");
                const v = ApprovalCalc.validatePolicy(policy || {});
                if (!v.ok) throw new Error(v.error);
                const actor = await API.asset.limits._actor(email);
                if (!actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin mới đặt được quy định duyệt lệnh");
                const p = v.policy;
                const { error } = await sbClient.from('finance_approval_policy').upsert({
                    id: 1, active: p.active, threshold_pct: p.thresholdPct, threshold_vnd: p.thresholdVnd, valid_days: p.validDays,
                    updated_by: actor.actorId, updated_at: new Date().toISOString()
                }, { onConflict: 'id' });
                if (error) throw error;
                return p.active ? "Đã bật quy định duyệt lệnh lớn" : "Đã lưu quy định duyệt lệnh (đang tắt)";
            }
        },
        // Kết quả kiểm tra ĐỘC LẬP hằng ngày của Edge Function approval-watch: lệnh lớn đã ghi vào sổ mà không có đề xuất đã duyệt (finance_approval_audit). Quản lý đánh dấu đã xem xét kèm ghi chú.
        approvalAudit: {
            list: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 90) * 86400000).toISOString();
                const { data, error } = await sbClient.from('finance_approval_audit').select('*').gte('detected_at', since).order('detected_at', { ascending: false }).limit(300);
                if (error) throw error;
                return data || [];
            },
            review: async (email, id, note) => {
                const actor = await API.asset.limits._actor(email);
                if (!actor.isManager) throw new Error("Chỉ quản lý danh mục hoặc admin được đánh dấu đã xem xét");
                const text = String(note || '').trim();
                if (text.length < 3) throw new Error("Ghi chú xem xét cần ít nhất 3 ký tự");
                const { data, error } = await sbClient.from('finance_approval_audit').update({ status: 'reviewed', review_note: text.slice(0, 500) }).eq('id', id).eq('status', 'open').select('id');
                if (error) throw error;
                if (!data || !data.length) throw new Error("Bản ghi đã được xem xét");
                return "Đã đánh dấu đã xem xét";
            }
        },
        orders: {
            _today: () => new Date().toISOString().slice(0, 10),
            // NAV hiện tại của danh mục (giá trị mã + tiền mặt - nợ), cùng cách tính với giới hạn đầu tư
            _nav: async (email, userId) => {
                const [holdings, cd] = await Promise.all([
                    API.asset.getHoldingsView(email),
                    sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle()
                ]);
                const mv = (holdings || []).reduce((s, h) => s + (Number(h.marketValue) || 0), 0);
                return mv + (cd && cd.data ? Number(cd.data.cash) || 0 : 0) - (cd && cd.data ? Number(cd.data.debt) || 0 : 0);
            },
            // Lệnh này có cần duyệt không, và đã có đề xuất đã duyệt (còn hạn) khớp chưa? trade: { type, symbol, quantity, price }
            checkTrade: async (email, trade) => {
                if (typeof ApprovalCalc === 'undefined') return { needed: false, policyActive: false };
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const policy = await API.asset.approvalPolicy.get();
                if (!policy.active) return { needed: false, policyActive: false, policy };
                const nav = await API.asset.orders._nav(email, userId);
                const n = ApprovalCalc.needsApproval(policy, nav, trade);
                if (!n.needed) return Object.assign({ policyActive: true, policy, nav }, n);
                const { data, error } = await sbClient.from('finance_order_requests').select('*').eq('user_id', userId).eq('status', 'approved');
                if (error) throw error;
                const match = ApprovalCalc.matchApproval(data || [], userId, trade, API.asset.orders._today());
                return Object.assign({ policyActive: true, policy, nav, match: match ? { id: match.id, valid_until: match.valid_until, quantity: match.quantity, value: match.value } : null }, n);
            },
            // input: { symbol, side, quantity, price, reason } -- đề xuất cho danh mục của `email`
            create: async (email, input) => {
                if (typeof ApprovalCalc === 'undefined') throw new Error("Thiếu thư viện duyệt lệnh (lib/approval-calc.js)");
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const nav = await API.asset.orders._nav(email, userId);
                const b = ApprovalCalc.buildRequest(input || {}, { nav });
                if (!b.ok) throw new Error(b.error);
                const ideaId = input && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(input.ideaId || '')) ? String(input.ideaId) : null;   // ý tưởng đầu tư sinh ra đề xuất này (tuỳ chọn)
                const { error } = await sbClient.from('finance_order_requests').insert(Object.assign({ user_id: userId }, b.row, ideaId ? { idea_id: ideaId } : {}));
                if (error) throw error;
                return "Đã gửi đề xuất lệnh, chờ quản lý duyệt";
            },
            list: async (email, limit) => {
                const userId = await getUserId(email);
                if (!userId) return [];
                const { data, error } = await sbClient.from('finance_order_requests').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 50, 200));
                if (error) throw error;
                return data || [];
            },
            // Mọi đề xuất của nhóm: đang chờ (bất kể cũ) + các đề xuất trong `days` ngày gần đây
            listAll: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 90) * 86400000).toISOString();
                const [recent, pending] = await Promise.all([
                    sbClient.from('finance_order_requests').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(500),
                    sbClient.from('finance_order_requests').select('*').eq('status', 'pending').order('created_at', { ascending: false }).limit(200)
                ]);
                if (recent.error) throw recent.error;
                if (pending.error) throw pending.error;
                const seen = new Set(), out = [];
                (recent.data || []).concat(pending.data || []).forEach(r => { if (!seen.has(r.id)) { seen.add(r.id); out.push(r); } });
                return out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            },
            // decision: 'approved' | 'rejected'. Người duyệt = người đang đăng nhập; trigger DB kiểm lại nguyên tắc hai người.
            decide: async (email, id, decision, note) => {
                if (!['approved', 'rejected'].includes(decision)) throw new Error("Quyết định không hợp lệ");
                const actor = await API.asset.limits._actor(email);
                const { data: req, error: gErr } = await sbClient.from('finance_order_requests').select('*').eq('id', id).maybeSingle();
                if (gErr) throw gErr;
                if (!req) throw new Error("Không tìm thấy đề xuất");
                const pol = await API.asset.approvalPolicy.get();
                const can = ApprovalCalc.canDecide({ isManager: actor.isManager, isAdmin: actor.isAdmin, canSelfApprove: pol.selfApprovers.includes(actor.actorId), actorId: actor.actorId }, req, decision, note);
                if (!can.allowed) throw new Error(can.reason);
                const patch = { status: decision, decision_note: String(note || '').trim().slice(0, 500) || null };
                if (decision === 'approved') patch.valid_until = ApprovalCalc.validUntil(API.asset.orders._today(), pol.validDays);
                const { data, error } = await sbClient.from('finance_order_requests').update(patch).eq('id', id).eq('status', 'pending').select('id');
                if (error) throw error;
                if (!data || !data.length) throw new Error("Đề xuất đã được xử lý bởi người khác");
                return decision === 'approved' ? "Đã duyệt đề xuất" : "Đã từ chối đề xuất";
            },
            cancel: async (id) => {
                const { data, error } = await sbClient.from('finance_order_requests').update({ status: 'cancelled' }).eq('id', id).in('status', ['pending', 'approved']).select('id');
                if (error) throw error;
                if (!data || !data.length) throw new Error("Đề xuất không còn huỷ được");
                return "Đã huỷ đề xuất";
            },
            markExecuted: async (id, txnId) => {
                const { error } = await sbClient.from('finance_order_requests').update({ status: 'executed', txn_id: txnId }).eq('id', id).eq('status', 'approved');
                if (error) throw error;
            }
        },

        // Giá trung bình ngày (VWAP) của nhiều mã từ `from` tới `to`, chia lô 20 mã: { SYMBOL: [[ngày, giá VND]] }. Edge Function stock-history chưa hỗ trợ cờ averages (bản cũ) thì trả rỗng, không lỗi.
        getDailyAverages: async (symbols, from, to) => {
            const list = [...new Set((symbols || []).map(x => String(x).toUpperCase()).filter(x => /^[A-Z0-9]{1,12}$/.test(x)))].slice(0, 80);
            const end = /^\d{4}-\d{2}-\d{2}$/.test(String(to || '')) ? String(to) : new Date().toISOString().slice(0, 10);
            const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
            const out = {}; let error = null;
            for (let i = 0; i < list.length; i += 20) {
                try {
                    const { data, error: err } = await sbClient.functions.invoke('stock-history', { body: { symbols: list.slice(i, i + 20), from: start, to: end, averages: true } });
                    if (err) throw err;
                    Object.assign(out, (data && data.averages) || {});
                } catch (e) { error = e.message || String(e); }
            }
            return { averages: out, error, from: start, to: end };
        },

        // Lịch sử giá đóng cửa nhiều mã (+ VN-Index) từ `from` tới nay, chia lô 20 mã. Trả { histories, error } -- lỗi một phần vẫn trả phần đã lấy được.
        getPriceHistories: async (symbols, from) => {
            const list = [...new Set((symbols || []).map(x => String(x).toUpperCase()).filter(x => /^[A-Z0-9]{1,12}$/.test(x)))].slice(0, 80);
            const to = new Date().toISOString().slice(0, 10);
            const floor = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
            let start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : floor;
            if (start < floor) start = floor;
            const histories = {};
            let error = null;
            for (let i = 0; i < list.length || i === 0; i += 20) {
                try { Object.assign(histories, await API.asset.getPriceHistory(list.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []), start, to)); }
                catch (e) { error = e.message || String(e); }
                if (i + 20 >= list.length) break;
            }
            return { histories, error, from: start, to };
        },

        // Chuỗi điểm của các chỉ số ngành HOSE + VN-Index từ trước ngày `from` ~10 ngày tới nay (cho Brinson). Chỉ số lỗi/thiếu sẽ vắng mặt trong kết quả.
        getSectorIndices: async (from) => {
            if (typeof BrinsonCalc === 'undefined') throw new Error("Thiếu thư viện Brinson (lib/brinson-calc.js)");
            const to = new Date().toISOString().slice(0, 10);
            const floor = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
            let start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? new Date(new Date(from + 'T00:00:00Z').getTime() - 10 * 86400000).toISOString().slice(0, 10) : floor;
            if (start < floor) start = floor;
            return await API.asset.getPriceHistory(BrinsonCalc.SECTOR_INDEX_CODES.concat(['VNINDEX']), start, to);
        },

        // --- Đối soát sổ lệnh với sao kê công ty chứng khoán (lib/reconcile.js). Phép so khớp chạy trên máy; ở đây chỉ lấy dữ liệu đầu vào và ghi nhật ký. ---
        reconcile: {
            getInputs: async (email) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const [txns, actions, cd] = await Promise.all([
                    API.asset.listTransactions(email), API.asset.corporateAction.list(email),
                    sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle()
                ]);
                return { txns, actions, cash: cd && cd.data ? Number(cd.data.cash) || 0 : 0, debt: cd && cd.data ? Number(cd.data.debt) || 0 : 0, today: new Date().toISOString().slice(0, 10) };
            },
            // rec: { kind: 'positions'|'trades', asOf, source, total, matched, mismatched, valueAtStake, cashStatement, cashApp, cashOk, summary, note }
            save: async (email, rec) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const r = rec || {};
                if (!['positions', 'trades'].includes(r.kind)) throw new Error("Loại đối soát không hợp lệ");
                if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.asOf || ''))) throw new Error("Ngày sao kê không hợp lệ");
                const actor = await API.asset.limits._actor(email);
                const int = (v) => Math.max(0, Math.round(Number(v) || 0));
                const optNum = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v))) ? null : Number(v);
                const { error } = await sbClient.from('finance_reconciliations').insert({
                    user_id: userId, kind: r.kind, as_of: r.asOf, source: r.source ? String(r.source).slice(0, 200) : null,
                    total: int(r.total), matched: int(r.matched), mismatched: int(r.mismatched), value_at_stake: Math.max(0, Number(r.valueAtStake) || 0),
                    cash_statement: optNum(r.cashStatement), cash_app: optNum(r.cashApp), cash_ok: r.cashOk === null || r.cashOk === undefined ? null : !!r.cashOk,
                    summary: r.summary || null, note: r.note ? String(r.note).slice(0, 500) : null, created_by: actor.actorId
                });
                if (error) throw error;
                return "Đã lưu kết quả đối soát";
            },
            // Lịch sử đối soát của một người (mới nhất trước)
            list: async (email, limit) => {
                const userId = await getUserId(email);
                if (!userId) return [];
                const { data, error } = await sbClient.from('finance_reconciliations').select('*').eq('user_id', userId).order('created_at', { ascending: false }).limit(Math.min(Number(limit) || 30, 200));
                if (error) throw error;
                return data || [];
            },
            // Mọi lần đối soát gần đây của cả nhóm (RLS cho nhóm finance/admin đọc) -- để quản lý xem ai đã đối soát tới ngày nào
            listAll: async (days) => {
                const since = new Date(Date.now() - (Number(days) || 365) * 86400000).toISOString();
                const { data, error } = await sbClient.from('finance_reconciliations').select('id, user_id, kind, as_of, source, total, matched, mismatched, value_at_stake, cash_ok, created_at').gte('created_at', since).order('created_at', { ascending: false }).limit(1000);
                if (error) throw error;
                return data || [];
            }
        },

        // --- Giá đóng cửa VN-Index/VN30: dữ liệu tham chiếu dùng chung, nhập tay bởi asset_manager ---
        benchmark: {
            list: async (indexCode, days) => {
                const from = days ? (() => { const d = new Date(); d.setDate(d.getDate() - Number(days)); return d.toISOString().slice(0, 10); })() : null;
                // Đọc theo trang: nhiều năm x nhiều chỉ số vượt 1.000 dòng mỗi lần đọc của máy chủ (bị cắt im lặng => so sánh hiệu suất sai)
                return API.asset._fetchAll(() => {
                    let query = sbClient.from('finance_benchmark_prices').select('*').order('price_date', { ascending: true }).order('index_code');
                    if (indexCode) query = query.eq('index_code', indexCode);
                    if (from) query = query.gte('price_date', from);
                    return query;
                });
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

        // --- Danh sách theo dõi: mã CHƯA mua nhưng muốn canh giá. Giá thị trường dùng chung bảng finance_holdings_price (cron cập nhật như mã đang giữ). ---
        // --- VALUATION BENCH: định giá chuyên sâu một cổ phiếu (lib/vb-*.js) ---
        // Dữ liệu một mã: Edge Function vb-data (báo cáo tài chính đầy đủ, nến OHLCV của mã và VN-Index, chuỗi P/E-P/B-P/S hằng ngày) + thống kê ngành + lịch sử định giá thị trường + lãi suất.
        // Mỗi nguồn lỗi riêng được trả trong `errors` để giao diện vẫn dựng được phần còn lại.
        vb: {
            _LIGHT: 'id, user_id, symbol, as_of, price, form, fair_low, fair_base, fair_high, margin_of_safety, grade, stance, confidence, confidence_score, tech_score, tech_rating, timing, market_score, composite, accumulate_low, accumulate_high, invalidation, note, created_at',
            data: async (symbol, opts) => {
                const sym = String(symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
                const o = opts || {}, errors = {};
                const fn = async () => {
                    const { data, error } = await sbClient.functions.invoke('vb-data', { body: { symbol: sym, mode: 'all', years: o.years || 8, candleYears: o.candleYears || 5 } });
                    if (error) {
                        let detail = error.message;
                        try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                        throw new Error(detail);
                    }
                    if (!data || data.ok === false) throw new Error((data && data.error) || 'Không lấy được dữ liệu từ nguồn');
                    return data;
                };
                // lite: chỉ lấy báo cáo + giá (một lượt gọi), bỏ truy vấn bội số ngành và lịch sử định giá -- dùng cho định giá hàng loạt ở bộ lọc thị trường (bên gọi đã có sẵn thống kê ngành)
                if (o.lite) { const d1 = await fn(); return { symbol: sym, vb: d1, peers: null, history: null, errors: d1.errors || {} }; }
                const [d, peers, hist] = await Promise.allSettled([fn(), API.asset.market.peers(sym), API.asset.market.valuationHistory(6)]);
                if (d.status !== 'fulfilled') throw d.reason;
                if (peers.status !== 'fulfilled') errors.peers = String(peers.reason && peers.reason.message || peers.reason);
                if (hist.status !== 'fulfilled') errors.history = String(hist.reason && hist.reason.message || hist.reason);
                const p = peers.status === 'fulfilled' ? peers.value : null, h = hist.status === 'fulfilled' ? hist.value : { rows: [], bond10y: null };
                return { symbol: sym, vb: d.value, peers: p, history: h, errors: Object.assign({}, d.value.errors || {}, errors) };
            },
            // Lưu một bản định giá (bản ghi mới, lịch sử bất biến). rec: các cột của finance_vb_valuations do lib/vb-engine.js (toRecord) tạo ra.
            save: async (email, rec) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("Không xác định được người dùng");
                const r = rec || {};
                const sym = String(r.symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
                if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.as_of || ''))) throw new Error("Thiếu ngày số liệu");
                const numOrNull = (v) => (v === null || v === undefined || v === '' || !isFinite(Number(v)) ? null : Number(v));
                const text = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
                const json = (v, max) => { const s = JSON.stringify(v === undefined ? null : v); if (s && s.length > max) throw new Error("Dữ liệu định giá quá lớn để lưu"); return v === undefined ? null : v; };
                if (!(numOrNull(r.fair_base) > 0)) throw new Error("Chưa có giá trị hợp lý để lưu");
                const row = {
                    user_id: userId, symbol: sym, as_of: r.as_of, price: numOrNull(r.price) > 0 ? numOrNull(r.price) : null, form: text(r.form, 20),
                    fair_low: numOrNull(r.fair_low), fair_base: numOrNull(r.fair_base), fair_high: numOrNull(r.fair_high), margin_of_safety: numOrNull(r.margin_of_safety),
                    grade: text(r.grade, 40), stance: text(r.stance, 60), confidence: text(r.confidence, 20), confidence_score: numOrNull(r.confidence_score),
                    tech_score: numOrNull(r.tech_score), tech_rating: text(r.tech_rating, 60), timing: text(r.timing, 120), market_score: numOrNull(r.market_score), composite: numOrNull(r.composite),
                    accumulate_low: numOrNull(r.accumulate_low), accumulate_high: numOrNull(r.accumulate_high), invalidation: numOrNull(r.invalidation),
                    methods: json(Array.isArray(r.methods) ? r.methods.slice(0, 40) : [], 40000), assumptions: json(r.assumptions || {}, 40000), summary: json(r.summary || {}, 40000), note: text(r.note, 1000),
                };
                const { data, error } = await sbClient.from('finance_vb_valuations').insert(row).select('id, created_at').single();
                if (error) throw error;
                return { id: data.id, createdAt: data.created_at, message: 'Đã lưu định giá ' + sym };
            },
            // Một bản theo mã định danh (đầy đủ cột), để nạp lại giả định của bản đã lưu
            get: async (id) => {
                const { data, error } = await sbClient.from('finance_vb_valuations').select('*').eq('id', String(id || '')).maybeSingle();
                if (error) throw error;
                return data || null;
            },
            // Bản MỚI NHẤT (đầy đủ cột) của một mã; null nếu chưa có
            latest: async (symbol) => {
                const sym = String(symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
                const { data, error } = await sbClient.from('finance_vb_valuations').select('*').eq('symbol', sym).order('created_at', { ascending: false }).limit(1);
                if (error) throw error;
                const row = (data && data[0]) || null;
                if (row) row.author = (await API.asset.vb._authors([row.user_id]))[row.user_id] || '';
                return row;
            },
            // Bội số của các mã do người dùng chọn làm bộ so sánh: lấy từ ảnh chụp thị trường hằng ngày; mã không có trong ảnh chụp bị bỏ qua
            peerRows: async (symbols) => {
                const list = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 40);
                if (list.length < 3) throw new Error('Cần tối thiểu 3 mã so sánh');
                const { data, error } = await sbClient.from('finance_market_snapshot').select('symbol, icb2_code, metrics').in('symbol', list);
                if (error) throw error;
                return (data || []).map(r => ({ symbol: r.symbol, icb2_code: r.icb2_code, metrics: r.metrics || {} }));
            },
            // Bản mới nhất (cột nhẹ) của nhiều mã: { SYM: row } -- cho Danh Mục / Bảng so sánh của Investment Workbench
            latestMany: async (symbols) => {
                const list = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))];
                if (!list.length) return {};
                const rows = await API.asset._fetchAll(() => sbClient.from('finance_vb_valuations').select(API.asset.vb._LIGHT).in('symbol', list).order('created_at', { ascending: false }));
                const out = {};
                (rows || []).forEach(r => { if (!out[r.symbol]) out[r.symbol] = r; });
                return out;
            },
            // Lịch sử các bản đã lưu của một mã (cột nhẹ, mới trước)
            history: async (symbol, limit) => {
                const sym = String(symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
                const { data, error } = await sbClient.from('finance_vb_valuations').select(API.asset.vb._LIGHT).eq('symbol', sym).order('created_at', { ascending: false }).limit(Math.min(200, Number(limit) || 50));
                if (error) throw error;
                const authors = await API.asset.vb._authors((data || []).map(r => r.user_id));
                return (data || []).map(r => Object.assign({}, r, { author: authors[r.user_id] || '' }));
            },
            // Mọi mã đã có định giá: bản mới nhất mỗi mã (cột nhẹ), cho trang Tổng quan của Valuation Bench
            listLatest: async (limit) => {
                const rows = await API.asset._fetchAll(() => sbClient.from('finance_vb_valuations').select(API.asset.vb._LIGHT).order('created_at', { ascending: false }));
                const out = [], seen = {};
                (rows || []).forEach(r => { if (!seen[r.symbol]) { seen[r.symbol] = true; out.push(r); } });
                const authors = await API.asset.vb._authors(out.map(r => r.user_id));
                return out.slice(0, Math.min(500, Number(limit) || 200)).map(r => Object.assign({}, r, { author: authors[r.user_id] || '' }));
            },
            remove: async (email, id) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("Không xác định được người dùng");
                const { data, error } = await sbClient.from('finance_vb_valuations').delete().eq('id', id).select('id');
                if (error) throw error;
                if (!data || !data.length) throw new Error("Không xoá được: bạn chỉ xoá được bản của mình (quản lý danh mục và admin xoá được mọi bản)");
                return 'Đã xoá bản định giá';
            },
            _authors: async (ids) => {
                const list = [...new Set((ids || []).filter(Boolean))];
                if (!list.length) return {};
                const { data } = await sbClient.from('users').select('id, nickname, email').in('id', list);
                const out = {};
                (data || []).forEach(u => { out[u.id] = u.nickname || String(u.email || '').split('@')[0]; });
                return out;
            }
        },
        watchlist: {
            list: async (email) => {
                const userId = await getUserId(email);
                if (!userId) return [];
                const { data: rows, error } = await sbClient.from('finance_watchlist')
                    .select('*').eq('user_id', userId).order('created_at', { ascending: false });
                if (error) throw error;
                const list = rows || [];
                if (!list.length) return [];
                const symbols = list.map(r => r.symbol);
                const { data: prices } = await sbClient.from('finance_holdings_price')
                    .select('symbol, market_price, locked, price_date, price_source, updated_at').eq('user_id', userId).in('symbol', symbols);
                const priceMap = {};
                (prices || []).forEach(p => {
                    priceMap[p.symbol] = { price: Number(p.market_price) || 0, locked: !!p.locked, priceDate: p.price_date || null, priceSource: p.price_source || null, updatedAt: p.updated_at || null };
                });
                const valuationBySymbol = {};
                const { data: vals } = await sbClient.from('finance_stock_valuations')
                    .select('symbol, year, data').in('symbol', symbols).order('year', { ascending: false });
                (vals || []).forEach(v => {
                    if (valuationBySymbol[v.symbol]) return;
                    const t = API.asset._valuationTarget(v.data);
                    if (t) valuationBySymbol[v.symbol] = { target: t, year: v.year };
                });
                const held = new Set((await API.asset.computeHoldings(userId)).map(h => h.symbol));
                return list.map(r => {
                    const entry = priceMap[r.symbol];
                    const price = entry ? entry.price : 0;
                    const manual = Number(r.target_price) || 0;
                    const val = valuationBySymbol[r.symbol];
                    const targetPrice = manual || (val ? Math.round(val.target) : 0);
                    const meta = API.asset._priceMeta(entry, price);
                    const buyBelow = Number(r.buy_below) || 0;
                    const added = Number(r.added_price) || 0;
                    return {
                        id: r.id, symbol: r.symbol, buyBelow, note: r.note || '', createdAt: r.created_at,
                        addedPrice: added, sinceAddedPct: added > 0 && price > 0 ? ((price - added) / added) * 100 : null,
                        price, priceMeta: meta,
                        targetPrice, targetSource: manual ? 'manual' : (val ? 'valuation' : null), targetYear: !manual && val ? val.year : null,
                        upsidePct: targetPrice > 0 && price > 0 ? ((targetPrice - price) / price) * 100 : null,
                        buyGapPct: buyBelow > 0 && price > 0 ? ((price - buyBelow) / buyBelow) * 100 : null,
                        held: held.has(r.symbol),
                        signal: buyBelow > 0 && price > 0 && price <= buyBelow && !(meta && meta.stale) ? 'buy' : null
                    };
                });
            },
            add: async (email, item) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const symbol = String(item.symbol || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{1,12}$/.test(symbol)) throw new Error("Mã không hợp lệ");
                const buyBelow = Number(item.buyBelow) || 0;
                const target = Number(item.targetPrice) || 0;
                // Đảm bảo có dòng giá (không ghi đè giá đang có) để cron fetch-stock-prices cập nhật giá cho mã này
                await sbClient.from('finance_holdings_price').upsert({ user_id: userId, symbol, market_price: 0 }, { onConflict: 'user_id,symbol', ignoreDuplicates: true });
                let price = 0;
                try {
                    const series = await API.asset.getPriceHistory([symbol], new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10), new Date().toISOString().slice(0, 10));
                    const rows = series[symbol] || [];
                    if (rows.length) {
                        const [date, close] = rows[rows.length - 1];
                        price = Number(close) || 0;
                        const { data: cur } = await sbClient.from('finance_holdings_price').select('market_price').eq('user_id', userId).eq('symbol', symbol).maybeSingle();
                        if (price > 0 && !(Number(cur && cur.market_price) > 0)) {
                            await sbClient.from('finance_holdings_price').update({ market_price: price, price_date: date, price_source: 'vnd-dchart', updated_at: new Date().toISOString() }).eq('user_id', userId).eq('symbol', symbol);
                        } else if (Number(cur && cur.market_price) > 0) price = Number(cur.market_price);
                    }
                } catch (e) { /* chưa lấy được giá ngay — cron sẽ cập nhật sau */ }
                const { error } = await sbClient.from('finance_watchlist').insert({
                    user_id: userId, symbol, buy_below: buyBelow > 0 ? buyBelow : null, target_price: target > 0 ? target : null,
                    note: item.note ? String(item.note).slice(0, 300) : null, added_price: price > 0 ? price : null
                });
                if (error) throw new Error(error.code === '23505' ? `${symbol} đã có trong danh sách theo dõi` : error.message);
                return `Đã thêm ${symbol} vào danh sách theo dõi`;
            },
            update: async (email, id, patch) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const fields = {};
                if ('buyBelow' in patch) fields.buy_below = Number(patch.buyBelow) > 0 ? Number(patch.buyBelow) : null;
                if ('targetPrice' in patch) fields.target_price = Number(patch.targetPrice) > 0 ? Number(patch.targetPrice) : null;
                if ('note' in patch) fields.note = patch.note ? String(patch.note).slice(0, 300) : null;
                if (!Object.keys(fields).length) return "Không có gì để cập nhật";
                const { error } = await sbClient.from('finance_watchlist').update(fields).eq('id', id).eq('user_id', userId);
                if (error) throw error;
                return "Đã cập nhật";
            },
            remove: async (email, id) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const { error } = await sbClient.from('finance_watchlist').delete().eq('id', id).eq('user_id', userId);
                if (error) throw error;
                return "Đã xoá khỏi danh sách theo dõi";
            }
        },

        // --- Nhật ký quyết định: lý do + kỳ vọng ghi lúc ra quyết định; kết quả đánh giá ở lib/decision-journal.js ---
        journal: {
            list: async (email) => {
                const userId = await getUserId(email);
                if (!userId) return [];
                const { data, error } = await sbClient.from('finance_decisions').select('*')
                    .eq('user_id', userId).is('deleted_at', null).order('decided_at', { ascending: false });
                if (error) throw error;
                return (data || []).slice().sort((a, b) => (a.decided_at < b.decided_at ? 1 : a.decided_at > b.decided_at ? -1 : (a.created_at < b.created_at ? 1 : -1)));
            },
            // Thêm mới hoặc sửa (có input.id, hoặc đã có quyết định gắn với txnId). Kiểm tra dữ liệu bằng DecisionJournal.validate.
            save: async (email, input) => {
                if (typeof DecisionJournal === 'undefined') throw new Error("Thiếu thư viện nhật ký quyết định (lib/decision-journal.js)");
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const v = DecisionJournal.validate(input);
                if (!v.ok) throw new Error(v.error);
                const row = Object.assign({}, v.row, { updated_at: new Date().toISOString() });
                let existingId = input.id || null;
                if (!existingId && row.txn_id) {
                    const { data: ex } = await sbClient.from('finance_decisions').select('id').eq('user_id', userId).eq('txn_id', row.txn_id).is('deleted_at', null).maybeSingle();
                    if (ex) existingId = ex.id;
                }
                if (existingId) {
                    const patch = Object.assign({}, row);
                    if (!patch.txn_id) delete patch.txn_id; // sửa tay không được gỡ liên kết với lệnh
                    const { error } = await sbClient.from('finance_decisions').update(patch).eq('id', existingId).eq('user_id', userId);
                    if (error) throw error;
                    return "Đã cập nhật quyết định";
                }
                const { error } = await sbClient.from('finance_decisions').insert(Object.assign({ user_id: userId }, row));
                if (error) throw new Error(error.code === '23505' ? 'Lệnh này đã có nhật ký quyết định' : error.message);
                return "Đã ghi quyết định vào nhật ký";
            },
            // Đánh giá lại sau này: điểm 1-5 + nhận xét + bài học
            saveReview: async (email, id, review) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const rating = Number(review && review.rating);
                if (!(rating >= 1 && rating <= 5)) throw new Error("Chọn điểm đánh giá từ 1 đến 5");
                const { error } = await sbClient.from('finance_decisions').update({
                    review_rating: Math.round(rating), review_note: review.note ? String(review.note).trim().slice(0, 1000) : null,
                    lesson: review.lesson ? String(review.lesson).trim().slice(0, 1000) : null,
                    review_date: new Date().toISOString().slice(0, 10), updated_at: new Date().toISOString()
                }).eq('id', id).eq('user_id', userId);
                if (error) throw error;
                return "Đã lưu đánh giá";
            },
            remove: async (email, id) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const { error } = await sbClient.from('finance_decisions').update({ deleted_at: new Date().toISOString() }).eq('id', id).eq('user_id', userId);
                if (error) throw error;
                return "Đã xoá quyết định khỏi nhật ký";
            },
            // Lệnh giao dịch gần đây CHƯA có nhật ký (để nhắc ghi lý do)
            unplannedTrades: async (email, days) => {
                const userId = await getUserId(email);
                if (!userId) return [];
                const since = new Date(Date.now() - (Number(days) || 45) * 86400000).toISOString().slice(0, 10);
                const txns = (await API.asset.listTransactions(email)).filter(t => String(t.trade_date) >= since);
                if (!txns.length) return [];
                const { data: linked } = await sbClient.from('finance_decisions').select('txn_id').eq('user_id', userId).is('deleted_at', null);
                const done = new Set((linked || []).map(d => d.txn_id).filter(Boolean));
                return txns.filter(t => !done.has(t.id)).map(t => ({ id: t.id, symbol: t.symbol, type: t.type, quantity: Number(t.quantity), price: Number(t.price), trade_date: t.trade_date }));
            },
        },

        // --- Tỷ trọng mục tiêu để cân bằng danh mục (symbol 'CASH' = tiền mặt) ---
        allocation: {
            list: async (email) => {
                const userId = await getUserId(email);
                if (!userId) return {};
                const { data, error } = await sbClient.from('finance_allocation_targets').select('symbol, target_pct').eq('user_id', userId);
                if (error) throw error;
                const map = {};
                (data || []).forEach(r => { map[r.symbol] = Number(r.target_pct) || 0; });
                return map;
            },
            // Thay toàn bộ bộ mục tiêu bằng targets = { SYMBOL: pct }
            save: async (email, targets) => {
                const userId = await getUserId(email);
                if (!userId) throw new Error("User không tồn tại");
                const entries = Object.entries(targets || {})
                    .map(([symbol, pct]) => [String(symbol).trim().toUpperCase(), Number(pct)])
                    .filter(([symbol, pct]) => /^[A-Z0-9]{1,12}$/.test(symbol) && isFinite(pct) && pct >= 0 && pct <= 100);
                const sum = entries.reduce((s, [, pct]) => s + pct, 0);
                if (sum > 100.0001) throw new Error("Tổng tỷ trọng mục tiêu không được vượt 100%");
                const keep = entries.map(([symbol]) => symbol);
                let del = sbClient.from('finance_allocation_targets').delete().eq('user_id', userId);
                if (keep.length) del = del.not('symbol', 'in', '(' + keep.join(',') + ')');
                const { error: delErr } = await del;
                if (delErr) throw delErr;
                if (entries.length) {
                    const { error } = await sbClient.from('finance_allocation_targets').upsert(
                        entries.map(([symbol, pct]) => ({ user_id: userId, symbol, target_pct: pct, updated_at: new Date().toISOString() })),
                        { onConflict: 'user_id,symbol' });
                    if (error) throw error;
                }
                return "Đã lưu tỷ trọng mục tiêu";
            }
        },

        // Gom MỌI dữ liệu thô cần cho báo cáo cuối tháng (tính toán nằm ở lib/monthly-report.js để kiểm thử được). month = 'YYYY-MM'.
        getMonthlyReportInputs: async (email, month) => {
            if (!/^\d{4}-\d{2}$/.test(String(month))) throw new Error("Tháng không hợp lệ (cần dạng YYYY-MM)");
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const [navHistory, txns, flows, holdings, watchlist, targets, benchmarkRows, journal] = await Promise.all([
                API.asset.getNavHistory(email), API.asset.listTransactions(email), API.asset.cashFlow.list(email),
                API.asset.getHoldingsView(email), API.asset.watchlist.list(email), API.asset.allocation.list(email),
                API.asset.benchmark.list('VNINDEX'), API.asset.journal.list(email)
            ]);
            const { data: actions } = await sbClient.from('finance_corporate_actions')
                .select('*').eq('user_id', userId).is('deleted_at', null);
            const { data: cd } = await sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle();

            // Giá lịch sử cho mọi mã từng giao dịch/đang giữ (+ VN-Index) -- khoảng từ 45 ngày trước đầu tháng tới 12 ngày sau cuối tháng
            const [y, m] = month.split('-').map(Number);
            const first = new Date(Date.UTC(y, m - 1, 1)), last = new Date(Date.UTC(y, m, 0));
            const from = new Date(first.getTime() - 45 * 86400000).toISOString().slice(0, 10);
            const to = new Date(Math.min(Date.now(), last.getTime() + 12 * 86400000)).toISOString().slice(0, 10);
            const symbols = Array.from(new Set(txns.map(t => t.symbol).concat(holdings.map(h => h.symbol)))).slice(0, 40);
            let histories = {}, historyError = null;
            try {
                for (let i = 0; i < symbols.length || i === 0; i += 20) {
                    Object.assign(histories, await API.asset.getPriceHistory(symbols.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []), from, to));
                    if (i + 20 >= symbols.length) break;
                }
            } catch (e) { historyError = e.message || String(e); }
            return {
                month, email, navHistory, txns, actions: actions || [], cashFlows: flows, holdingsNow: holdings, watchlist, targets,
                benchmark: benchmarkRows, cash: cd ? Number(cd.cash) || 0 : 0, debt: cd ? Number(cd.debt) || 0 : 0, histories, historyError, journal
            };
        },

        // Dữ liệu thô cho tab Lịch (tính toán ở lib/calendar-calc.js): sổ lệnh, hành động DN, dòng tiền, danh mục hiện tại (kèm giá vốn), sự kiện doanh nghiệp
        // đã/sắp công bố của mọi mã từng giao dịch, và quý báo cáo mới nhất của các mã đang giữ (từ bảng đệm số liệu tự làm mới). Lỗi phần phụ không làm hỏng cả báo cáo.
        getCalendarInputs: async (email) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const [txns, actions, cashFlows, holdings, dis] = await Promise.all([
                API.asset.listTransactions(email), API.asset.corporateAction.list(email), API.asset.cashFlow.list(email), API.asset.getHoldingsView(email),
                sbClient.from('finance_event_dismissals').select('event_id').eq('user_id', userId)
            ]);
            const scope = CorporateEvents.queryScope(txns);
            let events = [], eventsError = null;
            if (scope.symbols.length) {
                try { events = (await API.asset.events._fetchEvents(scope.symbols, scope.since)).events; } catch (e) { eventsError = e.message || String(e); }
            }
            const held = holdings.map(h => h.symbol);
            let latestQuarter = {};
            if (held.length) {
                try {
                    const cache = await API.stock.getFinancialsCache(held);
                    Object.keys(cache).forEach(s => {
                        const qs = (cache[s].quarters || []).slice().sort((a, b) => (b.year * 4 + b.quarter) - (a.year * 4 + a.quarter));
                        if (qs.length) latestQuarter[s] = qs[0].year + 'Q' + qs[0].quarter;
                    });
                } catch (e) { /* chưa có bảng đệm: coi như chưa theo dõi báo cáo */ }
            }
            return {
                today: new Date().toISOString().slice(0, 10), txns, actions, cashFlows, events, eventsError, latestQuarter,
                dismissed: (dis.data || []).map(r => r.event_id),
                holdings: holdings.map(h => ({ symbol: h.symbol, quantity: h.quantity, marketValue: h.marketValue, costValue: h.costValue }))
            };
        },

        // Dữ liệu thô cho phân tích hiệu quả so với chuẩn (tính toán ở lib/perf-calc.js): lịch sử NAV + giá chuẩn (VN-Index hoặc VN30)
        // phủ từ trước ngày chụp NAV đầu tiên. Lỗi lấy giá chuẩn không làm hỏng phần còn lại (benchError).
        getPerfInputs: async (email, benchKey) => {
            const key = ['VNINDEX', 'VN30'].includes(benchKey) ? benchKey : 'VNINDEX';
            const navHistory = await API.asset.getNavHistory(email);
            let bench = null, benchError = null;
            if (navHistory.length >= 2) {
                const first = String(navHistory[0].snapshot_date).slice(0, 10);
                const from = new Date(new Date(first + 'T00:00:00Z').getTime() - 20 * 86400000).toISOString().slice(0, 10);
                const to = new Date().toISOString().slice(0, 10);
                try { const s = await API.asset.getPriceHistory([key], from, to); bench = s[key] || null; if (!bench) benchError = 'Nguồn chưa có dữ liệu ' + key; }
                catch (e) { benchError = e.message || String(e); }
            }
            // Cổ tức tiền mặt (để tách lợi suất giá khỏi lợi suất tổng) và lợi suất trái phiếu (lãi phi rủi ro theo ngày): lỗi thì bỏ qua, phần tính vẫn chạy với mức cài tay
            const [flows, rates] = await Promise.all([API.asset.cashFlow.list(email).catch(() => []), API.asset.market.rates(1100).catch(() => [])]);
            const dividends = (flows || []).filter(f => f.flow_type === 'dividend').map(f => ({ date: String(f.flow_date).slice(0, 10), amount: Number(f.amount) || 0 }));
            return { navHistory, bench, benchKey: key, benchError, dividends, rates };
        },

        // Dữ liệu thô cho phân tích nguồn gốc lợi nhuận (tính toán ở lib/attribution-calc.js): sổ lệnh, hành động DN, dòng tiền, NAV đã chụp,
        // giá lịch sử của MỌI mã từng giao dịch + VN-Index từ trước mốc `from`. Lỗi giá không làm hỏng phần còn lại (historyError).
        getAttributionInputs: async (email, from) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const [txns, cashFlows, navHistory, actions] = await Promise.all([
                API.asset.listTransactions(email), API.asset.cashFlow.list(email), API.asset.getNavHistory(email), API.asset.corporateAction.list(email)
            ]);
            const symbols = [...new Set(txns.map(t => t.symbol))].slice(0, 60);
            const first = txns.reduce((m, t) => (!m || String(t.trade_date) < m ? String(t.trade_date).slice(0, 10) : m), null);
            const to = new Date().toISOString().slice(0, 10);
            const floor = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
            let start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : (first || to);
            if (first && start > first && !from) start = first;
            const hFrom = new Date(new Date(start + 'T00:00:00Z').getTime() - 12 * 86400000).toISOString().slice(0, 10);
            let histories = {}, historyError = null;
            if (symbols.length) {
                try {
                    for (let i = 0; i < symbols.length; i += 20) {
                        Object.assign(histories, await API.asset.getPriceHistory(symbols.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []), hFrom < floor ? floor : hFrom, to));
                    }
                } catch (e) { historyError = e.message || String(e); }
            }
            return { txns, cashFlows, navHistory, actions, histories, historyError, firstTxnDate: first, from: start, to };
        },

        // Dữ liệu thô cho "Gương Quyết Định" (lib/decision-mirror.js): sổ lệnh, hành động DN, nhật ký quyết định và giá lịch sử của mọi mã từng giao dịch
        // (+ VN-Index) từ 45 ngày trước lệnh/quyết định đầu tiên tới nay -- cần để đo diễn biến giá trước và sau từng lệnh.
        getMirrorInputs: async (email) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const [txns, actions, decisions] = await Promise.all([API.asset.listTransactions(email), API.asset.corporateAction.list(email), API.asset.journal.list(email)]);
            const symbols = [...new Set(txns.map(t => t.symbol).concat(decisions.map(d => d.symbol)).filter(Boolean))].slice(0, 60);
            const dates = txns.map(t => String(t.trade_date).slice(0, 10)).concat(decisions.map(d => String(d.decided_at).slice(0, 10))).filter(Boolean).sort();
            const today = new Date().toISOString().slice(0, 10);
            const floor = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
            const first = dates[0] || today;
            let from = new Date(new Date(first + 'T00:00:00Z').getTime() - 45 * 86400000).toISOString().slice(0, 10);
            if (from < floor) from = floor;
            let histories = {}, historyError = null;
            if (symbols.length) {
                try {
                    for (let i = 0; i < symbols.length; i += 20) {
                        Object.assign(histories, await API.asset.getPriceHistory(symbols.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []), from, today));
                    }
                } catch (e) { historyError = e.message || String(e); }
            }
            return { txns, actions, decisions, histories, historyError, today, from };
        },

        // Chuỗi giá chuẩn (VN-Index hoặc VN30) từ trước ngày `from` ~20 ngày tới nay, cho các phân tích hiệu quả cấp nhóm.
        getBenchSeries: async (benchKey, from) => {
            const key = ['VNINDEX', 'VN30'].includes(benchKey) ? benchKey : 'VNINDEX';
            const to = new Date().toISOString().slice(0, 10);
            const floor = new Date(Date.now() - 2590 * 86400000).toISOString().slice(0, 10);
            const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? new Date(new Date(from + 'T00:00:00Z').getTime() - 20 * 86400000).toISOString().slice(0, 10) : floor;
            const s = await API.asset.getPriceHistory([key], start < floor ? floor : start, to);
            return s[key] || [];
        },

        // Đọc hết một bảng lớn theo từng trang 1.000 dòng (giới hạn mặc định của máy chủ); build() trả query MỚI mỗi lần gọi.
        _fetchAll: async (build) => {
            const out = [];
            for (let from = 0; ; from += 1000) {
                const { data, error } = await build().range(from, from + 999);
                if (error) throw error;
                out.push(...(data || []));
                if (!data || data.length < 1000) break;
            }
            return out;
        },

        // Giá lịch sử + sự kiện doanh nghiệp cho một nhóm mã (dùng chung cho Rủi Ro cá nhân và Rủi Ro cấp nhóm). Lỗi phần nào được báo riêng.
        getMarketInputs: async (symbols, windowDays) => {
            const win = Math.min(Math.max(Number(windowDays) || 365, 90), 1100);
            const list = [...new Set((symbols || []).map(s => String(s).toUpperCase()))].slice(0, 60);
            const to = new Date().toISOString().slice(0, 10);
            const from = new Date(Date.now() - (win + 20) * 86400000).toISOString().slice(0, 10);
            let histories = {}, historyError = null, events = [], eventsError = null;
            if (list.length) {
                try {
                    for (let i = 0; i < list.length; i += 20) {
                        Object.assign(histories, await API.asset.getPriceHistory(list.slice(i, i + 20).concat(i === 0 ? ['VNINDEX'] : []), from, to));
                    }
                } catch (e) { historyError = e.message || String(e); }
                try { events = (await API.asset.events._fetchEvents(list, from)).events; } catch (e) { eventsError = e.message || String(e); }
            }
            return { histories, historyError, events, eventsError, from, to, windowDays: win };
        },

        // Dữ liệu thô của CẢ NHÓM (thành viên finance/admin đang hoạt động): sổ lệnh, hành động DN, dòng tiền, giá, tiền/nợ, lịch sử NAV.
        // Chính sách RLS cho phép nhóm finance/admin đọc dữ liệu của nhau. Phép gộp ở lib/group-calc.js.
        getGroupData: async () => {
            await API.asset.market.ensureMeta();
            const { data: users, error } = await sbClient.from('users').select('id, email, nickname, group_key, active').in('group_key', ['finance', 'admin']);
            if (error) throw error;
            const members = (users || []).filter(u => u.active !== false).map(u => ({ id: u.id, email: u.email, nickname: u.nickname || null }));
            const ids = members.map(m => m.id);
            if (!ids.length) return { members: [], txns: [], actions: [], cashFlows: [], prices: [], assets: [], navHistory: [], fetchedAt: new Date().toISOString() };
            const [txns, actions, cashFlows, prices, assets, navHistory] = await Promise.all([
                API.asset._fetchAll(() => sbClient.from('finance_transactions').select('*').in('user_id', ids).is('deleted_at', null).order('trade_date', { ascending: true })),
                API.asset._fetchAll(() => sbClient.from('finance_corporate_actions').select('*').in('user_id', ids).is('deleted_at', null).order('ex_date', { ascending: true })),
                API.asset._fetchAll(() => sbClient.from('finance_cash_flows').select('*').in('user_id', ids).is('deleted_at', null).order('flow_date', { ascending: true })),
                API.asset._fetchAll(() => sbClient.from('finance_holdings_price').select('user_id, symbol, market_price, price_date, updated_at').in('user_id', ids)),
                API.asset._fetchAll(() => sbClient.from('finance_assets').select('user_id, cash, debt, nav').in('user_id', ids)),
                API.asset._fetchAll(() => sbClient.from('finance_nav_history').select('user_id, snapshot_date, nav, net_contributed, cash, market_value').in('user_id', ids).order('snapshot_date', { ascending: true }))
            ]);
            return { members, txns, actions, cashFlows, prices, assets, navHistory, fetchedAt: new Date().toISOString() };
        },

        // Khối lượng giao dịch ngày của các mã (Edge Function stock-history với volumes:true) để tính thanh khoản. Trả { SYM: [[ngày, khối lượng]] }; mã thiếu dữ liệu vắng mặt.
        getVolumeHistory: async (symbols, days) => {
            const list = [...new Set((symbols || []).map(s => String(s).toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))].slice(0, 60);
            if (!list.length) return {};
            const d = Math.min(Math.max(Number(days) || 90, 30), 365);
            const to = new Date().toISOString().slice(0, 10);
            const from = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
            const out = {};
            for (let i = 0; i < list.length; i += 20) {
                const { data, error } = await sbClient.functions.invoke('stock-history', { body: { symbols: list.slice(i, i + 20), from, to, volumes: true } });
                if (error) {
                    let detail = error.message;
                    try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                    throw new Error(detail);
                }
                if (!data || !data.ok) throw new Error((data && data.error) || 'Không lấy được khối lượng giao dịch');
                Object.assign(out, data.volumes || {});
            }
            return out;
        },

        // Gom dữ liệu thô cho tab Rủi Ro (tính toán ở lib/risk-calc.js): danh mục hiện tại, tiền/nợ, giá lịch sử các mã đang giữ + VN-Index,
        // sự kiện doanh nghiệp để điều chỉnh giá (lỗi ở các phần phụ KHÔNG làm hỏng cả báo cáo), lịch sử NAV đã chụp.
        getRiskInputs: async (email, windowDays) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const win = Math.min(Math.max(Number(windowDays) || 365, 90), 1100);
            const [holdings, navHistory, cd] = await Promise.all([
                API.asset.getHoldingsView(email), API.asset.getNavHistory(email),
                sbClient.from('finance_assets').select('cash, debt').eq('user_id', userId).maybeSingle()
            ]);
            const mk = await API.asset.getMarketInputs(holdings.map(h => h.symbol).slice(0, 40), win);
            const { histories, historyError, events, eventsError, from, to } = mk;
            return {
                holdings: holdings.map(h => ({ symbol: h.symbol, quantity: h.quantity, marketValue: h.marketValue, marketPrice: h.marketPrice })),
                cash: cd && cd.data ? Number(cd.data.cash) || 0 : 0, debt: cd && cd.data ? Number(cd.data.debt) || 0 : 0,
                histories, historyError, events, eventsError, navHistory, from, to, windowDays: win
            };
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
            const flows = await API.asset._fetchAll(() => sbClient.from('finance_cash_flows')
                .select('flow_type, amount').eq('user_id', userId).is('deleted_at', null)
                .in('flow_type', ['deposit', 'withdrawal']).order('id'));
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
            const from = days ? (() => { const d = new Date(); d.setDate(d.getDate() - Number(days)); return d.toISOString().slice(0, 10); })() : null;
            // NAV chụp MỖI NGÀY: sau khoảng 2,7 năm vượt 1.000 dòng; không đọc theo trang thì hiệu suất (TWR) chỉ tính trên 1.000 ngày ĐẦU
            return API.asset._fetchAll(() => {
                let query = sbClient.from('finance_nav_history').select('*').eq('user_id', userId).order('snapshot_date', { ascending: true });
                if (from) query = query.gte('snapshot_date', from);
                return query;
            });
        },

        // --- KPI tổng hợp cho tab Hiệu Suất ---
        getSummaryKpis: async (email) => {
            const userId = await getUserId(email);
            const holdings = await API.asset.getHoldingsView(email);
            const unrealizedPnl = holdings.reduce((s, h) => s + h.unrealizedPnl, 0);
            const sells = await API.asset._fetchAll(() => sbClient.from('finance_transactions')
                .select('realized_pnl').eq('user_id', userId).eq('type', 'sell').is('deleted_at', null).order('id'));
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
                return { sharpe: null, maxDrawdown: null, volatility: null, annualizedReturn: null, cumulativeReturn: null, dataPoints: history ? history.length : 0, benchmark: null };
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
            // Time-Weighted Return: nối các lợi nhuận ngày "sạch" theo kiểu lãi kép (geometric linking) —
            // đo đúng hiệu quả đầu tư thực, không bị méo bởi quy mô/thời điểm nạp-rút vốn như %
            // tăng trưởng NAV thô (last/first). Chuẩn ngành cho báo cáo hiệu suất danh mục cá nhân.
            const cumulativeReturn = n > 0 ? (dailyReturns.reduce((acc, r) => acc * (1 + r), 1) - 1) * 100 : null;

            // Max Drawdown trên chuỗi NAV thực tế (không loại ngày có dòng tiền — đây là mức sụt
            // giá trị tài khoản nhà đầu tư thực sự trải qua, kể cả khi có rút vốn giữa chừng)
            let peak = Number(history[0].nav) || 0, maxDD = 0;
            history.forEach(h => {
                const nav = Number(h.nav) || 0;
                if (nav > peak) peak = nav;
                if (peak > 0) { const dd = (nav - peak) / peak; if (dd < maxDD) maxDD = dd; }
            });

            // So sánh benchmark: chỉ số hóa NAV và VN-Index về gốc 100 tại ngày đầu tiên có dữ liệu chung
            let benchmark = null, benchmarkSummary = null;
            try {
                const idxData = await API.asset.benchmark.list('VNINDEX');
                if (idxData && idxData.length) {
                    const idxByDate = {};
                    idxData.forEach(d => { idxByDate[d.price_date] = Number(d.close_value); });
                    const overlap = history.filter(h => idxByDate[h.snapshot_date] !== undefined);
                    if (overlap.length >= 2) {
                        // Cả hai đường được nối theo kiểu TWR trên CÙNG tập ngày: ngày có nạp/rút vốn (NAV bị méo
                        // bởi tiền góp) giữ nguyên cả danh mục lẫn VN-Index, nên "vượt/thua" không bị lệch bởi dòng tiền.
                        let pIdx = 100, bIdx = 100;
                        benchmark = [{ date: overlap[0].snapshot_date, portfolioIndexed: 100, benchmarkIndexed: 100 }];
                        for (let i = 1; i < overlap.length; i++) {
                            const prev = overlap[i - 1], cur = overlap[i];
                            const flowChanged = Math.abs((Number(cur.net_contributed) || 0) - (Number(prev.net_contributed) || 0)) > 1;
                            const prevNav = Number(prev.nav) || 0;
                            const prevIdx = idxByDate[prev.snapshot_date];
                            if (!flowChanged && prevNav > 0 && prevIdx > 0) {
                                pIdx *= Number(cur.nav) / prevNav;
                                bIdx *= idxByDate[cur.snapshot_date] / prevIdx;
                            }
                            benchmark.push({ date: cur.snapshot_date, portfolioIndexed: pIdx, benchmarkIndexed: bIdx });
                        }
                        const last = benchmark[benchmark.length - 1];
                        benchmarkSummary = {
                            from: benchmark[0].date, to: last.date,
                            portfolioPct: last.portfolioIndexed - 100, indexPct: last.benchmarkIndexed - 100,
                            excessPct: last.portfolioIndexed - last.benchmarkIndexed
                        };
                    }
                }
            } catch (e) { /* chưa có dữ liệu VN-Index — bỏ qua phần benchmark, không chặn các chỉ số khác */ }

            return { sharpe, maxDrawdown: maxDD, volatility: annualizedVol, annualizedReturn, cumulativeReturn, dataPoints: n, benchmark, benchmarkSummary };
        },

        // --- Trang "Tổng hợp" của cả team ---
        getTeamSummary: async () => {
            // Lọc nhóm finance/admin — phải khớp đúng tập thành viên với getMemberList/getTeamNavHistory,
            // nếu không KPI "Tổng NAV toàn team" và biểu đồ NAV team sẽ ra 2 con số khác nhau trên cùng 1 trang.
            const { data, error } = await sbClient.from('finance_assets')
                .select('*, users!inner(nickname, email, group_key)').in('users.group_key', ['finance', 'admin']);
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
        // Tổng NAV toàn team theo ngày — cộng nav mọi thành viên finance/admin từ
        // finance_nav_history. Dùng cho biểu đồ "NAV team theo thời gian" ở trang Tổng Hợp TS.
        getTeamNavHistory: async () => {
            const { data: members } = await sbClient.from('users').select('id').in('group_key', ['finance', 'admin']);
            const ids = (members || []).map(m => m.id);
            if (!ids.length) return [];
            // Mọi thành viên x mọi ngày: 5 người x 250 ngày đã vượt 1.000 dòng mỗi lần đọc => NAV nhóm thiếu các ngày gần đây nếu không đọc theo trang
            const data = await API.asset._fetchAll(() => sbClient.from('finance_nav_history')
                .select('snapshot_date, nav, user_id').in('user_id', ids).order('snapshot_date', { ascending: true }).order('user_id'));
            const byDate = {};
            (data || []).forEach(r => { byDate[r.snapshot_date] = (byDate[r.snapshot_date] || 0) + (Number(r.nav) || 0); });
            return Object.keys(byDate).sort().map(d => ({ snapshot_date: d, nav: byDate[d] }));
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
        // Kho lưu trữ. Xếp theo updated_at desc = mục vừa lưu trữ gần đây nhất lên đầu
        // (trigger personal_items_touch_updated_at chạm updated_at ở mọi UPDATE, nên đó
        // chính là thời điểm lưu trữ). Không xếp pinned lên đầu — trong kho thì vô nghĩa.
        listArchived: async () => {
            const { data, error } = await sbClient.from('personal_items').select('*')
                .eq('archived', true)
                .order('updated_at', { ascending: false });
            if (error) throw error;
            return data || [];
        },
        upsert: async (item) => {
            const row = {
                type: item.type,
                title: item.title || null,
                data: item.data || {},
                tags: Array.isArray(item.tags) ? item.tags : [],
                source_app: 'fin'
            };
            // pinned/archived CỐ TÌNH không nằm trong row mặc định. Trước đây row luôn ghi
            // `pinned: !!item.pinned`, trong khi MỌI caller (togglePersonalChecklist,
            // submitPersonalItemForm, savePersonalLayoutPref) đều không truyền pinned —
            // nghĩa là mỗi lần tick 1 checkbox là âm thầm bỏ ghim mục đó. Khi INSERT mà
            // thiếu 2 cột này thì DB tự dùng default (đều là false).
            if ('pinned' in item) row.pinned = !!item.pinned;
            if ('archived' in item) row.archived = !!item.archived;
            if (item.id) {
                const { data, error } = await sbClient.from('personal_items').update(row).eq('id', item.id).select().single();
                if (error) throw error;
                return data;
            }
            const { data, error } = await sbClient.from('personal_items').insert(row).select().single();
            if (error) throw error;
            return data;
        },
        // Patch hẹp: chỉ đụng đúng cờ được truyền vào, không bao giờ ghi đè title/data/tags.
        // Cố ý KHÔNG nhét archived qua upsert() — upsert dựng nguyên hàng, quên 1 trường là
        // xoá trắng title/data. Trả về nguyên hàng đã cập nhật để caller nhét thẳng vào
        // personalItemsCache (updated_at đã bị trigger đổi, đọc lại từ server là chính xác).
        setFlags: async (id, patch) => {
            const row = {};
            if (patch && 'pinned' in patch) row.pinned = !!patch.pinned;
            if (patch && 'archived' in patch) row.archived = !!patch.archived;
            if (Object.keys(row).length === 0) throw new Error('setFlags: không có cờ nào để cập nhật.');
            const { data, error } = await sbClient.from('personal_items').update(row).eq('id', id).select().single();
            if (error) throw error;
            return data;
        },
        // Giữ nguyên: giờ là đường 'Xoá vĩnh viễn' trong kho lưu trữ, không còn là nút xoá
        // trên thẻ (nút đó đã đổi thành Lưu trữ).
        remove: async (id) => {
            const { error } = await sbClient.from('personal_items').delete().eq('id', id);
            if (error) throw error;
            return "Đã xoá";
        }
    },
    // Local-folder sync bookkeeping (personal_sync_files) — one row per relative path inside
    // the user's linked folder, RLS by auth.uid() same as personal_items. The actual file
    // bytes live in the private 'personal_files' Storage bucket, path `${uid}/${relativePath}`.
    // See personal-sync.js for the engine that drives this via Rust fs commands + this API.
    personalSync: {
        getUserId: async () => {
            const { data } = await sbClient.auth.getUser();
            return data && data.user ? data.user.id : null;
        },
        listFiles: async () => {
            // Đọc theo trang tới khi hết: máy chủ trả tối đa 1.000 dòng mỗi lần. Nếu danh sách bị cắt, file nằm ngoài danh sách bị
            // hiểu là "đã xoá trên đám mây" và bị XOÁ KHỎI MÁY ở lượt đối chiếu (chốt chặn xoá hàng loạt chỉ chặn khi quá nửa).
            const out = [];
            for (let from = 0; ; ) {
                const { data, error } = await sbClient.from('personal_sync_files').select('*').eq('deleted', false)
                    .order('relative_path').order('id').range(from, from + 999);
                if (error) throw error;
                if (!data || !data.length) break;
                out.push(...data);
                from += data.length;
            }
            return out;
        },
        getFile: async (relativePath) => {
            const { data, error } = await sbClient.from('personal_sync_files').select('*').eq('relative_path', relativePath).maybeSingle();
            if (error) throw error;
            return data;
        },
        upsertFile: async (relativePath, contentHash, size) => {
            const { data, error } = await sbClient.from('personal_sync_files')
                .upsert({
                    relative_path: relativePath,
                    content_hash: contentHash,
                    size: size,
                    remote_updated_at: new Date().toISOString(),
                    deleted: false
                }, { onConflict: 'user_id,relative_path' })
                .select().single();
            if (error) throw error;
            return data;
        },
        markDeleted: async (relativePath) => {
            const { error } = await sbClient.from('personal_sync_files')
                .update({ deleted: true, remote_updated_at: new Date().toISOString() })
                .eq('relative_path', relativePath);
            if (error) throw error;
        },
        uploadBytes: async (userId, relativePath, blob) => {
            const path = userId + '/' + personalStorageKey(relativePath);
            const { error } = await sbClient.storage.from('personal_files').upload(path, blob, { upsert: true });
            if (error) throw error;
        },
        downloadBytes: async (userId, relativePath) => {
            const path = userId + '/' + personalStorageKey(relativePath);
            const { data, error } = await sbClient.storage.from('personal_files').download(path);
            if (error) throw error;
            return data; // Blob
        },
        deleteBytes: async (userId, relativePath) => {
            const path = userId + '/' + personalStorageKey(relativePath);
            const { error } = await sbClient.storage.from('personal_files').remove([path]);
            if (error) throw error;
        },
        subscribe: function (handler) {
            if (!sbClient) return null;
            const channel = sbClient.channel('personal-sync-files-changes');
            channel.on('postgres_changes', { event: '*', schema: 'public', table: 'personal_sync_files' }, (payload) => {
                try { handler(payload); } catch (err) { console.error('personalSync realtime handler error:', err); }
            });
            channel.subscribe();
            return channel;
        }
    },
    stock: {
        getStockList: async () => {
            const data = await API.asset._fetchAll(() => sbClient.from('finance_stock_valuations').select('symbol').order('symbol').order('year'));
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
            const { email: _omit, ...record } = payload; // email chỉ để xác định người lưu, không nằm trong hồ sơ
            const { error } = await sbClient.from('finance_stock_valuations').upsert({
                symbol, year, data: { ...record, symbol, year }, updated_by: email || null, updated_at: new Date().toISOString()
            }, { onConflict: 'symbol,year' });
            if (error) throw error;
            return `Lưu định giá "${symbol}" (${year}) thành công!`;
        },

        // Xoá 1 hồ sơ (mã, năm) — dùng để dọn dữ liệu nhập thử. Dữ liệu quý của mã giữ nguyên (còn dùng cho các năm khác).
        deleteValuation: async (symbol, year) => {
            const sym = String(symbol || '').trim().toUpperCase();
            if (!sym || !(Number(year) > 0)) throw new Error("Thiếu mã hoặc năm");
            const { error } = await sbClient.from('finance_stock_valuations').delete().eq('symbol', sym).eq('year', Number(year));
            if (error) throw error;
            return `Đã xoá định giá ${sym} (${year})`;
        },

        // Số liệu tài chính tự động (Edge Function stock-financials, nguồn VNDirect): tối đa 5 mã mỗi lần.
        // Trả { results: { SYM: { form, annual[], quarters[], dividends{} } }, errors: { SYM: lý do }, fetchedAt }. Tiền tính bằng đồng.
        fetchFinancials: async (symbols) => {
            const list = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))];
            if (!list.length) throw new Error("Thiếu mã cổ phiếu");
            const { data, error } = await sbClient.functions.invoke('stock-financials', { body: { symbols: list } });
            if (error) {
                let detail = error.message;
                try { const j = await error.context.json(); if (j && j.error) detail = j.error; } catch (e) { /* giữ message mặc định */ }
                throw new Error(detail);
            }
            if (!data || (!data.ok && !data.errors)) throw new Error((data && data.error) || 'Không lấy được số liệu tài chính');
            return { results: data.results || {}, errors: data.errors || {}, fetchedAt: data.fetchedAt || null };
        },

        // Số liệu đã được máy chủ làm mới hằng ngày (Edge Function refresh-financials -> bảng đệm finance_financials_cache).
        // getFinancialsUpdates: mã nào có số liệu MỚI hơn lần đồng bộ gần nhất của hồ sơ định giá (chỉ xét mã đã từng đồng bộ tự động, vì mã nhập tay
        // người dùng tự quản lý). Trả { updates: [{ symbol, annualYear, quarterKey, changedAt, lastSyncAt }], status: {ranAt,...}|null }.
        getFinancialsUpdates: async () => {
            const [{ data: cache, error }, { data: vals, error: vErr }, st] = await Promise.all([
                sbClient.from('finance_financials_cache').select('symbol, annual_year, quarter_key, changed_at, fetched_at'),
                sbClient.from('finance_stock_valuations').select('symbol, year, data'),
                sbClient.from('app_settings').select('value').eq('key', 'financials_refresh_status').maybeSingle()
            ]);
            if (error) throw error;
            if (vErr) throw vErr;
            const lastSync = {};
            (vals || []).forEach(v => { const t = v.data && v.data.financialsAt; if (t && (!lastSync[v.symbol] || t > lastSync[v.symbol])) lastSync[v.symbol] = t; });
            const updates = (cache || []).filter(c => lastSync[c.symbol] && c.changed_at && Date.parse(c.changed_at) > Date.parse(lastSync[c.symbol]))
                .map(c => ({ symbol: c.symbol, annualYear: c.annual_year, quarterKey: c.quarter_key, changedAt: c.changed_at, lastSyncAt: lastSync[c.symbol] }))
                .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
            let status = null;
            try { status = st && st.data && st.data.value ? JSON.parse(st.data.value) : null; } catch (e) { /* trạng thái hỏng: bỏ qua */ }
            return { updates, status };
        },
        // Lấy số liệu đã đệm của các mã (cùng định dạng fetchFinancials.results) để áp dụng mà không phải gọi nguồn thị trường.
        getFinancialsCache: async (symbols) => {
            const list = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))];
            if (!list.length) return {};
            const { data, error } = await sbClient.from('finance_financials_cache').select('symbol, payload').in('symbol', list);
            if (error) throw error;
            const out = {};
            (data || []).forEach(r => { if (r.payload) out[r.symbol] = r.payload; });
            return out;
        },

        // Lưu hàng loạt hồ sơ định giá (đã dựng bằng ValuationCalc.syncRecords/buildRecord): records = [{ symbol, year, record }].
        saveValuationRecords: async (records, email) => {
            const rows = (records || []).map(r => ({
                symbol: String(r.symbol || r.record.symbol || '').trim().toUpperCase(), year: Number(r.year || r.record.year),
                data: r.record, updated_by: email || null, updated_at: new Date().toISOString()
            })).filter(r => r.symbol && r.year >= 1990);
            if (!rows.length) return "Không có hồ sơ nào để lưu";
            const { error } = await sbClient.from('finance_stock_valuations').upsert(rows, { onConflict: 'symbol,year' });
            if (error) throw error;
            return `Đã lưu ${rows.length} hồ sơ định giá`;
        },
        // Lưu hàng loạt dữ liệu quý: rows = [{ symbol, year, quarter, lnst, revenue }]
        saveQuarters: async (rows, email) => {
            const clean = (rows || []).map(r => ({
                symbol: String(r.symbol || '').trim().toUpperCase(), year: Number(r.year), quarter: Number(r.quarter),
                lnst: Number(r.lnst), revenue: r.revenue === null || r.revenue === undefined || r.revenue === '' ? null : Number(r.revenue),
                updated_by: email || null, updated_at: new Date().toISOString()
            })).filter(r => r.symbol && r.year >= 2000 && r.year <= 2100 && [1, 2, 3, 4].includes(r.quarter) && isFinite(r.lnst) && (r.revenue === null || isFinite(r.revenue)));
            if (!clean.length) return "Không có dữ liệu quý nào để lưu";
            const { error } = await sbClient.from('finance_stock_quarters').upsert(clean, { onConflict: 'symbol,year,quarter' });
            if (error) throw error;
            return `Đã lưu ${clean.length} quý`;
        },

        // Các mã người dùng đang nắm / đang theo dõi (kể cả mã CHƯA có hồ sơ định giá) -> để gợi ý thêm tự động.
        getPortfolioSymbols: async (email) => {
            const userId = await getUserId(email);
            if (!userId) return { held: [], watched: [] };
            let held = [];
            try { held = (await API.asset.computeHoldings(userId)).map(h => h.symbol); } catch (e) { /* bỏ qua */ }
            const { data: wl } = await sbClient.from('finance_watchlist').select('symbol').eq('user_id', userId);
            return { held, watched: (wl || []).map(w => w.symbol) };
        },

        // Mọi hồ sơ định giá (mỗi mã nhiều năm, năm mới trước). Chỉ số/kết luận do lib/valuation-calc.js tính ở trình duyệt.
        getAllValuations: async () => {
            const data = await API.asset._fetchAll(() => sbClient.from('finance_stock_valuations')
                .select('symbol, year, data, updated_at, updated_by').order('symbol').order('year', { ascending: false }));   // bảng tăng dần theo số mã x số năm
            return (data || []).slice().sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0) || (b.year - a.year));
        },

        // Dữ liệu quý (LNST, doanh thu) của 1 mã để tính TTM; cùng đơn vị với báo cáo năm.
        getQuarters: async (symbol) => {
            const { data, error } = await sbClient.from('finance_stock_quarters').select('*')
                .eq('symbol', String(symbol || '').trim().toUpperCase())
                .order('year', { ascending: false }).order('quarter', { ascending: false });
            if (error) throw error;
            return (data || []).slice().sort((a, b) => (b.year - a.year) || (b.quarter - a.quarter));
        },
        saveQuarter: async (payload, email) => {
            const symbol = String(payload.symbol || '').trim().toUpperCase();
            const year = Number(payload.year), quarter = Number(payload.quarter);
            if (!symbol) throw new Error("Thiếu mã cổ phiếu");
            if (!(year >= 2000 && year <= 2100)) throw new Error("Năm không hợp lệ");
            if (![1, 2, 3, 4].includes(quarter)) throw new Error("Quý phải từ 1 đến 4");
            const lnst = Number(payload.lnst);
            if (payload.lnst === '' || payload.lnst === null || payload.lnst === undefined || !isFinite(lnst)) throw new Error("Thiếu lợi nhuận sau thuế của quý");
            const rev = payload.revenue === '' || payload.revenue === null || payload.revenue === undefined ? null : Number(payload.revenue);
            if (rev !== null && !isFinite(rev)) throw new Error("Doanh thu không hợp lệ");
            const { error } = await sbClient.from('finance_stock_quarters').upsert({
                symbol, year, quarter, lnst, revenue: rev, updated_by: email || null, updated_at: new Date().toISOString()
            }, { onConflict: 'symbol,year,quarter' });
            if (error) throw error;
            return `Đã lưu Q${quarter}/${year} của ${symbol}`;
        },
        deleteQuarter: async (symbol, year, quarter) => {
            const { error } = await sbClient.from('finance_stock_quarters').delete()
                .eq('symbol', String(symbol || '').trim().toUpperCase()).eq('year', Number(year)).eq('quarter', Number(quarter));
            if (error) throw error;
            return "Đã xoá quý";
        },

        // Giá hiện tại của nhiều mã: ưu tiên giá trong Bàn Tài Sản của người dùng (cron cập nhật, còn mới), thiếu thì lấy giá đóng cửa
        // gần nhất từ máy chủ (stock-history). Trả { SYMBOL: { price, date, source: 'portfolio' | 'market' } }; mã không lấy được thì vắng mặt.
        getLivePrices: async (symbols, email) => {
            const clean = [...new Set((symbols || []).map(s => String(s || '').trim().toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))];
            const out = {};
            if (!clean.length) return out;
            const userId = email ? await getUserId(email) : null;
            if (userId) {
                const { data } = await sbClient.from('finance_holdings_price')
                    .select('symbol, market_price, locked, price_date, price_source, updated_at').eq('user_id', userId).in('symbol', clean);
                (data || []).forEach(r => {
                    const price = Number(r.market_price) || 0;
                    const meta = API.asset._priceMeta({ price, locked: !!r.locked, priceDate: r.price_date, priceSource: r.price_source, updatedAt: r.updated_at }, price);
                    if (price > 0 && !meta.stale) out[r.symbol] = { price, date: meta.date, source: 'portfolio' };
                });
            }
            const missing = clean.filter(s => !out[s]);
            const to = new Date().toISOString().slice(0, 10);
            const from = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
            for (let i = 0; i < missing.length; i += 20) {
                try {
                    const series = await API.asset.getPriceHistory(missing.slice(i, i + 20), from, to);
                    Object.keys(series || {}).forEach(sym => {
                        const rows = series[sym] || [];
                        if (!rows.length) return;
                        const [date, close] = rows[rows.length - 1];
                        if (Number(close) > 0) out[sym] = { price: Number(close), date, source: 'market' };
                    });
                } catch (e) { /* không lấy được giá thị trường -> bảng dùng giá đã lưu trong hồ sơ */ }
            }
            return out;
        },

        // Bảng so sánh: mỗi mã 1 dòng (năm mới nhất + năm liền trước nếu có để tính tăng trưởng), kèm giá hiện tại,
        // dữ liệu quý, và cờ đang nắm / đang theo dõi của người dùng.
        getOverview: async (email) => {
            const rows = await API.stock.getAllValuations();
            const qrows = await API.asset._fetchAll(() => sbClient.from('finance_stock_quarters').select('symbol, year, quarter, lnst, revenue').order('symbol').order('year').order('quarter'));   // bảng đã gần 1.000 dòng
            const quartersBy = {};
            (qrows || []).forEach(q => { (quartersBy[q.symbol] = quartersBy[q.symbol] || []).push(q); });
            const latest = {};
            rows.forEach(r => { // rows đã xếp theo mã, năm giảm dần
                const cur = latest[r.symbol];
                if (!cur) latest[r.symbol] = { row: r, prev: null };
                else if (!cur.prev && r.year === cur.row.year - 1) cur.prev = r;
            });
            const symbols = Object.keys(latest);
            const userId = email ? await getUserId(email) : null;
            let held = new Set(), watched = new Set();
            if (userId && symbols.length) {
                try { held = new Set((await API.asset.computeHoldings(userId)).map(h => h.symbol)); } catch (e) { /* bỏ nhãn đang nắm */ }
                const { data: wl } = await sbClient.from('finance_watchlist').select('symbol').eq('user_id', userId);
                watched = new Set((wl || []).map(w => w.symbol));
            }
            const live = await API.stock.getLivePrices(symbols, email);
            return symbols.map(symbol => {
                const { row, prev } = latest[symbol];
                const lp = live[symbol];
                return {
                    symbol, year: row.year, data: row.data, prev: prev ? prev.data : null, quarters: quartersBy[symbol] || [],
                    price: lp ? lp.price : 0, priceSource: lp ? lp.source : null, priceDate: lp ? lp.date : null,
                    held: held.has(symbol), watched: watched.has(symbol), updatedAt: row.updated_at, updatedBy: row.updated_by
                };
            });
        },

        // Áp dụng kết quả định giá vào danh mục của NGƯỜI DÙNG: giá mục tiêu -> mã đang nắm (ngưỡng cảnh báo mục tiêu) và/hoặc mục theo dõi;
        // giá muốn mua -> Theo Dõi (thêm mới nếu chưa có). Dùng lại đúng các hàm đã có nên cảnh báo email/desktop chạy như cũ.
        pushToPortfolio: async (email, symbol, levels) => {
            const userId = await getUserId(email);
            if (!userId) throw new Error("User không tồn tại");
            const sym = String(symbol || '').trim().toUpperCase();
            if (!/^[A-Z0-9]{1,12}$/.test(sym)) throw new Error("Mã không hợp lệ");
            const target = Number(levels && levels.targetPrice) || 0;
            const buy = Number(levels && levels.buyBelow) || 0;
            if (!(target > 0) && !(buy > 0)) throw new Error("Chưa có mức giá nào để áp dụng");
            const held = (await API.asset.computeHoldings(userId)).some(h => h.symbol === sym);
            const { data: wl } = await sbClient.from('finance_watchlist').select('id').eq('user_id', userId).eq('symbol', sym).maybeSingle();
            const done = [];
            if (target > 0 && held) {
                await API.asset.setHoldingLevel(email, sym, 'target', target);
                done.push('đặt giá mục tiêu cho mã đang nắm');
            }
            if (wl) {
                const patch = {};
                if (buy > 0) patch.buyBelow = buy;
                if (target > 0) patch.targetPrice = target;
                await API.asset.watchlist.update(email, wl.id, patch);
                done.push('cập nhật mục Theo Dõi');
            } else if (buy > 0 || (target > 0 && !held)) {
                await API.asset.watchlist.add(email, { symbol: sym, buyBelow: buy, targetPrice: target, note: 'Từ Định Giá CP' });
                done.push('thêm vào Theo Dõi');
            }
            return `${sym}: đã ${done.join(' và ')}`;
        }
    },
    // --- Quy trình nghiên cứu và ý tưởng đầu tư (lib/ideas.js): ý tưởng -> nghiên cứu -> chờ phản biện -> duyệt/bác -> vào danh mục -> đóng.
    //     Quy tắc chuyển trạng thái được kiểm ở đây (RLS chỉ giới hạn ai được ghi dòng nào). ---
    ideas: {
        // Giá hiện tại các mã + điểm VN-Index gần nhất, để ghi nhận giá vào/ra và tính kết quả so với chỉ số.
        marks: async (email, symbols) => {
            const list = [...new Set((symbols || []).map(s => String(s).toUpperCase()).filter(s => /^[A-Z0-9]{1,12}$/.test(s)))];
            let prices = {}, index = null;
            if (list.length) { try { prices = await API.stock.getLivePrices(list, email); } catch (e) { /* thiếu giá: để trống */ } }
            try {
                const to = new Date().toISOString().slice(0, 10);
                const from = new Date(Date.now() - 12 * 86400000).toISOString().slice(0, 10);
                const s = (await API.asset.getPriceHistory(['VNINDEX'], from, to)).VNINDEX || [];
                index = s.length ? Number(s[s.length - 1][1]) : null;
            } catch (e) { /* thiếu chỉ số: kết quả tính không có alpha */ }
            return { prices, index };
        },
        list: async () => {
            const { data: ideas, error } = await sbClient.from('finance_ideas').select('*').order('updated_at', { ascending: false });
            if (error) throw error;
            const [votes, comments, users] = await Promise.all([
                API._fetchAllRows(() => sbClient.from('finance_idea_votes').select('idea_id, user_id, vote')),
                API._fetchAllRows(() => sbClient.from('finance_idea_comments').select('id, idea_id, user_id, kind, created_at')),
                sbClient.from('users').select('id, email, nickname').in('group_key', ['finance', 'admin'])
            ]);
            const members = {};
            ((users && users.data) || []).forEach(u => { members[u.id] = u.nickname || String(u.email || '').split('@')[0]; });
            return { ideas: ideas || [], votes, comments, members };
        },
        get: async (id) => {
            const { data: idea, error } = await sbClient.from('finance_ideas').select('*').eq('id', id).maybeSingle();
            if (error) throw error;
            if (!idea) throw new Error("Không tìm thấy ý tưởng");
            const [{ data: comments }, { data: votes }] = await Promise.all([
                sbClient.from('finance_idea_comments').select('*').eq('idea_id', id).order('created_at', { ascending: true }),
                sbClient.from('finance_idea_votes').select('*').eq('idea_id', id)
            ]);
            return { idea, comments: comments || [], votes: votes || [] };
        },
        // Tạo mới hoặc sửa. Người tạo = người đang đăng nhập. Giá ghi nhận mặc định là giá hiện tại và điểm VN-Index lúc tạo (để so kết quả sau này).
        save: async (email, input) => {
            const v = IdeaFlow.validate(input || {});
            if (!v.ok) throw new Error(v.error);
            const actor = await API.asset.limits._actor(email);
            if (!actor.actorId) throw new Error("User không tồn tại");
            const i = v.idea;
            const row = {
                symbol: i.symbol, title: i.title.trim(), direction: i.direction, thesis: i.thesis || null, catalysts: i.catalysts || null, risks: i.risks || null,
                buy_below: i.buyBelow, target_price: i.target, stop_price: i.stop, horizon_months: i.horizonMonths, conviction: i.conviction,
                valuation: i.valuation || null, tags: i.tags, updated_at: new Date().toISOString()
            };
            if (input && input.id) {
                const { data: cur } = await sbClient.from('finance_ideas').select('*').eq('id', input.id).maybeSingle();
                if (!cur) throw new Error("Không tìm thấy ý tưởng");
                if (cur.user_id !== actor.actorId) throw new Error("Chỉ tác giả được sửa ý tưởng");
                if (!['idea', 'research', 'rejected'].includes(cur.status)) throw new Error("Ý tưởng đang chờ phản biện hoặc đã duyệt: hãy đưa về “Đang nghiên cứu” trước khi sửa");
                const { error } = await sbClient.from('finance_ideas').update(row).eq('id', input.id);
                if (error) throw error;
                return "Đã cập nhật ý tưởng!";
            }
            const marks = await API.ideas.marks(email, [i.symbol]);
            const live = marks.prices[i.symbol] ? Number(marks.prices[i.symbol].price) : 0;
            const entry = i.entry > 0 ? i.entry : (live > 0 ? live : null);
            // Kiểm lại mục tiêu/cắt lỗ theo giá ghi nhận vừa lấy được
            if (entry && i.direction === 'long') {
                if (i.target !== null && i.target <= entry) throw new Error("Ý tưởng mua: giá mục tiêu phải cao hơn giá hiện tại (" + Math.round(entry).toLocaleString('en-US') + ")");
                if (i.stop !== null && i.stop >= entry) throw new Error("Ý tưởng mua: ngưỡng cắt lỗ phải thấp hơn giá hiện tại (" + Math.round(entry).toLocaleString('en-US') + ")");
            }
            const { data: created, error } = await sbClient.from('finance_ideas').insert(Object.assign(row, { user_id: actor.actorId, entry_price: entry, index_at_entry: marks.index })).select('id').single();
            if (error) throw error;
            return { message: "Đã ghi nhận ý tưởng!", id: created.id };
        },
        setStatus: async (email, id, to, data) => {
            const { data: cur, error } = await sbClient.from('finance_ideas').select('*').eq('id', id).maybeSingle();
            if (error) throw error;
            if (!cur) throw new Error("Không tìm thấy ý tưởng");
            const actor = await API.asset.limits._actor(email);
            const d = Object.assign({}, data || {});
            if (to === 'closed' && !(Number(d.closePrice) > 0)) {
                const marks = await API.ideas.marks(email, [cur.symbol]);
                const p = marks.prices[cur.symbol] ? Number(marks.prices[cur.symbol].price) : 0;
                if (p > 0) d.closePrice = p;
                if (marks.index > 0) d.indexClose = marks.index;
            }
            const t = IdeaFlow.transition(cur, to, { userId: actor.actorId, isManager: actor.isManager }, d);
            if (!t.ok) throw new Error(t.error);
            const { error: upErr } = await sbClient.from('finance_ideas').update(Object.assign({}, t.patch, { updated_at: new Date().toISOString() })).eq('id', id);
            if (upErr) throw upErr;
            return "Đã chuyển sang “" + IdeaFlow.STATUSES[to].label + "”!";
        },
        addComment: async (email, id, kind, text) => {
            const actor = await API.asset.limits._actor(email);
            const body = String(text || '').trim();
            if (!body) throw new Error("Nhập nội dung");
            if (body.length > 2000) throw new Error("Nội dung tối đa 2.000 ký tự");
            if (!IdeaFlow.COMMENT_KINDS[kind]) throw new Error("Loại bình luận không hợp lệ");
            const { data: idea } = await sbClient.from('finance_ideas').select('user_id, status').eq('id', id).maybeSingle();
            if (!idea) throw new Error("Không tìm thấy ý tưởng");
            if (idea.status === 'closed') throw new Error("Ý tưởng đã đóng");
            if (kind === 'answer' && idea.user_id !== actor.actorId) throw new Error("Chỉ tác giả được trả lời phản biện");
            if (kind === 'challenge' && idea.user_id === actor.actorId) throw new Error("Không tự phản biện ý tưởng của mình — hãy dùng “Bình luận” hoặc “Trả lời”");
            const { error } = await sbClient.from('finance_idea_comments').insert({ idea_id: id, user_id: actor.actorId, kind, text: body });
            if (error) throw error;
            return kind === 'challenge' ? "Đã gửi phản biện!" : "Đã gửi!";
        },
        deleteComment: async (email, commentId) => {
            const actor = await API.asset.limits._actor(email);
            const { data: c } = await sbClient.from('finance_idea_comments').select('user_id').eq('id', commentId).maybeSingle();
            if (!c) return "Đã xoá!";
            if (c.user_id !== actor.actorId && !actor.isManager) throw new Error("Chỉ xoá được bình luận của chính mình");
            const { error } = await sbClient.from('finance_idea_comments').delete().eq('id', commentId);
            if (error) throw error;
            return "Đã xoá!";
        },
        vote: async (email, id, vote, reason) => {
            if (!IdeaFlow.VOTES[vote]) throw new Error("Phiếu không hợp lệ");
            const actor = await API.asset.limits._actor(email);
            const { data: idea } = await sbClient.from('finance_ideas').select('user_id, status').eq('id', id).maybeSingle();
            if (!idea) throw new Error("Không tìm thấy ý tưởng");
            if (idea.user_id === actor.actorId) throw new Error("Tác giả không bỏ phiếu cho ý tưởng của mình");
            if (idea.status !== 'review') throw new Error("Chỉ bỏ phiếu khi ý tưởng đang chờ phản biện");
            if (vote === 'against' && String(reason || '').trim().length < 3) throw new Error("Phản đối phải nêu lý do");
            const { error } = await sbClient.from('finance_idea_votes').upsert({ idea_id: id, user_id: actor.actorId, vote, reason: String(reason || '').trim() || null, updated_at: new Date().toISOString() }, { onConflict: 'idea_id,user_id' });
            if (error) throw error;
            return "Đã ghi phiếu!";
        },
        remove: async (email, id) => {
            const actor = await API.asset.limits._actor(email);
            const { data: cur } = await sbClient.from('finance_ideas').select('user_id, status').eq('id', id).maybeSingle();
            if (!cur) return "Đã xoá!";
            const own = cur.user_id === actor.actorId && ['idea', 'research'].includes(cur.status);
            if (!own && !actor.isManager) throw new Error("Chỉ tác giả được xoá ý tưởng khi còn ở bước Ý tưởng/Đang nghiên cứu; sau đó hãy đóng thay vì xoá");
            const { error } = await sbClient.from('finance_ideas').delete().eq('id', id);
            if (error) throw error;
            return "Đã xoá ý tưởng!";
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
            if (!data) throw new Error('Không tìm thấy mục cần khôi phục (có thể đã bị xoá hẳn hoặc vừa được khôi phục ở nơi khác).');

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
                                await deleteFromStorage(file.bucket, file.path);
                            } else if (file.url) {
                                const urlParts = file.url.split('/general_bucket/');
                                if (urlParts.length > 1) {
                                    const filePath = decodeURIComponent(urlParts[1]);
                                    // deleteFromStorage() thay vì gọi sbClient.storage trực tiếp -- tự định
                                    // tuyến qua MinIO nếu 'general_bucket' được thêm vào NEW_MINIO_BUCKETS
                                    // sau này (2 bản gõ tay giống hệt từng có ở đây, dễ lệch nhau).
                                    await deleteFromStorage('general_bucket', filePath);
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
                                    await deleteFromStorage(file.bucket, file.path);
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
    // Compliance-grade audit trail. Most rows are written server-side by Postgres
    // triggers (fn_audit_row_change) on the mutated tables directly — this module is
    // only the read path plus a narrow client-driven fallback for actions with no
    // single mutated row (nothing currently needs the fallback, kept for completeness).
    audit: {
        log: async (entityType, entityId, action, summary, actorId, actorEmail, groupKey, traceId, result = 'success') => {
            if (!sbClient) return;
            const { error } = await sbClient.from('audit_log').insert({
                actor_id: actorId || null,
                actor_email: actorEmail || null,
                entity_type: entityType,
                entity_id: entityId || null,
                operation: 'UPDATE',
                action,
                source: 'client',
                summary,
                group_key: groupKey || null,
                trace_id: traceId,
                result
            });
            if (error) console.error('Audit log error', error);
        },
        list: async (filters = {}) => {
            if (!sbClient) return [];
            const limit = filters.limit || 50;
            const offset = filters.offset || 0;
            let q = sbClient.from('audit_log').select('*').order('occurred_at', { ascending: false }).range(offset, offset + limit - 1);
            if (filters.actorEmail) q = q.ilike('actor_email', `%${filters.actorEmail}%`);
            if (filters.entityType) q = q.eq('entity_type', filters.entityType);
            if (filters.groupKey) q = q.eq('group_key', filters.groupKey);
            if (filters.from) q = q.gte('occurred_at', filters.from);
            if (filters.to) q = q.lte('occurred_at', filters.to);
            const { data, error } = await q;
            if (error) throw error;
            return data;
        }
    },
    // Phase F: local backup / restore. Local-backup.js writes JSON snapshots to
    // $APPLOCALDATA/backups via the fs plugin directly (no DB round trip). This module
    // is the read-back/restore side — list what's on disk, diff a chosen snapshot
    // against live data before touching anything, then restore via upsert (never
    // delete+reinsert) so an interruption partway leaves already-restored tables intact.
    backup: {
        _RESTORE_EXCLUDE: new Set(['audit_log', 'system_logs']), // append-only history, never a restore target
        _PK: { // upsert onConflict column(s) per table -- most default to 'id'
            app_settings: 'key', finance_stocks: 'symbol', user_status: 'uid',
            lounge_players: 'email', task_assignees: 'task_id,user_email',
            finance_holdings_price: 'user_id,symbol', finance_allocation_targets: 'user_id,symbol', finance_event_dismissals: 'user_id,event_id', finance_idea_votes: 'idea_id,user_id', finance_policy_weights: 'sector'
        },
        listLocal: async () => {
            if (!window.__TAURI__ || !window.__TAURI__.fs) return [];
            const fs = window.__TAURI__.fs;
            const entries = await fs.readDir('backups', { baseDir: fs.BaseDirectory.AppLocalData });
            return entries.filter(e => e.name && e.name.indexOf('backup-') === 0)
                .sort((a, b) => (a.name < b.name ? 1 : -1));
        },
        _readBackup: async (fileName) => {
            const fs = window.__TAURI__.fs;
            const text = await fs.readTextFile('backups/' + fileName, { baseDir: fs.BaseDirectory.AppLocalData });
            return JSON.parse(text);
        },
        previewDiff: async (fileName) => {
            const snapshot = await API.backup._readBackup(fileName);
            const rows = [];
            for (const table of Object.keys(snapshot)) {
                if (API.backup._RESTORE_EXCLUDE.has(table)) continue;
                const entry = snapshot[table];
                const backupCount = Array.isArray(entry) ? entry.length : 0;
                const backupError = !Array.isArray(entry) ? (entry && entry.error) : null;
                let liveCount = null, liveError = null;
                try {
                    const { count, error } = await sbClient.from(table).select('*', { count: 'exact', head: true });
                    if (error) liveError = error.message; else liveCount = count;
                } catch (e) { liveError = String(e); }
                rows.push({ table, backupCount, liveCount, backupError, liveError });
            }
            return rows;
        },
        restore: async (fileName, confirmFileName) => {
            if (fileName !== confirmFileName) throw new Error('Xác nhận tên file không khớp -- huỷ khôi phục.');
            const snapshot = await API.backup._readBackup(fileName);
            const ORDER = ['users', 'org_units', 'projects', 'tasks', 'task_assignees', 'task_comments',
                'project_milestones', 'files', 'events', 'app_settings', 'fin_roles', 'sci_roles',
                'member_roles', 'finance_assets', 'finance_transactions', 'finance_cash_flows',
                'finance_corporate_actions', 'finance_decisions', 'finance_holdings_price', 'finance_benchmark_prices',
                'finance_nav_history', 'finance_notes', 'finance_stock_valuations', 'finance_stock_quarters', 'finance_stocks',
                'finance_watchlist', 'finance_allocation_targets', 'finance_event_dismissals', 'finance_limits', 'finance_limit_exceptions', 'finance_ideas', 'finance_idea_comments', 'finance_idea_votes', 'finance_vb_valuations', 'finance_reconciliations', 'finance_policy_weights', 'finance_approval_policy', 'finance_order_requests', 'finance_approval_audit', 'finance_restricted_symbols', 'personal_items', 'personal_sync_files', 'calendar_connections', 'sci_journals',
                'user_status', 'lounge_players'];
            const tables = Object.keys(snapshot).filter(t => !API.backup._RESTORE_EXCLUDE.has(t));
            tables.sort((a, b) => {
                const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
                return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
            });
            const results = [];
            for (const table of tables) {
                const rowsData = snapshot[table];
                if (!Array.isArray(rowsData)) { results.push({ table, skipped: true, reason: 'backup entry lỗi, bỏ qua' }); continue; }
                if (!rowsData.length) { results.push({ table, upserted: 0 }); continue; }
                const onConflict = API.backup._PK[table] || 'id';
                let upserted = 0, error = null;
                const CHUNK = 500;
                for (let i = 0; i < rowsData.length; i += CHUNK) {
                    const chunk = rowsData.slice(i, i + CHUNK);
                    const { error: err } = await sbClient.from(table).upsert(chunk, { onConflict });
                    if (err) { error = err.message; break; }
                    upserted += chunk.length;
                }
                results.push({ table, upserted, error });
            }
            return results;
        }
    },
    // Light "team status" KPI strip — ported from wh-org's admin-only cross-group BI
    // dashboard (Phase 2), but this app is single-group so it's always called with
    // filters.groupKey = 'finance' fixed, visible to any logged-in user (their own
    // team's own data, nothing cross-group to protect here). No charts, no xlsx/pdf —
    // just the two data functions plus the existing downloadCsv() for export.
    reporting: {
        summary: async (filters = {}) => {
            if (!sbClient) return null;
            let pq = sbClient.from('projects').select('id, group_key, status, archived_at').is('deleted_at', null);
            if (filters.groupKey) pq = pq.eq('group_key', filters.groupKey);
            const { data: projects, error: pErr } = await pq;
            if (pErr) throw pErr;

            const activeProjects = (projects || []).filter(p => !p.archived_at);
            const projectIds = (projects || []).map(p => p.id);
            const projectGroupMap = {};
            (projects || []).forEach(p => { projectGroupMap[p.id] = p.group_key || 'unknown'; });

            let tasks = [];
            if (projectIds.length > 0) {
                const { data, error } = await sbClient.from('tasks')
                    .select('id, project_id, status, due_date, updated_at')
                    .is('deleted_at', null).in('project_id', projectIds);
                if (error) throw error;
                tasks = data || [];
            }

            const { data: users, error: uErr } = await sbClient.from('users').select('email, group_key');
            if (uErr) throw uErr;

            const byGroup = {};
            const ensure = (g) => byGroup[g] || (byGroup[g] = {
                activeProjects: 0, totalTasks: 0, done: 0, working: 0, stuck: 0, notStarted: 0,
                overdue: 0, members: 0
            });

            activeProjects.forEach(p => { ensure(p.group_key || 'unknown').activeProjects++; });

            const today = new Date(); today.setHours(0, 0, 0, 0);
            tasks.forEach(t => {
                const g = projectGroupMap[t.project_id] || 'unknown';
                const b = ensure(g);
                b.totalTasks++;
                const st = String(t.status || '').toLowerCase();
                if (st === 'done') b.done++;
                else if (st === 'working on it') b.working++;
                else if (st === 'stuck') b.stuck++;
                else b.notStarted++;
                if (st !== 'done' && t.due_date) {
                    const due = new Date(String(t.due_date).slice(0, 10) + 'T00:00:00');
                    if (due < today) b.overdue++;
                }
            });
            (users || []).filter(u => !filters.groupKey || u.group_key === filters.groupKey)
                .forEach(u => { ensure(u.group_key || 'unknown').members++; });

            const totals = Object.values(byGroup).reduce((acc, b) => {
                Object.keys(b).forEach(k => { acc[k] = (acc[k] || 0) + b[k]; });
                return acc;
            }, {});

            return { byGroup, totals, generatedAt: new Date().toISOString() };
        },
        projects: async (filters = {}) => {
            if (!sbClient) return [];
            let q = sbClient.from('projects').select('*, users!owner_id(nickname)').is('deleted_at', null)
                .order('updated_at', { ascending: false }).limit(500);
            if (filters.groupKey) q = q.eq('group_key', filters.groupKey);
            const { data: projects, error } = await q;
            if (error) throw error;
            if (!projects || projects.length === 0) return [];

            const ids = projects.map(p => p.id);
            const { data: tasks } = await sbClient.from('tasks').select('project_id, status').is('deleted_at', null).in('project_id', ids);

            return projects.map(p => {
                const pTasks = (tasks || []).filter(t => t.project_id === p.id);
                const stats = { done: 0, working: 0, stuck: 0, notStarted: 0 };
                pTasks.forEach(t => {
                    const st = String(t.status).toLowerCase();
                    if (st === 'done') stats.done++;
                    else if (st === 'working on it') stats.working++;
                    else if (st === 'stuck') stats.stuck++;
                    else stats.notStarted++;
                });
                return {
                    id: p.id, name: p.name, groupKey: p.group_key, status: p.status,
                    owner: p.users ? p.users.nickname : 'Unknown',
                    percent: pTasks.length ? Math.round(stats.done / pTasks.length * 100) : (p.percent || 0),
                    taskStats: stats, isShared: p.is_shared, updatedAt: p.updated_at
                };
            });
        }
    },
    // Phase B RBAC: role-management CRUD on member_roles. Table is shared verbatim
    // across all 3 apps (same DB) -- this module is identical in each app's api.js.
    roles: {
        listAll: async () => {
            if (!sbClient) return [];
            const { data, error } = await sbClient.from('member_roles').select('user_id, group_key, role');
            if (error) { console.error('roles.listAll lỗi', error); return []; }
            return data || [];
        },
        update: async (userId, groupKey, role) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('member_roles')
                .upsert({ user_id: userId, group_key: groupKey, role }, { onConflict: 'user_id,group_key' });
            if (error) throw error;
            return `Đã cập nhật vai trò thành "${role}"`;
        }
    },
    orgUnits: {
        // Flat list -- client builds the tree (small N, a handful of units total).
        listAll: async () => {
            if (!sbClient) return [];
            const { data, error } = await sbClient.from('org_units')
                .select('id, name, group_key, parent_id, lead_user_id, created_at')
                .order('group_key', { ascending: true }).order('name', { ascending: true });
            if (error) throw error;
            return data || [];
        },
        create: async (name, groupKey, parentId, leadUserId) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('org_units').insert({
                name: String(name || '').trim(),
                group_key: groupKey,
                parent_id: parentId || null,
                lead_user_id: leadUserId || null
            });
            if (error) throw error;
            return `Đã tạo tổ "${name}"`;
        },
        update: async (id, fields) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const updates = {};
            if (fields.name !== undefined) updates.name = String(fields.name).trim();
            if (fields.parentId !== undefined) updates.parent_id = fields.parentId || null;
            if (fields.leadUserId !== undefined) updates.lead_user_id = fields.leadUserId || null;
            const { error } = await sbClient.from('org_units').update(updates).eq('id', id);
            if (error) throw error;
            return 'Đã cập nhật tổ';
        },
        remove: async (id) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('org_units').delete().eq('id', id);
            if (error) throw error;
            return 'Đã xóa tổ';
        },
        assignUser: async (userId, orgUnitId) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('users').update({ org_unit_id: orgUnitId || null }).eq('id', userId);
            if (error) throw error;
            return 'Đã gán người dùng vào tổ';
        }
    },
    calendarConnection: {
        get: async () => {
            if (!sbClient) return null;
            const { data, error } = await sbClient.from('calendar_connections')
                .select('*').eq('provider', 'google').maybeSingle();
            if (error) { console.error('calendarConnection.get lỗi', error); return null; }
            return data || null;
        },
        save: async (tokens) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { data: userRes } = await sbClient.auth.getUser();
            const uid = userRes && userRes.user ? userRes.user.id : undefined;
            const row = {
                user_id: uid,
                provider: 'google',
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token || null,
                expires_at: tokens.expires_at || null,
                scope: tokens.scope || null
            };
            // Chỉ ghi email khi người gọi thật sự truyền (lúc kết nối); lần làm mới token không truyền nên giữ nguyên email cũ
            if (Object.prototype.hasOwnProperty.call(tokens, 'google_account_email')) row.google_account_email = tokens.google_account_email || null;
            const { error } = await sbClient.from('calendar_connections')
                .upsert(row, { onConflict: 'user_id,provider' });
            if (error) throw error;
            return 'Đã lưu kết nối Google Calendar';
        },
        disconnect: async () => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const { error } = await sbClient.from('calendar_connections').delete().eq('provider', 'google');
            if (error) throw error;
            return 'Đã ngắt kết nối Google Calendar';
        },
        touchSync: async () => {
            if (!sbClient) return;
            const { error } = await sbClient.from('calendar_connections')
                .update({ last_synced_at: new Date().toISOString() }).eq('provider', 'google');
            if (error) throw error;
        },
        // Đa lịch (đợt 4): danh sách calendarId Google mà người dùng chọn kéo về thêm, ngoài
        // 'primary' (luôn bật mặc định, UI "Quản lý lịch" ở calendar-connect.js không cho bỏ).
        setSyncedCalendars: async (calendarIds) => {
            if (!sbClient) throw new Error("Chưa setup Supabase");
            const ids = (Array.isArray(calendarIds) && calendarIds.length) ? calendarIds : ['primary'];
            const { error } = await sbClient.from('calendar_connections')
                .update({ synced_calendar_ids: ids }).eq('provider', 'google');
            if (error) throw error;
            return 'Đã lưu lựa chọn lịch đồng bộ.';
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
            const EMPTY = { projects: [], tasks: [], files: [], events: [], comments: [], milestones: [], personal: [] };
            if (!sbClient) return EMPTY;
            const q = String(query || '').trim();
            if (q.length < 2) return EMPTY;

            const safe = q.replace(/[%_,()]/g, ' ').trim();
            if (!safe) return EMPTY;
            const pattern = `%${safe}%`;

            const PERSONAL_TYPE_LABEL = { note: 'Ghi chú', pin: 'Đã ghim', checklist: 'Việc riêng', shortcut: 'Lối tắt', calendar_event: 'Lịch riêng' };
            const [{ data: personalTextRows }, { data: personalTagRows }] = await Promise.all([
                sbClient.from('personal_items').select('id, type, title, data, tags').eq('archived', false)
                    .or(`title.ilike.${pattern},data->>text.ilike.${pattern}`).limit(8),
                sbClient.from('personal_items').select('id, type, title, data, tags').eq('archived', false)
                    .contains('tags', [safe]).limit(8)
            ]);
            const personalRowsById = {};
            [...(personalTextRows || []), ...(personalTagRows || [])].forEach(p => { personalRowsById[p.id] = p; });
            const personal = Object.values(personalRowsById).slice(0, 8).map(p => ({
                id: p.id,
                title: p.title || '(không tiêu đề)',
                subtitle: PERSONAL_TYPE_LABEL[p.type] || p.type,
                personalType: p.type,
                type: 'personal'
            }));

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

            return { projects, tasks, files, events, comments, milestones, personal };
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
    'provisionUser', 'updateUserGroup', 'removeUser', 'setUserActive', 'updateNickname',
    'addAssetTransaction', 'deleteAssetTransaction', 'setMarketPrice', 'setHoldingLevel', 'setAlertPrefs', 'setCashDebt', 'saveStockValuation',
    'saveStockQuarter', 'deleteStockQuarter', 'deleteStockValuation', 'pushStockToPortfolio', 'saveStockValuationBatch', 'saveStockQuarterBatch', 'saveDecision', 'saveDecisionReview', 'deleteDecision',
    'grantFinRole', 'revokeFinRole', 'updateMemberRole',
    'applyCorporateEvents', 'dismissCorporateEvent', 'restoreCorporateEvent', 'saveIdea', 'setIdeaStatus', 'addIdeaComment', 'deleteIdeaComment', 'voteIdea', 'removeIdea', 'saveLimit', 'removeLimit', 'setLimitActive', 'addRestricted', 'setRestrictedActive', 'resolveDataHealth', 'addCashFlow', 'deleteCashFlow', 'addCorporateAction', 'deleteCorporateAction', 'upsertBenchmarkPrice',
    'savePolicy', 'saveReconciliation', 'saveApprovalPolicy', 'setSelfApprovers', 'reviewApprovalAudit', 'createOrderRequest', 'decideOrderRequest', 'cancelOrderRequest', 'importAssetTransactions', 'undoAssetImportBatch', 'addWatchlistItem', 'updateWatchlistItem', 'removeWatchlistItem', 'saveAllocationTargets',
    'savePersonalItem', 'deletePersonalItem', 'setPersonalItemFlags',
    'saveCalendarConnection', 'disconnectCalendarConnection', 'touchCalendarSync', 'setSyncedCalendars',
    'upsertGoogleEvents', 'pruneGoogleEvents',
    'linkGoogleEventId', 'applyGooglePullUpdate', 'deleteGoogleSyncRow', 'markGoogleSyncedBatch',
    'createOrgUnit', 'updateOrgUnit', 'deleteOrgUnit', 'assignUserOrgUnit',
    'restoreFromBackup'
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
            case 'setUserActive': result = await API.user.setActive(params.email, params.active); break;

            case 'getRecentFilesForDashboard': result = await API.file.getRecentFilesForDashboard(params.groupKey); break;
            case 'getFileList': result = await API.file.list(params.groupKey, params); break;
            case 'deleteFile': result = await API.file.delete(params.fileId, params.groupKey); break;
            case 'permanentDeleteFile': result = await API.file.permanentDelete(params.fileId, params.groupKey); break;
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
            case 'updateProject': result = await API.project.updateNote(params.projectId, { status: params.status, description: params.description, expectedVersion: params.expectedVersion, orgUnitId: params.orgUnitId }, params.groupKey); break;
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
            case 'getTeamNavHistory': result = await API.asset.getTeamNavHistory(); break;
            case 'getMemberList': result = await API.asset.getMemberList(); break;
            case 'getMemberDetail': result = await API.asset.getMemberDetail(params.email); break;
            case 'listAssetTransactions': result = await API.asset.listTransactions(params.email); break;
            case 'previewAssetImport': result = await API.asset.previewImport(params.email, params.rows); break;
            case 'importAssetTransactions': result = await API.asset.importTransactions(params.email, params.rows, params.opts); break;
            case 'undoAssetImportBatch': result = await API.asset.undoImportBatch(params.email, params.batchId); break;
            case 'getRealizedReport': result = await API.asset.getRealizedReport(params.email, params.year); break;
            case 'getAssetPriceHistory': result = await API.asset.getPriceHistory(params.symbols, params.from, params.to); break;
            case 'getWatchlist': result = await API.asset.watchlist.list(params.email); break;
            case 'addWatchlistItem': result = await API.asset.watchlist.add(params.email, params.item); break;
            case 'updateWatchlistItem': result = await API.asset.watchlist.update(params.email, params.id, params.patch); break;
            case 'removeWatchlistItem': result = await API.asset.watchlist.remove(params.email, params.id); break;
            case 'getAllocationTargets': result = await API.asset.allocation.list(params.email); break;
            case 'saveAllocationTargets': result = await API.asset.allocation.save(params.email, params.targets); break;
            case 'getMonthlyReportInputs': result = await API.asset.getMonthlyReportInputs(params.email, params.month); break;
            case 'addAssetTransaction': result = await API.asset.addTransaction(params.email, params.txn); break;
            case 'deleteAssetTransaction': result = await API.asset.deleteTransaction(params.email, params.id); break;
            case 'getHoldingsView': result = await API.asset.getHoldingsView(params.email); break;
            case 'setMarketPrice': result = await API.asset.setMarketPrice(params.email, params.symbol, params.price); break;
            case 'togglePriceLock': result = await API.asset.togglePriceLock(params.email, params.symbol, params.locked); break;
            case 'setHoldingLevel': result = await API.asset.setHoldingLevel(params.email, params.symbol, params.kind, params.value); break;
            case 'getAlertPrefs': result = await API.asset.getAlertPrefs(params.email); break;
            case 'setAlertPrefs': result = await API.asset.setAlertPrefs(params.email, params.enabled); break;
            case 'sendTestAlertEmail': result = await API.asset.sendTestAlertEmail(); break;
            case 'getSymbolPerformance': result = await API.asset.getSymbolPerformance(params.email); break;
            case 'getPriceFetchStatus': result = await API.asset.getPriceFetchStatus(); break;
            case 'getCashDebt': result = await API.asset.getCashDebt(params.email); break;
            case 'setCashDebt': result = await API.asset.setCashDebt(params.email, params.cash, params.debt); break;
            case 'getPerfInputs': result = await API.asset.getPerfInputs(params.email, params.benchKey); break;
            case 'getMirrorInputs': result = await API.asset.getMirrorInputs(params.email); break;
            case 'getAttributionInputs': result = await API.asset.getAttributionInputs(params.email, params.from); break;
            case 'getBenchSeries': result = await API.asset.getBenchSeries(params.benchKey, params.from); break;
            case 'getGroupData': result = await API.asset.getGroupData(); break;
            case 'getMarketInputs': result = await API.asset.getMarketInputs(params.symbols, params.windowDays); break;
            case 'getCalendarInputs': result = await API.asset.getCalendarInputs(params.email); break;
            case 'getVolumeHistory': result = await API.asset.getVolumeHistory(params.symbols, params.days); break;
            case 'getRiskInputs': result = await API.asset.getRiskInputs(params.email, params.windowDays); break;
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
            case 'getFinancialsUpdates': result = await API.stock.getFinancialsUpdates(); break;
            case 'getFinancialsCache': result = await API.stock.getFinancialsCache(params.symbols); break;
            case 'getStockHistory': result = await API.stock.getStockHistory(params.symbol); break;
            case 'saveStockValuation': result = await API.stock.saveStockValuation(params, params.email); break;
            case 'deleteStockValuation': result = await API.stock.deleteValuation(params.symbol, params.year); break;
            case 'fetchStockFinancials': result = await API.stock.fetchFinancials(params.symbols); break;
            case 'saveStockValuationBatch': result = await API.stock.saveValuationRecords(params.records, params.email); break;
            case 'saveStockQuarterBatch': result = await API.stock.saveQuarters(params.rows, params.email); break;
            case 'getStockPortfolioSymbols': result = await API.stock.getPortfolioSymbols(params.email); break;
            case 'listLimits': result = await API.asset.limits.list(); break;
            case 'saveLimit': result = await API.asset.limits.save(params.email, params.limit); break;
            case 'listRestricted': result = await API.asset.restricted.list(); break;
            case 'getVbData': result = await API.asset.vb.data(params.symbol, { years: params.years, candleYears: params.candleYears, lite: params.lite }); break;
            case 'saveVbValuation': result = await API.asset.vb.save(params.email, params.record); break;
            case 'getVbById': result = await API.asset.vb.get(params.id); break;
            case 'getVbLatest': result = await API.asset.vb.latest(params.symbol); break;
            case 'getVbPeerRows': result = await API.asset.vb.peerRows(params.symbols); break;
            case 'getVbLatestMany': result = await API.asset.vb.latestMany(params.symbols); break;
            case 'getVbHistory': result = await API.asset.vb.history(params.symbol, params.limit); break;
            case 'listVbLatest': result = await API.asset.vb.listLatest(params.limit); break;
            case 'deleteVbValuation': result = await API.asset.vb.remove(params.email, params.id); break;
            case 'getMarketRates': result = await API.asset.market.rates(params.days); break;
            case 'getDailyAverages': result = await API.asset.getDailyAverages(params.symbols, params.from, params.to); break;
            case 'getStockRatios': result = await API.asset.market.ratios(params.symbols); break;
            case 'getValuationHistory': result = await API.asset.market.valuationHistory(params.years); break;
            case 'getMarketUniverse': result = await API.asset.market.marketUniverse(params.force); break;
            case 'getPeerStats': result = await API.asset.market.peerStats(params.symbols); break;
            case 'getPeerValuation': result = await API.asset.market.peers(params.symbol); break;
            case 'getMarketReference': result = await API.asset.market.reference(params.symbol); break;
            case 'getSettlement': result = await API.asset.market.settlement(params.email); break;
            case 'listDataHealth': result = await API.asset.market.healthList(params.days); break;
            case 'resolveDataHealth': result = await API.asset.market.healthResolve(params.email, params.id, params.note); break;
            case 'listFunctionRuns': result = await API.asset.market.runs(params.days); break;
            case 'listSourceProbes': result = await API.asset.market.sourceProbes(params.days); break;
            case 'ensureMarketMeta': result = await API.asset.market.ensureMeta(params.force); break;
            case 'addRestricted': result = await API.asset.restricted.add(params.email, params.restricted); break;
            case 'setRestrictedActive': result = await API.asset.restricted.setActive(params.email, params.id, params.active); break;
            case 'removeLimit': result = await API.asset.limits.remove(params.id); break;
            case 'setLimitActive': result = await API.asset.limits.setActive(params.id, params.active); break;
            case 'checkTradeLimits': result = await API.asset.limits.checkTrade(params.email, params.trade); break;
            case 'listPolicy': result = await API.asset.policy.list(); break;
            case 'getApprovalPolicy': result = await API.asset.approvalPolicy.get(); break;
            case 'setSelfApprovers': result = await API.asset.approvalPolicy.setSelfApprovers(params.email, params.ids); break;
            case 'listApprovalAudit': result = await API.asset.approvalAudit.list(params.days); break;
            case 'reviewApprovalAudit': result = await API.asset.approvalAudit.review(params.email, params.id, params.note); break;
            case 'saveApprovalPolicy': result = await API.asset.approvalPolicy.save(params.email, params.policy); break;
            case 'checkTradeApproval': result = await API.asset.orders.checkTrade(params.email, params.trade); break;
            case 'createOrderRequest': result = await API.asset.orders.create(params.email, params.request); break;
            case 'listOrderRequests': result = await API.asset.orders.list(params.email, params.limit); break;
            case 'listAllOrderRequests': result = await API.asset.orders.listAll(params.days); break;
            case 'decideOrderRequest': result = await API.asset.orders.decide(params.email, params.id, params.decision, params.note); break;
            case 'cancelOrderRequest': result = await API.asset.orders.cancel(params.id); break;
            case 'savePolicy': result = await API.asset.policy.save(params.email, params.weights); break;
            case 'getPriceHistories': result = await API.asset.getPriceHistories(params.symbols, params.from); break;
            case 'getSectorIndices': result = await API.asset.getSectorIndices(params.from); break;
            case 'getReconcileInputs': result = await API.asset.reconcile.getInputs(params.email); break;
            case 'saveReconciliation': result = await API.asset.reconcile.save(params.email, params.record); break;
            case 'listReconciliations': result = await API.asset.reconcile.list(params.email, params.limit); break;
            case 'listAllReconciliations': result = await API.asset.reconcile.listAll(params.days); break;
            case 'listComplianceLog': result = await API.asset.limits.complianceLog(params.days); break;
            case 'listLimitExceptions': result = await API.asset.limits.exceptions(params.days); break;
            case 'getLimitActor': result = await API.asset.limits._actor(params.email); break;
            case 'listIdeas': result = await API.ideas.list(); break;
            case 'getIdea': result = await API.ideas.get(params.id); break;
            case 'saveIdea': result = await API.ideas.save(params.email, params.idea); break;
            case 'setIdeaStatus': result = await API.ideas.setStatus(params.email, params.id, params.to, params.data); break;
            case 'addIdeaComment': result = await API.ideas.addComment(params.email, params.id, params.kind, params.text); break;
            case 'deleteIdeaComment': result = await API.ideas.deleteComment(params.email, params.commentId); break;
            case 'voteIdea': result = await API.ideas.vote(params.email, params.id, params.vote, params.reason); break;
            case 'removeIdea': result = await API.ideas.remove(params.email, params.id); break;
            case 'getIdeaMarks': result = await API.ideas.marks(params.email, params.symbols); break;
            case 'loadCorporateEvents': result = await API.asset.events.load(params.email); break;
            case 'applyCorporateEvents': result = await API.asset.events.apply(params.email, params.events, params.ids, params.opts); break;
            case 'dismissCorporateEvent': result = await API.asset.events.dismiss(params.email, params.event); break;
            case 'restoreCorporateEvent': result = await API.asset.events.restore(params.email, params.eventId); break;
            case 'listDecisions': result = await API.asset.journal.list(params.email); break;
            case 'saveDecision': result = await API.asset.journal.save(params.email, params.decision); break;
            case 'saveDecisionReview': result = await API.asset.journal.saveReview(params.email, params.id, params.review); break;
            case 'deleteDecision': result = await API.asset.journal.remove(params.email, params.id); break;
            case 'getUnplannedTrades': result = await API.asset.journal.unplannedTrades(params.email, params.days); break;
            case 'getStockOverview': result = await API.stock.getOverview(params.email); break;
            case 'getStockQuarters': result = await API.stock.getQuarters(params.symbol); break;
            case 'saveStockQuarter': result = await API.stock.saveQuarter(params, params.email); break;
            case 'deleteStockQuarter': result = await API.stock.deleteQuarter(params.symbol, params.year, params.quarter); break;
            case 'getStockLivePrices': result = await API.stock.getLivePrices(params.symbols, params.email); break;
            case 'pushStockToPortfolio': result = await API.stock.pushToPortfolio(params.email, params.symbol, { targetPrice: params.targetPrice, buyBelow: params.buyBelow }); break;

            case 'getMyFinRoles': result = await API.finRoles.getMyRoles(params.email); break;
            case 'listFinRoles': result = await API.finRoles.listAll(); break;
            case 'grantFinRole': result = await API.finRoles.grantRole(params.targetEmail, params.role, params.byEmail); break;
            case 'revokeFinRole': result = await API.finRoles.revokeRole(params.targetEmail, params.role); break;

            case 'getDeletedItems': result = await API.system.getDeletedItems(params.tableName, params.groupKey); break;
            case 'restoreItem': result = await API.system.restoreItem(params.tableName, params.id); break;
            case 'hardDeleteItem': result = await API.system.hardDeleteItem(params.tableName, params.id); break;

            case 'getAuditLog': result = await API.audit.list(params); break;

            case 'getLocalBackups': result = await API.backup.listLocal(); break;
            case 'previewRestoreDiff': result = await API.backup.previewDiff(params.fileName); break;
            case 'restoreFromBackup': {
                result = await API.backup.restore(params.fileName, params.confirmFileName);
                const failed = result.filter(r => r.error);
                const traceId2 = "TRC_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
                await API.audit.log('backup', params.fileName, 'restoreFromBackup',
                    `Khôi phục từ ${params.fileName}: ${result.length - failed.length}/${result.length} bảng thành công`,
                    null, params.email, params.groupKey, traceId2, failed.length ? 'error' : 'success');
                break;
            }

            case 'getReportSummary': result = await API.reporting.summary(params); break;
            case 'getReportProjects': result = await API.reporting.projects(params); break;

            case 'getMyRole': result = await API.auth.getMyRole(params.groupKey); break;
            case 'listMemberRoles': result = await API.roles.listAll(); break;
            case 'updateMemberRole': result = await API.roles.update(params.userId, params.groupKey, params.role); break;

            case 'listOrgUnits': result = await API.orgUnits.listAll(); break;
            case 'createOrgUnit': result = await API.orgUnits.create(params.name, params.groupKey, params.parentId, params.leadUserId); break;
            case 'updateOrgUnit': result = await API.orgUnits.update(params.id, params); break;
            case 'deleteOrgUnit': result = await API.orgUnits.remove(params.id); break;
            case 'assignUserOrgUnit': result = await API.orgUnits.assignUser(params.userId, params.orgUnitId); break;

            case 'getCalendarConnection': result = await API.calendarConnection.get(); break;
            case 'saveCalendarConnection': result = await API.calendarConnection.save(params); break;
            case 'disconnectCalendarConnection': result = await API.calendarConnection.disconnect(); break;
            case 'touchCalendarSync': result = await API.calendarConnection.touchSync(); break;
            case 'setSyncedCalendars': result = await API.calendarConnection.setSyncedCalendars(params.calendarIds); break;
            case 'upsertGoogleEvents': result = await API.calendar.upsertGoogleEvents(params.rows); break;
            case 'pruneGoogleEvents': result = await API.calendar.pruneGoogleEvents(params.email, params.groupKey, params.calendarId, params.activeGoogleIds, params.windowStart, params.windowEnd); break;
            case 'getPersonalEventsForPush': result = await API.calendar.getPersonalEventsForPush(params.email, params.groupKey, params.windowStart, params.windowEnd); break;
            case 'getGoogleSyncState': result = await API.calendar.getGoogleSyncState(params.googleEventIds); break;
            case 'getEventsVersionsByGoogleId': result = await API.calendar.getEventsVersionsByGoogleId(params.googleEventIds); break;
            case 'linkGoogleEventId': result = await API.calendar.linkGoogleEventId(params.eventId, params.googleEventId, params.googleCalendarId); break;
            case 'applyGooglePullUpdate': result = await API.calendar.applyGooglePullUpdate(params.eventId, params.fields); break;
            case 'deleteGoogleSyncRow': result = await API.calendar.deleteGoogleSyncRow(params.eventId); break;
            case 'markGoogleSyncedBatch': result = await API.calendar.markGoogleSyncedBatch(params.entries); break;
            case 'getRecurringMasterGoogleIds': result = await API.calendar.getRecurringMasterGoogleIds(params.googleEventIds); break;

            case 'getNotifications': result = await API.notification.get(params.groupKey, params.limit, params.email); break;
            case 'syncLounge': result = await API.lounge.sync(params); break;

            case 'getPersonalItems': result = await API.personal.list(params.type); break;
            case 'savePersonalItem': result = await API.personal.upsert(params); break;
            case 'deletePersonalItem': result = await API.personal.remove(params.id); break;
            case 'getArchivedPersonalItems': result = await API.personal.listArchived(); break;
            case 'setPersonalItemFlags': result = await API.personal.setFlags(params.id, params); break;

            default:
                console.warn(`Supabase chưa hỗ trợ action: ${action}`);
                return { status: 'success', data: [], message: `Chưa cấu hình hành động ${action}` };
        }
        let finalMessage = typeof result === 'string' ? result : 'OK';
        const entityId = params.taskId || params.id || params.eventId || params.projectId || null;

        if (MUTATING_ACTIONS.has(action)) window.lastLocalMutationAt = Date.now();

        if ((action === 'createEvent' || action === 'updateEvent' || action === 'deleteEvent') && typeof window.scheduleGoogleCalendarPush === 'function') {
            window.scheduleGoogleCalendarPush();
        }

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
    if (window.__TAURI__) {
        // Bản desktop (Tauri) KHÔNG dùng Service Worker: nó phát lại trang đã lưu nên app dễ hiện giao diện cũ
        // hoặc "không có bản lưu ngoại tuyến" sau mỗi lần cập nhật. Gỡ mọi đăng ký + cache còn sót.
        navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister())).catch(() => {});
        if (window.caches) caches.keys().then(ks => ks.forEach(k => caches.delete(k))).catch(() => {});
    } else {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js')
                .then(reg => console.log('Đã kích hoạt thành công. Phạm vi:', reg.scope))
                .catch(err => console.error('Lỗi kích hoạt:', err));
        });
    }
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
