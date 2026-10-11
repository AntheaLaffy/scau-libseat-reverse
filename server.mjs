#!/usr/bin/env node
// libseat-scau MCP server (stdio)
//
// 目标站点：华南农业大学图书馆座位预约系统 https://libseat.scau.edu.cn/
// 逆向要点见 README.md / docs/逆向记录.md：CAS 免验证码登录、预约走 /web/user/due、
// 房间=room、区域=district、预约=due。
//
// 工具分四组：会话/验证码、查询、预约操作、站点其它功能（智能规划、组队、成员、
// 公告、FAQ、假期、违约、资产报修、平面图）。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync } from 'node:fs';

import { api } from './api.mjs';
import { describeCas } from './cas.mjs';
import { CaptchaUnavailable, describeCaptchaMode } from './captcha.mjs';
import { config, describeConfig } from './config.mjs';
import { ensureLogin, forgetSession, login, pendingCaptcha, sessionStatus } from './session.mjs';
import { captureSamples, probeSolver } from './flows.mjs';
import { request, withSession } from './http.mjs';
import * as ops from './seatops.mjs';

const server = new McpServer({ name: 'libseat-scau', version: '0.2.0' });

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

const roomLocator = {
  roomId: z.string().optional().describe('房间 id，最准'),
  room: z.string().optional().describe('房间名关键字（如 一楼思政、研讨间、自习），需唯一匹配'),
};

const dateArg = z.string().describe('YYYY-MM-DD');
const startArg = z.string().describe('HH:mm，如 09:00');
const endArg = z.string().optional().describe('HH:mm，省略 = startTime + 30 分钟');

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
      '(0) cas（默认，推荐）：走学校统一身份认证，**没有验证码**，实测 418ms 拿到业务会话，会话是 7 天有效的 webuser JWT；' +
      '(1) 求解器可用（captchaMode=command/http）：自动抓图→解码→提交，失败就换新会话+新图重试；' +
      '(2) 人工/模型读图（manual）：第一次调用会返回验证码图片（同时把「图 + 它的 JSESSIONID」留成待解码状态），' +
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
  { title: '退出登录', description: '调用站点 logout 并清空内存会话。', inputSchema: {} },
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
      '连抓 N 张验证码并落盘（默认 captcha-samples/），每张都带独立 JSESSIONID 记录进 manifest.jsonl。' +
      '这是给自定义求解器做数据集/回归的稳定入口。最后一张会留成「待解码」，人工/模型读完码可以直接带 captcha 调 libseat_login。',
    inputSchema: {
      count: z.number().int().min(1).max(50).default(1),
      withImage: z.boolean().default(true).describe('是否把第一张图内联返回（供人/模型直接读）'),
    },
  },
  wrap(async ({ count, withImage }) => {
    const samples = await captureSamples({ count });
    const content = [{ type: 'text', text: JSON.stringify({ dir: config.captchaDir, count, files: samples.map((s) => s.file) }, null, 2) }];
    if (withImage) content.push(image(readFileSync(samples[0].file)));
    return { content };
  }),
);

server.registerTool(
  'libseat_captcha_probe',
  {
    title: '验证求解器（确定性探针）',
    description:
      '每轮：抓新图 → 求解 → 用探针账号提交一次。判定 captcha_rejected（服务端拒绝该码）vs captcha_accepted' +
      '（码通过了、报错落到账号层）→ 得到求解器真命中率。需要一个探针账号，可用你自己的账号。',
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
    description: '公开接口，不需要登录。可按名称、楼栋、楼层、只看开放、只看空间过滤。',
    inputSchema: {
      query: z.string().optional().describe('房间名/楼层/楼栋关键字，如 一楼、研讨间'),
      building: z.string().optional().describe('楼栋关键字，如 总馆'),
      floor: z.string().optional().describe('楼层关键字，如 三楼'),
      onlyOpen: z.boolean().default(false),
      spaceOnly: z.boolean().default(false).describe('只看研讨间等空间（isonlyspace=1）'),
    },
  },
  wrap(async (args) => {
    const rooms = await ops.listRooms(args);
    return json({ total: rooms.length, rooms });
  }),
);

server.registerTool(
  'libseat_timespans',
  {
    title: '可预约时间片',
    description: '返回半小时粒度的时间片（形如 "07:00"）与楼层标签；空间预约的时间片是整点（09:00–22:00）。',
    inputSchema: { type: z.number().int().optional().describe('2 = 空间时间片') },
  },
  wrap(async (args) => json(await ops.timespans(args))),
);

