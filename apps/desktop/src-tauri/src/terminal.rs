/*---------------------------------------------------------------------------------------------
 *  terminal.rs — Tauri 侧 PTY 终端管理（替代 Bun sidecar 的 WebSocket /terminal）
 *
 *  为什么放在 Rust 侧：
 *    Bun v1.3.4（--compile 单文件 + `bun run` 直接执行 两种模式都一样）的运行时在驱动
 *    @lydell/node-pty 时无法正确建立 PTY 子进程的 controlling terminal —— 表现为
 *    spawn-helper 挂在 `open(slave_pty)` 上，或 zsh exec 后立刻 exit 0 无任何输出。
 *    同一份 node_modules 用 Node.js 22 跑则完全正常（已多次验证）。
 *    所以把 PTY 管理从 sidecar（Bun）抽到 Tauri Rust 侧，根除 Bun 运行时这层风险。
 *
 *  架构：
 *    portable-pty (wezterm) 跨平台抽象（macOS / Linux PTY；Windows ConPTY）。
 *    每个终端实例：
 *      - 一个 PtyPair（master/slave fd）
 *      - 一个 Child（被 spawn 的 shell 进程）
 *      - 一个 reader 线程：阻塞读 master，把字节通过 Tauri Event 派发到前端
 *      - 一个 writer：BoxedWriter，主线程 / Tauri 命令调用即可写入
 *
 *  前端协议（Tauri command + event）：
 *    invoke('terminal_create', {cwd, cols, rows, shell?})         → returns id (string)
 *    invoke('terminal_write',  {id, data: string})                → 用户键入
 *    invoke('terminal_resize', {id, cols, rows})                  → 窗口尺寸变化
 *    invoke('terminal_close',  {id})                              → 主动关闭
 *    listen('terminal://data', (e) => {id, data: number[]})       → PTY → 前端
 *    listen('terminal://exit', (e) => {id, exitCode})             → shell 进程退出
 *--------------------------------------------------------------------------------------------*/

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

/// 单个终端实例的运行态（owned 在主线程；reader 线程通过 Arc 共享）。
struct PtySession {
	id:        String,
	writer:    Box<dyn Write + Send>,
	master:    Box<dyn MasterPty + Send>,
	killer:    Box<dyn ChildKiller + Send + Sync>,
}

/// 全局：id → 会话。Mutex 保护并发 invoke。
#[derive(Default)]
pub struct TerminalRegistry(Mutex<HashMap<String, PtySession>>);

#[derive(Serialize, Clone)]
struct TerminalDataEvent {
	id:   String,
	/// 字节数组（前端按 Uint8Array 接 → xterm.js 的 write 直接消化）
	data: Vec<u8>,
}

#[derive(Serialize, Clone)]
struct TerminalExitEvent {
	id:        String,
	#[serde(rename = "exitCode")]
	exit_code: Option<i32>,
}

#[derive(Deserialize)]
pub struct CreateArgs {
	cwd:    String,
	cols:   u16,
	rows:   u16,
	#[serde(default)]
	shell:  Option<String>,
}

#[derive(Deserialize)]
pub struct WriteArgs {
	id:   String,
	data: String,
}

#[derive(Deserialize)]
pub struct ResizeArgs {
	id:   String,
	cols: u16,
	rows: u16,
}

#[derive(Deserialize)]
pub struct CloseArgs {
	id: String,
}

/// 生成一个 8 字符随机 id，与原 sidecar /terminal 的命名风格一致
fn gen_id() -> String {
	use std::time::{SystemTime, UNIX_EPOCH};
	let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
	let pid   = std::process::id();
	format!("{:08x}", nanos.wrapping_mul(pid).wrapping_add(pid))
}

