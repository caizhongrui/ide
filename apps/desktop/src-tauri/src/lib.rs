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
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, RunEvent, WindowEvent};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

// F11: Windows 上启动子进程时不弹 cmd 黑窗
#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// 构造一个 std::process::Command，在 Windows 上设置 CREATE_NO_WINDOW (0x08000000)
/// 让子进程**不分配 console**——治启动时 netstat / taskkill / curl 等 Windows 系统命令反复闪黑窗。
/// 其它平台行为与 std::process::Command::new 完全相同。
fn cmd_no_window(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut c = std::process::Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

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
            let _ = cmd_no_window("taskkill")
                .args(["/PID", &p.to_string(), "/T", "/F"])
                .output();
        }
        #[cfg(unix)]
        {
            // 先 SIGTERM 让 Hono 优雅关闭（释放端口）
            let _ = cmd_no_window("kill")
                .args(["-TERM", &p.to_string()])
                .output();
            std::thread::sleep(Duration::from_millis(250));
            // 250ms 后如果还在，SIGKILL 强杀（同时杀掉子进程组 -pid）
            let _ = cmd_no_window("kill")
                .args(["-KILL", &format!("-{}", p)])  // 杀整个进程组
                .output();
            let _ = cmd_no_window("kill")
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
/// 每次 spawn 时追加一行启动分隔符（不再整体清空——否则每次启动都丢掉上次
/// 卡死前的历史日志，没法排查"刚打开就卡"）。仅当文件超过 5MB 时轮转一次，
/// 保留最近一半，避免无限增长。
fn reset_sidecar_log(header: &str) {
    if let Some(path) = sidecar_log_path() {
        if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
        const MAX_BYTES: u64 = 5 * 1024 * 1024;
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > MAX_BYTES {
                if let Ok(content) = std::fs::read_to_string(&path) {
                    let keep_from = content.len().saturating_sub((MAX_BYTES / 2) as usize);
                    let tail_start = content[keep_from..].find('\n').map(|i| keep_from + i + 1).unwrap_or(keep_from);
                    let _ = std::fs::write(&path, &content[tail_start..]);
                }
            }
        }
        append_sidecar_log(&format!("\n========== {header} =========="));
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

/// 从 sidecar stdout 的握手行 `__MAXIAN_READY__ {"url":..,"port":51847,..}` 解析实际端口。
/// 端口由 OS 经 --port 0 动态分配，sidecar listen 成功后把它打到 stdout 回报给桌面端。
fn parse_ready_port(line: &str) -> Option<u16> {
    let brace = line.find('{')?;
    let v: serde_json::Value = serde_json::from_str(line[brace..].trim()).ok()?;
    v.get("port")
        .and_then(|p| p.as_u64())
        .and_then(|p| u16::try_from(p).ok())
}

/// Windows Job Object（kill-on-close）：把 sidecar 挂进一个进程级唯一的 Job，父进程（本桌面
/// 进程）的句柄一旦关闭（正常退出 / 崩溃 / 被任务管理器或 kill -9 强杀），OS 自动连带终止 Job
/// 内所有进程。这是比 stdin-EOF 启发式更可靠的 OS 级生命周期绑定，杜绝"占住端口的孤儿 sidecar"。
/// （Chrome / Electron / VS Code 同款机制。）mac/linux 无此机制，仍由 sidecar 的 stdin-EOF
/// watcher 兜底——PR_SET_PDEATHSIG 需子进程在 exec 前自设，无法经 tauri-plugin-shell 注入。
#[cfg(windows)]
mod winjob {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };

    /// 包裹裸 HANDLE 以便存进 OnceLock（HANDLE 本身非 Send/Sync）。句柄存活到本进程退出，
    /// 退出时由 OS 关闭 → 触发 kill-on-close。故意不主动 CloseHandle，这正是我们要的语义。
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<JobHandle> = OnceLock::new();

    fn ensure_job() -> HANDLE {
        JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if !job.is_null() {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
            }
            JobHandle(job)
        })
        .0
    }

    /// 把指定 pid 挂进 kill-on-close Job。成功返回 true。
    pub fn assign_kill_on_close(pid: u32) -> bool {
        unsafe {
            let job = ensure_job();
            if job.is_null() {
                return false;
            }
            let proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(job, proc) != 0;
            CloseHandle(proc);
            ok
        }
    }
}

