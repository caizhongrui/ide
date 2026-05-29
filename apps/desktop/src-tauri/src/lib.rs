/*---------------------------------------------------------------------------------------------
 *  码弦 Maxian Desktop — Tauri 入口
 *
 *  职责：
 *    1. 应用启动时拉起 maxian-server sidecar（Bun --compile 产出的单文件二进制）
 *       - 启动前检测端口：若已有进程占用，尝试 /health 探活，是自己就复用，不是就 kill
 *    2. 将监听地址 / 凭据通过 server_info 命令暴露给前端
 *    3. 应用退出时可靠地 kill sidecar：
 *       - 监听 WindowEvent::CloseRequested（关窗即 kill，不等 Exit）
 *       - 也在 RunEvent::Exit 兜底
 *       - Windows: taskkill /T /F 递归杀整棵进程树
 *       - Unix:    先 SIGTERM 让 Hono 优雅关闭，250ms 后 SIGKILL 保底
 *
 *  Sidecar 命名约定：
 *    bin/maxian-server-<rust-target-triple>[.exe]
 *    Tauri 按当前运行平台自动选择（由 externalBin 配置驱动）
 *--------------------------------------------------------------------------------------------*/

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, WindowEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

mod terminal;
mod pet;
mod skills;

struct ServerHandle(Mutex<Option<CommandChild>>);
struct ServerPid(Mutex<Option<u32>>);   // 备份 pid，即使 CommandChild 被 take 走也能最后一击
/// K-Port (v0.2.24)：sidecar 实际绑定的端口。env MAXIAN_PORT 是"期望"端口，
/// 但被占用时会自动找空闲端口，实际端口写入这里供 server_info 读取。
struct ServerPort(Mutex<Option<u16>>);

fn read_env_or_default(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// K-Port：从 start 起最多试 50 个端口找空闲的。返回 None 表示全部被占。
/// v0.2.28 起改为固定端口策略（不再让步换端口），此函数保留备用、暂不调用。
#[allow(dead_code)]
fn find_free_port(start: u16) -> Option<u16> {
    use std::net::TcpListener;
    for offset in 0..50u16 {
        let p = start.saturating_add(offset);
        // bind 成功立刻 drop（listener 出作用域），端口空闲
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return Some(p);
        }
    }
    None
}

// ─── O9: 窗口尺寸/位置持久化 ──────────────────────────────────────────────
// 简化方案：不引 tauri-plugin-window-state 插件，直接读写 ~/.maxian/desktop-window-state.json

fn window_state_path() -> Option<PathBuf> {
    #[cfg(unix)]
    let home = std::env::var("HOME").ok();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").ok();
    home.map(|h| PathBuf::from(h).join(".maxian").join("desktop-window-state.json"))
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
struct WindowState {
    width: Option<u32>,
    height: Option<u32>,
    x: Option<i32>,
    y: Option<i32>,
    maximized: Option<bool>,
}

fn load_window_state() -> Option<WindowState> {
    let path = window_state_path()?;
    let content = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

fn save_window_state(s: &WindowState) {
    if let Some(path) = window_state_path() {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(&path, json);
        }
    }
}

/// 确保窗口当前位置落在某个显示器可视区内，否则居中。
/// 用于 single-instance 激活：万一窗口跑到屏幕外，点图标即可把它拉回来。
fn ensure_window_on_screen(win: &tauri::WebviewWindow) {
    let pos = match win.outer_position() { Ok(p) => p, Err(_) => return };
    if let Ok(monitors) = win.available_monitors() {
        for m in monitors {
            let mp = m.position();
            let ms = m.size();
            // 物理坐标比较；留余量让标题栏仍可抓取
            if pos.x >= mp.x - 100
                && pos.x <= mp.x + ms.width as i32 - 100
                && pos.y >= mp.y
                && pos.y <= mp.y + ms.height as i32 - 50 {
                return;  // 在可视区内，保持不动
            }
        }
        let _ = win.center();  // 不在任何显示器内 → 居中
    }
}

/// 硬 kill sidecar：Windows 用 taskkill /T /F 杀进程树，Unix 先 SIGTERM 后 SIGKILL。
/// 即便 CommandChild 已丢失，也能靠 pid 补杀。
fn hard_kill_sidecar(child: Option<CommandChild>, pid: Option<u32>) {
    if let Some(c) = child {
        // Tauri 的 kill() 封装（通常走 SIGKILL / TerminateProcess），调用一次
        let _ = c.kill();
    }
    if let Some(p) = pid {
        println!("[maxian-desktop] 硬 kill sidecar pid={}", p);
        #[cfg(target_os = "windows")]
        {
            // taskkill /T 递归杀子进程树，/F 强制
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &p.to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(unix)]
        {
            // 先 SIGTERM 让 Hono 优雅关闭（释放端口）
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &p.to_string()])
                .output();
            std::thread::sleep(Duration::from_millis(250));
            // 250ms 后如果还在，SIGKILL 强杀（同时杀掉子进程组 -pid）
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &format!("-{}", p)])  // 杀整个进程组
                .output();
            let _ = std::process::Command::new("kill")
                .args(["-KILL", &p.to_string()])
                .output();
        }
    }
}

