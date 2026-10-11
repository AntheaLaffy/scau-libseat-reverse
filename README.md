# 华南农业大学图书馆座位预约系统逆向（libseat.scau.edu.cn）

对图书馆座位预约系统的协议逆向，外加一个 stdio MCP server（**36 个工具**）：账号密码登录
（走统一身份认证，**免验证码**）、查空座与实时空位、房间详情与平面图、提交/取消预约、
签到签退、暂离归位、续座、智能规划与批量下单、空间组队与同行成员、公告/FAQ/假期、
违约记录、资产报修。另附 **36 个 CLI 子命令 + 36 个脚本**（`cli.mjs` / `scripts/`：34 个功能脚本 + 全量对账 + 签到兜底）。

面向的是**自己的账号**：所有请求都以你本人身份发出，站方规则（每人每天最多 3 次、
开馆时段、开始后 15 分钟内签到、离馆 40 分钟内归位）照常生效。

- 完整逆向记录（接口表、验证码规则与实测数据、CAS 三步协议、读图命中率、踩过的坑）：
  [docs/逆向记录.md](docs/逆向记录.md)
- 成果摘要（逆完了什么、实测结论、交付物清单、边界、**抓包方法**）：
  [docs/成果.md](docs/成果.md)
- 验证码样本与 manifest（会话值只留 `jsessionid_sha256` 指纹，不落原文），可用来训练 / 回归自己的求解器：
  [`captcha-samples/`](captcha-samples/)

## 两个副本：仓库 + 番茄todo 实际加载的那份

- **这里**是正式仓库：源码、逆向记录、样本、GitHub 历史都在这里。
- `~/code/todo/mcp/libseat/` 是**番茄todo 实际加载的副本**（那个仓库的 `/mcp/` 被 gitignore，
  所以它不入库）。app 的 `mcp.json`（`~/.local/share/studio.tomato.todo/agent/mcp.json`）里
  `seat` 指向副本的 `server.mjs`：

  ```json
  {
    "mcpServers": {
      "seat": {
        "command": "/home/fuurin/.local/lib/tomato-todo/agent/bin/node",
        "args": ["/home/fuurin/code/todo/mcp/libseat/server.mjs"],
        "env": { "LIBSEAT_ENV_FILE": "/home/fuurin/code/todo/mcp/libseat/.env" },
        "exposure": "codemode",
        "description": "华南农业大学图书馆座位：查空座、看预约、下单/签到/签退/取消"
      }
    }
  }
  ```

  路径按自己机器改。`exposure: codemode` 表示助手在代码里调用这些工具（工具名形如
  `mcp__seat__libseat_*`），不会撑大工具声明；助手只在用户主动发起的对话里连接 MCP，
  自动唤醒轮次不加载。
- 在**这边**改完代码，跑 `./sync-to-copy.sh` 同步到副本（`.env`、样本、`node_modules` 不同步）。

## 免责

本项目只做协议逆向与个人自动化：所有请求都以**你自己的账号**身份发出，不绕过鉴权、
不碰别人的数据。站方规则（每人每天最多 3 次预约、开馆时段、开始后 15 分钟内签到、
离馆 40 分钟内归位、违规计数）由服务端强制，本工具不会也不能改变。请勿用于高频轮询、
代他人抢座或转卖座位。

---

## MCP server

外置 MCP server（stdio），目标站点 <https://libseat.scau.edu.cn/>。账号密码写在本地
`.env`，进程内存里维持会话，401 自动重登，验证码走可插拔求解器。

本仓库就是源码本体；`.env`（凭据）与 `*-session.json` / `*-pending.json` 被 `.gitignore` 排除，
验证码样本只落 `jsessionid_sha256` 指纹、不落会话原文。

## 安装

```bash
bash install.sh                  # 装依赖 + 生成 .env + 注册到 Codex + 自检
```

装完重启 Codex 会话，MCP 里会出现 `libseat-scau` 的 `libseat_*` 工具。

## 逆向结论

前端是 Vite SPA，接口全部由 `/assets/*.js` 逆向得到（前端用 `fetch` +
`credentials:"include"`，**没有任何 Authorization/token 机制**）。

