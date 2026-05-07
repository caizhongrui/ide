/*---------------------------------------------------------------------------------------------
 *  pet.rs — 桌面豹子宠物窗口（K-Pet）
 *
 *  独立 Tauri WebviewWindow，加载 pet.html：
 *    - transparent + decorations:false + always-on-top + skip-taskbar
 *    - 默认 160×160，靠右上角放
 *    - 状态由主窗口通过 'pet:state' Tauri 事件广播过来
 *    - 命令：pet_window_show / pet_window_hide / pet_window_toggle / pet_window_snap
 *--------------------------------------------------------------------------------------------*/

use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindowBuilder};

const PET_WINDOW_LABEL: &str = "pet";
const PET_WIDTH: f64 = 200.0;
const PET_HEIGHT: f64 = 220.0;   // 略高，因为机械豹是全身站立人形
/// 默认距离屏幕边的内边距
const PET_MARGIN: f64 = 24.0;

/// 创建（或拿到）pet 窗口
fn ensure_pet_window(app: &AppHandle) -> Result<tauri::WebviewWindow, String> {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		return Ok(win);
	}
	// 默认放屏幕右上角
	let (sx, sy) = primary_monitor_size(app);
	let pos_x = (sx - PET_WIDTH - PET_MARGIN).max(0.0);
	let pos_y = PET_MARGIN;

	let builder = WebviewWindowBuilder::new(app, PET_WINDOW_LABEL, WebviewUrl::App("pet.html".into()))
		.title("Maxian Pet")
		.inner_size(PET_WIDTH, PET_HEIGHT)
		.min_inner_size(140.0, 160.0)
		.max_inner_size(320.0, 360.0)
		.resizable(false)
		.always_on_top(true)
		.decorations(false)
		.transparent(true)
		.skip_taskbar(true)
		.shadow(false)
		.focused(false)
		.position(pos_x, pos_y);

	builder.build().map_err(|e| format!("创建 pet 窗口失败: {e}"))
}

/// 获取主显示器逻辑尺寸（pet 窗口位置计算用）
fn primary_monitor_size(app: &AppHandle) -> (f64, f64) {
	if let Some(win) = app.get_webview_window("main") {
		if let Ok(Some(monitor)) = win.current_monitor() {
			let size = monitor.size();
			let scale = monitor.scale_factor();
			return (size.width as f64 / scale, size.height as f64 / scale);
		}
	}
	(1440.0, 900.0)
}

#[tauri::command]
pub async fn pet_window_show(app: AppHandle) -> Result<(), String> {
	let win = ensure_pet_window(&app)?;
	win.show().map_err(|e| e.to_string())?;
	// 不抢焦点，保持主窗口活动
	let _ = win.set_focus();
	Ok(())
}

#[tauri::command]
pub async fn pet_window_hide(app: AppHandle) -> Result<(), String> {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		win.hide().map_err(|e| e.to_string())?;
	}
	Ok(())
}

#[tauri::command]
pub async fn pet_window_toggle(app: AppHandle) -> Result<bool, String> {
	if let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) {
		let visible = win.is_visible().unwrap_or(false);
		if visible {
			win.hide().map_err(|e| e.to_string())?;
			Ok(false)
		} else {
			win.show().map_err(|e| e.to_string())?;
			Ok(true)
		}
	} else {
		// 还没创建过 → 创建并显示
		let win = ensure_pet_window(&app)?;
		win.show().map_err(|e| e.to_string())?;
		Ok(true)
	}
}

/// 把宠物窗口贴到屏幕指定角落
/// corner: "top-left" | "top-right" | "bottom-left" | "bottom-right"
#[tauri::command]
pub async fn pet_window_snap(app: AppHandle, corner: String) -> Result<(), String> {
	let Some(win) = app.get_webview_window(PET_WINDOW_LABEL) else {
		return Err("pet 窗口未创建".into());
	};
	let (sw, sh) = primary_monitor_size(&app);
	let (x, y) = match corner.as_str() {
		"top-left"     => (PET_MARGIN, PET_MARGIN),
		"top-right"    => ((sw - PET_WIDTH - PET_MARGIN).max(0.0), PET_MARGIN),
		"bottom-left"  => (PET_MARGIN, (sh - PET_HEIGHT - PET_MARGIN).max(0.0)),
		"bottom-right" => ((sw - PET_WIDTH - PET_MARGIN).max(0.0), (sh - PET_HEIGHT - PET_MARGIN).max(0.0)),
		_ => return Err(format!("未知 corner: {corner}")),
	};
	win.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
	Ok(())
}

/// 主窗口推状态给宠物窗口（前端可直接用 Tauri 的 emit_to API；这里另外提供一条原生命令，
/// 方便在 Rust 侧（比如 sidecar 监听）也能驱动）
#[tauri::command]
pub async fn pet_emit_state(app: AppHandle, state: String, hint: Option<String>) -> Result<(), String> {
	let payload = serde_json::json!({
		"state": state,
		"hint": hint,
	});
	let _ = app.emit_to(PET_WINDOW_LABEL, "pet:state", payload);
	Ok(())
}
