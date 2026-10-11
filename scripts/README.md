# scripts/ —— 一站一功能，每个功能一个脚本

这里是把站点功能拆成**一串可以直接跑的独立脚本**：一个脚本 = 一个功能，
`node scripts/<名字>.mjs` 就能用，适合在改版后逐条对账、也方便单独调参。

每个脚本都只是把参数转发给 `../cli.mjs` 的对应子命令，实现只有一份
（`cli.mjs` → `seatops.mjs` → `api.mjs`），所以脚本之间不会各自漂移。

```bash
node scripts/rooms.mjs --query 一楼        # 看有哪些房间
node scripts/availability.mjs              # 现在哪儿有空位（免登录）
node scripts/seats.mjs --room 一楼思政 --date 2026-10-12 --start 09:00
node scripts/reserve.mjs --room 一楼思政 --first-free --date 2026-10-12 --start 09:00 --hours 3 --dry-run
```

`node scripts/<名字>.mjs --help` 看该功能的参数；`node ../cli.mjs` 看全部子命令。

## 全部脚本

| 分组 | 脚本 | 说明 |
| --- | --- | --- |
| 会话 | `status.mjs` | 登录状态与配置 |
| | `login.mjs` | 登录（cas 免验证码；`--captcha` 提交人工读出的码） |
| | `captcha.mjs` | 抓验证码样本 |
| | `probe.mjs` | 求解器命中率探针 |
| 查 | `rooms.mjs` | 房间/座位区列表 |
| | `availability.mjs` | 全馆实时空位（免登录） |
| | `timespans.mjs` | 可预约时间片 |
| | `seats.mjs` | 某房间某时段的座位占用（`--real-time` 免登录） |
| | `room-detail.mjs` | 房间详情：时间规则 + 可预约日期 + 座位表 |
| | `room-map.mjs` | 房间平面图（座位分布） |
| 预约 | `reserve.mjs` | 提交预约（座位/空间） |
| | `mine.mjs` | 我的预约列表 |
| | `today.mjs` | 今日预约 |
| | `detail.mjs` | 预约详情 |
| | `order-log.mjs` | 预约状态流水 |
| | `cancel.mjs` | 取消预约 |
| | `checkin.mjs` | 签到（⚠️ 网页端接口，普通客户端会被拒 —— 签不了到，只能查状态） |
| | `checkin-guard.mjs` | 签到兜底：盯自己的签到有没有成功（比如手机扫的），到取消截止还没签上就自动撤单，全程落盘当证据。**它不能替你签到**（那条接口被锁死） |
| | `signout.mjs` | 签退 |
| | `tempout.mjs` | 暂离 / 归位 |
| | `continue.mjs` | 续座 |
| | `smart-plan.mjs` | 智能规划：找满足时长的座位方案 |
| | `smart-due.mjs` | 按规划批量下单 |
| 空间协作 | `group.mjs` | 组队 / 同意 / 加入 / 邀请列表 |
| | `members.mjs` | 同行成员：list / find / add / remove |
| 账号与信息 | `me.mjs` | 我的档案：积分、违约、总预约数 |
| | `home.mjs` | 首页概览 |
| | `districts.mjs` | 校区 / 区域列表 |
| | `announcements.mjs` | 公告（`--full` 带正文） |
| | `faq.mjs` | 常见问题 |
| | `holidays.mjs` | 假期 / 闭馆安排 |
| | `violations.mjs` | 我的违约记录 |
| 资产 | `assets.mjs` | 座位/房间里的设备 |
| | `repair.mjs` | 设备报修 |
| 逃生舱 | `api.mjs` | 原始接口调用 |

## 一把梭

```bash
node scripts/run-all.mjs            # 只读命令全跑一遍（含 CAS 登录、实时空位、座位表…）
node scripts/run-all.mjs --write    # 追加 dry-run 写入（reserve --dry-run、members list）
```

任何一个失败都会在末尾汇总，退出码非 0；改版后先跑这个，就知道是哪一块坏了。
