// Chạy NGUYÊN FILE calendar-connect.js (file dùng chung 3 app) với fetch/callGAS giả. Múi giờ cố định America/Edmonton
// (UTC-6/-7): đúng múi giờ gây lỗi lệch giờ/lệch ngày ở bản cũ, mà test chạy ở UTC thì không bao giờ thấy.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'America/Edmonton';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, '../../calendar-connect.js'), 'utf8');

function makeEnv() {
  const log = { fetches: [], gas: [], toasts: [] };
  const timers = [];
  let fetchHandler = () => ({ status: 200, body: {} });
  let gasHandler = () => null;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    Intl, URL, URLSearchParams, TextEncoder, TextDecoder, Date, Promise, JSON, Math, Uint8Array, atob: globalThis.atob,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    setInterval: () => 0,
    document: { readyState: 'loading', getElementById: () => null },
    escapeHtml: (x) => String(x),
    showToast: (msg, type) => log.toasts.push({ msg, type }),
    fetch: async (url, opts = {}) => {
      log.fetches.push({ url: String(url), method: opts.method || 'GET', body: opts.body ? (() => { try { return JSON.parse(opts.body); } catch (e) { return String(opts.body); } })() : null });   // token gửi dạng form, không phải JSON
      const r = await fetchHandler(String(url), opts);
      return {
        ok: r.status >= 200 && r.status < 300, status: r.status,
        json: async () => r.body,
      };
    },
    callGAS: async (action, params) => {
      log.gas.push({ action, params });
      const data = await gasHandler(action, params);
      return { status: 'success', data, message: 'OK' };
    },
    sbClient: { auth: { getUser: async () => ({ data: { user: { email: 'toi@example.com' } } }) } },
    API: {
      calendarConnection: { get: async () => sandbox.__connection },
      auth: { getUserGroup: async () => 'finance' },
    },
    __connection: {
      access_token: 'tok', refresh_token: 'ref', expires_at: new Date(Date.now() + 3600e3).toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar.events openid email', synced_calendar_ids: ['primary'],
    },
  };
  sandbox.window = sandbox;
  sandbox.window.addEventListener = () => {};
  sandbox.window.OAuthLoopback = { isTauri: () => true };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  return {
    sb: sandbox, log, timers,
    onFetch: (fn) => { fetchHandler = fn; },
    onGas: (fn) => { gasHandler = fn; },
  };
}

// Cách cột timestamptz của Postgres (múi giờ DB = UTC) đọc 1 chuỗi giờ: có offset/'Z' thì đúng mốc đó, KHÔNG có thì
// coi là UTC. (JS thì ngược lại: chuỗi trần là giờ địa phương -- chính chỗ lệch này gây lỗi lệch ngày.)
function asDb(str) {
  return new Date(/(Z|[+-]\d\d:?\d\d)$/i.test(str) ? str : str + 'Z');
}

describe('múi giờ của môi trường test', () => {
  it('đang chạy ở múi giờ khác UTC (nếu không, các test dưới đây vô nghĩa)', () => {
    expect(new Date(2026, 9, 5).getTimezoneOffset()).not.toBe(0);
  });
});

describe('sự kiện cả ngày: không lệch ngày ở múi giờ phía tây UTC', () => {
  it('kéo từ Google về: ngày 5/10 vẫn là ngày 5/10 theo giờ máy (bản cũ lùi sang 4/10)', () => {
    const { sb } = makeEnv();
    const row = sb.mapGoogleEventToRow(
      { id: 'g1', summary: 'Nghỉ lễ', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } },
      'toi@example.com', 'finance', 'primary');
    const start = asDb(row.start_time);
    const end = asDb(row.end_time);
    expect([start.getFullYear(), start.getMonth() + 1, start.getDate(), start.getHours(), start.getMinutes()]).toEqual([2026, 10, 5, 0, 0]);
    expect([end.getFullYear(), end.getMonth() + 1, end.getDate(), end.getHours(), end.getMinutes(), end.getSeconds()]).toEqual([2026, 10, 5, 23, 59, 59]);
  });

  it('sự kiện cả ngày nhiều ngày: ngày kết thúc loại trừ của Google được lùi 1 ngày', () => {
    const { sb } = makeEnv();
    const row = sb.mapGoogleEventToRow(
      { id: 'g2', start: { date: '2026-10-05' }, end: { date: '2026-10-08' } }, 'a@b.c', 'finance', 'primary');
    expect(asDb(row.end_time).getDate()).toBe(7);
  });

  it('vòng tròn: kéo về rồi đẩy lên cho ra đúng ngày cũ, vẫn là sự kiện cả ngày', () => {
    const { sb } = makeEnv();
    const row = sb.mapGoogleEventToRow(
      { id: 'g1', start: { date: '2026-10-05' }, end: { date: '2026-10-06' } }, 'a@b.c', 'finance', 'primary');
    const body = sb.mapRowToGoogleEventBody({ ...row, start_time: asDb(row.start_time).toISOString(), end_time: asDb(row.end_time).toISOString() });
    expect(body.start).toEqual({ date: '2026-10-05' });
    expect(body.end).toEqual({ date: '2026-10-06' });
  });
});