| 用途 | 方法 | 路径 | 请求体 |
| --- | --- | --- | --- |
| 验证码 | GET | `/api/web/user/captcha?t=<ms>` | — |
| 登录 | POST | `/api/web/user/login` | `{userName, password, captcha}` |
| 登出 | POST | `/api/web/user/logout` | — |
| 当前用户 | POST | `/api/web/pc/user` | — |
| 房间列表 | POST | `/api/public/home` | `{}` |
| 时间片/楼层标签 | POST | `/api/public/taglist` | — |
| 座位占用（公开） | POST | `/api/public/seatState` | `{roomId, startTime, endTime}` |
| 座位占用（登录） | POST | `/api/web/user/seatState` | 同上 |
| **提交预约** | POST | `/api/web/user/due` | `{seatesid, duestartime, dueendtime, reason, memberids}` |
| 我的预约 | POST | `/api/web/user/duelist` | `{duetype, pageNum, pageSize, duestatus?, startDate?, endDate?}` |
| 预约详情 | POST | `/api/web/user/duedetail` | `{id}` |
| 取消 | POST | `/api/web/user/cancel` | `{id}` |
| 签到 | POST | `/api/web/user/checkin/sign` | `{id}` |
| 签退 | POST | `/api/web/user/signout` | `{id}` |
| 暂离/归位 | POST | `/api/web/user/tempout` | `{orderid, istempout}` |
| 续座 | POST | `/api/web/user/continueOrder` | `{orderid, continuetime}` |
| 状态流水 | POST | `/api/web/seatOrderStateLog/listByOrderId` | `{orderId}` |
| CAS 单点登录 | GET | `/sso/scau/` | → 302 `https://cas.scau.edu.cn/lyuapServer/login?service=...` |

要点：

- **密码是明文提交**，没有 RSA/AES/SM2 之类的客户端加密，也没有时间戳签名。
- **座位二维码没有凭据**：解出来就是 `https://libseat.scau.edu.cn/use?seatName=<座位名>`，
  没有 token / 订单号 / 签名；`/use` 甚至不是前端路由（兜底给 `index.html`）。
- **签到走的是两条接口**：网页端 `POST /web/user/checkin/sign {id}` 被设备授权锁死
  （`本机未授权，请到馆内签到机操作`，换网络/换 IP/换 UA 都无效），手机端用的是
  `POST /web/user/in {id}`（不在前端 bundle 里）—— 详见 [docs/成果.md](docs/成果.md) 第 5 节。
- 「预约」在站点内部叫 **due**，`seatesid` 用的是座位表里的 `seatid`（不是 `code`）。
- 时间段格式前后不一致，照抄前端：查询座位用 `"YYYY-MM-DD HH:mm:ss"`，提交预约用 `"YYYY-MM-DD HH:mm"`；
  结束时间 = 最后一个半小时片 + 30 分钟。
- `/op/*` 那几个接口要 `Idempotent-Token` 头（`GET /api/op/idempotent/token`），座位预约主流程用不到，
  但 `http.mjs` 里已经按前端的做法自动补。

## 登录链路与「不用 cookie」

```
GET  /api/web/user/captcha   -> 120x40 JPEG + Set-Cookie: JSESSIONID=...
POST /api/web/user/login     -> {userName, password, captcha}   同一条 JSESSIONID
```

### 两条登录路径（`LIBSEAT_LOGIN_MODE`）

| 模式 | 说明 | 验证码 |
| --- | --- | --- |
| `cas`（默认） | 走学校统一身份认证：`POST {CAS}/v1/tickets`（RSA 加密密码）→ 拿 ticket → `GET /sso/scau?ticket=…` 换业务会话。实测 418ms，**全程没有验证码** | 无 |
| `local` | 走站点自带的 `/api/web/user/login`，密码明文 + 图形验证码（ddddocr 求解，`LIBSEAT_LOGIN_RETRIES` 次换图重试） | 每次都要 |

会话本身是 `webuser` cookie 里的 JWT，**有效期 7 天**，所以正常情况下一周才需要重登一次；
401 时 `ensureLogin()` 会自动按当前模式重登。

CAS 的加密算法不是 PKCS#1，而是前端那套「BigInt + Barrett 分块裸 RSA」（公钥硬编码在
`app.<hash>.js` 的 module 7）；细节和踩过的坑见 `docs/LIBSEAT_MCP.md` 的「统一身份认证链路」。

验证码规则（全部实测，见下面的“证据”）：

