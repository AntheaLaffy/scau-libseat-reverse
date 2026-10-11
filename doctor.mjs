#!/usr/bin/env node
// 自检 CLI：配置 / 连通性 / 验证码 / 登录 / 求解器探针。
//
//   node doctor.mjs                # 配置 + 公共接口 + 抓一张验证码
//   node doctor.mjs --capture 5    # 抓 5 张样本
//   node doctor.mjs --login        # 用 .env 里的账号真实登录一次
//   node doctor.mjs --probe 10     # 求解器探针 10 轮（拿命中率）
//   node doctor.mjs --rooms        # 打印房间列表
import { api } from './api.mjs';
import { describeCaptchaMode } from './captcha.mjs';
import { config, describeConfig } from './config.mjs';
import { captureSamples, probeSolver } from './flows.mjs';
import { sessionStatus, login, forgetSession } from './session.mjs';

const argv = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const hasFlag = (name) => argv.includes(name);

const print = (label, value) => console.log(`\n== ${label} ==\n${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`);

async function main() {
  print('配置', describeConfig());
  print('验证码求解', describeCaptchaMode());

  print('公共接口连通性', '');
  try {
    const rooms = await api.rooms({});
    const tags = await api.taglistPublic();
    console.log(`  /public/home   ok  rooms=${rooms?.data?.rooms?.length ?? 0}`);
    console.log(`  /public/taglist ok  timespans=${tags?.data?.timspans?.length ?? 0}`);
    if (hasFlag('--rooms')) {
      for (const r of rooms.data.rooms) console.log(`  - ${r.name}  id=${r.id}  空位=${r.availableseatcount}`);
    }
  } catch (err) {
    console.log(`  ✗ 公共接口失败: ${err.message}`);
    process.exitCode = 1;
  }

  const captureCount = Number(argValue('--capture', 0));
  const doDefaultCapture = !hasFlag('--login') && !hasFlag('--probe') && !captureCount;
  const n = captureCount || (doDefaultCapture ? 1 : 0);
  if (n > 0) {
    const samples = await captureSamples({ count: n });
    print(`验证码样本 (${n})`, { dir: config.captchaDir, files: samples.map((s) => s.file) });
    console.log('  用图片查看器打开上面任一文件，人工识别后可用：node doctor.mjs --login --captcha XXXX');
  }

  if (hasFlag('--probe')) {
    const rounds = Number(argValue('--probe', 5)) || 5;
    print(`求解器探针 (${rounds} 轮)`, await probeSolver({ rounds }));
  }

  if (hasFlag('--login')) {
    forgetSession();
    const captcha = argValue('--captcha', undefined);
    try {
      const res = await login({ captcha });
      print('登录成功', { user: res.user, captchaFile: res.captchaFile, attempts: res.attempts });
      print('会话', sessionStatus());
      const me = await api.me().catch(() => null);
      if (me) print('/web/pc/user', me);
    } catch (err) {
      print('登录失败', { name: err.name, message: err.message, captchaFile: err.file, attempts: err.attempts });
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(`doctor 失败: ${err.stack ?? err.message}`);
  process.exit(1);
});
