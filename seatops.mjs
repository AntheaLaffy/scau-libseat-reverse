// 站点功能的高层操作层：MCP 工具与 scripts/ 下的脚本共用同一份实现。
//
// 这一层的职责是「把接口表翻译成用户能懂的操作」：找房间、挑座位、算时间窗、
// 拼预约报文、归一化返回。凡是能从 bundle 里抄到确切字段的地方都照抄，不做发挥。
import { api, normalizeWindow } from './api.mjs';
import { config } from './config.mjs';
import { SessionExpired, withSession } from './http.mjs';
import { ensureLogin, forgetSession, login, sessionStatus } from './session.mjs';

export { SessionExpired, sessionStatus, login, forgetSession, ensureLogin };

/** 401 时重登一次再试（所有联网操作都走这里） */
export async function authed(fn) {
  await ensureLogin();
  return withSession(fn, async () => {
    forgetSession();
    await login();
  });
}

function unwrap(res, what) {
  if (res?.isOk !== true) throw new Error(`${what}失败：${res?.message || res?.msg || '未知错误'}`);
  return res.data;
}

// ---------------------------------------------------------------- 房间

export const roomBrief = (r) => ({
  id: r.id,
  name: r.name,
  code: r.code,
  building: r.buildingname,
  floor: r.floorname,
  district: r.districtname,
  districtId: r.districtid,
  open: r.isopen === 1,
  openRange: `${(r.open_start_time ?? '').slice(0, 5)}-${(r.open_end_time ?? '').slice(0, 5)}`,
  seats: r.seatscount,
  freeSeats: r.availableseatcount,
  usingSeats: r.usingseatcount,
  spaceOnly: r.isonlyspace === 1,
  capacity: r.isonlyspace === 1 ? `${r.peoplemin}-${r.peoplemax} 人` : null,
  cover: r.coverimgurl,
});

/** 房间列表（公开接口），支持按名字/楼层/建筑关键字过滤 */
export async function listRooms({ query, building, floor, onlyOpen = false, spaceOnly = false } = {}) {
  const data = unwrap(await api.rooms({}), '获取房间列表');
  let rooms = (data.rooms ?? []).map(roomBrief);
  if (query) rooms = rooms.filter((r) => `${r.name}${r.building}${r.floor}${r.district}`.includes(query));
  if (building) rooms = rooms.filter((r) => (r.building ?? '').includes(building));
  if (floor) rooms = rooms.filter((r) => (r.floor ?? '').includes(floor));
  if (onlyOpen) rooms = rooms.filter((r) => r.open);
  if (spaceOnly) rooms = rooms.filter((r) => r.spaceOnly);
  return rooms;
}

/** 定位唯一房间：roomId 精确匹配，否则 room 关键字唯一匹配 */
export async function findRoom({ roomId, room } = {}) {
  const rooms = await listRooms({});
  if (roomId) {
    const hit = rooms.find((r) => String(r.id) === String(roomId) || r.code === roomId);
    if (!hit) throw new Error(`房间不存在: ${roomId}`);
    return hit;
  }
  if (!room) throw new Error('需要 roomId 或 room（房间名关键字）');
  const hits = rooms.filter((r) => `${r.name}${r.floor}${r.building}`.includes(room));
  if (hits.length === 0) throw new Error(`没有匹配「${room}」的房间`);
  if (hits.length > 1) {
    throw new Error(`「${room}」匹配到多个房间，请用 roomId：${hits.map((r) => `${r.name}=${r.id}`).join('，')}`);
  }
  return hits[0];
}

// ---------------------------------------------------------------- 座位

const seatBrief = (s) => ({ seatId: s.seatid, name: s.seatname, count: s.count, free: s.count === '0' });

/**
 * 座位占用。
 * - realtime: 现在→1 分钟后（和公共查询页一致），走公开接口，不需要登录
 * - 指定时间窗：登录后走 /web/user/seatState（公开接口同样可用，但登录态更贴近真实下单）
 */