/// sidecar 日志文件路径（%USERPROFILE%\.maxian\sidecar.log 或 ~/.maxian/sidecar.log）。
/// 把 GUI 下看不见的 sidecar 输出 / 崩溃码 / spawn 失败原因落盘，便于排查"服务没起来"。
fn sidecar_log_path() -> Option<PathBuf> {
    #[cfg(unix)]
    let home = std::env::var("HOME").ok();
    #[cfg(windows)]
    let home = std::env::var("USERPROFILE").ok();
    home.map(|h| PathBuf::from(h).join(".maxian").join("sidecar.log"))
}
/// 每次 spawn 前清空，只保留本次启动的输出（避免无限增长）。
fn reset_sidecar_log(header: &str) {
    if let Some(path) = sidecar_log_path() {
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(&path, format!("{header}\n"));
    }
}
fn append_sidecar_log(line: &str) {
    if let Some(path) = sidecar_log_path() {
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            use std::io::Write;
            let _ = writeln!(f, "{}", line.trim_end());
        }
    }
}

/// 杀掉占用指定端口的进程：清理上次没退干净的残留 sidecar，确保新 sidecar 能在固定端口起来。
fn kill_process_on_port(port: &str) {
    #[cfg(windows)]
    {
        if let Ok(out) = std::process::Command::new("netstat").args(["-ano"]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            let needle = format!(":{}", port);
            let mut pids: std::collections::HashSet<String> = std::collections::HashSet::new();
            for line in text.lines() {
                if line.contains(&needle) && line.to_uppercase().contains("LISTENING") {
                    if let Some(pid) = line.split_whitespace().last() {
                        if pid != "0" { pids.insert(pid.to_string()); }
                    }
                }
            }
            for pid in pids {
                let _ = std::process::Command::new("taskkill").args(["/F", "/PID", &pid]).output();
                println!("[maxian-desktop] 杀掉占用端口 {} 的残留进程 pid={}", port, pid);
            }
        }
    }
    #[cfg(unix)]
    {
        if let Ok(out) = std::process::Command::new("lsof").args(["-ti", &format!(":{}", port)]).output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for pid in text.split_whitespace() {
                let _ = std::process::Command::new("kill").args(["-9", pid]).output();
                println!("[maxian-desktop] 杀掉占用端口 {} 的残留进程 pid={}", port, pid);
            }
        }
    }
}

