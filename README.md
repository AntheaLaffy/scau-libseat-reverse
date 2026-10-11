# 华南农业大学图书馆座位预约系统逆向（libseat.scau.edu.cn）

对图书馆座位预约系统的协议逆向，外加一个 stdio MCP server（16 个工具）：账号密码登录
（走统一身份认证，**免验证码**）、查空座、看/取消预约、签到签退、预约详情。

面向的是**自己的账号**：所有请求都以你本人身份发出，站方规则（每人每天最多 3 次、
开馆时段、开始后 15 分钟内签到、离馆 40 分钟内归位）照常生效。

- 完整逆向记录（接口表、验证码规则与实测数据、CAS 三步协议、读图命中率、踩过的坑）：
  [docs/逆向记录.md](docs/逆向记录.md)
- 验证码样本与 manifest（`jsessionid` 已剔除），可用来训练 / 回归自己的求解器：
  [`captcha-samples/`](captcha-samples/)

下面这节起是 MCP server 自身的说明。

---

# libseat-scau MCP（华南农业大学图书馆座位预约）

外置 MCP server（stdio），目标站点 <https://libseat.scau.edu.cn/>。账号密码写在本地
`.env`，进程内存里维持会话，401 自动重登，验证码走可插拔求解器。

本目录整体被 `.gitignore`（`/mcp/`）排除，不入库；`.env` 内含凭据，`chmod 600`。

## 安装

```bash
bash mcp/libseat/install.sh      # 装依赖 + 生成 .env + 注册到 Codex + 自检
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
captcha-samples/manifest.jsonl      {"ts","file","sha256","bytes","jsessionid","kind",...}
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
| `libseat_seats` | 某房间某时段座位占用（需登录） |
| `libseat_reserve` | 提交预约（可给 seatId 或 seatName） |
| `libseat_my_reservations` / `libseat_reservation_detail` | 预约列表 / 详情 |
| `libseat_cancel` / `libseat_checkin` / `libseat_signout` / `libseat_tempout` | 取消 / 签到 / 签退 / 暂离归位 |
| `libseat_api` | 原始接口逃生舱（站点改版时用） |

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
- MCP 协议层：`node smoke.mjs` 完成 initialize / tools/list（16 个工具）/ tools/call（真实取到房间列表）；
- 进程存活：常开管道下 server 持续在线、管道关闭（EOF）才退出。

未验证（需要你的账号或求解器才能真正跑成功分支）：`due` 提交、`duelist`/`duedetail`、
`cancel`/`checkin`/`signout`/`tempout` 的成功返回。字段与路径来自前端 bundle，
若站点改版，用 `libseat_api` 逃生舱对一下即可。

> 沙箱提示：Codex 的受限执行环境里，嵌套子进程的管道会丢数据（`smoke.mjs` 会拿不到任何回复）。
> 在普通终端里跑 `node smoke.mjs` 是正常的；这不是 server 的问题。

## 边界

密码明文提交、验证码与 JSESSIONID 绑定，这个 MCP 做的是「模拟你自己在浏览器里登录」。
自动化抢座可能与该站的用户协议冲突（每人每天最多 3 次、开馆时段、15 分钟签到等规则
仍然生效，服务端会拒绝），先确认学校是否允许再用；别拿去做高频轮询或帮别人刷座。