export async function seatStates(args) {
  const { realtime = false, onlyFree = true, roomId, room } = args;
  const target = await findRoom({ roomId, room });
  let start;
  let end;
  if (realtime) {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    start = fmt(now);
    end = fmt(new Date(now.getTime() + 60_000));
  } else {
    const win = normalizeWindow(args);
    start = win.seatStateStart;
    end = win.seatStateEnd;
  }
  const data = realtime
    ? unwrap(await api.seatStatePublic({ roomId: target.id, startTime: start, endTime: end }), '查询座位')
    : unwrap(await authed(() => api.seatState({ roomId: target.id, startTime: start, endTime: end })), '查询座位');
  const all = (data ?? []).map(seatBrief);
  const free = all.filter((s) => s.free);
  return {
    room: target,
    window: { start, end, realtime },
    total: all.length,
    free: free.length,
    seats: onlyFree ? free : all,
  };
}

/** 房间座位表（含规则与可预约日期）：/web/roomDetails */
export async function roomDetail({ roomId, room, date, startTime, endTime, pageNum = 1, pageSize = 200, onlyFree = false }) {
  const target = await findRoom({ roomId, room });
  const win = normalizeWindow({ date, startTime, endTime });
  const data = unwrap(
    await authed(() => api.roomDetails({ roomId: target.id, startTime: win.roomDetailStart, endTime: win.roomDetailEnd, pageNum, pageSize })),
    '获取房间详情',
  );
  const list = data?.seats?.list ?? [];
  const seats = list.map((row) => ({
    seatId: row.seat?.id,
    name: row.seat?.seatname,
    type: row.seat?.seattypename,
    people: row.seat?.peoplemax,
    free: row.count === '0' || row.count === 0 ? true : row.count === undefined ? undefined : false,
    count: row.count,
    raw: row,
  }));
  return {
    room: target,
    window: { start: win.roomDetailStart, end: win.roomDetailEnd },
    rule: data?.rule ?? null,
    dueDates: data?.canDueDateList ?? [],
    total: data?.seats?.total ?? list.length,
    seats: onlyFree ? seats.filter((s) => s.free) : seats,
    page: { pageNum: data?.seats?.pageNum ?? pageNum, totalPage: data?.seats?.totalPage ?? 1 },
  };
}

/** 按名字/序号挑一个空闲座位，返回座位表里的 seatid */
export async function pickSeat({ roomId, room, date, startTime, endTime, seatName, firstFree = false }) {
  const res = await seatStates({ roomId, room, date, startTime, endTime, onlyFree: false });
  const free = res.seats.filter((s) => s.free);
  if (!free.length) throw new Error(`${res.room.name} 该时段没有空闲座位`);
  if (seatName) {
    const key = seatName.trim().toUpperCase();
    const exact = res.seats.filter((s) => (s.name ?? '').toUpperCase() === key);
    if (exact.length === 1) return { room: res.room, seat: exact[0], window: res.window };
    const loose = free.filter((s) => (s.name ?? '').toUpperCase().includes(key));
    if (loose.length === 1) return { room: res.room, seat: loose[0], window: res.window };
    if (loose.length > 1) throw new Error(`座位名 ${seatName} 匹配到 ${loose.length} 个空闲座位，请写全名`);
    if (exact.length === 0) throw new Error(`该房间没有座位 ${seatName}`);
    throw new Error(`座位 ${seatName} 在该时段已被占用`);
  }
  if (!firstFree) throw new Error('需要 seatId、seatName，或显式 firstFree=true 让它自己挑第一个空位');
  return { room: res.room, seat: free[0], window: res.window, alternatives: free.slice(1, 6) };
}

// ---------------------------------------------------------------- 预约