/// 启动前探活：检查端口上是否有我们的 maxian-server（用 /health 验证）。
/// 返回值：true=端口上是 maxian-server（残留，需清理）；false=端口空闲或被别的服务占。
fn probe_existing_server(port: &str, user: &str, pass: &str) -> bool {
    // 1. 试着连一下 /health
    let url = format!("http://127.0.0.1:{}/health", port);
    let auth = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", user, pass))
    };
    // 用 curl 做 HEAD 探活（避免引入 reqwest 依赖；Windows 10+ 已自带 curl.exe）
    let devnull = if cfg!(windows) { "NUL" } else { "/dev/null" };
    let out = std::process::Command::new("curl")
        .args([
            "-s", "-o", devnull,
            "-w", "%{http_code}",
            "--max-time", "2",
            "-H", &format!("Authorization: Basic {}", auth),
            &url,
        ])
        .output();
    if let Ok(o) = out {
        let code = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if code == "200" {
            println!("[maxian-desktop] 端口 {} 上检测到 maxian-server（/health=200，按残留处理）", port);
            return true;
        }
        if !code.is_empty() && code != "000" {
            // 是别的服务占着端口（401/403/等）
            eprintln!("[maxian-desktop] ⚠️ 端口 {} 被占用（HTTP {}），但不是我们的 maxian-server", port, code);
        }
    }
    false
}