describe('sự kiện có giờ khi đẩy lên Google', () => {
  it('gửi mốc tuyệt đối kèm timeZone của máy', () => {
    const { sb } = makeEnv();
    const body = sb.mapRowToGoogleEventBody({
      title: 'Họp', start_time: '2026-10-05T15:00:00.000Z', end_time: '2026-10-05T16:00:00.000Z', recurrence: 'none',
    });
    expect(body.start).toEqual({ dateTime: '2026-10-05T15:00:00.000Z', timeZone: 'America/Edmonton' });
    expect(body.end.timeZone).toBe('America/Edmonton');
    expect(body.recurrence).toBeUndefined();
  });

  it('sự kiện lặp có RRULE và timeZone (Google từ chối sự kiện lặp thiếu timeZone)', () => {
    const { sb } = makeEnv();
    const body = sb.mapRowToGoogleEventBody({
      title: 'Họp tuần', start_time: '2026-10-05T15:00:00.000Z', end_time: '2026-10-05T16:00:00.000Z',
      recurrence: 'weekly', recurrence_end: '2026-12-31',
    });
    // Hết ngày 31/12 theo giờ Edmonton (UTC-7) = 06:59:59 UTC ngày 1/1. Cộng cứng 23:59:59Z sẽ cắt mất lần lặp cuối trong ngày kết thúc.
    expect(body.recurrence).toEqual(['RRULE:FREQ=WEEKLY;UNTIL=20270101T065959Z']);
    expect(body.start.timeZone).toBe('America/Edmonton');
  });

  it('sự kiện lặp CẢ NGÀY dùng UNTIL dạng ngày (Google từ chối UNTIL có giờ)', () => {
    const { sb } = makeEnv();
    const body = sb.mapRowToGoogleEventBody({
      title: 'Nghỉ định kỳ', start_time: new Date(2026, 9, 5, 0, 0, 0).toISOString(), end_time: new Date(2026, 9, 5, 23, 59, 59).toISOString(),
      recurrence: 'monthly', recurrence_end: '2026-12-31',
    });
    expect(body.start).toEqual({ date: '2026-10-05' });
    expect(body.recurrence).toEqual(['RRULE:FREQ=MONTHLY;UNTIL=20261231']);
  });
});

describe('googleIdForWorkhubEvent', () => {
  it('chỉ gồm 0-9 a-v (base32hex), dài 5..1024, ổn định theo cùng 1 ID', () => {
    const { sb } = makeEnv();
    for (const id of ['EV_1785241729702', '7f9c2b1e-1111-4a3b-9c0d-aaaaaaaaaaaa', 'Sự kiện']) {
      const gid = sb.googleIdForWorkhubEvent(id);
      expect(gid).toMatch(/^[0-9a-v]{5,1024}$/);
      expect(sb.googleIdForWorkhubEvent(id)).toBe(gid);
    }
    expect(sb.googleIdForWorkhubEvent('A')).not.toBe(sb.googleIdForWorkhubEvent('B'));
  });
});

