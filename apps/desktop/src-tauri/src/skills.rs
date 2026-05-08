/*---------------------------------------------------------------------------------------------
 *  skills.rs — 内置技能库（bundled skills）安装模块
 *
 *  职责：
 *    1. 首次启动时自动把 `core` 组技能复制到 ~/.maxian/skills/maxian-builtin/
 *       —— 通过 ~/.maxian/skills/.maxian-bundled-installed-v{N} 标志位记录已安装版本
 *    2. 提供 list_bundled_skills 命令返回 manifest 给前端"推荐技能库"面板
 *    3. 提供 install_bundled_skills 命令按 skill_id 列表安装到指定目录
 *
 *  路径解析策略：
 *    Dev：resource = <repo>/apps/desktop/bundled-skills/
 *    Release：通过 app.path().resolve_resource("bundled-skills/...") 拿到 .app 内的路径
 *--------------------------------------------------------------------------------------------*/

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 标志位文件版本号 —— 当 manifest 增减 core skill 时 +1，会触发新增的 skill 补装
const INSTALLED_FLAG_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SkillEntry {
    pub id: String,
    pub file: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SkillGroup {
    pub id: String,
    pub title: String,
    pub description: String,
    #[serde(rename = "autoInstall", default)]
    pub auto_install: bool,
    pub skills: Vec<SkillEntry>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SkillsManifest {
    pub version: u32,
    pub description: String,
    pub groups: Vec<SkillGroup>,
}

#[derive(Serialize, Clone, Debug)]
pub struct InstallResult {
    pub installed: Vec<String>,         // 成功安装的 skill id
    pub skipped: Vec<String>,           // 已存在跳过
    pub failed: Vec<(String, String)>,  // (skill_id, 错误原因)
    pub target_dir: String,
}

// ─── 路径辅助 ─────────────────────────────────────────────────────────────

fn home_dir() -> Option<PathBuf> {
    #[cfg(unix)]
    let h = std::env::var("HOME").ok();
    #[cfg(windows)]
    let h = std::env::var("USERPROFILE").ok();
    h.map(PathBuf::from)
}

/// 解析 bundled-skills 目录绝对路径。
/// - Dev：从 current_exe 向上找 `apps/desktop/bundled-skills/` 或同级 `bundled-skills/`
/// - Release：通过 Tauri resource API 取 .app 内资源路径
fn resolve_bundled_dir(app: &AppHandle) -> Option<PathBuf> {
    // 优先走 release 路径（Tauri resolve_resource）
    if let Ok(resource_path) = app.path().resolve(
        "bundled-skills/manifest.json",
        tauri::path::BaseDirectory::Resource,
    ) {
        if resource_path.exists() {
            // 返回 manifest.json 的父目录
            if let Some(parent) = resource_path.parent() {
                return Some(parent.to_path_buf());
            }
        }
    }

    // dev 模式 fallback：从 current_exe 向上探测
    if let Ok(exe) = std::env::current_exe() {
        let mut probe = exe.clone();
        for _ in 0..6 {
            for tail in [
                "bundled-skills",
                "apps/desktop/bundled-skills",
                "../bundled-skills",
            ] {
                let cand = probe.join(tail);
                if cand.join("manifest.json").exists() {
                    return Some(cand);
                }
            }
            if let Some(parent) = probe.parent() {
                probe = parent.to_path_buf();
            } else {
                break;
            }
        }
    }
    None
}

fn read_manifest(bundled_dir: &Path) -> Result<SkillsManifest, String> {
    let path = bundled_dir.join("manifest.json");
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 manifest.json 失败 ({}): {}", path.display(), e))?;
    serde_json::from_str::<SkillsManifest>(&raw)
        .map_err(|e| format!("解析 manifest.json 失败: {}", e))
}

/// 把单个 skill 安装到目标目录。返回 (installed, skipped) — 都是 bool。
fn install_one(
    bundled_dir: &Path,
    skill: &SkillEntry,
    target_dir: &Path,
    overwrite: bool,
) -> Result<bool, String> {
    let src = bundled_dir.join(&skill.file);
    if !src.exists() {
        return Err(format!("源文件不存在: {}", src.display()));
    }
    // 用 skill.id.md 命名（不复制原始 core/xxx.md 路径结构）
    let dst = target_dir.join(format!("{}.md", skill.id));
    if dst.exists() && !overwrite {
        return Ok(false); // skipped
    }
    std::fs::create_dir_all(target_dir)
        .map_err(|e| format!("创建目录 {} 失败: {}", target_dir.display(), e))?;
    std::fs::copy(&src, &dst)
        .map_err(|e| format!("复制 {} → {} 失败: {}", src.display(), dst.display(), e))?;
    Ok(true)
}

// ─── 首次启动自动安装 ─────────────────────────────────────────────────────

/// 在 setup() 阶段调用：检查标志位，如未装则把 core 组复制到 ~/.maxian/skills/maxian-builtin/。
/// 不抛错——失败仅打印日志，不阻断应用启动。
pub fn auto_install_core_skills_on_first_launch(app: &AppHandle) {
    let Some(home) = home_dir() else {
        eprintln!("[skills] 无法解析 HOME，跳过自动安装");
        return;
    };
    let skills_root = home.join(".maxian").join("skills");
    let flag_path = skills_root.join(format!(".maxian-bundled-installed-v{}", INSTALLED_FLAG_VERSION));

    if flag_path.exists() {
        // 已经装过当前版本，不再处理
        return;
    }

    let Some(bundled_dir) = resolve_bundled_dir(app) else {
        eprintln!("[skills] 找不到 bundled-skills 目录，跳过自动安装");
        return;
    };

    let manifest = match read_manifest(&bundled_dir) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[skills] {}", e);
            return;
        }
    };

    let target_dir = skills_root.join("maxian-builtin");
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        eprintln!("[skills] 创建目标目录失败: {}", e);
        return;
    }

    let mut installed_count = 0;
    let mut skipped_count = 0;
    for group in &manifest.groups {
        if !group.auto_install {
            continue;
        }
        for skill in &group.skills {
            match install_one(&bundled_dir, skill, &target_dir, false) {
                Ok(true) => installed_count += 1,
                Ok(false) => skipped_count += 1,
                Err(e) => eprintln!("[skills] 安装 {} 失败: {}", skill.id, e),
            }
        }
    }

    // 写标志位（用 JSON 记录元信息便于排查）
    let installed_at_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let flag_content = serde_json::json!({
        "version": INSTALLED_FLAG_VERSION,
        "installedAtUnix": installed_at_unix,
        "installedCount": installed_count,
        "skippedCount": skipped_count,
    });
    let _ = std::fs::write(&flag_path, flag_content.to_string());
    println!(
        "[skills] 自动安装完成：新装 {} 个，已存在跳过 {} 个 → {}",
        installed_count,
        skipped_count,
        target_dir.display()
    );
}