/**
 * 状态文案照抄前端 index-*.js 的格式化函数（duestatu / dueendstatu / signin 三者一起决定）：
 *   0 待审核；1 未签到|已完成（看 signin）；2 使用中；3 暂离；
 *   4 已结束（dueendstatu 1/2=已取消，3=审核不通过，其余=已结束）；
 *   5 违约（dueendstatu 100 未到场 / 101 早退 / 102 签到人数不足）。
 */
function statusText(o) {
  const s = Number(o?.duestatu);
  const e = Number(o?.dueendstatu);
  const n = Number(o?.signin);
  switch (s) {
    case 0:
      return '待审核';
    case 1:
      return n === 0 ? '未签到' : '已完成';
    case 2:
      return '使用中';
    case 3:
      return '暂离';
    case 4:
      return e === 1 || e === 2 ? '已取消' : e === 3 ? '审核不通过' : '已结束';
    case 5:
      return e === 100 ? '未到场' : e === 101 ? '早退' : e === 102 ? '签到人数不足' : '违约';
    default:
      return '已结束';
  }
}

export function briefOrder(o) {
  return {
    id: o.id,
    kind: o.duetype === 2 ? '空间' : '座位',
    room: o.room,
    roomId: o.roomid,
    floor: o.floorname,
    seat: o.seatname,
    seatId: o.seatid,
    date: o.duedate,
    start: o.duestartime,
    end: o.dueendtime,
    status: o.duestatu,
    statusText: statusText(o),
    endStatus: o.dueendstatu,
    signedIn: o.signin === 1,
    canCancelAt: o.iscancancel,
    channel: o.duechannel,
    isMain: o.is_main === 1 || undefined,
    openGroup: o.is_open_group,
    memberCount: (o.memberList ?? []).length || undefined,
  };
}

/** 提交预约。dryRun 只回报文不真的下单。 */
export async function reserve({ roomId, room, seatId, seatName, firstFree = false, date, startTime, endTime, reason = '', memberIds = [], attachmentUrl, attachmentName, applyForm, dryRun = false }) {
  const win = normalizeWindow({ date, startTime, endTime });
  if (win.minutes > 300) throw new Error(`单次预约最长 5 小时，当前 ${win.minutes} 分钟（${win.startTime}-${win.endTime}）`);
  if (win.minutes <= 0) throw new Error('结束时间必须晚于开始时间');

  let resolved = null;
  let target = null;
  if (!seatId) {
    if (!seatName && !firstFree) throw new Error('需要 seatId、seatName，或 firstFree=true');
    resolved = await pickSeat({ roomId, room, date, startTime, endTime, seatName, firstFree });
    seatId = resolved.seat.seatId;
    target = resolved.room;
  } else if (roomId || room) {
    // 只给了 seatId 时不强制查房间（座位 id 本身就能下单）
    target = await findRoom({ roomId, room });
  }

  const payload = {
    seatesid: seatId,
    duestartime: win.dueStart,
    dueendtime: win.dueEnd,
    reason: reason ?? '',
    memberids: memberIds ?? [],
  };
  if (attachmentUrl) {
    payload.attachmentUrl = attachmentUrl;
    payload.attachmentName = attachmentName ?? '';
  }
  // 空间（研讨间）要带申请单
  if (applyForm) payload.applyForm = typeof applyForm === 'string' ? applyForm : JSON.stringify(applyForm);

  if (dryRun) return { dryRun: true, room: target, seat: resolved?.seat ?? null, request: payload, window: win };

  const res = await authed(() => api.reserve(payload));
  return { ok: res?.isOk === true, room: target, seat: resolved?.seat ?? null, window: win, request: payload, message: res?.message ?? '', data: res?.data ?? null };
}