fn spawn_server(app: &AppHandle) -> Result<CommandChild, String> {
    // 默认端口 4096 → 51847：避开 Node dev 工具（Vite 5173 / CRA 3000 / webpack 8080 等）
    // 常用范围，落在动态/私有端口区（49152+）。与 jiusi(51823) 错开，避免同机两端互撞。
    // 用户可用 MAXIAN_PORT 环境变量覆盖；被占时仍走下方 find_free_port 自动让步。
    let configured = read_env_or_default("MAXIAN_PORT", "51847");
    let user = read_env_or_default("MAXIAN_USER", "maxian");
    let pass = read_env_or_default("MAXIAN_PASS", "test123");

    // 启动前探活：51847 上若已有 maxian-server——加了 single-instance 后不会有合法的并发实例，
    // 所以一定是上次没退干净的【残留】。它的 parent-death watcher 认的是【旧 app】的 pid，
    // 复用它会让它几秒后发现旧 app 已死而自杀 → 端口变空 → 前端 /health 失败（Windows 高发）。
    // 故：杀掉残留 + 重新 spawn 全新 sidecar（认【当前 app】为 parent，不会自杀），稳定在固定端口。
    if probe_existing_server(&configured, &user, &pass) {
        println!("[maxian-desktop] 检测到残留 sidecar 占用端口 {}，杀掉后重新 spawn", configured);
        kill_process_on_port(&configured);
        std::thread::sleep(Duration::from_millis(600));  // 等端口释放再 bind
    }

    // 固定端口策略（v0.2.28）：**不再** K-Port 让步换端口。
    // 原因：让步后 sidecar 实际端口与前端探测端口（拿不到 server_info 时 fallback 51847）不一致，
    // Windows 上高发——前端探 51847、sidecar 在 51848 → /health 连不上 → "启动失败"。
    // 改为：端口被占时强杀占用进程（netstat/taskkill on Win，lsof/kill on unix），固定复用 51847。
    // 宁可端口固定可预测（前后端永远一致、报错端口可信），也不悄悄换端口制造不一致。
    let configured_port: u16 = configured.parse().unwrap_or(51847);
    {
        use std::net::TcpListener;
        if TcpListener::bind(("127.0.0.1", configured_port)).is_err() {
            eprintln!(
                "[maxian-desktop] 端口 {} 被占用，强杀占用进程后固定复用该端口（不让步换端口）",
                configured_port
            );
            kill_process_on_port(&configured);
            std::thread::sleep(Duration::from_millis(600)); // 等端口释放再 bind
        }
    }
    let port_num: u16 = configured_port;
    let port = port_num.to_string();

    // 把实际端口写入 state，供 server_info / 前端读取
    if let Some(s) = app.try_state::<ServerPort>() {
        if let Ok(mut g) = s.0.lock() {
            *g = Some(port_num);
        }
    }

    // O4：传父进程 PID 给 sidecar，sidecar 自己 watch 父进程死亡然后自杀
    // 解决 dev 环境用 kill -9 强杀 desktop 主进程时 Tauri CloseRequested handler 不跑、
    // sidecar 给 init 接管成为僵尸的问题
    let parent_pid = std::process::id().to_string();

    // B5: 计算 maxian-deps 目录绝对路径（dev / release 都覆盖）
    // dev：current_exe = <repo>/apps/desktop/src-tauri/target/debug/maxian-desktop
    //      maxian-deps 在 <repo>/apps/desktop/src-tauri/bin/maxian-deps
    //      → exe.parent().parent().parent() = src-tauri/，然后 join bin/maxian-deps
    // release：current_exe = .../Contents/MacOS/maxian Dev
    //      sidecar 同级 maxian-deps：.../Contents/MacOS/maxian-deps
    let pty_deps_path = {
        let mut found: Option<std::path::PathBuf> = None;
        if let Ok(exe) = std::env::current_exe() {
            // 收集候选锚点目录，逐层向上 5 级，每层尝试 ./maxian-deps、bin/maxian-deps、
            // src-tauri/bin/maxian-deps、apps/desktop/src-tauri/bin/maxian-deps
            let mut probe = exe.clone();
            for _ in 0..6 {
                for tail in [
                    "maxian-deps",
                    "bin/maxian-deps",
                    "src-tauri/bin/maxian-deps",
                    "apps/desktop/src-tauri/bin/maxian-deps",
                ] {
                    let cand = probe.join(tail);
                    if cand.join("package.json").exists() {
                        found = Some(cand);
                        break;
                    }
                }
                if found.is_some() { break; }
                if let Some(parent) = probe.parent() {
                    probe = parent.to_path_buf();
                } else {
                    break;
                }
            }
        }
        found.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()
    };
    println!("[maxian-desktop] MAXIAN_PTY_DEPS={}", if pty_deps_path.is_empty() { "(未找到)" } else { &pty_deps_path });

    let sidecar = app
        .shell()
        .sidecar("maxian-server")
        .map_err(|e| format!("创建 sidecar 失败（检查 externalBin 是否包含 bin/maxian-server）: {e}"))?
        .args([
            "--port", &port,
            "--host", "127.0.0.1",
            "--cors",
            "--username", &user,
            "--password", &pass,
        ])
        .env("MAXIAN_PARENT_PID", &parent_pid)
        .env("MAXIAN_KILL_ON_PARENT_DEATH", "1")
        .env("MAXIAN_PTY_DEPS", &pty_deps_path)
        // sidecar 内存上限：默认 2GB（agent + SQLite + bundles 够用）。
        // BUN_GC_HEAP_GROWTH_RATIO 限制 GC 堆增长率，避免无节制扩张。
        // NODE_MAX_OLD_SPACE_SIZE 是 Node 风格变量，Bun 部分场景兼容。
        .env("BUN_GC_HEAP_GROWTH_RATIO", "1.5")
        .env("NODE_OPTIONS", "--max-old-space-size=2048");

    reset_sidecar_log(&format!("=== maxian-server spawn: port={} ===", port));
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| {
            let msg = format!("启动 maxian-server sidecar 失败: {e}");
            // spawn 直接失败：多半是 sidecar binary 被杀毒/EDR 拦截删除/隔离，或文件缺失
            append_sidecar_log(&format!("[spawn ERROR] {msg}（疑似被杀毒/EDR 拦截，或 binary 缺失）"));
            msg
        })?;

    let pid = child.pid();
    println!("[maxian-desktop] sidecar 已启动 pid={} port={}", pid, port);
    append_sidecar_log(&format!("[spawn OK] pid={} port={}", pid, port));

    // 后台消费子进程 stdout/stderr，透传到本进程（便于开发时查看日志）
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(data) => {
                    if let Ok(line) = String::from_utf8(data) {
                        print!("{line}");
                        append_sidecar_log(&line);
                    }
                }
                CommandEvent::Stderr(data) => {
                    if let Ok(line) = String::from_utf8(data) {
                        eprint!("{line}");
                        append_sidecar_log(&format!("[stderr] {}", line.trim_end()));
                    }
                }
                CommandEvent::Error(err) => {
                    eprintln!("[maxian-desktop] sidecar 事件错误: {err}");
                    append_sidecar_log(&format!("[error] {err}"));
                }
                CommandEvent::Terminated(payload) => {
                    println!(
                        "[maxian-desktop] sidecar 已退出 code={:?} signal={:?}",
                        payload.code, payload.signal
                    );
                    // 非 0 退出码 = sidecar 崩溃/被杀；用户可据此区分"被拦截"还是"运行崩溃"
                    append_sidecar_log(&format!("[terminated] code={:?} signal={:?}", payload.code, payload.signal));
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(child)
}

