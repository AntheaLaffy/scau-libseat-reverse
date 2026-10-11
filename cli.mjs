#!/usr/bin/env node
// 站点功能的命令行入口：一个子命令 = 一个功能。
//
//   node cli.mjs                       # 列出全部子命令
//   node cli.mjs <cmd> --help          # 看某个子命令怎么用
//   node cli.mjs rooms --query 一楼
//   node cli.mjs availability
//   node cli.mjs reserve --room 一楼思政 --date 2026-10-12 --start 09:00 --hours 3 --dry-run
//
// scripts/ 下每个功能各有一个同名薄脚本（`node scripts/rooms.mjs`），内容就是转发到这里的
// 对应子命令；两者共用同一份实现，不存在两套逻辑。
import { CaptchaUnavailable } from './captcha.mjs';
import { config, describeConfig } from './config.mjs';
import { captureSamples, probeSolver } from './flows.mjs';
import { login, sessionStatus } from './session.mjs';
import * as ops from './seatops.mjs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- 参数解析

/** --key value / --key=value / --flag / 位置参数 */
function parseArgv(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { flags, rest };
}

const num = (v) => (v === undefined ? undefined : Number(v));
const list = (v) => (v === undefined ? undefined : (Array.isArray(v) ? v : String(v).split(',').filter(Boolean)));
const bool = (v) => v === true || v === 'true' || v === '1' || v === 'yes';