- 验证码**与 JSESSIONID 绑定**：不带 cookie 提交、或换一条会话提交，一律 `验证码错误`；
- **区分大小写**：`FYRV` 通过、`fyrv` 拒绝；
- **一次一图**：校验失败、**或那次校验通过之后**，同一张图都不再可用 → 重试必须换图+换会话
  （真账号实测：某个码被接受后，同一条会话上再提交它、或者干脆不带码，都回 `验证码错误`，
  说明服务端逐次校验、没有会话级豁免）；
- 服务端**先校验验证码、再查账号**：验证码对了但账号不存在 → `{"message":"user can not find"}`。

最后一条正好是判断“求解器给的码是否被服务端接受”的确定性信号，`libseat_captcha_probe`
就是靠它算命中率的（不需要一个能登录成功的账号）。

所以「不用 cookie 的方案」在这里的落地是：**不落盘、不复用、不导出任何 cookie**，
只在内存里维持当前会话；每个进程启动 / 每次 401 / 每次验证码失败都重新走一遍完整的
`新会话 + 新验证码 + 登录`。cookie 本身是协议的一部分，绕不过去，绕过去反而是最脆的做法
（存下来的 JSESSIONID 一失效就得人工重登）。

### 证据（实测）

```bash
# 1. 抓图：拿到图 + 它绑定的 JSESSIONID
curl -sS -c jar.txt 'https://libseat.scau.edu.cn/api/web/user/captcha?t=1' -o cap.jpg
magick cap.jpg -colorspace Gray -normalize -filter Lanczos -resize 500% cap_big.png   # 放大读图

# 2. 人工读图得 FYRV，带上同一条会话提交（假账号，只验证链路）
curl -sS -b jar.txt -X POST https://libseat.scau.edu.cn/api/web/user/login \
  -H 'content-type: application/json' \
  --data '{"userName":"test0000","password":"test0000","captcha":"FYRV"}'
# -> {"isOk":false,"message":"user can not find","data":null,"code":null}   ← 验证码被接受

curl -sS -b jar.txt -X POST ... --data '{...,"captcha":"fyrv"}'   # -> 验证码错误（大小写敏感）
curl -sS          -X POST ... --data '{...,"captcha":"FYRV"}'   # 不带 cookie -> 验证码错误
```

## 验证码：稳定复现方式

三件套必须绑在一起，缺一不可：**字节确定的图 + 生成它的 JSESSIONID + 那次登录判定**。
每次尝试都落盘：

```
captcha-samples/<时间戳>-<sha256前8位>.jpg
captcha-samples/manifest.jsonl      {"ts","file","sha256","bytes","jsessionid_sha256","kind",...}
```

三条入口：

1. `libseat_captcha_capture(count)` —— 连抓 N 张（每张独立会话）入数据集。
2. `libseat_captcha_probe(rounds)` —— **确定性探针**：抓图 → 求解 → 用探针账号提交一次。
   - `captcha_rejected`：服务端拒绝该码；
   - `captcha_accepted`：码通过了，报错已经落到账号/密码层。
   用它算出的命中率是求解器的真实命中率，不需要一个能登录成功的账号。
3. `LIBSEAT_CAPTCHA_MODE=manual` —— 只抓图不解码。两步握手：`libseat_login` 先把图片内联返回，
   同时把「这张图 + 它的 JSESSIONID」留成待解码状态；读出 4 位后带 `captcha` 参数再调一次，
   **在原会话上原样提交**。码不对不直接失败，会自动换新图并把下一张图交回来 —— 一次调用 = 一张图。

### Agent 自己读图行不行？（实测）

可以，但不是一次就对。用 `readcheck.mjs` 做了两轮、共 10 张图，人工/模型读图后按原会话提交，
以服务端的 `user can not find`（码被接受）为客观判定：

```
第 1 轮：XHG8 ✓  YPDY ✗  PHXG ✗  SEYJ ✓  FC9C ✗     2/5
第 2 轮：K479 ✗  ALCH ✓  ATTL ✗  9RUE ✗  49XR ✗     1/5
首次命中 30%
```

所以「agent 有能力处理登录」这件事，关键不在单次读对，而在**每次失败只损失一张图**：
`LIBSEAT_LOGIN_RETRIES=5` 把 30% 的单图命中抬到 `1-0.7^5 ≈ 83%`，10 次 ≈ 97%。
当前这套 `login` 就是按这个语义写的：失败 → 换新会话+新图 → 再来，不需要你介入。
想要更稳就上求解器：把预处理（去干扰线）+ 定制 OCR 接到 `command`/`http` 契约上，
再用 `--probe N` 量命中率。

### 接你自己的求解器