server.registerTool(
  'libseat_seats',
  {
    title: '查询座位占用',
    description:
      '查某房间某时段的座位状态。count 为 "0" 表示空闲。realtime=true 时查「现在→1 分钟」的实时快照' +
      '（和公共查询页一致，免登录）。需要 roomId 或 room 之一。',
    inputSchema: {
      ...roomLocator,
      date: z.string().optional().describe('YYYY-MM-DD（realtime 时可省）'),
      startTime: z.string().optional().describe('HH:mm（realtime 时可省）'),
      endTime: endArg,
      realtime: z.boolean().default(false),
      onlyFree: z.boolean().default(true),
    },
  },
  wrap(async (args) => {
    if (!args.realtime && (!args.date || !args.startTime)) throw new Error('非实时查询需要 date 与 startTime（或用 realtime=true）');
    return json(await ops.seatStates(args));
  }),
);

server.registerTool(
  'libseat_availability',
  {
    title: '全馆实时空位',
    description: '公开接口，免登录：逐个房间取「现在→1 分钟」的实时快照，按空位数排序。适合「现在哪儿有座」。',
    inputSchema: {
      building: z.string().optional(),
      floor: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional().describe('只查前 N 个房间'),
      concurrency: z.number().int().min(1).max(10).default(5),
    },
  },
  wrap(async (args) => json(await ops.availability(args))),
);

server.registerTool(
  'libseat_room_detail',
  {
    title: '房间详情（规则 + 可预约日期 + 座位表）',
    description: '对应站点「空间/座位」预约页：返回该房间该时段的时间规则、可预约日期与座位表（含每座占用）。',
    inputSchema: {
      ...roomLocator,
      date: dateArg,
      startTime: startArg,
      endTime: endArg,
      onlyFree: z.boolean().default(false),
      pageSize: z.number().int().min(1).max(500).default(200),
    },
  },
  wrap(async (args) => json(await ops.roomDetail(args))),
);

server.registerTool(
  'libseat_room_map',
  {
    title: '房间平面图（座位分布）',
    description: 'roomattach：拿到房间的座位分布图（canvas 样式 + HTML）。用于看座位在房间里的位置。',
    inputSchema: { ...roomLocator },
  },
  wrap(async (args) => json(await ops.roomMap(args))),
);

server.registerTool(
  'libseat_my_reservations',
  {
    title: '我的预约列表',
    description: '站点内部把预约叫 due。duetype: 1=座位, 2=空间；duestatus 可传状态数组（0 待同意…5 已取消）。',
    inputSchema: {
      duetype: z.number().int().optional(),
      duestatus: z.union([z.number().int(), z.array(z.number().int())]).optional().describe('状态过滤，可数组'),
      date: z.string().optional().describe('YYYY-MM-DD，限定当天'),
      startDate: z.string().optional().describe('"YYYY-MM-DD HH:mm:ss"'),
      endDate: z.string().optional(),
      pageNum: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
      brief: z.boolean().default(true).describe('true=归一化成好读的字段；false=原始响应'),
    },
  },
  wrap(async (args) => json(await ops.myReservations(args))),
);

server.registerTool(
  'libseat_today',
  { title: '今日预约', description: 'todaylist：今天的所有预约（平台首页「今日预约」那一栏）。', inputSchema: {} },
  wrap(async () => json(await ops.todayReservations())),
);

server.registerTool(
  'libseat_reservation_detail',
  {
    title: '预约详情',
    description: '按预约 id 查详情（duedetail），含成员、申请单、签到状态等。',
    inputSchema: { id: z.string().describe('预约 id（来自 libseat_my_reservations）') },
  },
  wrap(async ({ id }) => json(await ops.reservationDetail({ id }))),
);

server.registerTool(
  'libseat_order_log',
  {
    title: '预约状态流水',
    description: '按预约 id 查状态变更记录（listByOrderId）：什么时候被预约/签到/暂离/释放。',
    inputSchema: { id: z.string().describe('预约 id') },
  },
  wrap(async ({ id }) => json(await ops.orderLog({ orderId: id }))),
);