// ─── Tauri 命令：列出 bundled manifest ─────────────────────────────────────

#[tauri::command]
pub fn list_bundled_skills(app: AppHandle) -> Result<SkillsManifest, String> {
    let bundled_dir = resolve_bundled_dir(&app)
        .ok_or_else(|| "找不到内置技能目录".to_string())?;
    read_manifest(&bundled_dir)
}

// ─── Tauri 命令：手动安装一组 skills ───────────────────────────────────────

#[derive(Deserialize)]
pub struct InstallArgs {
    /// 要安装的 skill id 列表（来自 manifest）
    pub skill_ids: Vec<String>,
    /// 目标位置标识："user"（~/.maxian/skills/maxian-builtin/）或 "user-custom"（~/.maxian/skills/）
    /// 默认 "user"
    #[serde(default)]
    pub target: Option<String>,
    /// 是否覆盖已存在文件
    #[serde(default)]
    pub overwrite: bool,
}

#[tauri::command]
pub fn install_bundled_skills(app: AppHandle, args: InstallArgs) -> Result<InstallResult, String> {
    let bundled_dir = resolve_bundled_dir(&app)
        .ok_or_else(|| "找不到内置技能目录".to_string())?;
    let manifest = read_manifest(&bundled_dir)?;
    let home = home_dir().ok_or_else(|| "无法解析 HOME".to_string())?;

    let target_dir = match args.target.as_deref().unwrap_or("user") {
        "user" => home.join(".maxian").join("skills").join("maxian-builtin"),
        "user-custom" => home.join(".maxian").join("skills"),
        other => return Err(format!("未知 target: {}", other)),
    };

    std::fs::create_dir_all(&target_dir)
        .map_err(|e| format!("创建目录失败: {}", e))?;

    // 把所有 skill flatten 成 id → entry 映射
    let mut all: std::collections::HashMap<String, &SkillEntry> = std::collections::HashMap::new();
    for group in &manifest.groups {
        for s in &group.skills {
            all.insert(s.id.clone(), s);
        }
    }

    let mut result = InstallResult {
        installed: vec![],
        skipped: vec![],
        failed: vec![],
        target_dir: target_dir.to_string_lossy().into_owned(),
    };

    for sid in &args.skill_ids {
        let Some(skill) = all.get(sid) else {
            result.failed.push((sid.clone(), "manifest 中未找到".to_string()));
            continue;
        };
        match install_one(&bundled_dir, skill, &target_dir, args.overwrite) {
            Ok(true) => result.installed.push(sid.clone()),
            Ok(false) => result.skipped.push(sid.clone()),
            Err(e) => result.failed.push((sid.clone(), e)),
        }
    }
    Ok(result)
}