只要满足下面任一契约，其它代码不用动：

- `command`：`LIBSEAT_CAPTCHA_CMD=python3 my_solver.py {file}`，stdout 输出 4 位码。
  参考实现见 `solvers/ddddocr_cli.py`（仅为演示接口，不保证命中率）。
- `http`：`LIBSEAT_CAPTCHA_HTTP_URL=...`，收到 `POST {"image_base64": "...", "image_sha256": "..."}`，
  返回 `{"code":"abcd"}` 或纯文本。

调参闭环：`node doctor.mjs --probe 20` → 看 `accuracy` → 改求解器 → 再来一轮。

**当前已接的基线是 ddddocr**（`.env` 里已配好，`uv` 自动挑兼容的 Python）：

```
LIBSEAT_CAPTCHA_MODE=command
LIBSEAT_CAPTCHA_CMD=uv run --python 3.12 --with ddddocr python /abs/path/solvers/ddddocr_cli.py {file}
```

实测单图 44%（假探针账号 `--probe 12`，服务端判定为准），配 `LIBSEAT_LOGIN_RETRIES=5` ≈ 95%。
两个坑：**输出要转大写**（ddddocr 大小写不稳，站点区分大小写），**放大预处理没用**（实测无改善）。
剩余误差来自它只吐 3 个字符或者吐汉字（字符集含中文），这种情况会直接换下一张图，不算账。

## 工具

| 工具 | 说明 |
| --- | --- |
| `libseat_status` | 配置 + 登录状态（脱敏，不回显密码） |
| `libseat_login` / `libseat_logout` | 登录 / 退出；登录支持 `captcha` 单次人工提交 |
| `libseat_captcha_capture` | 抓验证码样本（可选内联图片） |
| `libseat_captcha_probe` | 求解器命中率探针 |
| `libseat_rooms` / `libseat_timespans` | 房间与时间片（公开，免登录） |
| `libseat_seats` | 某房间某时段座位占用；`realtime=true` 走公开接口查「现在」的快照（免登录） |
| `libseat_reserve` | 提交预约（可给 seatId 或 seatName） |
| `libseat_my_reservations` / `libseat_reservation_detail` | 预约列表 / 详情 |
| `libseat_today` / `libseat_order_log` | 今日预约 / 预约状态流水 |
| `libseat_cancel` / `libseat_checkin` / `libseat_signout` / `libseat_tempout` / `libseat_continue` | 取消 / 签到 / 签退 / 暂离归位 / 续座 |
| `libseat_smart_plan` / `libseat_smart_due` | 智能规划（候选座位方案）/ 按方案批量下单 |
| `libseat_group` / `libseat_members` | 空间组队（open/close/agree/refuse/join/邀请）/ 同行成员（list/find/add/remove） |
| `libseat_me` / `libseat_home` / `libseat_districts` | 我的档案（积分/违约）/ 首页概览 / 校区 |
| `libseat_room_detail` / `libseat_room_map` | 房间详情（规则+可预约日期+座位表）/ 房间平面图 |
| `libseat_availability` | 全馆实时空位（公开接口，免登录） |
| `libseat_announcements` / `libseat_faq` / `libseat_holidays` | 公告 / 常见问题 / 假期闭馆 |
| `libseat_violations` / `libseat_violations_read` | 违约记录 / 标记提醒已读 |
| `libseat_assets` / `libseat_report_repair` | 座位/房间设备 / 报修 |
| `libseat_api` | 原始接口逃生舱（站点改版时用） |

> ⚠️ `libseat_checkin` 打的是网页端那条被设备授权锁死的接口（`本机未授权，请到馆内签到机操作`）。
> 日常签到用手机扫码或馆内签到机；这条工具留着是为了记录/对照，别当签到用。

合计 **36 个工具**，覆盖站点前台的全部功能（座位 + 研讨间空间、预约全生命周期、
智能规划、组队与同行成员、公告/FAQ/违约/资产报修）。

## 命令行：一串脚本，一个功能一个

不想走 MCP 的话，`cli.mjs` + `scripts/` 把每个功能做成了可以直接跑的脚本
（`scripts/<功能>.mjs` 就是转发到 `cli.mjs` 的同名子命令，实现只有一份：
`cli.mjs` → `seatops.mjs` → `api.mjs`）。

