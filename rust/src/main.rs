mod client;

use client::{Api, Order, Room, Seat};
use slint::{Model, ModelRc, SharedString, VecModel};
use std::sync::{Arc, Mutex};

slint::include_modules!();

struct State {
    api: Api,
    rooms: Vec<Room>,
    seats: Vec<Seat>,
    orders: Vec<Order>,
}

fn show_rooms(ui: &AppWindow, rows: &[Room]) {
    let query = ui.get_search_text().to_string();
    ui.set_selected_room(-1);
    ui.set_seats(ModelRc::new(VecModel::from(Vec::<SeatRow>::new())));
    ui.set_rooms(ModelRc::new(VecModel::from(
        rows.iter()
            .filter(|r| {
                query.is_empty()
                    || r.name.contains(&query)
                    || r.building.contains(&query)
                    || r.floor.contains(&query)
            })
            .map(|r| RoomRow {
                name: r.name.clone().into(),
                location: format!("{} · {}", r.building, r.floor).into(),
                count: if r.open {
                    format!("{} / {} 空位", r.free, r.total)
                } else {
                    "暂未开放".into()
                }
                .into(),
                id: r.id.clone().into(),
            })
            .collect::<Vec<_>>(),
    )));
}

fn run_task<T: Send + 'static>(
    ui: &AppWindow,
    state: Arc<Mutex<State>>,
    task: impl FnOnce(&mut State) -> Result<T, String> + Send + 'static,
    done: impl FnOnce(&AppWindow, Result<T, String>) + Send + 'static,
) {
    ui.set_busy(true);
    ui.set_status_text("正在连接图书馆服务…".into());
    let weak = ui.as_weak();
    std::thread::spawn(move || {
        let result = match state.lock() {
            Ok(mut guard) => task(&mut guard),
            Err(_) => Err("内部状态不可用".into()),
        };
        let _ = slint::invoke_from_event_loop(move || {
            if let Some(ui) = weak.upgrade() {
                ui.set_busy(false);
                if let Err(ref e) = result {
                    ui.set_status_text(format!("错误: {e}").into());
                }
                done(&ui, result);
            }
        });
    });
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let env_file = std::env::var("LIBSEAT_ENV_FILE")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../.env").into());
    let _ = dotenvy::from_path(&env_file);
    let base =
        std::env::var("LIBSEAT_BASE_URL").unwrap_or_else(|_| "https://libseat.scau.edu.cn".into());
    let user = std::env::var("LIBSEAT_USER").unwrap_or_default();
    let password = std::env::var("LIBSEAT_PASS").unwrap_or_default();
    let mut api = Api::new(base, user.clone(), password)?;
    if std::env::args().any(|arg| arg == "--check-login") {
        match api.login() {
            Ok(()) => println!("login: ok"),
            Err(error) => {
                eprintln!("login: failed: {error}");
                std::process::exit(1);
            }
        }
        return Ok(());
    }
    let state = Arc::new(Mutex::new(State {
        api,
        rooms: vec![],
        seats: vec![],
        orders: vec![],
    }));
    let ui = AppWindow::new()?;
    ui.set_date_text(client::today().into());
    ui.set_user_text(if user.is_empty() {
        "未配置账号".into()
    } else {
        format!("账号 {}***", user.chars().take(2).collect::<String>()).into()
    });

    let s = state.clone();
    let weak = ui.as_weak();
    ui.on_refresh_rooms(move || {
        let Some(ui) = weak.upgrade() else {
            return;
        };
        run_task(
            &ui,
            s.clone(),
            |state| {
                let rows = state.api.rooms()?;
                state.rooms = rows.clone();
                Ok(rows)
            },
            |ui, result| {
                if let Ok(rows) = result {
                    show_rooms(ui, &rows);
                    ui.set_status_text(format!("已加载 {} 个阅览空间", rows.len()).into());
                }
            },
        );
    });

    let s = state.clone();
    let weak = ui.as_weak();
    ui.on_search_changed(move |_| {
        let Some(ui) = weak.upgrade() else {
            return;
        };
        if let Ok(guard) = s.try_lock() {
            show_rooms(&ui, &guard.rooms);
        }
    });

    let s = state.clone();
    let weak = ui.as_weak();
    ui.on_refresh_seats(move || {
        let Some(ui) = weak.upgrade() else {
            return;
        };
        let room = ui
            .get_rooms()
            .row_data(ui.get_selected_room() as usize)
            .map(|r| r.id.to_string());
        let date = ui.get_date_text().to_string();
        let start = ui.get_start_text().to_string();
        let end = ui.get_end_text().to_string();
        run_task(
            &ui,
            s.clone(),
            move |state| {
                let id = room.ok_or("请先选择阅览空间")?;
                let rows = state.api.seats(&id, &date, &start, &end)?;
                state.seats = rows.clone();
                Ok(rows)
            },
            |ui, result| {
                if let Ok(rows) = result {
                    let free = rows.iter().filter(|s| s.free).count();
                    ui.set_seats(ModelRc::new(VecModel::from(
                        rows.iter()
                            .map(|s| SeatRow {
                                name: s.name.clone().into(),
                                state: if s.free { "可预约" } else { "已占用" }.into(),
                                id: s.id.clone().into(),
                                free: s.free,
                            })
                            .collect::<Vec<_>>(),
                    )));
                    ui.set_status_text(format!("查询完成：{} 个空座", free).into());
                }
            },
        );
    });

    let s = state.clone();
    let weak = ui.as_weak();
    ui.on_reserve_seat(move || {
        let Some(ui) = weak.upgrade() else {
            return;
        };
        let index = ui.get_selected_seat();
        let date = ui.get_date_text().to_string();
        let start = ui.get_start_text().to_string();
        let end = ui.get_end_text().to_string();
        run_task(
            &ui,
            s.clone(),
            move |state| {
                let seat = state.seats.get(index as usize).ok_or("请先选择座位")?;
                if !seat.free {
                    return Err("座位已占用".into());
                }
                state.api.reserve(&seat.id.clone(), &date, &start, &end)
            },
            |ui, result| {
                if let Ok(message) = result {
                    ui.set_status_text(message.into());
                    ui.set_active_tab(1);
                    ui.invoke_refresh_orders();
                }
            },
        );
    });

    let s = state.clone();
    let weak = ui.as_weak();
    ui.on_refresh_orders(move || {
        let Some(ui) = weak.upgrade() else {
            return;
        };
        run_task(
            &ui,
            s.clone(),
            |state| {
                let rows = state.api.orders()?;
                state.orders = rows.clone();
                Ok(rows)
            },
            |ui, result| {
                if let Ok(rows) = result {
                    ui.set_selected_order(-1);
                    ui.set_orders(ModelRc::new(VecModel::from(
                        rows.iter()
                            .map(|o| OrderRow {
                                title: format!("{} · {}", o.room, o.seat).into(),
                                time: format!("{} - {} · #{}", o.start, o.end, o.id).into(),
                                state: o.status.clone().into(),
                                id: o.id.clone().into(),
                            })
                            .collect::<Vec<_>>(),
                    )));
                    ui.set_status_text(format!("已加载 {} 条预约", rows.len()).into());
                }
            },
        );
    });

    let s = state.clone();
    let weak = ui.as_weak();
    ui.on_order_action(move |action: SharedString| {
        let Some(ui) = weak.upgrade() else {
            return;
        };
        let index = ui.get_selected_order();
        let present = ui.get_present();
        let action = action.to_string();
        run_task(
            &ui,
            s.clone(),
            move |state| {
                let order = state
                    .orders
                    .get(index as usize)
                    .ok_or("请先选择订单")?
                    .clone();
                state.api.order_action(&action, &order, present)
            },
            |ui, result| {
                if let Ok(message) = result {
                    ui.set_status_text(message.into());
                    ui.invoke_refresh_orders();
                }
            },
        );
    });

    ui.invoke_refresh_rooms();
    ui.run()?;
    Ok(())
}