export async function myReservations({ duetype, duestatus, date, startDate, endDate, pageNum = 1, pageSize = 20, brief = true } = {}) {
  const body = { pageNum, pageSize };
  if (duetype) body.duetype = duetype;
  if (duestatus) body.duestatus = Array.isArray(duestatus) ? duestatus : [duestatus];
  if (date) {
    body.startDate = `${date} 00:00:00`;
    body.endDate = `${date} 23:59:59`;
  }
  if (startDate) body.startDate = startDate;
  if (endDate) body.endDate = endDate;
  const data = unwrap(await authed(() => api.reserveList(body)), '获取预约列表');
  const list = data?.list ?? [];
  return { total: Number(data?.total ?? list.length), pageNum: data?.pageNum ?? pageNum, pageSize: data?.pageSize ?? pageSize, orders: brief ? list.map(briefOrder) : list, raw: brief ? undefined : data };
}

export async function reservationDetail({ id, brief = true }) {
  const data = unwrap(await authed(() => api.reserveDetail({ id })), '获取预约详情');
  if (!brief) return data;
  // duedetail 的返回体跟 duelist 的行结构不同：这里给的是订单视图字段
  // （座位名、是否主预约人、进出馆记录、违约记录、同行成员…），所以单独归一化。
  return {
    id,
    seat: data?.mapSeatName ?? null,
    isMain: data?.isMain ?? null,
    isOrderMember: data?.isOrderMember ?? null,
    inLibrary: data?.inLibrary ?? null,
    needMemberAgree: data?.needMemberAgree ?? null,
    memberAgreeTimeout: data?.memberAgreeTimeout ?? null,
    isAudit: data?.isAudit ?? null,
    peoplemax: data?.peoplemax ?? null,
    hasMapAttachment: data?.hasMapAttachment ?? null,
    members: data?.memberList ?? [],
    applyForm: data?.applyForm ?? null,
    passRecords: data?.passRecords ?? [],
    illegaRecords: data?.illegaRecords ?? [],
    swipeRecords: data?.swipeRecords ?? [],
    raw: data,
  };
}

export async function todayReservations() {
  const data = unwrap(await authed(() => api.todayList({})), '获取今日预约');
  const list = Array.isArray(data) ? data : data?.list ?? [];
  return { count: list.length, orders: list.map(briefOrder), raw: list };
}