server.registerTool(
  'libseat_me',
  { title: '我的信息', description: '当前账号档案：积分、累计违约、账号状态、总预约次数、上次预约。', inputSchema: {} },
  wrap(async () => json(await ops.me())),
);

server.registerTool(
  'libseat_home',
  { title: '首页概览', description: 'pc/home：房间列表 + 统计（各房间可用座位数、总量）。', inputSchema: {} },
  wrap(async () => json(await ops.home())),
);

server.registerTool(
  'libseat_districts',
  { title: '校区 / 区域列表', description: '/web/area/district：校区列表。', inputSchema: {} },
  wrap(async () => json(await ops.districts())),
);
// ---------------------------------------------------------------- 预约操作

server.registerTool(
  'libseat_reserve',
  {
    title: '提交预约',
    description:
      '预约座位或空间（POST /web/user/due）。给 seatId 直接提交；给 seatName 或 firstFree=true 则先查该时段座位表再定座。' +
      'dryRun=true 只回报文不下单。站点规则：开馆时段内、每天最多 3 次、单次最长 5 小时、开始后 15 分钟内需签到。',
    inputSchema: {
      ...roomLocator,
      seatId: z.string().optional().describe('座位 sid，如 485323798111846400'),
      seatName: z.string().optional().describe('座位名，如 M1C001'),
      firstFree: z.boolean().default(false).describe('自动挑该房间该时段的第一个空闲座位'),
      date: dateArg,
      startTime: startArg,
      endTime: endArg,
      reason: z.string().default(''),
      memberIds: z.array(z.string()).default([]).describe('同行成员的用户 id（空间预约）'),
      attachmentUrl: z.string().optional().describe('空间预约的附件地址'),
      attachmentName: z.string().optional(),
      applyForm: z.union([z.string(), z.record(z.any())]).optional().describe('空间预约申请单：{activityType,activityName,unit,participantCount,phone,officeTel,remark}'),
      dryRun: z.boolean().default(false),
    },
  },
  wrap(async (args) => json(await ops.reserve(args))),
);

server.registerTool(
  'libseat_smart_plan',
  {
    title: '智能规划（找座方案）',
    description:
      'smartPlan：给定日期/时长/起始时间，返回若干候选方案（同一方案里可能需要中途换座）。' +
      'metaOnly=true 只取元信息（最晚可预约日期、签到窗口、开闭馆时间）。',
    inputSchema: {
      date: dateArg,
      hours: z.number().min(0.5).max(12).describe('想要的小时数'),
      startTime: z.string().optional().describe('HH:mm，省略则不限起始'),
      fullDay: z.boolean().default(false),
      sameSeat: z.boolean().default(true).describe('尽量同一个座位'),
      preferMealBreak: z.boolean().default(false),
      preferredRoomIds: z.array(z.string()).optional().describe('优先房间 id 列表'),
      metaOnly: z.boolean().default(false),
    },
  },
  wrap(async (args) => json(await ops.smartPlan(args))),
);

server.registerTool(
  'libseat_smart_due',
  {
    title: '按方案批量下单',
    description: 'smartDue：把 libseat_smart_plan 返回的某个 plan.segments 原样提交（[{seatId,duestartime,dueendtime}]）。',
    inputSchema: {
      segments: z
        .array(z.object({ seatId: z.string(), duestartime: z.string(), dueendtime: z.string() }))
        .min(1)
        .describe('直接来自 smart_plan 的 plan.segments'),
    },
  },
  wrap(async (args) => json(await ops.smartDue(args))),
);

server.registerTool(
  'libseat_cancel',
  { title: '取消预约', description: '按预约 id 取消（/web/user/cancel）。规则：预约开始前 30 分钟以上才能取消。', inputSchema: { id: z.string() } },
  wrap(async ({ id }) => json(await ops.cancel({ id }))),
);

server.registerTool(
  'libseat_checkin',
  { title: '签到', description: '按预约 id 签到（/web/user/checkin/sign）。返回 signedIn=true 表示成功。', inputSchema: { id: z.string() } },
  wrap(async ({ id }) => json(await ops.checkin({ id }))),
);

server.registerTool(
  'libseat_signout',
  { title: '签退', description: '按预约 id 签退（/web/user/signout）。', inputSchema: { id: z.string() } },
  wrap(async ({ id }) => json(await ops.signout({ id }))),
);