describe('pushPendingLocalEvents', () => {
  const newEvent = (id, title = 'Họp') => ({
    id, title, start_time: '2026-10-05T15:00:00+00:00', end_time: '2026-10-05T16:00:00+00:00',
    description: null, location: null, recurrence: 'none', google_event_id: null, version: 1, deleted_at: null,
  });

  it('sự kiện mới: tạo trên Google với ID ổn định rồi ghi liên kết về WorkHub', async () => {
    const env = makeEnv();
    env.onGas((action) => (action === 'getPersonalEventsForPush' ? [newEvent('EV_1')] : action === 'linkGoogleEventId' ? 2 : null));
    env.onFetch(() => ({ status: 200, body: { id: 'will-be-replaced', updated: '2026-10-02T10:00:00Z' } }));
    const out = await env.sb.pushPendingLocalEvents('tok', 'toi@example.com', 'finance', 'a', 'b');
    expect(out.pushed).toBe(1);
    expect(out.failed).toEqual([]);
    const post = env.log.fetches.find(f => f.method === 'POST');
    expect(post.body.id).toMatch(/^vh[0-9a-f]+$/);
    expect(post.body.summary).toBe('Họp');
    expect(env.log.gas.find(g => g.action === 'linkGoogleEventId').params.eventId).toBe('EV_1');
    expect(env.log.gas.find(g => g.action === 'markGoogleSyncedBatch').params.entries).toHaveLength(1);
  });

  it('LỖI CŨ: rớt mạng sau khi tạo => lần đẩy sau gặp 409 và CẬP NHẬT bản đã có, không tạo trùng', async () => {
    const env = makeEnv();
    env.onGas((action) => (action === 'getPersonalEventsForPush' ? [newEvent('EV_1')] : action === 'linkGoogleEventId' ? 2 : null));
    env.onFetch((url, opts) => {
      if (opts.method === 'POST') return { status: 409, body: { error: { message: 'The requested identifier already exists.' } } };
      if (opts.method === 'PATCH') return { status: 200, body: { id: JSON.parse(opts.body).id || 'x', updated: '2026-10-02T10:00:00Z' } };
      return { status: 200, body: {} };
    });
    const out = await env.sb.pushPendingLocalEvents('tok', 'toi@example.com', 'finance', 'a', 'b');
    expect(out.pushed).toBe(1);
    expect(out.failed).toEqual([]);
    const patch = env.log.fetches.find(f => f.method === 'PATCH');
    expect(patch).toBeTruthy();
    expect(patch.body.status).toBe('confirmed');
    expect(env.log.fetches.filter(f => f.method === 'POST')).toHaveLength(1);
    // ID trong URL của PATCH chính là ID ổn định đã gửi lúc tạo
    expect(patch.url).toContain(env.sb.googleIdForWorkhubEvent('EV_1'));
  });

  it('LỖI CŨ: 1 sự kiện lỗi được BÁO RA (không chỉ console.warn) và không chặn các sự kiện khác', async () => {
    const env = makeEnv();
    env.onGas((action) => (action === 'getPersonalEventsForPush' ? [newEvent('EV_BAD', 'Hỏng'), newEvent('EV_OK', 'Tốt')] : action === 'linkGoogleEventId' ? 2 : null));
    env.onFetch((url, opts) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      if (body.summary === 'Hỏng') return { status: 400, body: { error: { message: 'Missing time zone definition for start time.' } } };
      return { status: 200, body: { id: body.id, updated: '2026-10-02T10:00:00Z' } };
    });
    const out = await env.sb.pushPendingLocalEvents('tok', 'toi@example.com', 'finance', 'a', 'b');
    expect(out.pushed).toBe(1);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]).toMatchObject({ title: 'Hỏng', message: 'Missing time zone definition for start time.' });
  });

  it('sự kiện đã xoá và đã liên kết: xoá bên Google và dọn bảng theo dõi', async () => {
    const env = makeEnv();
    env.onGas((action) => (action === 'getPersonalEventsForPush'
      ? [{ ...newEvent('EV_DEL'), google_event_id: 'gid1', google_calendar_id: 'primary', deleted_at: '2026-10-02T00:00:00Z' }] : null));
    env.onFetch(() => ({ status: 204, body: {} }));
    const out = await env.sb.pushPendingLocalEvents('tok', 'toi@example.com', 'finance', 'a', 'b');
    expect(out.pushed).toBe(1);
    expect(env.log.fetches.some(f => f.method === 'DELETE' && f.url.endsWith('/events/gid1'))).toBe(true);
    expect(env.log.gas.some(g => g.action === 'deleteGoogleSyncRow')).toBe(true);
  });
});

