use chrono::Duration;
use num_bigint::BigUint;
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, SET_COOKIE};
use reqwest::Method;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::time::Duration as StdDuration;

const CAS: &str = "https://cas.scau.edu.cn/lyuapServer";
const MODULUS: &str = concat!(
    "00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5fd22c2e7ac519cab59198ece036dcf289",
    "ea8201e2a0b9ded307f8fb704136eaeb670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604",
    "bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1"
);

fn rsa_encrypt(password: &str) -> Result<String, String> {
    let modulus = BigUint::parse_bytes(MODULUS.as_bytes(), 16).ok_or("CAS 公钥无效")?;
    let exponent = BigUint::from(65537u32);
    let significant_digits = MODULUS.trim_start_matches('0').len();
    let chunksize = 2 * (significant_digits.div_ceil(4) - 1);
    let mut bytes: Vec<u8> = password.encode_utf16().map(|c| c as u8).collect();
    if bytes.is_empty() {
        return Err("密码不能为空".into());
    }
    bytes.resize(bytes.len().div_ceil(chunksize) * chunksize, 0);
    Ok(bytes
        .chunks(chunksize)
        .map(|chunk| {
            let cipher = BigUint::from_bytes_le(chunk).modpow(&exponent, &modulus);
            let hex = cipher.to_str_radix(16);
            format!("{:0>width$}", hex, width = hex.len().div_ceil(4) * 4)
        })
        .collect::<Vec<_>>()
        .join(" "))
}

#[derive(Clone, Debug)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub building: String,
    pub floor: String,
    pub free: i64,
    pub total: i64,
    pub open: bool,
}

#[derive(Clone, Debug)]
pub struct Seat {
    pub id: String,
    pub name: String,
    pub free: bool,
}

#[derive(Clone, Debug)]
pub struct Order {
    pub id: String,
    pub room: String,
    pub seat: String,
    pub start: String,
    pub end: String,
    pub status: String,
    pub status_code: i64,
    pub signed_in: bool,
    pub sign_start: Option<String>,
    pub sign_end: Option<String>,
}

pub struct Api {
    client: Client,
    cookies: HashMap<String, HashMap<String, String>>,
    base: String,
    user: String,
    password: String,
    logged_in: bool,
}

fn value_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        _ => v.to_string(),
    }
}

fn field(v: &Value, name: &str) -> String {
    value_string(&v[name])
}