export async function cancel({ id }) {
  const res = await authed(() => api.cancel(id));
  return { id, ok: res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
}

/**
 * 签到 —— **注意：这条接口（/web/user/checkin/sign）是网页 SPA / 签到机那条路，被服务端设备授权锁死**，
 * 普通客户端（包括本工具）一律收到「本机未授权，请到馆内签到机操作」。
 * 手机扫码签到走的是另一条接口 /web/user/in，本项目只记录结论、不接入（见 docs/成果.md 第 5 节）。
 * 所以这个函数的现实用途是「查自己签没签上」和「对齐站点行为」，不是替你签到。
 */
export async function checkin({ id }) {
  const res = await authed(() => api.checkin(id));
  const raw = res?.message ?? '';
  const blocked = raw.includes('本机未授权') || raw.includes('非检索机');
  // 被拒时把「你到底签没签上」查出来 —— 否则这个函数就只剩一句报错了
  let state = null;
  if (blocked) {
    const mine = await authed(() => api.reserveList({ pageNum: 1, pageSize: 50 })).catch(() => null);
    const row = (mine?.data?.list ?? []).find((o) => String(o.id) === String(id));
    if (row) state = { signedIn: row.signin === 1, statusText: statusText(row), entryTime: row.entrytime, seat: row.seatname, start: row.duestartime };
  }
  return {
    id,
    ok: res?.isOk === true,
    signedIn: res?.data?.signin === 1 || state?.signedIn === true,
    message: raw,
    state,
    // 别让调用方以为「再试一次就能签上」
    hint: blocked
      ? '这条是网页端/签到机的接口，服务端按设备授权放行，本机（普通客户端）签不了 —— 请用手机扫码或馆内签到机完成签到；本工具只能用来查签到状态'
      : undefined,
    data: res?.data ?? null,
  };
}

export async function signout({ id }) {
  const res = await authed(() => api.signout(id));
  return { id, ok: res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
}

export async function tempout({ orderid, istempout = true }) {
  const res = await authed(() => api.tempout({ orderid, istempout }));
  return { orderid, istempout, ok: res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
}

/**
 * 续座。注意 `continuetime` 是**整数分钟**（要续多久），不是时间点 ——
 * 前端从订单 rule 的 ruleReservation.keep_max_time 生成 30/60/90… 的选项，
 * 服务端把它当 Integer 反序列化（传时间字符串会 500 JSON parse error）。
 */
export async function continueOrder({ orderid, minutes = 30 }) {
  const m = Number(minutes);
  if (!Number.isInteger(m) || m <= 0) throw new Error('minutes 必须是正整数（单位：分钟）');
  const res = await authed(() => api.continueOrder({ orderid, continuetime: m }));
  return { orderid, minutes: m, ok: res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
}

export async function orderLog({ orderId }) {
  const data = unwrap(await authed(() => api.orderStateLog({ orderId })), '获取状态流水');
  const list = Array.isArray(data) ? data : data?.list ?? [];
  return { orderId, count: list.length, logs: list };
}

// ---------------------------------------------------------------- 智能规划

export async function smartPlan({ date, hours, startTime, fullDay = false, sameSeat = true, preferMealBreak = false, preferredRoomIds = null, metaOnly = false }) {
  if (!date) throw new Error('smartPlan 需要 date');
  if (!Number.isFinite(Number(hours))) throw new Error('smartPlan 需要 hours');
  // 站点要求 startTime 与 fullDay 至少给一个，否则 500「must not be null」
  if (!startTime && !fullDay) throw new Error('smartPlan 需要 startTime（HH:mm），或 fullDay=true 表示整天');
  const body = { date, hours, sameSeat, preferMealBreak, preferredRoomIds, metaOnly };
  if (fullDay) body.fullDay = true;
  if (startTime) body.startTime = startTime;
  const data = unwrap(await authed(() => api.smartPlan(body)), '智能规划');
  const plans = (data?.plans ?? []).map((p) => ({
    segments: p.segments ?? [],
    totalHours: p.totalHours,
    seatChanges: p.seatChanges,
    hasGap: p.hasGap,
    sameSeat: p.sameSeat,
  }));
  return { date, hours, startTime: startTime ?? null, fullDay, plans, meta: { maxDate: data?.maxDate, signStart: data?.signStart, openTime: data?.openTime, closeTime: data?.closeTime, maxAvailableHours: data?.maxAvailableHours, reason: data?.reason }, raw: metaOnly ? undefined : data };
}

export async function smartDue({ segments }) {
  if (!Array.isArray(segments) || segments.length === 0) throw new Error('segments 不能为空，形如 [{seatId, duestartime, dueendtime}]');
  const res = await authed(() => api.smartDue({ segments }));
  return { ok: res?.isOk === true, count: segments.length, message: res?.message ?? '', data: res?.data ?? null };
}

// ---------------------------------------------------------------- 组队 / 成员

export async function group({ action, orderId, isOpenGroup, isagree }) {
  switch (action) {
    case 'open':
    case 'close': {
      const res = await authed(() => api.openGroup({ orderId, isOpenGroup: action === 'open' ? 1 : 0 }));
      return { action, orderId, ok: res?.code === 200 || res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
    }
    case 'agree':
    case 'refuse': {
      const res = await authed(() => api.agree({ orderId, isagree: action === 'agree' ? 1 : 0 }));
      return { action, orderId, ok: res?.code === 200 || res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
    }
    case 'join': {
      const res = await authed(() => api.joinGroup({ orderId }));
      return { action, orderId, ok: res?.code === 200 || res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
    }
    case 'invitations': {
      const data = unwrap(await authed(() => api.inviteMyList({})), '获取邀请');
      return { invitations: data?.list ?? [] };
    }
    default:
      throw new Error(`未知 action: ${action}（open/close/agree/refuse/join/invitations）`);
  }
}

export async function members({ action, id, userName, memberIds, pageNum = 1, pageSize = 10 }) {
  switch (action) {
    case 'list': {
      const data = unwrap(await authed(() => api.membersList({ id })), '获取成员');
      return { orderId: id, members: data ?? [] };
    }
    case 'find': {
      if (!userName) throw new Error('find 需要 userName');
      const data = unwrap(await authed(() => api.findOtherUser({ userName, pageNum, pageSize })), '搜索用户');
      return { users: data?.list ?? [], total: Number(data?.total ?? 0) };
    }
    case 'add': {
      const res = await authed(() => api.addMembers({ id, memberIds }));
      return { action, orderId: id, ok: res?.isOk === true, message: res?.message ?? '' };
    }
    case 'remove': {
      const res = await authed(() => api.deleteMembers({ id, memberIds }));
      return { action, orderId: id, ok: res?.isOk === true, message: res?.message ?? '' };
    }
    default:
      throw new Error(`未知 action: ${action}（list/find/add/remove）`);
  }
}

// ---------------------------------------------------------------- 公告 / FAQ / 假期 / 违约 / 资产

export async function announcements({ pageNum = 1, pageSize = 10, withContent = false } = {}) {
  const data = unwrap(await api.announcement({ pageNum, pageSize }), '获取公告');
  const list = (data?.list ?? []).map((a) => ({
    id: a.id,
    title: a.title,
    publisher: a.publisher_name,
    sendTime: a.send_time,
    content: withContent ? a.content : undefined,
  }));
  return { total: Number(data?.total ?? list.length), announcements: list };
}

export async function faqs() {
  const data = unwrap(await api.faq({}), '获取常见问题');
  const list = Array.isArray(data) ? data : data?.list ?? [];
  return {
    count: list.length,
    categories: [...new Set(list.map((f) => f.categoryName).filter(Boolean))],
    faqs: list.map((f) => ({ id: f.id, category: f.categoryName, question: f.question, answer: f.answer, showHome: f.showHome })),
  };
}

export async function holidays() {
  const data = unwrap(await authed(() => api.holidayList()), '获取假期');
  const list = Array.isArray(data) ? data : data?.list ?? [];
  return { count: list.length, holidays: list };
}

export async function violations({ pageNum = 1, pageSize = 10 } = {}) {
  const data = unwrap(await authed(() => api.illegaList({ pageNum, pageSize })), '获取违约记录');
  const list = (data?.list ?? []).map((v) => ({
    id: v.id,
    rule: v.violation,
    room: v.room_name,
    seat: v.userseatsid,
    time: v.illegatime,
    points: v.point,
    deduct: v.deduct_point,
    appealState: v.appealstate,
    state: v.state,
    readTime: v.read_time,
    note: v.revokecontent,
  }));
  return { total: Number(data?.total ?? list.length), violations: list, unread: await api.illegalUnread().then((r) => r?.data ?? null) };
}

export async function markViolationsRead(body = {}) {
  const res = await authed(() => api.illegalRead(body));
  return { ok: res?.isOk === true, data: res?.data ?? null };
}

export async function assets({ kind, id }) {
  const locationType = kind === 'room' ? 2 : 1;
  const data = unwrap(await authed(() => api.assetByLocation({ locationType, locationId: id })), '获取资产');
  return { locationType, locationId: id, assets: data ?? [] };
}

export async function reportRepair({ assetItemId, reportType = 1, reportUser, reportPhone, reportDesc }) {
  if (!assetItemId) throw new Error('需要 assetItemId（先从 assets 里拿）');
  if (!reportDesc) throw new Error('需要 reportDesc（描述故障）');
  const res = await authed(() => api.assetRepairReport({ assetItemId, reportType, reportUser: reportUser ?? '', reportPhone: reportPhone ?? '', reportDesc }));
  return { ok: res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null };
}

// ---------------------------------------------------------------- 账号 / 概览

export async function me() {
  const data = unwrap(await authed(() => api.getMy()), '获取个人信息');
  return {
    id: data?.id,
    username: data?.username,
    realname: data?.realname,
    unit: data?.unit,
    district: data?.district_name,
    phone: data?.phone,
    email: data?.email,
    points: Number(data?.points ?? 0),
    irregularities: Number(data?.irregularities_num ?? 0),
    periodIrregularities: Number(data?.period_illega_num ?? 0),
    status: data?.status,
    lastViolation: data?.last_cycle_violate,
    totalOrders: Number(data?.total_order ?? 0),
    lastOrder: data?.last_order,
    seatOrderCount: data?.seat_order_count,
    spaceOrderCount: data?.space_order_count,
    raw: data,
  };
}

export async function home() {
  const data = unwrap(await authed(() => api.home({})), '获取首页');
  const rooms = (data?.rooms ?? []).map(roomBrief);
  return {
    rooms,
    totalFree: rooms.reduce((n, r) => n + (r.freeSeats ?? 0), 0),
    keys: Object.keys(data ?? {}),
    raw: data,
  };
}

export async function districts() {
  // /web/area/district 必须要 id（空 body 会 500：parm.id is null）。
  // 前端没有传 id 的调用点，所以这里退一步用当前账号的 district_id 去问。
  let id = config.districtId;
  if (!id) {
    const mine = await api.getMy().catch(() => null);
    id = mine?.data?.district_id ?? null;
  }
  const data = unwrap(await authed(() => api.districts(id ? { id } : {})), '获取校区');
  const districts = Array.isArray(data) ? data : [data].filter(Boolean);
  return { count: districts.length, districts, note: id ? `按 district_id=${id} 查询` : '未取到 district_id' };
}

export async function timespans({ type } = {}) {
  // /web/taglist 要登录；没登录就退回公开的 /public/taglist（只有 timspans/tages）
  let data;
  try {
    data = unwrap(await authed(() => api.taglist({ ...(type ? { type } : {}) })), '获取时间片');
  } catch {
    data = unwrap(await api.taglistPublic(), '获取时间片');
  }
  return {
    timespans: (data?.timspans ?? []).map((t) => t.timeSpan),
    spaceTimespans: (data?.spaceTimspans ?? []).map((t) => t.timeSpan),
    tags: data?.tages ?? [],
  };
}

export async function roomMap({ roomId, room }) {
  const target = await findRoom({ roomId, room });
  const data = unwrap(await api.roomAttachPublic({ id: target.id }), '获取房间平面图');
  return { room: target, canvasStyle: data?.canvasstyle, html: data?.roomhtml, roomJson: data?.roomjson };
}

/** 全馆实时空位（公开接口，免登录）：现在→1 分钟窗口，逐个房间数空位 */
export async function availability({ concurrency = 5, building, floor, limit } = {}) {
  const rooms = (await listRooms({ building, floor, onlyOpen: true })).filter((r) => !r.spaceOnly);
  const slice = limit ? rooms.slice(0, limit) : rooms;
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const startTime = fmt(now);
  const endTime = fmt(new Date(now.getTime() + 60_000));
  const out = [];
  for (let i = 0; i < slice.length; i += concurrency) {
    const batch = slice.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (r) => {
        try {
          const data = unwrap(await api.seatStatePublic({ roomId: r.id, startTime, endTime }), '查询座位');
          const seats = data ?? [];
          return { ...r, free: seats.filter((s) => s.count === '0').length, total: seats.length, freeSeats: seats.filter((s) => s.count === '0').length, sample: seats.filter((s) => s.count === '0').slice(0, 5).map((s) => s.seatname) };
        } catch (err) {
          return { ...r, error: err.message };
        }
      }),
    );
    out.push(...results);
  }
  out.sort((a, b) => (b.free ?? -1) - (a.free ?? -1));
  return { at: startTime, rooms: out, totalFree: out.reduce((n, r) => n + (r.free ?? 0), 0) };
}

export { api, normalizeWindow, config };