/** 时长（小时）→ 结束时间 */
function endFromHours(startTime, hours) {
  if (!startTime || !hours) return undefined;
  const [h, m] = startTime.split(':').map(Number);
  const total = h * 60 + m + Math.round(Number(hours) * 60);
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function out(value) {
  console.log(JSON.stringify(value, null, 2));
  return value;
}

function need(flags, key) {
  if (flags[key] === undefined) throw new Error(`缺少 --${key}`);
  return flags[key];
}

// ---------------------------------------------------------------- 子命令表

export const commands = {
  status: {
    desc: '登录状态与配置（脱敏）',
    run: async () => out({ config: describeConfig(), session: sessionStatus() }),
  },
  login: {
    desc: '登录（cas 免验证码；--captcha 提交人工读出的码）',
    usage: '[--captcha XXXX] [--user U] [--pass P]',
    run: async ({ flags }) => {
      try {
        const res = await login({ user: flags.user, password: flags.pass, captcha: flags.captcha });
        return out({ ok: true, user: res.user, attempts: res.attempts });
      } catch (err) {
        if (err instanceof CaptchaUnavailable && err.file) {
          return out({ ok: false, needsCaptcha: true, captchaFile: err.file, hint: '看图后加 --captcha XXXX 再跑一次' });
        }
        throw err;
      }
    },
  },
  logout: { desc: '退出登录并清空内存会话', run: async () => out(await ops.api.logout().catch((e) => ({ isOk: false, message: e.message }))) },

  rooms: {
    desc: '房间/座位区列表',
    usage: '[--query 关键字] [--building 总馆] [--floor 三楼] [--open] [--space]',
    run: async ({ flags }) => out(await ops.listRooms({ query: flags.query, building: flags.building, floor: flags.floor, onlyOpen: bool(flags.open), spaceOnly: bool(flags.space) })),
  },
  availability: {
    desc: '全馆实时空位（免登录，按空位数排序）',
    usage: '[--building 总馆] [--floor 三楼] [--limit 10]',
    run: async ({ flags }) => out(await ops.availability({ building: flags.building, floor: flags.floor, limit: num(flags.limit), concurrency: num(flags.concurrency) })),
  },
  timespans: {
    desc: '可预约时间片（--type 2 取空间时间片）',
    run: async ({ flags }) => out(await ops.timespans({ type: num(flags.type) })),
  },
  seats: {
    desc: '某房间某时段座位占用（--realtime 查实时快照，免登录）',
    usage: '(--room 关键字 | --room-id ID) [--date D --start HH:mm] [--real-time] [--all]',
    run: async ({ flags }) =>
      out(
        await ops.seatStates({
          room: flags.room,
          roomId: flags['room-id'],
          date: flags.date,
          startTime: flags.start,
          endTime: flags.end,
          realtime: bool(flags['real-time'] ?? flags.realtime),
          onlyFree: !bool(flags.all),
        }),
      ),
  },
  'room-detail': {
    desc: '房间详情：时间规则 + 可预约日期 + 座位表',
    usage: '(--room 关键字 | --room-id ID) --date D --start HH:mm [--end HH:mm]',
    run: async ({ flags }) =>
      out(
        await ops.roomDetail({
          room: flags.room,
          roomId: flags['room-id'],
          date: need(flags, 'date'),
          startTime: need(flags, 'start'),
          endTime: flags.end,
          onlyFree: bool(flags.free),
        }),
      ),
  },
  'room-map': {
    desc: '房间平面图（座位分布 HTML/画布样式）',
    usage: '(--room 关键字 | --room-id ID)',
    run: async ({ flags }) => out(await ops.roomMap({ room: flags.room, roomId: flags['room-id'] })),
  },

  reserve: {
    desc: '提交预约（座位/空间）；--dry-run 只回报文',
    usage: '(--room 关键字|--room-id ID) (--seat M1C001 | --seat-id ID | --first-free) --date D --start HH:mm [--end HH:mm | --hours 3] [--reason 文本] [--dry-run]',
    run: async ({ flags }) =>
      out(
        await ops.reserve({
          room: flags.room,
          roomId: flags['room-id'],
          seatName: flags.seat,
          seatId: flags['seat-id'],
          firstFree: bool(flags['first-free']),
          date: need(flags, 'date'),
          startTime: need(flags, 'start'),
          endTime: flags.end ?? endFromHours(flags.start, flags.hours),
          reason: flags.reason ?? '',
          memberIds: list(flags.members) ?? [],
          dryRun: bool(flags['dry-run']),
        }),
      ),
  },
  mine: {
    desc: '我的预约列表',
    usage: '[--type 1|2] [--date D] [--status 1,2] [--page N] [--size N] [--raw]',
    run: async ({ flags }) =>
      out(
        await ops.myReservations({
          duetype: num(flags.type),
          duestatus: list(flags.status)?.map(Number),
          date: flags.date,
          pageNum: num(flags.page),
          pageSize: num(flags.size),
          brief: !bool(flags.raw),
        }),
      ),
  },
  today: { desc: '今日预约', run: async () => out(await ops.todayReservations()) },
  detail: {
    desc: '预约详情',
    usage: '--id ORDER_ID',
    run: async ({ flags }) => out(await ops.reservationDetail({ id: need(flags, 'id') })),
  },
  'order-log': {
    desc: '预约状态流水',
    usage: '--id ORDER_ID',
    run: async ({ flags }) => out(await ops.orderLog({ orderId: need(flags, 'id') })),
  },
  cancel: { desc: '取消预约', usage: '--id ORDER_ID', run: async ({ flags }) => out(await ops.cancel({ id: need(flags, 'id') })) },
  checkin: {
    desc: '签到（⚠️ 网页端接口，普通客户端会被拒；签不了到，只能查状态）',
    usage: '--id ORDER_ID',
    run: async ({ flags }) => out(await ops.checkin({ id: need(flags, 'id') })),
  },
  signout: { desc: '签退', usage: '--id ORDER_ID', run: async ({ flags }) => out(await ops.signout({ id: need(flags, 'id') })) },
  tempout: {
    desc: '暂离 / 归位',
    usage: '--id ORDER_ID [--back]',
    run: async ({ flags }) => out(await ops.tempout({ orderid: need(flags, 'id'), istempout: !bool(flags.back) })),
  },
  continue: {
    desc: '续座（--minutes 是续多久，单位分钟，服务端按整数收）',
    usage: '--id ORDER_ID [--minutes 30]',
    run: async ({ flags }) => out(await ops.continueOrder({ orderid: need(flags, 'id'), minutes: num(flags.minutes) ?? 30 })),
  },

  'smart-plan': {
    desc: '智能规划：找满足时长的座位方案',
    usage: '--date D --hours N [--start HH:mm] [--any-seat] [--rooms id1,id2] [--meta-only]',
    run: async ({ flags }) =>
      out(
        await ops.smartPlan({
          date: need(flags, 'date'),
          hours: Number(need(flags, 'hours')),
          startTime: flags.start,
          fullDay: bool(flags['full-day']),
          sameSeat: !bool(flags['any-seat']),
          preferMealBreak: bool(flags['meal-break']),
          preferredRoomIds: list(flags.rooms),
          metaOnly: bool(flags['meta-only']),
        }),
      ),
  },
  'smart-due': {
    desc: '按智能规划返回的 segments 批量下单',
    usage: '--segments \'[{"seatId":"..","duestartime":"..","dueendtime":".."}]\'',
    run: async ({ flags }) => out(await ops.smartDue({ segments: JSON.parse(need(flags, 'segments')) })),
  },

  group: {
    desc: '空间组队：open/close/agree/refuse/join/invitations',
    usage: '--action open --id ORDER_ID',
    run: async ({ flags }) => out(await ops.group({ action: need(flags, 'action'), orderId: flags.id })),
  },
  members: {
    desc: '同行成员：list/find/add/remove',
    usage: '--action list --id ORDER_ID | --action find --user 学号 | --action add --id ORDER_ID --member-ids u1,u2',
    run: async ({ flags }) =>
      out(await ops.members({ action: need(flags, 'action'), id: flags.id, userName: flags.user, memberIds: list(flags['member-ids']) })),
  },

  me: { desc: '我的档案：积分 / 违约 / 总预约数', run: async () => out(await ops.me()) },
  home: { desc: '首页概览：房间 + 统计', run: async () => out(await ops.home()) },
  districts: { desc: '校区 / 区域列表', run: async () => out(await ops.districts()) },
  announcements: {
    desc: '公告（--full 带正文）',
    usage: '[--page N] [--size N] [--full]',
    run: async ({ flags }) => out(await ops.announcements({ pageNum: num(flags.page), pageSize: num(flags.size), withContent: bool(flags.full) })),
  },
  faq: { desc: '常见问题（官方问答）', run: async () => out(await ops.faqs()) },
  holidays: { desc: '假期 / 闭馆安排', run: async () => out(await ops.holidays()) },
  violations: {
    desc: '我的违约记录',
    usage: '[--page N] [--size N]',
    run: async ({ flags }) => out(await ops.violations({ pageNum: num(flags.page), pageSize: num(flags.size) })),
  },
  'violations-read': { desc: '标记违约提醒已读', run: async () => out(await ops.markViolationsRead()) },
  assets: {
    desc: '座位/房间里的设备（报修前拿 assetItemId）',
    usage: '--kind seat|room --id ID',
    run: async ({ flags }) => out(await ops.assets({ kind: need(flags, 'kind'), id: need(flags, 'id') })),
  },
  repair: {
    desc: '设备报修',
    usage: '--asset-item-id ID --desc "灯不亮"',
    run: async ({ flags }) =>
      out(await ops.reportRepair({ assetItemId: need(flags, 'asset-item-id'), reportDesc: need(flags, 'desc'), reportUser: flags.user, reportPhone: flags.phone })),
  },

  captcha: {
    desc: '抓验证码样本',
    usage: '[--count N]',
    run: async ({ flags }) => out((await captureSamples({ count: num(flags.count) ?? 1 })).map((s) => s.file)),
  },
  probe: {
    desc: '求解器命中率探针',
    usage: '[--rounds N]',
    run: async ({ flags }) => out(await probeSolver({ rounds: num(flags.rounds) ?? 5 })),
  },
  api: {
    desc: '原始接口逃生舱',
    usage: '--path /web/user/duelist [--method POST] [--body \'{"pageNum":1}\'] [--auth]',
    run: async ({ flags }) => {
      const { request } = await import('./http.mjs');
      const method = (flags.method ?? 'POST').toUpperCase();
      const body = flags.body ? JSON.parse(flags.body) : undefined;
      const run = () => request(method, need(flags, 'path'), { body, auth: bool(flags.auth) });
      return out(bool(flags.auth) ? await ops.authed(run) : await run());
    },
  },
};

// ---------------------------------------------------------------- 入口

export function helpText() {
  const width = Math.max(...Object.keys(commands).map((k) => k.length));
  return [
    'libseat-scau CLI —— 每个子命令对应站点的一个功能。',
    '',
    '用法: node cli.mjs <command> [options]',
    '',
    ...Object.entries(commands).map(([name, c]) => `  ${name.padEnd(width)}  ${c.desc}${c.usage ? `\n${' '.repeat(width + 6)}用法: ${c.usage}` : ''}`),
    '',
    `站点: ${config.baseUrl}   登录模式: ${config.loginMode}   账号: ${config.user ? '已配置' : '未配置（先在 .env 填 LIBSEAT_USER/LIBSEAT_PASS）'}`,
  ].join('\n');
}

export async function run(name, argv = []) {
  const cmd = commands[name];
  if (!cmd) {
    console.error(`未知子命令: ${name}\n`);
    console.error(helpText());
    process.exitCode = 2;
    return;
  }
  const { flags } = parseArgv(argv);
  if (flags.help) {
    console.log(`${name} — ${cmd.desc}\n用法: node cli.mjs ${name} ${cmd.usage ?? ''}`);
    return;
  }
  try {
    await cmd.run({ flags, argv });
  } catch (err) {
    console.error(`✗ ${name}: ${err.message}`);
    if (process.env.LIBSEAT_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}

// 直接运行时：node cli.mjs <cmd> ...
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [name, ...argv] = process.argv.slice(2);
  if (!name || name === '--help' || name === '-h' || name === 'help') {
    console.log(helpText());
  } else {
    await run(name, argv);
  }
}