impl Api {
    pub fn new(base: String, user: String, password: String) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(StdDuration::from_secs(20))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            client,
            cookies: HashMap::new(),
            base: base.trim_end_matches('/').into(),
            user,
            password,
            logged_in: false,
        })
    }

    fn send(
        &mut self,
        method: Method,
        url: &str,
        body: Option<&Value>,
        form: Option<&[(&str, String)]>,
    ) -> Result<(u16, HeaderMap, String), String> {
        let host = reqwest::Url::parse(url)
            .map_err(|e| e.to_string())?
            .host_str()
            .unwrap_or("")
            .to_string();
        let mut req = self.client.request(method, url);
        if let Some(jar) = self.cookies.get(&host) {
            let cookie = jar
                .iter()
                .map(|(k, v)| format!("{k}={v}"))
                .collect::<Vec<_>>()
                .join("; ");
            req = req.header("cookie", cookie);
        }
        if let Some(body) = body {
            req = req.json(body);
        }
        if let Some(form) = form {
            req = req
                .header("referer", format!("{CAS}/login?service={}", self.base))
                .form(form);
        }
        let res = req.send().map_err(|e| format!("请求失败: {e}"))?;
        for raw in res.headers().get_all(SET_COOKIE).iter() {
            if let Ok(pair) = raw.to_str() {
                if let Some((key, value)) = pair.split(';').next().unwrap_or("").split_once('=') {
                    self.cookies
                        .entry(host.clone())
                        .or_default()
                        .insert(key.trim().into(), value.trim().into());
                }
            }
        }
        let status = res.status().as_u16();
        let headers = res.headers().clone();
        let text = res.text().map_err(|e| e.to_string())?;
        Ok((status, headers, text))
    }

    fn post(&mut self, path: &str, body: Value, auth: bool) -> Result<Value, String> {
        if auth && !self.logged_in {
            self.login()?;
        }
        let url = format!("{}/api{}", self.base, path);
        for attempt in 0..2 {
            let (status, _, text) = self.send(Method::POST, &url, Some(&body), None)?;
            let data: Value = serde_json::from_str(&text)
                .map_err(|_| format!("服务端返回非 JSON (HTTP {status})"))?;
            if auth && (status == 401 || data["code"] == 401) && attempt == 0 {
                self.logged_in = false;
                self.login()?;
                continue;
            }
            if status >= 400 {
                return Err(format!("HTTP {status}: {}", field(&data, "message")));
            }
            if data["isOk"] == false {
                return Err(field(&data, "message"));
            }
            return Ok(data);
        }
        Err("登录已过期".into())
    }

    pub fn login(&mut self) -> Result<(), String> {
        if self.user.is_empty() || self.password.is_empty() {
            return Err("请在 .env 配置 LIBSEAT_USER / LIBSEAT_PASS".into());
        }
        self.cookies.clear();
        self.logged_in = false;
        let service = format!("{}/sso/scau", self.base);
        let form = [
            ("username", self.user.clone()),
            ("password", rsa_encrypt(&self.password)?),
            ("service", service.clone()),
        ];
        let (_, _, text) = self.send(
            Method::POST,
            &format!("{CAS}/v1/tickets"),
            None,
            Some(&form),
        )?;
        let data: Value = serde_json::from_str(&text).map_err(|_| "CAS 返回非 JSON".to_string())?;
        if let Some(code) = data["data"]["code"].as_str() {
            let reason = match code {
                "PASSERROR" => "账号或密码错误",
                "NOUSER" => "账号不存在",
                "NOREGISTER" => "账号未注册到该应用",
                "NOAUTHORIZATION" => "账号未授权该应用",
                "USERLOCK" => "账号已锁定",
                "CODEFALSE" => "CAS 要求验证码",
                _ => code,
            };
            return Err(format!("CAS 登录失败: {reason} ({code})"));
        }
        let ticket = data["ticket"]
            .as_str()
            .or_else(|| data["data"]["ticket"].as_str())
            .ok_or("CAS 未返回 ticket")?;
        let mut current = reqwest::Url::parse(&service).map_err(|e| e.to_string())?;
        current.query_pairs_mut().append_pair("ticket", ticket);
        let mut completed = false;
        for _ in 0..6 {
            let (status, headers, _) = self.send(Method::GET, current.as_str(), None, None)?;
            if !(300..400).contains(&status) {
                if status >= 400 {
                    return Err(format!("图书馆会话建立失败 (HTTP {status})"));
                }
                completed = true;
                break;
            }
            let location = headers
                .get("location")
                .and_then(|v| v.to_str().ok())
                .ok_or("CAS 跳转缺少 location")?;
            current = current.join(location).map_err(|e| e.to_string())?;
        }
        if !completed {
            return Err("CAS 跳转次数过多".into());
        }
        let me = self.post("/web/pc/user", json!({}), false)?;
        if me["isOk"] != true {
            return Err("CAS 已认证，但图书馆会话未建立".into());
        }
        self.logged_in = true;
        Ok(())
    }

    pub fn rooms(&mut self) -> Result<Vec<Room>, String> {
        let data = self.post("/public/home", json!({}), false)?;
        let rows = data["data"]["rooms"].as_array().ok_or("房间数据格式变化")?;
        Ok(rows
            .iter()
            .map(|r| Room {
                id: field(r, "id"),
                name: field(r, "name"),
                building: field(r, "buildingname"),
                floor: field(r, "floorname"),
                free: r["availableseatcount"].as_i64().unwrap_or(0),
                total: r["seatscount"].as_i64().unwrap_or(0),
                open: r["isopen"] == 1,
            })
            .collect())
    }

    pub fn seats(
        &mut self,
        room: &str,
        date: &str,
        start: &str,
        end: &str,
    ) -> Result<Vec<Seat>, String> {
        validate_window(date, start, end)?;
        let data = self.post("/web/user/seatState", json!({
            "roomId": room, "startTime": format!("{date} {start}:00"), "endTime": format!("{date} {end}:00")
        }), true)?;
        let rows = data["data"].as_array().ok_or("座位数据格式变化")?;
        Ok(rows
            .iter()
            .map(|s| Seat {
                id: field(s, "seatid"),
                name: field(s, "seatname"),
                free: s["count"] == "0" || s["count"] == 0,
            })
            .collect())
    }

    pub fn reserve(
        &mut self,
        seat: &str,
        date: &str,
        start: &str,
        end: &str,
    ) -> Result<String, String> {
        validate_window(date, start, end)?;
        if seat.is_empty() {
            return Err("请先选择座位".into());
        }
        let data = self.post(
            "/web/user/due",
            json!({
                "seatesid": seat, "duestartime": format!("{date} {start}"),
                "dueendtime": format!("{date} {end}"), "reason": "", "memberids": []
            }),
            true,
        )?;
        Ok(data["message"].as_str().unwrap_or("预约已提交").into())
    }

    pub fn orders(&mut self) -> Result<Vec<Order>, String> {
        let data = self.post(
            "/web/user/duelist",
            json!({"pageNum": 1, "pageSize": 100}),
            true,
        )?;
        let rows = data["data"]["list"].as_array().ok_or("预约列表格式变化")?;
        Ok(rows
            .iter()
            .map(|o| {
                let status_code = o["duestatu"].as_i64().unwrap_or(-1);
                let status = match status_code {
                    0 => "待审核",
                    1 if o["signin"] == 0 => "未签到",
                    1 => "已完成",
                    2 => "使用中",
                    3 => "暂离",
                    4 => "已结束",
                    5 => "违约",
                    _ => "未知",
                };
                Order {
                    id: field(o, "id"),
                    room: field(o, "room"),
                    seat: field(o, "seatname"),
                    start: field(o, "duestartime"),
                    end: field(o, "dueendtime"),
                    status: status.into(),
                    status_code,
                    signed_in: o["signin"] == 1,
                    sign_start: o["signstar"].as_str().map(str::to_string),
                    sign_end: o["signend"].as_str().map(str::to_string),
                }
            })
            .collect())
    }

    pub fn order_action(
        &mut self,
        action: &str,
        order: &Order,
        present: bool,
    ) -> Result<String, String> {
        let (path, body) = match action {
            "cancel" => ("/web/user/cancel", json!({"id": order.id})),
            "signout" => ("/web/user/signout", json!({"id": order.id})),
            "leave" => (
                "/web/user/tempout",
                json!({"orderid": order.id, "istempout": true}),
            ),
            "return" => (
                "/web/user/tempout",
                json!({"orderid": order.id, "istempout": false}),
            ),
            "extend" => (
                "/web/user/continueOrder",
                json!({"orderid": order.id, "continuetime": 30}),
            ),
            "checkin" => {
                if !present {
                    return Err("请先确认本人已到馆".into());
                }
                if order.signed_in || order.status_code != 1 {
                    return Err("订单当前不可签到".into());
                }
                let (Some(start), Some(end)) = (&order.sign_start, &order.sign_end) else {
                    return Err("缺少可信签到窗口".into());
                };
                let parse = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S");
                let now = chrono::Utc::now().naive_utc() + Duration::hours(8);
                if now < parse(start).map_err(|_| "签到开始时间无效")?
                    || now > parse(end).map_err(|_| "签到截止时间无效")?
                {
                    return Err("不在签到时间窗内".into());
                }
                ("/web/user/in", json!({"id": order.id}))
            }
            _ => return Err("未知操作".into()),
        };
        let response = self.post(path, body, true)?;
        let updated = self
            .orders()?
            .into_iter()
            .find(|o| o.id == order.id)
            .ok_or("操作后未找到订单")?;
        if action == "checkin" && !updated.signed_in {
            return Err("服务端接受请求，但尚未确认签到成功".into());
        }
        Ok(format!(
            "{} · {}",
            response["message"].as_str().unwrap_or("操作已提交"),
            updated.status
        ))
    }
}