#[tauri::command]
fn server_info(server_port: tauri::State<'_, ServerPort>) -> serde_json::Value {
    // K-Port：优先读 spawn_server 写入的实际端口；fallback 到 env / 51847 默认
    let port: u16 = server_port
        .0
        .lock()
        .ok()
        .and_then(|g| *g)
        .unwrap_or_else(|| {
            std::env::var("MAXIAN_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(51847)
        });
    serde_json::json!({
        "baseUrl": format!("http://127.0.0.1:{}", port),
        "port": port,
        "username": std::env::var("MAXIAN_USER").unwrap_or_else(|_| "maxian".into()),
        "password": std::env::var("MAXIAN_PASS").unwrap_or_else(|_| "test123".into()),
    })
}

/// 进程资源监控（左下角状态栏用）：返回当前桌面端进程 + sidecar 子进程的内存/CPU。
/// sysinfo 是跨平台的（macOS/Windows/Linux），mem_bytes 单位字节，cpu_percent 是单核相对值（多核机器可能 > 100）。
#[tauri::command]
fn process_stats(server_pid: tauri::State<'_, ServerPid>) -> serde_json::Value {
    use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

    let mut sys = System::new_with_specifics(
        RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
    );
    // sysinfo 要求两次 refresh 之间隔一段才能算 cpu_usage（差分）
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    std::thread::sleep(std::time::Duration::from_millis(120));
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let self_pid = std::process::id();
    let sidecar_pid: Option<u32> = server_pid.0.lock().ok().and_then(|g| *g);

    let (mut self_mem, mut self_cpu) = (0u64, 0.0f32);
    let (mut sc_mem,   mut sc_cpu)   = (0u64, 0.0f32);
    let (mut total_mem, mut total_cpu) = (0u64, 0.0f32);

    if let Some(p) = sys.process(Pid::from_u32(self_pid)) {
        self_mem = p.memory();
        self_cpu = p.cpu_usage();
        total_mem += self_mem;
        total_cpu += self_cpu;
    }
    if let Some(pid) = sidecar_pid {
        if let Some(p) = sys.process(Pid::from_u32(pid)) {
            sc_mem = p.memory();
            sc_cpu = p.cpu_usage();
            total_mem += sc_mem;
            total_cpu += sc_cpu;
        }
    }

    // 系统总内存 / 可用内存（用于计算占比）
    let sys_total = sys.total_memory();
    let sys_used  = sys.used_memory();

    serde_json::json!({
        "self": {
            "pid": self_pid,
            "memBytes": self_mem,
            "cpuPercent": self_cpu,
        },
        "sidecar": {
            "pid": sidecar_pid,
            "memBytes": sc_mem,
            "cpuPercent": sc_cpu,
        },
        "total": {
            "memBytes": total_mem,
            "cpuPercent": total_cpu,
        },
        "system": {
            "totalMemBytes": sys_total,
            "usedMemBytes":  sys_used,
        }
    })
}

/// 打开本地目录到系统资源管理器（macOS Finder / Windows Explorer / Linux 文件管理器）。
///
/// 行为：
/// - 入参可以是文件路径或目录路径；若是文件则自动打开其父目录。
/// - 如果目标目录不存在，则递归创建（mkdir -p 语义），方便用户拖入资源（如 skills .md 文件）。
/// - 平台分发：macOS 用 `open`，Windows 用 `explorer`，Linux 用 `xdg-open`。
///
/// 与前端 SkillsPanel "打开目录" 按钮配合使用：用户点击后立即进入 `~/.maxian/skills/` 目录，
/// 手动放入下载的 .md 技能文件。
#[tauri::command]
fn open_path_in_explorer(path: String) -> Result<(), String> {
    use std::path::Path;

    if path.trim().is_empty() {
        return Err("路径为空".into());
    }

    // ~ 展开（前端如果传 "~/.maxian/skills/" 这种字面量也能正确处理）
    let expanded: String = if let Some(rest) = path.strip_prefix("~/") {
        #[cfg(unix)]
        let home = std::env::var("HOME").unwrap_or_default();
        #[cfg(windows)]
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        if home.is_empty() {
            path.clone()
        } else {
            format!("{}/{}", home, rest)
        }
    } else if path == "~" {
        #[cfg(unix)]
        let home = std::env::var("HOME").unwrap_or_default();
        #[cfg(windows)]
        let home = std::env::var("USERPROFILE").unwrap_or_default();
        home
    } else {
        path.clone()
    };

    let p = Path::new(&expanded);

    // 若是文件路径则切换到其父目录
    let target = if p.is_file() {
        p.parent()
            .ok_or_else(|| format!("文件 {} 没有父目录", expanded))?
            .to_path_buf()
    } else {
        p.to_path_buf()
    };

    // 不存在则尝试创建（仅当传入的不是文件路径时；文件父目录正常应当存在）
    if !target.exists() {
        std::fs::create_dir_all(&target)
            .map_err(|e| format!("创建目录 {} 失败: {}", target.display(), e))?;
    }

    #[cfg(target_os = "macos")]
    let cmd_name = "open";
    #[cfg(target_os = "windows")]
    let cmd_name = "explorer";
    #[cfg(all(unix, not(target_os = "macos")))]
    let cmd_name = "xdg-open";

    std::process::Command::new(cmd_name)
        .arg(target.as_os_str())
        .spawn()
        .map_err(|e| format!("打开 {} 失败（{}）: {}", target.display(), cmd_name, e))?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance 必须最先注册：再次启动 / 点任务栏图标时不开新实例，
        // 而是把已有主窗口激活——拉回可视区 + 取消最小化 + 置前台 + 聚焦。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                ensure_window_on_screen(&win);
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServerHandle(Mutex::new(None)))
        .manage(ServerPid(Mutex::new(None)))
        .manage(ServerPort(Mutex::new(None)))
        .manage(terminal::TerminalRegistry::default())
        .invoke_handler(tauri::generate_handler![
            server_info,
            process_stats,
            open_path_in_explorer,
            terminal::terminal_create,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            pet::pet_window_show,
            pet::pet_window_hide,
            pet::pet_window_toggle,
            pet::pet_window_snap,
            pet::pet_emit_state,
            skills::list_bundled_skills,
            skills::install_bundled_skills,
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // 首次启动自动复制内置 core 技能到 ~/.maxian/skills/maxian-builtin/
            // —— 标志位是版本化的，新增 core 技能后只需 +1 即可在下次启动补装
            skills::auto_install_core_skills_on_first_launch(&handle);

            match spawn_server(&handle) {
                Ok(child) => {
                    let pid = child.pid();
                    if let Some(state) = app.try_state::<ServerHandle>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(child);
                        }
                    }
                    if let Some(state) = app.try_state::<ServerPid>() {
                        if let Ok(mut guard) = state.0.lock() {
                            *guard = Some(pid);
                        }
                    }
                }
                Err(e) => {
                    if e == "__REUSE_EXISTING__" {
                        // 复用已有 server，跳过 spawn（也不记录 pid，不 kill 它）
                        println!("[maxian-desktop] 跳过 spawn，使用已有 sidecar");
                    } else {
                        eprintln!("[maxian-desktop] {e}");
                    }
                }
            }

            // O9：恢复上次的窗口尺寸/位置/maximized 状态
            if let Some(win) = app.get_webview_window("main") {
                if let Some(state) = load_window_state() {
                    // 尺寸：clamp 到不小于 minWidth/minHeight(900x600)，防坏 state 把窗口缩没
                    if let (Some(w), Some(h)) = (state.width, state.height) {
                        let _ = win.set_size(LogicalSize::new(w.max(900) as f64, h.max(600) as f64));
                    }
                    // 位置：必须落在某个显示器可视区内，否则居中——
                    // 防窗口恢复到屏幕外（换显示器/改分辨率/负坐标），出现"任务栏有预览但点不出窗口"
                    if let (Some(x), Some(y)) = (state.x, state.y) {
                        let mut on_screen = false;
                        if let Ok(monitors) = win.available_monitors() {
                            for m in monitors {
                                let scale = m.scale_factor();
                                let mx = m.position().x as f64 / scale;
                                let my = m.position().y as f64 / scale;
                                let mw = m.size().width as f64 / scale;
                                let mh = m.size().height as f64 / scale;
                                // 窗口左上角大致落在该显示器内（留余量，标题栏可抓取）
                                if (x as f64) >= mx - 100.0 && (x as f64) <= mx + mw - 100.0
                                    && (y as f64) >= my && (y as f64) <= my + mh - 50.0 {
                                    on_screen = true;
                                    break;
                                }
                            }
                        }
                        if on_screen {
                            let _ = win.set_position(LogicalPosition::new(x as f64, y as f64));
                        } else {
                            let _ = win.center();
                        }
                    }
                    if state.maximized.unwrap_or(false) {
                        let _ = win.maximize();
                    }
                }
            }

            // 监听每个窗口的 CloseRequested：保存状态 + kill sidecar
            // 同时监听 Resized / Moved 事件持久化（节流：保存放在 CloseRequested 时一次性做）
            let h2 = app.handle().clone();
            if let Some(win) = app.get_webview_window("main") {
                let win_for_save = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { .. } = event {
                        // O9：保存窗口状态
                        let maximized = win_for_save.is_maximized().unwrap_or(false);
                        let mut state = WindowState { maximized: Some(maximized), ..Default::default() };
                        if !maximized {
                            // 仅在非最大化时保存 size/pos（最大化时 size 是屏幕大小，下次启动还原会怪异）
                            if let Ok(PhysicalSize { width, height }) = win_for_save.outer_size() {
                                let scale = win_for_save.scale_factor().unwrap_or(1.0);
                                state.width = Some((width as f64 / scale).round() as u32);
                                state.height = Some((height as f64 / scale).round() as u32);
                            }
                            if let Ok(PhysicalPosition { x, y }) = win_for_save.outer_position() {
                                let scale = win_for_save.scale_factor().unwrap_or(1.0);
                                state.x = Some((x as f64 / scale).round() as i32);
                                state.y = Some((y as f64 / scale).round() as i32);
                            }
                        }
                        save_window_state(&state);
                        println!("[maxian-desktop] 已保存窗口状态");

                        // 原有：kill sidecar
                        println!("[maxian-desktop] 检测到 CloseRequested，kill sidecar");
                        let child = h2.try_state::<ServerHandle>()
                            .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));
                        let pid = h2.try_state::<ServerPid>()
                            .and_then(|s| s.0.lock().ok().and_then(|g| *g));
                        hard_kill_sidecar(child, pid);
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri build failed")
        .run(|app, event| {
            // 兜底：Exit 时也 kill 一次（窗口 CloseRequested 没来得及触发时保命）
            if let RunEvent::Exit = event {
                let child = app.try_state::<ServerHandle>()
                    .and_then(|s| s.0.lock().ok().and_then(|mut g| g.take()));
                let pid = app.try_state::<ServerPid>()
                    .and_then(|s| s.0.lock().ok().and_then(|g| *g));
                hard_kill_sidecar(child, pid);
            }
        });
}