describe('khoá chống chạy chồng + đẩy có gộp', () => {
  function syncEnv() {
    const env = makeEnv();
    env.onGas((action) => {
      if (action === 'getPersonalEventsForPush') return [];
      if (action === 'getGoogleSyncState' || action === 'getEventsVersionsByGoogleId') return {};
      return null;
    });
    env.onFetch(() => ({ status: 200, body: { items: [] } }));
    return env;
  }

  it('2 lệnh đồng bộ cùng lúc chỉ chạy 1 lượt (chạy chồng = tạo trùng sự kiện trên Google)', async () => {
    const env = syncEnv();
    const [a, b] = await Promise.all([env.sb.syncGoogleCalendarEvents(), env.sb.syncGoogleCalendarEvents()]);
    expect(a).toBe(b);
    expect(env.log.gas.filter(g => g.action === 'touchCalendarSync')).toHaveLength(1);
  });

  it('xong lượt này thì lượt sau chạy lại được', async () => {
    const env = syncEnv();
    await env.sb.syncGoogleCalendarEvents();
    await env.sb.syncGoogleCalendarEvents();
    expect(env.log.gas.filter(g => g.action === 'touchCalendarSync')).toHaveLength(2);
  });

  it('scheduleGoogleCalendarPush gộp nhiều thao tác sát nhau thành 1 lượt', async () => {
    const env = syncEnv();
    env.sb.scheduleGoogleCalendarPush();
    env.sb.scheduleGoogleCalendarPush();
    env.sb.scheduleGoogleCalendarPush();
    const live = env.timers.filter(t => !t.cancelled && t.ms === 4000);
    expect(live).toHaveLength(1);
    await live[0].fn();
    await new Promise(r => setImmediate(r));
    expect(env.log.gas.filter(g => g.action === 'touchCalendarSync')).toHaveLength(1);
  });

  it('chưa kết nối Google: đẩy nền im lặng, không gọi mạng, không báo lỗi', async () => {
    const env = syncEnv();
    env.sb.__connection = null;
    const r = await env.sb.syncGoogleCalendarQuiet('push');
    expect(r).toBeNull();
    expect(env.log.fetches).toHaveLength(0);
    expect(env.log.toasts).toHaveLength(0);
  });

  it('báo cho người dùng khi đẩy lỗi, kèm lý do', async () => {
    const env = makeEnv();
    env.onGas((action) => (action === 'getPersonalEventsForPush'
      ? [{ id: 'EV_1', title: 'Họp', start_time: '2026-10-05T15:00:00+00:00', end_time: '2026-10-05T16:00:00+00:00', recurrence: 'none', google_event_id: null, version: 1 }]
      : (action === 'getGoogleSyncState' || action === 'getEventsVersionsByGoogleId') ? {} : null));
    env.onFetch((url, opts) => (opts.method === 'POST' ? { status: 403, body: { error: { message: 'Insufficient Permission' } } } : { status: 200, body: { items: [] } }));
    await env.sb.syncGoogleCalendarQuiet('push');
    expect(env.log.toasts.some(t => t.type === 'warning' && /Insufficient Permission/.test(t.msg))).toBe(true);
  });
});