pub fn validate_window(date: &str, start: &str, end: &str) -> Result<(), String> {
    chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| "日期格式应为 YYYY-MM-DD")?;
    let a =
        chrono::NaiveTime::parse_from_str(start, "%H:%M").map_err(|_| "开始时间格式应为 HH:mm")?;
    let b =
        chrono::NaiveTime::parse_from_str(end, "%H:%M").map_err(|_| "结束时间格式应为 HH:mm")?;
    let minutes = (b - a).num_minutes();
    if !(1..=300).contains(&minutes) {
        return Err("时段必须晚于开始，且不超过 5 小时".into());
    }
    Ok(())
}

pub fn today() -> String {
    (chrono::Utc::now() + Duration::hours(8))
        .format("%Y-%m-%d")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cas_encrypt_matches_frontend_shape() {
        let value = rsa_encrypt("test123").unwrap();
        assert_eq!(value, "556386088bed8a24d6d61615f1d355cd79ea501e5ca52a4a8688fc2a587abeb030c7042cbbceb8daaf92facf658a65256e96e44dcc6a7871fdeb4554067a1a23265e9a4c2f768e69b6be2bc170014fcd6a5796f2d02198964a60a1f6b6087f70a9dfd10bcffa36a37c982abee41a9744f54a735353a79593b7e2fd61a4317c0f");
    }
    #[test]
    fn windows_reject_invalid_ranges() {
        assert!(validate_window("2026-10-11", "09:00", "12:00").is_ok());
        assert!(validate_window("2026-10-11", "12:00", "09:00").is_err());
        assert!(validate_window("2026-10-11", "09:00", "15:00").is_err());
    }
}