/// 创建新终端会话。返回 id。
#[tauri::command]
pub fn terminal_create(
	app: AppHandle,
	registry: State<'_, TerminalRegistry>,
	args: CreateArgs,
) -> Result<String, String> {
	let CreateArgs { cwd, cols, rows, shell } = args;

	let pty_system = native_pty_system();
	let pair = pty_system
		.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
		.map_err(|e| format!("openpty 失败: {e}"))?;

	// 选 shell：参数 → $SHELL → 平台默认
	let shell_path = shell.filter(|s| !s.is_empty()).or_else(|| std::env::var("SHELL").ok())
		.unwrap_or_else(|| {
			if cfg!(target_os = "windows") {
				"cmd.exe".to_string()
			} else {
				"/bin/zsh".to_string()
			}
		});

	let mut cmd = CommandBuilder::new(&shell_path);
	// 强制 UTF-8 locale，确保 ls / 中文文件名等正常
	cmd.env("LANG",     "en_US.UTF-8");
	cmd.env("LC_ALL",   "en_US.UTF-8");
	cmd.env("LC_CTYPE", "en_US.UTF-8");
	cmd.env("TERM",     "xterm-256color");
	// 继承当前 PATH 等关键环境变量，但不要 dump 全部（避免泄漏 Tauri 内部环境）
	for key in ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SHELL"] {
		if let Ok(v) = std::env::var(key) {
			cmd.env(key, v);
		}
	}
	if !cwd.is_empty() {
		cmd.cwd(&cwd);
	}

	let child = pair.slave.spawn_command(cmd).map_err(|e| format!("spawn shell 失败: {e}"))?;
	let killer = child.clone_killer();

	// 拿 reader（用于线程读）和 writer（用于处理用户输入）
	let mut reader = pair.master.try_clone_reader().map_err(|e| format!("clone reader 失败: {e}"))?;
	let writer = pair.master.take_writer().map_err(|e| format!("take writer 失败: {e}"))?;

	// 关掉 slave 的句柄，否则 master 永远不会因 child exit 而 EOF
	drop(pair.slave);

	let id = gen_id();

	// 启动 reader 线程：阻塞 read，每 chunk 转 Tauri event
	let app_clone = app.clone();
	let id_clone  = id.clone();
	std::thread::spawn(move || {
		let mut buf = vec![0u8; 8192];
		loop {
			match reader.read(&mut buf) {
				Ok(0) => break, // EOF
				Ok(n) => {
					let payload = TerminalDataEvent {
						id: id_clone.clone(),
						data: buf[..n].to_vec(),
					};
					if let Err(e) = app_clone.emit("terminal://data", payload) {
						eprintln!("[terminal {id_clone}] emit data 失败: {e}");
						break;
					}
				}
				Err(e) => {
					eprintln!("[terminal {id_clone}] read 错误: {e}");
					break;
				}
			}
		}
		// reader 退出 = master 的 slave 端已关闭 = shell 进程结束
		// 无法在这里直接拿 exit_code（child 在主线程）；用单独线程在 wait 上块阻塞拿
	});

	// 启动 wait 线程：等 child 退出，发 exit 事件，并从 registry 移除
	let app_wait = app.clone();
	let id_wait  = id.clone();
	let mut child_for_wait = child;
	std::thread::spawn(move || {
		let exit_code = child_for_wait.wait().ok().map(|s| s.exit_code() as i32);
		let _ = app_wait.emit("terminal://exit", TerminalExitEvent {
			id: id_wait.clone(),
			exit_code,
		});
		// 从 registry 移除
		if let Some(state) = app_wait.try_state::<TerminalRegistry>() {
			let mut map = state.0.lock();
			map.remove(&id_wait);
		}
		println!("[terminal] {id_wait} 退出 (exitCode={:?})", exit_code);
	});

	let session = PtySession {
		id:        id.clone(),
		writer,
		master:    pair.master,
		killer,
	};

	{
		let mut map = registry.0.lock();
		map.insert(id.clone(), session);
	}

	println!("[terminal] 新建 {id} (shell={shell_path}, cwd={cwd}, {cols}x{rows})");
	Ok(id)
}

/// 写入用户输入到 PTY
#[tauri::command]
pub fn terminal_write(
	registry: State<'_, TerminalRegistry>,
	args: WriteArgs,
) -> Result<(), String> {
	let mut map = registry.0.lock();
	let session = map.get_mut(&args.id).ok_or_else(|| format!("终端 {} 不存在", args.id))?;
	session.writer.write_all(args.data.as_bytes()).map_err(|e| format!("写入失败: {e}"))?;
	session.writer.flush().map_err(|e| format!("flush 失败: {e}"))?;
	Ok(())
}

/// 调整 PTY 尺寸
#[tauri::command]
pub fn terminal_resize(
	registry: State<'_, TerminalRegistry>,
	args: ResizeArgs,
) -> Result<(), String> {
	let map = registry.0.lock();
	let session = map.get(&args.id).ok_or_else(|| format!("终端 {} 不存在", args.id))?;
	session.master.resize(PtySize {
		rows: args.rows,
		cols: args.cols,
		pixel_width: 0,
		pixel_height: 0,
	}).map_err(|e| format!("resize 失败: {e}"))?;
	Ok(())
}

/// 主动关闭终端（等同 Ctrl+D + kill）
#[tauri::command]
pub fn terminal_close(
	registry: State<'_, TerminalRegistry>,
	args: CloseArgs,
) -> Result<(), String> {
	let mut map = registry.0.lock();
	if let Some(mut session) = map.remove(&args.id) {
		// 先尝试正常 kill，让 wait 线程发 exit 事件
		let _ = session.killer.kill();
	}
	Ok(())
}