server.registerTool(
  'libseat_tempout',
  {
    title: '暂离 / 归位',
    description: 'istempout=true 暂离，false 归位（/web/user/tempout，字段是 orderid）。离馆需 40 分钟内归位。',
    inputSchema: { orderid: z.string(), istempout: z.boolean().default(true) },
  },
  wrap(async ({ orderid, istempout }) => json(await ops.tempout({ orderid, istempout }))),
);

server.registerTool(
  'libseat_continue',
  {
    title: '续座',
    description: 'continueOrder：延长当前预约。minutes 是「续多久」（服务端字段 continuetime 收的是整数分钟，不是时间点）。',
    inputSchema: {
      orderid: z.string().describe('预约 id'),
      minutes: z.number().int().min(1).max(300).default(30).describe('续座时长（分钟），如 30/60/90'),
    },
  },
  wrap(async (args) => json(await ops.continueOrder(args))),
);

// ---------------------------------------------------------------- 组队 / 成员 / 其它

server.registerTool(
  'libseat_group',
  {
    title: '空间预约组队 / 邀请',
    description: 'open/close=开放或关闭组队；agree/refuse=同意或拒绝邀请；join=加入；invitations=我收到的邀请列表。',
    inputSchema: {
      action: z.enum(['open', 'close', 'agree', 'refuse', 'join', 'invitations']),
      orderId: z.string().optional().describe('预约 id（invitations 不需要）'),
    },
  },
  wrap(async (args) => json(await ops.group(args))),
);

server.registerTool(
  'libseat_members',
  {
    title: '同行成员管理',
    description: 'list=看成员；find=搜人（按学号/工号匹配 userName，实测姓名搜不到）；add/remove=增删成员（需要 id 与 memberIds）。',
    inputSchema: {
      action: z.enum(['list', 'find', 'add', 'remove']),
      id: z.string().optional().describe('预约 id（list/add/remove）'),
      userName: z.string().optional().describe('find 的关键字'),
      memberIds: z.array(z.string()).optional().describe('用户 id 列表'),
      pageNum: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
    },
  },
  wrap(async (args) => json(await ops.members(args))),
);

server.registerTool(
  'libseat_announcements',
  {
    title: '公告',
    description: '图书馆公告（含座位使用规则）。withContent=true 时带正文 HTML。',
    inputSchema: {
      pageNum: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
      withContent: z.boolean().default(false),
    },
  },
  wrap(async (args) => json(await ops.announcements(args))),
);

server.registerTool(
  'libseat_faq',
  { title: '常见问题', description: '/web/faq/list：怎么预约、怎么签到、违约怎么算，官方问答。', inputSchema: {} },
  wrap(async () => json(await ops.faqs())),
);

server.registerTool(
  'libseat_holidays',
  { title: '假期 / 闭馆安排', description: '/web/holiday/list：节假日暂停预约的时间段。', inputSchema: {} },
  wrap(async () => json(await ops.holidays())),
);

server.registerTool(
  'libseat_violations',
  {
    title: '我的违约记录',
    description: '违规列表：原因、扣分、申诉状态、是否需要阅读提醒；顺带带上未读提醒。',
    inputSchema: {
      pageNum: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
    },
  },
  wrap(async (args) => json(await ops.violations(args))),
);

server.registerTool(
  'libseat_violations_read',
  { title: '标记违约提醒已读', description: 'illegal/read：清掉「违约提醒」弹窗的未读状态。', inputSchema: {} },
  wrap(async () => json(await ops.markViolationsRead())),
);

server.registerTool(
  'libseat_assets',
  {
    title: '座位/房间资产',
    description: 'asset/item/byLocation：看某个座位或房间里的设备（灯、插座、桌椅），报修时先拿 assetItemId。',
    inputSchema: {
      kind: z.enum(['seat', 'room']).describe('seat=座位，room=房间'),
      id: z.string().describe('seatId 或 roomId'),
    },
  },
  wrap(async (args) => json(await ops.assets(args))),
);

server.registerTool(
  'libseat_report_repair',
  {
    title: '设备报修',
    description: 'asset/item/repair/report：对某个资产报修（需要 assetItemId 与描述）。',
    inputSchema: {
      assetItemId: z.string(),
      reportType: z.number().int().default(1),
      reportUser: z.string().optional(),
      reportPhone: z.string().optional(),
      reportDesc: z.string().describe('故障描述'),
    },
  },
  wrap(async (args) => json(await ops.reportRepair(args))),
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
