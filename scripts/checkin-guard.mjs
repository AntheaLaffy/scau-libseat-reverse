#!/usr/bin/env node
// 签到兜底：场馆里偶尔「本机未授权」签不上，人却在座位上 —— 这个脚本在签到窗口内
// 反复重试签到，一旦成功就停；如果到取消截止（开始前 1 分钟）还是没签上，就自动
// 取消订单，避免白背一次违约，并把全过程落盘当证据（找管理员撤销/申诉时用）。
//
//   node scripts/checkin-guard.mjs --id 545107005610655744
//   node scripts/checkin-guard.mjs --id <ORDER> --interval 15 --cancel-on-fail
//   node scripts/checkin-guard.mjs --id <ORDER> --log /tmp/checkin-guard.log
//
// 注意：它只反复打站点的签到接口，不伪造设备/位置。签不上说明服务端不认这台机器，
// 那时该做的是去签到机、或用手机扫码，而不是把身份伪造成签到机。
import { appendFileSync } from 'node:fs';
import { checkin, cancel, myReservations } from '../seatops.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const id = arg('id');
if (!id) {
  console.error('用法: node scripts/checkin-guard.mjs --id <ORDER_ID> [--interval 20] [--cancel-on-fail] [--log FILE]');
  process.exit(2);
}
const intervalSec = Number(arg('interval', 20));
const minutesOf = (s) => (s ? new Date(s.replace(/-/g, '/')).getTime() : 0);
const logFile = arg('log', null);
const log = (line) => {
  const s = `[${new Date().toLocaleString('zh-CN')}] ${line}`;
  console.log(s);
  if (logFile) appendFileSync(logFile, `${s}\n`);
};

const findOrder = async () => {
  const mine = await myReservations({ pageSize: 50, brief: false });
  return (mine.raw?.list ?? []).find((o) => String(o.id) === String(id));
};

let order = await findOrder();
if (!order) {
  console.error(`订单 ${id} 找不到（是不是今天/本周之外的？）`);
  process.exit(2);
}
const seat = order.seatname || order.room;
const signEnd = minutesOf(order.signend);
const cancelBy = minutesOf(order.iscancancel);
log(`盯着订单 ${id}｜${order.room} ${seat}｜签到窗口 ${order.signstar} → ${order.signend}｜取消截止 ${order.iscancancel}`);

let attempt = 0;
for (;;) {
  attempt += 1;
  const now = Date.now();
  if (order.signin === 1) {
    log(`✔ 已签到（signin=1），收工`);
    process.exit(0);
  }
  if (signEnd && now > signEnd) {
    log(`✗ 签到窗口已过仍未签上（${attempt - 1} 次尝试）。`);
    if (order.signin !== 1 && now < cancelBy) {
      log('…仍在取消截止前，尝试取消以免违约');
    }
    process.exit(2);
  }
  if (cancelBy && now >= cancelBy - 60_000) {
    if (has('cancel-on-fail')) {
      const res = await cancel({ id });
      log(`⏰ 到取消截止还没签上，已取消：ok=${res.ok} ${res.message}`);
    } else {
      log('⏰ 到取消截止还没签上；没加 --cancel-on-fail，请自己决定是否取消（再晚就算违约了）');
    }
    process.exit(3);
  }
  try {
    const res = await checkin({ id });
    log(`#${attempt} 签到：ok=${res.ok} signedIn=${res.signedIn} message=${res.message}`);
    if (res.ok && res.signedIn) process.exit(0);
  } catch (err) {
    log(`#${attempt} 签到异常：${err.message}`);
  }
  order = (await findOrder()) ?? order;
  if (order.signin === 1) {
    log('✔ 复查到 signin=1（可能是你手机扫的），收工');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, intervalSec * 1000));
}
