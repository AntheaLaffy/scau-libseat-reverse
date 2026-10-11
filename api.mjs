// 接口表：全部来自前端 bundle 逆向（index-BwTQkZGU.js / SeatView / due / myReserve 分块）。
// 前缀统一 /api，鉴权走 JSESSIONID。
import { request } from './http.mjs';

const post = (path, body) => request('POST', path, { body });

export const api = {
  // --- 登录 / 账号 ---
  login: ({ userName, password, captcha }) => post('/web/user/login', { userName, password, captcha }),
  logout: () => post('/web/user/logout'),
  me: () => post('/web/pc/user'),
  getMy: () => post('/web/user/getMy'),
  updateMy: (body) => post('/web/user/updateMy', body),
  clientIp: () => post('/web/user/clientIp'),
  kioskCheckIn: () => post('/web/user/kioskCheckIn'),

  // --- 房间 / 时间片 / 座位 ---
  rooms: (body = {}) => post('/public/home', body),
  taglistPublic: () => post('/public/taglist'),
  taglist: () => post('/web/taglist'),
  roomDetails: (body) => post('/web/roomDetails', body),
  districts: () => post('/web/area/district'),
  roomAttachPublic: (body) => post('/public/roomattach/selectByRoomId', body),
  roomAttach: (body) => post('/web/roomattach/selectByRoomId', body),
  seatStatePublic: ({ roomId, startTime, endTime }) => post('/public/seatState', { roomId, startTime, endTime }),
  seatState: ({ roomId, startTime, endTime }) => post('/web/user/seatState', { roomId, startTime, endTime }),
  announcement: (body = {}) => post('/public/announcement/list', body),

  // --- 预约（站点内部把预约叫 due）---
  reserve: (body) => post('/web/user/due', body),
  reserveList: (body = {}) => post('/web/user/duelist', body),
  reserveDetail: (body) => post('/web/user/duedetail', body),
  cancel: (id) => post('/web/user/cancel', { id }),
  checkin: (id) => post('/web/user/checkin/sign', { id }),
  signout: (id) => post('/web/user/signout', { id }),
  tempout: ({ orderid, istempout }) => post('/web/user/tempout', { orderid, istempout }),
  continueOrder: ({ orderid, continuetime }) => post('/web/user/continueOrder', { orderid, continuetime }),
  agree: ({ orderId, isagree }) => post('/web/user/agree', { orderId, isagree }),
  openGroup: ({ orderId, isOpenGroup }) => post('/web/user/openGroup', { orderId, isOpenGroup }),
  joinGroup: ({ orderId }) => post('/web/user/joinGroup', { orderId }),
  orderStateLog: ({ orderId }) => post('/web/seatOrderStateLog/listByOrderId', { orderId }),
  todayList: (body = {}) => post('/web/user/todaylist', body),
};

/**
 * 补全时间段：站点的 seatState 查询用 "YYYY-MM-DD HH:mm:ss"，
 * 而提交预约（due）用的是 "YYYY-MM-DD HH:mm"（前端就是这么写的，别自作聪明统一）。
 */
export function normalizeWindow({ date, startTime, endTime }) {
  if (!date) throw new Error('缺少 date（YYYY-MM-DD）');
  if (!startTime) throw new Error('缺少 startTime（HH:mm）');
  const start = startTime.length === 5 ? `${startTime}:00` : startTime;
  let end = endTime;
  if (!end) {
    const [h, m] = start.split(':').map(Number);
    const total = h * 60 + m + 30;
    end = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  } else if (end.length === 5) {
    end = `${end}:00`;
  }
  return {
    date,
    startTime,
    seatStateStart: `${date} ${start}`,
    seatStateEnd: `${date} ${end}`,
    dueStart: `${date} ${start.slice(0, 5)}`,
    dueEnd: `${date} ${end.slice(0, 5)}`,
  };
}