```bash
node cli.mjs                                  # 列出全部子命令
node scripts/rooms.mjs --query 一楼
node scripts/availability.mjs                 # 现在哪儿有空位（免登录）
node scripts/reserve.mjs --room 一楼思政 --first-free --date 2026-10-12 --start 09:00 --hours 3 --dry-run
node scripts/mine.mjs --size 5
node scripts/checkin.mjs --id <ORDER_ID>
node scripts/run-all.mjs                      # 只读功能全跑一遍，逐条对账
```

完整清单见 [`scripts/README.md`](scripts/README.md)。

## CLI 自检

```bash
node doctor.mjs                # 配置 + 公共接口 + 抓一张验证码
node doctor.mjs --rooms        # 打印房间列表
node doctor.mjs --capture 10   # 抓 10 张样本
node doctor.mjs --login        # 用 .env 账号真实登录
node doctor.mjs --login --captcha AB3D   # 人工读图后单次提交
node doctor.mjs --probe 10     # 求解器探针
node readcheck.mjs capture 5   # 抓 5 张（各自会话）供人/模型读
node readcheck.mjs submit FYRV 3A48 ...   # 按顺序提交读到的码，打印命中率

# 真账号：登录本身、以及“登录后下次登录还要不要验证码”
node logintest.mjs --multi 4                  # 抓 4 张（各自会话），给读图留试错余地
node logintest.mjs --codes AAAA BBBB CCCC DDDD   # 按顺序试，登进去的会话跑完整套判定
node logintest.mjs --reuse 2 --code TWCU      # 在“码已被接受过”的会话上测是否还免验证码
node logintest.mjs --captcha AB3D --watch 60  # 追加会话寿命观测（最多 60 分钟）
```

## 已验证 / 未验证

已验证（联网实测）：

- `/public/home`（10 个房间）、`/public/taglist`（31 个时间片）、`/public/seatState`（座位表 `seatname/count/seatid`）；
- `/web/user/captcha` → JPEG 120x40 + `Set-Cookie: JSESSIONID`；
- **登录链路一直通到账号查询**：人工读图提交正确验证码 → `user can not find`（见上方证据）；
- 401 约定：`/web/pc/*`、`/web/user/*` 未登录返回 `{"code":401,"msg":"请登录访问"}`；
- MCP 协议层：`node smoke.mjs` 完成 initialize / tools/list（36 个工具）/ tools/call（真实取到房间列表）；
- 进程存活：常开管道下 server 持续在线、管道关闭（EOF）才退出。

第二轮（2026-10-11 晚，真账号实测）已把这些跑到确定结论：

| 分支 | 结论 |
| --- | --- |
| `due` 提交 | ✔ 成功（19:32 下 20:00 档，返回完整 `order` + `rule`）；过去时间被拒；次日档要等当天 **20:00 放号** |
| `duelist` / `duedetail` / `todaylist` / 状态流水 | ✔ 成功 |
| `cancel` | ✔ 成功（订单转 `duestatu:4 / dueendstatu:1`） |
| `smartPlan` / `smartDue` | ✔ 20:00 后跑通，`maxDate` 自动变次日 |
| `checkin` | ✗ `checkin/sign` 被设备授权锁死（`本机未授权，请到馆内签到机操作`），换 SSID/AP、换源 IP、换 UA/Referer 都无效。抓包+订单流水坐实：**手机签到走的是另一条接口 `/api/web/user/in`**（不在前端 bundle 里，移动端客户端用的），本条记录结论、不封装成远程签到 |
| `signout` / `tempout` / `continueOrder` | 需要已签到且到开始时间，当前账号拿不到；已确认 `continuetime` 是**整数分钟** |
| 组队 / 成员 / 违约 / 资产 / 公告 / FAQ | ✔ 读接口全通；成员搜索按**学号**匹配（姓名搜不到） |

字段与路径来自前端 bundle，若站点改版，用 `libseat_api` 逃生舱对一下即可。

> 沙箱提示：Codex 的受限执行环境里，嵌套子进程的管道会丢数据（`smoke.mjs` 会拿不到任何回复）。
> 在普通终端里跑 `node smoke.mjs` 是正常的；这不是 server 的问题。

## 边界

密码明文提交、验证码与 JSESSIONID 绑定，这个 MCP 做的是「模拟你自己在浏览器里登录」。
自动化抢座可能与该站的用户协议冲突（每人每天最多 3 次、开馆时段、15 分钟签到等规则
仍然生效，服务端会拒绝），先确认学校是否允许再用；别拿去做高频轮询或帮别人刷座。
