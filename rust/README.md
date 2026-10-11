# 砚席桌面端 (Rust + Slint)

独立的原生桌面客户端。`cargo run --manifest-path rust/Cargo.toml` 启动；默认从仓库根目录 `.env` 读取 `LIBSEAT_USER`、`LIBSEAT_PASS` 和可选的 `LIBSEAT_BASE_URL`，也可用 `LIBSEAT_ENV_FILE` 指定配置文件。环境变量优先于文件。凭据和 cookie 仅保留在进程内存中。

当前桌面流程：房间查询、时段空座、预约、我的预约，以及签到、暂离/归位、续座、签退、取消。签到需要本人到馆确认，并检查订单签到窗口与回查状态。预约提交前请核对座位和时段；UI 不会自动选择空座。

原有 Node MCP server/CLI 仍保留，用于尚未迁移的 37 工具及脚本。此 crate 尚未替代 `server.mjs`，尤其不包含本地验证码登录、房间平面图、空间组队、资产报修等流程。

验证：`cargo test --manifest-path rust/Cargo.toml`。首次编译会下载 Slint 和依赖，并需要桌面图形环境；无图形环境可运行测试和 `cargo check`。

只验证真实账号登录（不会提交预约）：`cargo run --manifest-path rust/Cargo.toml -- --check-login`。仅输出成功或错误类型，不输出凭据、ticket 或 cookie。
