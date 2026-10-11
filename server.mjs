#!/usr/bin/env node
// libseat-scau MCP server (stdio)
//
// 目标站点：华南农业大学图书馆座位预约系统 https://libseat.scau.edu.cn/
// 逆向要点见 README.md：账号密码登录、验证码与 JSESSIONID 绑定、预约走 /web/user/due。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { api, normalizeWindow } from './api.mjs';
import { describeCas } from './cas.mjs';
import { CaptchaUnavailable, describeCaptchaMode } from './captcha.mjs';
import { config, describeConfig } from './config.mjs';
import { LoginFailed, ensureLogin, forgetSession, login, pendingCaptcha, sessionStatus } from './session.mjs';
import { captureSamples, probeSolver } from './flows.mjs';
import { request, withSession } from './http.mjs';
import { readFileSync } from 'node:fs';

const server = new McpServer({ name: 'libseat-scau', version: '0.1.0' });

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const image = (buffer) => ({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' });

/** 人工读图链路：把图内联回给调用方（模型/人都能直接看） */
function withCaptchaImage(payload, file) {
  const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  try {
    content.push(image(readFileSync(file)));
  } catch {
    // 图读不到就只回文本，路径已在 payload 里
  }
  return { content };
}

function fail(err) {
  const payload = { error: err?.name ?? 'Error', message: err?.message ?? String(err) };
  if (err?.file) payload.captchaFile = err.file;
  if (err?.attempts) payload.attempts = err.attempts;
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

const wrap = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (err) {
    return fail(err);
  }
};

async function authed(fn) {
  await ensureLogin();
  return withSession(fn, async () => {
    forgetSession();
    await login();
  });
}

async function findRoom({ roomId, room }) {
  const res = await api.rooms({});
  if (res?.isOk !== true) throw new Error(`获取房间列表失败: ${res?.message ?? '未知错误'}`);
  const rooms = res.data?.rooms ?? [];
  if (roomId) {
    const hit = rooms.find((r) => String(r.id) === String(roomId) || r.code === roomId);
    if (!hit) throw new Error(`房间不存在: ${roomId}`);
    return hit;
  }
  if (!room) throw new Error('需要 roomId 或 room（房间名关键字）');
  const hits = rooms.filter((r) => (r.name ?? '').includes(room));
  if (hits.length === 0) throw new Error(`没有匹配「${room}」的房间`);
  if (hits.length > 1) throw new Error(`「${room}」匹配到多个房间，请用 roomId: ${hits.map((r) => `${r.name}=${r.id}`).join(', ')}`);
  return hits[0];
}

const roomBrief = (r) => ({
  id: r.id,
  name: r.name,
  code: r.code,
  building: r.buildingname,
  floor: r.floorname,
  district: r.districtname,
  open: r.isopen === 1,
  openRange: `${r.open_start_time ?? '?'}-${r.open_end_time ?? '?'}`,
  seats: r.seatscount,
  freeSeats: r.availableseatcount,
});

// ---------------------------------------------------------------- 会话 / 验证码

server.registerTool(
  'libseat_status',
  {
    title: '登录状态与配置',
    description: '查看当前会话是否已登录、账号配置是否就绪、验证码求解方式。不返回密码。',
    inputSchema: {},
  },
  wrap(async () => json({ config: describeConfig(), cas: describeCas(), captcha: describeCaptchaMode(), session: sessionStatus(), pendingCaptcha: pendingCaptcha() })),
);

server.registerTool(
  'libseat_login',
  {
    title: '登录图书馆座位预约系统',
    description:
      '用 .env 中的账号密码登录，按 LIBSEAT_LOGIN_MODE 分两条路径：' +
      '(0) cas（默认，推荐）：走学校统一身份认证，**没有验证码**，实测 418ms 拿到业务会话，' +
      '会话是 7 天有效的 webuser JWT；' +
      '(1) 求解器可用（captchaMode=command/http）：自动抓图→解码→提交，失败就换新会话+新图重试；' +
      '(2) 人工/模型读图（manual）：第一次调用会返回验证码图片（同时把“图 + 它的 JSESSIONID”留成待解码状态），' +
      '读出 4 位字符后带 captcha 参数再调一次，会用同一条会话原样提交。验证码区分大小写、一次一图。',
    inputSchema: {
      user: z.string().optional().describe('覆盖 LIBSEAT_USER'),
      password: z.string().optional().describe('覆盖 LIBSEAT_PASS'),
      captcha: z.string().optional().describe('人工/外部流程解出的 4 位验证码（区分大小写）；提交给上一张待解码的图'),
    },
  },
  wrap(async (args) => {
    try {
      const result = await login({ user: args.user, password: args.password, captcha: args.captcha });
      return json({ ok: true, data: result.user, attempts: result.attempts, captchaFile: result.captchaFile });
    } catch (err) {
      if (err instanceof CaptchaUnavailable && err.file) {
        return withCaptchaImage(
          {
            ok: false,
            needsCaptcha: true,
            captchaFile: err.file,
            hint: '读出图中 4 位字符（区分大小写），带 captcha 参数再调一次 libseat_login；该图绑定的会话已保留',
          },
          err.file,
        );
      }
      throw err;
    }
  }),
);

server.registerTool(
  'libseat_logout',
  {
    title: '退出登录',
    description: '调用站点 logout 并清空内存会话。',
    inputSchema: {},
  },
  wrap(async () => {
    const res = await api.logout().catch((err) => ({ isOk: false, message: err.message }));
    forgetSession();
    return json({ ok: true, server: res });
  }),
);

server.registerTool(
  'libseat_captcha_capture',
  {
    title: '抓取验证码样本',
    description:
      '连抓 N 张验证码并落盘（默认 mcp/libseat/captcha-samples/），每张都带独立 JSESSIONID 记录进 manifest.jsonl。' +
      '这是给自定义求解器做数据集/回归的稳定入口。最后一张会留成“待解码”，' +
      '人工/模型读完码可以直接带 captcha 调 libseat_login。',
    inputSchema: {
      count: z.number().int().min(1).max(50).default(1),
      withImage: z.boolean().default(true).describe('是否把第一张图内联返回（供人/模型直接读）'),
    },
  },
  wrap(async ({ count, withImage }) => {
    const samples = await captureSamples({ count });
    const content = [{ type: 'text', text: JSON.stringify({ dir: config.captchaDir, count, files: samples.map((s) => s.file) }, null, 2) }];
    if (withImage) {
      const first = await import('node:fs').then((fs) => fs.readFileSync(samples[0].file));
      content.push(image(first));
    }
    return { content };
  }),
);

server.registerTool(
  'libseat_captcha_probe',
  {
    title: '验证求解器（确定性探针）',
    description:
      '每轮：抓新图 → 求解 → 用探针账号提交一次。判定 captcha_rejected（服务端拒绝该码）vs captcha_accepted' +
      '（码通过了、报错落到账号层）→ 得到求解器真命中率。需要一个探针账号，可用你自己的账号（不会真的登录成功也无所谓）。',
    inputSchema: {
      rounds: z.number().int().min(1).max(50).default(5),
      user: z.string().optional(),
      password: z.string().optional(),
    },
  },
  wrap(async (args) => json(await probeSolver(args))),
);

// ---------------------------------------------------------------- 查询

server.registerTool(
  'libseat_rooms',
  {
    title: '房间/座位区列表',
    description: '公开接口，不需要登录。可按名称关键字过滤。',
    inputSchema: { query: z.string().optional().describe('房间名关键字，如 一楼、研讨间') },
  },
  wrap(async ({ query }) => {
    const res = await api.rooms({});
    if (res?.isOk !== true) throw new Error(res?.message ?? '获取房间失败');
    const rooms = (res.data?.rooms ?? []).map(roomBrief);
    return json({ total: rooms.length, rooms: query ? rooms.filter((r) => r.name.includes(query)) : rooms });
  }),
);

server.registerTool(
  'libseat_timespans',
  {
    title: '可预约时间片',
    description: '公开接口，返回半小时粒度的时间片（timeSpan 形如 "07:00"）与楼层标签。',
    inputSchema: {},
  },
  wrap(async () => {
    const res = await api.taglistPublic();
    if (res?.isOk !== true) throw new Error(res?.message ?? '获取时间片失败');
    return json({ timespans: (res.data?.timspans ?? []).map((t) => t.timeSpan), tags: res.data?.tages ?? [] });
  }),
);

server.registerTool(
  'libseat_seats',
  {
    title: '查询座位占用',
    description: '查某房间某时段的座位状态（需要登录）。count 为 "0" 表示空闲。',
    inputSchema: {
      roomId: z.string().optional(),
      room: z.string().optional().describe('房间名关键字，二选一'),
      date: z.string().describe('YYYY-MM-DD'),
      startTime: z.string().describe('HH:mm，如 09:00'),
      endTime: z.string().optional().describe('HH:mm，省略=startTime+30min'),
      onlyFree: z.boolean().default(true),
    },
  },
  wrap(async (args) => {
    const room = await findRoom(args);
    const win = normalizeWindow(args);
    const res = await authed(() => api.seatState({ roomId: room.id, startTime: win.seatStateStart, endTime: win.seatStateEnd }));
    if (res?.isOk !== true) throw new Error(res?.message ?? '查询座位失败');
    const all = res.data ?? [];
    const seats = (args.onlyFree ? all.filter((s) => s.count === '0') : all).map((s) => ({ seatId: s.seatid, name: s.seatname, count: s.count }));
    return json({ room: roomBrief(room), window: { start: win.seatStateStart, end: win.seatStateEnd }, total: all.length, shown: seats.length, seats });
  }),
);

server.registerTool(
  'libseat_my_reservations',
  {
    title: '我的预约列表',
    description: '站点内部把预约叫 due。duetype: 1=座位, 2=空间（可省略取全部）。',
    inputSchema: {
      duetype: z.number().int().optional(),
      date: z.string().optional().describe('YYYY-MM-DD，限定当天'),
      pageNum: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
    },
  },
  wrap(async (args) => {
    const body = { pageNum: args.pageNum, pageSize: args.pageSize };
    if (args.duetype) body.duetype = args.duetype;
    if (args.date) {
      body.startDate = `${args.date} 00:00:00`;
      body.endDate = `${args.date} 23:59:59`;
    }
    const res = await authed(() => api.reserveList(body));
    if (res?.isOk !== true) throw new Error(res?.message ?? '获取预约列表失败');
    return json(res.data ?? res);
  }),
);

server.registerTool(
  'libseat_reservation_detail',
  {
    title: '预约详情',
    description: '按预约 id 查详情（duedetail）。',
    inputSchema: { id: z.string().describe('预约 id（来自 libseat_my_reservations）') },
  },
  wrap(async ({ id }) => {
    const res = await authed(() => api.reserveDetail({ id }));
    if (res?.isOk !== true) throw new Error(res?.message ?? '获取详情失败');
    return json(res.data ?? res);
  }),
);

// ---------------------------------------------------------------- 预约操作

server.registerTool(
  'libseat_reserve',
  {
    title: '提交预约',
    description:
      '预约座位（POST /web/user/due）。给 seatId 直接提交；给 seatName 则先查该时段座位表再匹配。' +
      '注意站点规则：开馆时段内、每天最多 3 次、开始后 15 分钟内需签到。',
    inputSchema: {
      roomId: z.string().optional(),
      room: z.string().optional().describe('房间名关键字，解析 seatName 时用'),
      seatId: z.string().optional().describe('座位 sid，如 485323798111846400'),
      seatName: z.string().optional().describe('座位名，如 M1C001（需能唯一匹配）'),
      date: z.string().describe('YYYY-MM-DD'),
      startTime: z.string().describe('HH:mm'),
      endTime: z.string().optional().describe('HH:mm，省略=startTime+30min'),
      reason: z.string().default(''),
      memberIds: z.array(z.string()).default([]),
    },
  },
  wrap(async (args) => {
    const win = normalizeWindow(args);
    let seatId = args.seatId;
    if (!seatId) {
      if (!args.seatName) throw new Error('需要 seatId 或 seatName');
      const room = await findRoom(args);
      const res = await authed(() => api.seatState({ roomId: room.id, startTime: win.seatStateStart, endTime: win.seatStateEnd }));
      if (res?.isOk !== true) throw new Error(res?.message ?? '查询座位失败');
      const hits = (res.data ?? []).filter((s) => (s.seatname ?? '').trim() === args.seatName.trim());
      if (hits.length !== 1) throw new Error(`座位名 ${args.seatName} 匹配到 ${hits.length} 个，请改用 seatId`);
      if (hits[0].count !== '0') throw new Error(`座位 ${args.seatName} 在该时段已被占用（count=${hits[0].count}）`);
      seatId = hits[0].seatid;
    }
    const payload = {
      seatesid: seatId,
      duestartime: win.dueStart,
      dueendtime: win.dueEnd,
      reason: args.reason ?? '',
      memberids: args.memberIds ?? [],
    };
    const res = await authed(() => api.reserve(payload));
    return json({ request: payload, isOk: res?.isOk === true, message: res?.message ?? '', data: res?.data ?? null });
  }),
);

server.registerTool(
  'libseat_cancel',
  {
    title: '取消预约',
    description: '按预约 id 取消（/web/user/cancel）。',
    inputSchema: { id: z.string() },
  },
  wrap(async ({ id }) => json(await authed(() => api.cancel(id)))),
);

server.registerTool(
  'libseat_checkin',
  {
    title: '签到',
    description: '按预约 id 签到（/web/user/checkin/sign）。返回 data.signin==1 表示成功。',
    inputSchema: { id: z.string() },
  },
  wrap(async ({ id }) => json(await authed(() => api.checkin(id)))),
);

server.registerTool(
  'libseat_signout',
  {
    title: '签退',
    description: '按预约 id 签退（/web/user/signout）。',
    inputSchema: { id: z.string() },
  },
  wrap(async ({ id }) => json(await authed(() => api.signout(id)))),
);

server.registerTool(
  'libseat_tempout',
  {
    title: '暂离 / 归位',
    description: 'istempout=true 暂离，false 归位（/web/user/tempout，字段是 orderid）。离馆需 40 分钟内归位。',
    inputSchema: { orderid: z.string(), istempout: z.boolean().default(true) },
  },
  wrap(async ({ orderid, istempout }) => json(await authed(() => api.tempout({ orderid, istempout })))),
);

server.registerTool(
  'libseat_api',
  {
    title: '原始接口调用（逃生舱）',
    description:
      '直接打站点接口，路径以 /public、/web 或 /op 开头（自动加 /api 前缀）。用于站点改版后按需扩展，auth=true 时自动带登录会话。',
    inputSchema: {
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).default('POST'),
      path: z.string().describe('如 /web/user/duelist'),
      body: z.record(z.any()).optional(),
      auth: z.boolean().default(false),
    },
  },
  wrap(async ({ method, path, body, auth }) => {
    if (!/^\/(public|web|op)\//.test(path)) throw new Error('path 必须以 /public、/web 或 /op 开头');
    const run = () => request(method, path, { body, auth });
    const res = auth ? await authed(run) : await run();
    return json(res);
  }),
);

// ---------------------------------------------------------------- 启动

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[libseat-mcp] ready base=${config.baseUrl} captcha=${config.captchaMode} user=${config.user ? '已配置' : '未配置'}`);
