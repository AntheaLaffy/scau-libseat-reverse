// 接口表：全部来自前端 bundle 逆向（index-BwTQkZGU.js 及其分块）并逐条联网实测。
// 前缀统一 /api，鉴权走 JSESSIONID（fetch credentials:"include"，没有 Authorization 机制）。
//
// 命名沿用站点自己的叫法：预约 = due，座位 = seat，房间 = room，区域 = district。
// 字段上的两个坑（照抄前端，别自作聪明统一）：
//   1. 查座位 /roomDetails 用 "YYYY-MM-DD HH:mm"，但 /web/user/seatState 用 "YYYY-MM-DD HH:mm:ss"；
//      提交预约 /web/user/due 又回到 "YYYY-MM-DD HH:mm"。
//   2. /web/roomDetails 的入参是 roomid / startime（是 startime，不是 starttime），
//      而返回体里的座位表是 data.seats.list[].seat。
import { request } from './http.mjs';

const post = (path, body) => request('POST', path, { body });
const get = (path) => request('GET', path, {});

export const api = {
  // ---------------------------------------------------------------- 登录 / 账号
  login: ({ userName, password, captcha }) => post('/web/user/login', { userName, password, captcha }),
  logout: () => post('/web/user/logout'),
  me: () => post('/web/pc/user'),
  home: (body = {}) => post('/web/pc/home', body),
  getMy: () => post('/web/user/getMy'),
  updateMy: (body) => post('/web/user/updateMy', body),
  clientIp: () => post('/web/user/clientIp'),
  kioskCheckIn: () => post('/web/user/kioskCheckIn'),

  // ---------------------------------------------------------------- 公共（免登录）
  rooms: (body = {}) => post('/public/home', body),
  taglistPublic: () => post('/public/taglist'),
  seatStatePublic: ({ roomId, startTime, endTime }) => post('/public/seatState', { roomId, startTime, endTime }),
  roomAttachPublic: ({ id }) => post('/public/roomattach/selectByRoomId', { id }),
  announcement: (body = {}) => post('/public/announcement/list', body),

  // ---------------------------------------------------------------- 区域 / 房间 / 时间片
  districts: (body = {}) => post('/web/area/district', body),
  taglist: (body = {}) => post('/web/taglist', body),
  roomDetails: ({ roomId, startTime, endTime, pageNum = 1, pageSize = 200 }) =>
    post('/web/roomDetails', { pageNum, pageSize, roomid: roomId, startime: startTime, endtime: endTime }),
  roomAttach: ({ id }) => post('/web/roomattach/selectByRoomId', { id }),
  seatState: ({ roomId, startTime, endTime }) => post('/web/user/seatState', { roomId, startTime, endTime }),
  holidayList: () => post('/web/holiday/list'),
  announcementList: (body = {}) => post('/public/announcement/list', body),
  faq: (body = {}) => post('/web/faq/list', body),

  // ---------------------------------------------------------------- 预约（due）
  reserve: (body) => post('/web/user/due', body),
  reserveList: (body = {}) => post('/web/user/duelist', body),
  reserveDetail: (body) => post('/web/user/duedetail', body),
  todayList: (body = {}) => post('/web/user/todaylist', body),
  cancel: (id) => post('/web/user/cancel', { id }),
  checkin: (id) => post('/web/user/checkin/sign', { id }),
  signout: (id) => post('/web/user/signout', { id }),
  tempout: ({ orderid, istempout }) => post('/web/user/tempout', { orderid, istempout }),
  continueOrder: ({ orderid, continuetime }) => post('/web/user/continueOrder', { orderid, continuetime }),
  orderStateLog: ({ orderId }) => post('/web/seatOrderStateLog/listByOrderId', { orderId }),

  // ---------------------------------------------------------------- 智能规划 / 批量下单
  smartPlan: (body) => post('/web/user/smartPlan', body),
  smartDue: ({ segments }) => post('/web/user/smartDue', { segments }),

  // ---------------------------------------------------------------- 组队 / 同行成员（空间预约）
  inviteMyList: (body = {}) => post('/web/user/inviteMyList', body),
  agree: ({ orderId, isagree }) => post('/web/user/agree', { orderId, isagree }),
  openGroup: ({ orderId, isOpenGroup }) => post('/web/user/openGroup', { orderId, isOpenGroup }),
  joinGroup: ({ orderId }) => post('/web/user/joinGroup', { orderId }),
  membersList: ({ id }) => post('/web/user/membersList', { id }),
  findOtherUser: ({ userName, pageNum = 1, pageSize = 10 }) => post('/web/user/findotheruser', { pageNum, pageSize, userName }),
  addMembers: ({ id, memberIds }) => post('/web/user/addMembers', { id, memberIds }),
  deleteMembers: ({ id, memberIds }) => post('/web/user/deleteMembers', { id, memberIds }),

  // ---------------------------------------------------------------- 违规 / 资产
  illegaList: (body = {}) => post('/web/illega/list', body),
  illegalUnread: () => get('/web/illegal/latestUnread'),
  illegalRead: (body = {}) => post('/web/illegal/read', body),
  assetByLocation: ({ locationType, locationId }) => post('/web/asset/item/byLocation', { locationType, locationId }),
  assetRepairReport: (body) => post('/web/asset/item/repair/report', body),
};

/**
 * 补全时间段。
 * - seatState / roomDetails 查询用 "YYYY-MM-DD HH:mm:ss" 与 "YYYY-MM-DD HH:mm"（各自见上）
 * - 提交预约（due）用 "YYYY-MM-DD HH:mm"
 * - 结束时间 = 最后一个半小时片 + 30 分钟
 */
export function normalizeWindow({ date, startTime, endTime }) {
  if (!date) throw new Error('缺少 date（YYYY-MM-DD）');
  if (!startTime) throw new Error('缺少 startTime（HH:mm）');
  const startHm = startTime.slice(0, 5);
  const [h, m] = startHm.split(':').map(Number);
  let endHm = endTime ? endTime.slice(0, 5) : null;
  if (!endHm) {
    const total = h * 60 + m + 30;
    endHm = `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  return {
    date,
    startTime: startHm,
    endTime: endHm,
    // /web/user/seatState 要秒
    seatStateStart: `${date} ${startHm}:00`,
    seatStateEnd: `${date} ${endHm}:00`,
    // /web/roomDetails 要分（字段名还是 startime）
    roomDetailStart: `${date} ${startHm}`,
    roomDetailEnd: `${date} ${endHm}`,
    // /web/user/due 要分
    dueStart: `${date} ${startHm}`,
    dueEnd: `${date} ${endHm}`,
    minutes: (Number(endHm.slice(0, 2)) * 60 + Number(endHm.slice(3))) - (h * 60 + m),
  };
}