fn spawn_server(app: &AppHandle) -> Result<CommandChild, String> {
    let user = read_env_or_default("MAXIAN_USER", "maxian");
    let pass = read_env_or_default("MAXIAN_PASS", "test123");

    // 端口策略（v0.2.44 重构）：传 --port 0，让 OS 原子分配一个保证空闲的端口。
    // 旧方案（固定 51847 + probe_existing_server + kill_process_on_port + find_free_port 让步
    // 重试）整套删除——根因是"父子在抢一个具体的 TCP 端口"：端口被上次没退干净的残留 sidecar
    // 占用、或被安全软件 MITM（本机回环留下 ESTABLISHED 连接，且是杀不掉的受保护进程）占住，
    // 就反复 EADDRINUSE 崩溃；固定端口死守时没有逃生口 → 永远"启动失败"。
    //
    // port=0 由内核交回一个【已绑好的】空闲端口，从原理上消灭 EADDRINUSE，也没有"先用
    // TcpListener 探测、后 sidecar 真正 bind"之间的竞态窗口。sidecar listen 成功后会在 stdout
    // 打印 `__MAXIAN_READY__ {json}`（含实际端口），下方 stdout 消费循环解析它并写入 ServerPort；
    // 握手到达前 server_info 返回 ready:false，前端 waitForServer 持续重试直到拿到实际端口。
    //
    // 孤儿治理交给 OS 级机制：Windows 用 Job Object（kill-on-close，见下方 winjob），
    // mac/linux 仍由 sidecar 的 stdin-EOF watcher 兜底。故不再需要启动前探活/强杀残留。

    // O4：传父进程 PID 给 sidecar（mac/linux 的 stdin-EOF watcher 据此自杀兜底）。
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
            "--port", "0",            // ← 让 OS 原子分配空闲端口；实际端口经 __MAXIAN_READY__ 回报
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

    reset_sidecar_log("=== maxian-server spawn: port=0 (OS 动态分配) ===");
    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| {
            let msg = format!("启动 maxian-server sidecar 失败: {e}");
            // spawn 直接失败：多半是 sidecar binary 被杀毒/EDR 拦截删除/隔离，或文件缺失
            append_sidecar_log(&format!("[spawn ERROR] {msg}（疑似被杀毒/EDR 拦截，或 binary 缺失）"));
            msg
        })?;

    let pid = child.pid();
    println!("[maxian-desktop] sidecar 已启动 pid={}（端口由 OS 分配，等待 __MAXIAN_READY__）", pid);
    append_sidecar_log(&format!("[spawn OK] pid={}（等待 __MAXIAN_READY__ 回报实际端口）", pid));

    // Windows：把 sidecar 挂进 kill-on-close Job Object，父进程一旦退出/崩溃/被强杀，OS 自动
    // 连带终止，杜绝占住端口的孤儿。mac/linux 仍由 sidecar 的 stdin-EOF watcher 兜底。
    #[cfg(windows)]
    {
        if winjob::assign_kill_on_close(pid) {
            append_sidecar_log(&format!("[winjob] pid={} 已挂入 kill-on-close Job Object", pid));
        } else {
            append_sidecar_log(&format!("[winjob] pid={} 挂入 Job 失败（退回 stdin-EOF 兜底）", pid));
        }
    }

    // 后台消费子进程 stdout/stderr：透传日志 + 解析 sidecar 的 `__MAXIAN_READY__` 握手行拿实际端口
    let ready_app = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        // 握手检测缓冲：Stdout 事件不保证按行切分，累积到换行再判断，避免标记行被 chunk 截断
        let mut ready_buf = String::new();
        let mut ready_done = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(data) => {
                    // from_utf8_lossy：绝不因 chunk 边界切断多字节 UTF-8 就丢掉整块（会吞掉握手行）
                    let line = String::from_utf8_lossy(&data).into_owned();
                    print!("{line}");
                    append_sidecar_log(&line);
                    if !ready_done {
                        ready_buf.push_str(&line);
                        while let Some(nl) = ready_buf.find('\n') {
                            let one: String = ready_buf.drain(..=nl).collect();
                            if one.contains("__MAXIAN_READY__") {
                                if let Some(p) = parse_ready_port(&one) {
                                    if let Some(s) = ready_app.try_state::<ServerPort>() {
                                        if let Ok(mut g) = s.0.lock() { *g = Some(p); }
                                    }
                                    // 主动把实际端口推给前端（Tauri 事件），不依赖前端轮询 server_info。
                                    // 端口发现的"推"模型：握手一完成立刻通知，消除前端轮询的时序脆弱。
                                    let _ = ready_app.emit("maxian:server-ready", serde_json::json!({
                                        "port":    p,
                                        "baseUrl": format!("http://127.0.0.1:{}", p),
                                    }));
                                    println!("[maxian-desktop] sidecar 就绪，实际端口={}", p);
                                    append_sidecar_log(&format!("[ready] sidecar 实际端口={}", p));
                                    ready_done = true;
                                    break;
                                }
                            }
                        }
                        if ready_buf.len() > 16_384 { ready_buf.clear(); }  // 保险：避免无界增长
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
    // v0.2.44：端口由 sidecar 经 stdout `__MAXIAN_READY__` 握手回报后写入 ServerPort。
    // 握手到达前端口未知 —— 返回 ready:false（不再臆测 51847），前端 waitForServer 会持续
    // 重试直到拿到实际端口。MAXIAN_PORT 环境变量仍作为显式覆盖（standalone / dev 用）。
    let port: Option<u16> = server_port
        .0
        .lock()
        .ok()
        .and_then(|g| *g)
        .or_else(|| std::env::var("MAXIAN_PORT").ok().and_then(|s| s.parse().ok()));
    match port {
        Some(p) => serde_json::json!({
            "ready":    true,
            "baseUrl":  format!("http://127.0.0.1:{}", p),
            "port":     p,
            "username": std::env::var("MAXIAN_USER").unwrap_or_else(|_| "maxian".into()),
            "password": std::env::var("MAXIAN_PASS").unwrap_or_else(|_| "test123".into()),
        }),
        None => serde_json::json!({ "ready": false }),
    }
}

/// 进程资源监控（左下角状态栏用）：返回当前桌面端进程 + sidecar 子进程的内存/CPU。
/// sysinfo 是跨平台的（macOS/Windows/Linux），mem_bytes 单位字节，cpu_percent 是单核相对值（多核机器可能 > 100）。
#[tauri::command]
async fn process_stats(server_pid: tauri::State<'_, ServerPid>) -> Result<serde_json::Value, String> {
    // 先把 sidecar pid 取出（u32 是 Send），State 不能跨 spawn_blocking 边界。
    let sidecar_pid: Option<u32> = server_pid.0.lock().ok().and_then(|g| *g);

    // 核心修复：原来是【同步】command，在主线程枚举全进程 + sleep 120ms。Tauri 里同步
    // command 在主线程跑 = webview 消息循环被冻结，Windows 大进程表阻塞数百 ms~数秒 →
    // "未响应"。改成 async + spawn_blocking：sysinfo 重活搬到阻塞线程池，彻底离开主线程。
    // sysinfo 逻辑保持不变（零编译风险）。
    tauri::async_runtime::spawn_blocking(move || {
        use sysinfo::{Pid, ProcessRefreshKind, RefreshKind, System};

        let __t0 = std::time::Instant::now();
        let mut sys = System::new_with_specifics(
            RefreshKind::new().with_processes(ProcessRefreshKind::everything()),
        );
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        std::thread::sleep(std::time::Duration::from_millis(120));
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        let __proc_count = sys.processes().len();
        let __elapsed_ms = __t0.elapsed().as_millis();
        if __elapsed_ms > 200 {
            append_sidecar_log(&format!(
                "[PERFDIAG] process_stats blocking-thread {}ms (enumerated {} processes, off main thread)",
                __elapsed_ms, __proc_count
            ));
        }

        let self_pid = std::process::id();
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
    })
    .await
    .map_err(|e| format!("process_stats join error: {}", e))
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

    cmd_no_window(cmd_name)
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