describe('LỖI MẤT DỮ LIỆU CŨ: tải lịch lỗi không được dọn sự kiện của lịch đó', () => {
  function env2(calendars, fetchFor) {
    const env = makeEnv();
    env.sb.__connection = Object.assign({}, env.sb.__connection, { synced_calendar_ids: calendars });
    env.onGas((action) => {
      if (action === 'getPersonalEventsForPush') return [];
      if (action === 'getGoogleSyncState' || action === 'getEventsVersionsByGoogleId') return {};
      return null;
    });
    env.onFetch(fetchFor);
    return env;
  }
  const ev = (id) => ({ id, status: 'confirmed', summary: 'S ' + id, updated: '2026-10-05T00:00:00Z', start: { dateTime: '2026-10-06T09:00:00+07:00' }, end: { dateTime: '2026-10-06T10:00:00+07:00' } });

  it('lịch phụ lỗi 503: lịch chính vẫn dọn bình thường, lịch lỗi KHÔNG bị dọn, kết quả và thông báo nêu rõ', async () => {
    const env = env2(['primary', 'work@group'], (url) => (url.includes('work%40group') ? { status: 503, body: { error: { message: 'Backend Error' } } } : { status: 200, body: { items: [ev('a1')] } }));
    const r = await env.sb.syncGoogleCalendarEvents();
    const prunes = env.log.gas.filter(g => g.action === 'pruneGoogleEvents').map(g => g.params.calendarId);
    expect(prunes).toEqual(['primary']);
    expect(r.failedCalendars).toEqual([{ calendarId: 'work@group', message: 'Backend Error', status: 503 }]);
    expect(env.log.gas.some(g => g.action === 'touchCalendarSync')).toBe(true);
    expect(env.sb.calendarStatusLineHtml()).toContain('1 lịch chưa tải được');
  });
  it('lỗi ở trang 2 của một lịch cũng không dọn lịch đó (trang 1 không phải toàn bộ sự kiện)', async () => {
    const env = env2(['primary'], (url) => (url.includes('pageToken=p2') ? { status: 500, body: { error: { message: 'Internal' } } } : { status: 200, body: { items: [ev('b1')], nextPageToken: 'p2' } }));
    const r = await env.sb.syncGoogleCalendarEvents();
    expect(env.log.gas.filter(g => g.action === 'pruneGoogleEvents')).toHaveLength(0);
    expect(r.failedCalendars).toHaveLength(1);
  });
  it('MỌI lịch đều lỗi (vd bị thu hồi quyền): báo lỗi, không dọn, không ghi "đã đồng bộ"', async () => {
    const env = env2(['primary'], () => ({ status: 401, body: { error: { message: 'Invalid Credentials' } } }));
    await expect(env.sb.syncGoogleCalendarEvents()).rejects.toThrow(/Kết nối lại.*Invalid Credentials|Invalid Credentials/);
    expect(env.log.gas.filter(g => g.action === 'pruneGoogleEvents' || g.action === 'touchCalendarSync')).toHaveLength(0);
    expect(env.sb.calendarStatusLineHtml()).toMatch(/Kết nối lại/);
  });
  it('sự kiện xuất hiện lại bên Google được ghi kèm deleted_at = null để hiện lại', () => {
    const row = env2(['primary'], () => ({ status: 200, body: { items: [] } })).sb.mapGoogleEventToRow(ev('z9'), 'toi@example.com', 'finance', 'primary');
    expect(row).toMatchObject({ id: 'GCAL_z9', google_event_id: 'z9', deleted_at: null });
  });
});

describe('kết nối Google: tham số state (RFC 8252)', () => {
  function connectEnv(redirect) {
    const env = makeEnv();
    env.sb.crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (i * 37 + 11) & 255; return a; } };
    let authUrl = null;
    env.sb.window.OAuthLoopback = {
      isTauri: () => true, OAUTH_CALLBACK_URL: 'http://127.0.0.1:43781/callback',
      createPkcePair: async () => ({ codeVerifier: 'v', codeChallenge: 'c', method: 'S256' }),
      awaitRedirect: async (u) => { authUrl = new URL(u); return redirect(authUrl.searchParams.get('state')); },
      parseQueryString: (qs) => Object.fromEntries(new URLSearchParams(qs)),
    };
    env.onFetch(() => ({ status: 200, body: { access_token: 'a', expires_in: 3600, scope: 'x' } }));
    env.onGas(() => null);
    return { env, url: () => authUrl };
  }
  it('gửi state ngẫu nhiên và từ chối phản hồi mang state khác (không đổi mã lấy token)', async () => {
    const { env, url } = connectEnv(() => 'code=ma-la&state=khac');
    await env.sb.connectGoogleCalendar();
    expect(url().searchParams.get('state')).toMatch(/^[0-9a-f]{48}$/);
    expect(env.log.fetches.some((f) => f.url.includes('oauth2.googleapis.com/token'))).toBe(false);
    expect(env.log.toasts.some((t) => t.type === 'error' && /không khớp/.test(t.msg))).toBe(true);
  });
  it('state khớp thì đổi mã lấy token như bình thường', async () => {
    const { env } = connectEnv((st) => 'code=ma-dung&state=' + st);
    await env.sb.connectGoogleCalendar();
    expect(env.log.fetches.some((f) => f.url.includes('oauth2.googleapis.com/token'))).toBe(true);
  });
});
