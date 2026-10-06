use crate::access::{canonicalize_lossy, ensure_allowed, is_symlink, is_under, AppState};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};

/// Same soft cap as vault search file reads (plugin CSS/JS assets).
const MAX_PLUGIN_FILE_BYTES: u64 = 1_500_000;
/// Hard cap for a single `plugin.json` manifest (parsed fully into memory).
const MAX_PLUGIN_MANIFEST_BYTES: u64 = 1024 * 1024;
/// Hard cap on plugin folders scanned under a single root.
const MAX_PLUGIN_DIR_ENTRIES: usize = 512;
/// Resource types `read_plugin_file` may serve. Plugins are CSS-only (API v2,
/// no JS execution) — anything scriptable/executable must never be returned.
const ALLOWED_PLUGIN_RES_EXTS: &[&str] = &["css", "json"];

/// Whether `path` carries an extension a plugin resource may have (`.css` / `.json`).
fn plugin_res_ext_allowed(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            ALLOWED_PLUGIN_RES_EXTS
                .iter()
                .any(|x| e.eq_ignore_ascii_case(x))
        })
        .unwrap_or(false)
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub id: String,
    pub title: String,
    pub keybinding: Option<String>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub field_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginContributes {
    pub css: Vec<String>,
    pub commands: Vec<PluginCommand>,
    pub body_class: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub settings: Vec<PluginSettingField>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub source: String,
    pub root: String,
    pub contributes: PluginContributes,
}

/// Parse a `plugin.json` body. `dir` is only used for the default `style.css` fallback.
pub(crate) fn parse_plugin_manifest_str(raw: &str, dir: &Path, source: &str) -> Option<PluginInfo> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    parse_plugin_manifest_value(value, dir, source)
}

fn parse_plugin_manifest_value(
    value: serde_json::Value,
    dir: &Path,
    source: &str,
) -> Option<PluginInfo> {
    let id = value.get("id")?.as_str()?.to_string();
    let name = value
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(&id)
        .to_string();
    let version = value
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("0.0.0")
        .to_string();
    let description = value
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let author = value
        .get("author")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let contributes_val = value.get("contributes");
    let css = contributes_val
        .and_then(|c| c.get("css"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            if dir.join("style.css").exists() {
                vec!["style.css".into()]
            } else {
                Vec::new()
            }
        });

    let commands = contributes_val
        .and_then(|c| c.get("commands"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let id = item.get("id")?.as_str()?.to_string();
                    let title = item
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let keybinding = item
                        .get("keybinding")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    Some(PluginCommand {
                        id,
                        title,
                        keybinding,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let body_class = contributes_val
        .and_then(|c| c.get("bodyClass").or_else(|| c.get("body_class")))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| Some(format!("plugin-{id}")));

    let settings = contributes_val
        .and_then(|c| c.get("settings"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| {
                    let key = item.get("key")?.as_str()?.to_string();
                    let label = item
                        .get("label")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&key)
                        .to_string();
                    let field_type = item
                        .get("type")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let default = item.get("default").cloned();
                    Some(PluginSettingField {
                        key,
                        label,
                        field_type,
                        default,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    Some(PluginInfo {
        id,
        name,
        version,
        description,
        author,
        source: source.to_string(),
        root: dir.to_string_lossy().to_string(),
        contributes: PluginContributes {
            css,
            commands,
            body_class,
            settings,
        },
    })
}

pub(crate) fn parse_plugin_manifest(dir: &Path, source: &str) -> Result<PluginInfo, String> {
    let manifest_path = dir.join("plugin.json");
    let meta = fs::metadata(&manifest_path).map_err(|e| format!("无法读取插件清单: {e}"))?;
    if !meta.is_file() {
        return Err("插件清单不是文件".into());
    }
    if meta.len() > MAX_PLUGIN_MANIFEST_BYTES {
        return Err(format!(
            "插件清单过大（上限 {} KB）",
            MAX_PLUGIN_MANIFEST_BYTES / 1024
        ));
    }
    let raw = fs::read_to_string(&manifest_path).map_err(|e| format!("无法读取插件清单: {e}"))?;
    parse_plugin_manifest_str(&raw, dir, source).ok_or_else(|| "插件清单格式无效".to_string())
}

pub(crate) fn scan_plugin_root(root: &Path, source: &str, out: &mut Vec<PluginInfo>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten().take(MAX_PLUGIN_DIR_ENTRIES) {
        let path = entry.path();
        // Only real directories: `is_dir()` follows symlinks, so a link pointing
        // outside the vault could otherwise get its plugin listed. Skip links.
        if is_symlink(&path) || !path.is_dir() {
            continue;
        }
        match parse_plugin_manifest(&path, source) {
            Ok(info) => {
                // Prefer app-level over vault if same id already present
                if out.iter().any(|p| p.id == info.id) {
                    continue;
                }
                out.push(info);
            }
            Err(err) => eprintln!("skip plugin manifest {}: {err}", path.display()),
        }
    }
}

/// Resolve (and create) the per-user plugins directory. Blocking; callers own
/// the thread (commands wrap it in `spawn_blocking`).
pub(crate) fn user_plugins_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取应用数据目录: {e}"))?
        .join("plugins");
    fs::create_dir_all(&dir).map_err(|e| format!("无法创建插件目录: {e}"))?;
    Ok(dir)
}

#[tauri::command]
pub(crate) async fn get_user_plugins_dir(app: tauri::AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = user_plugins_dir(&app)?;
        Ok(dir.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("插件目录任务失败: {e}"))?
}

#[tauri::command]
pub(crate) async fn list_plugins(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    vault_root: Option<String>,
) -> Result<Vec<PluginInfo>, String> {
    // ACL check up-front (cheap, needs State); scan runs on a blocking thread.
    if let Some(vault) = &vault_root {
        let vault_path = PathBuf::from(vault);
        ensure_allowed(&state, &vault_path)?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut plugins = Vec::new();

        let user_dir = user_plugins_dir(&app)?;
        scan_plugin_root(&user_dir, "user", &mut plugins);

        if let Some(vault) = vault_root {
            let vault_plugins = PathBuf::from(&vault).join(".markelle").join("plugins");
            scan_plugin_root(&vault_plugins, "vault", &mut plugins);
        }

        plugins.sort_by_key(|a| a.name.to_lowercase());
        Ok(plugins)
    })
    .await
    .map_err(|e| format!("插件扫描任务失败: {e}"))?
}

pub(crate) fn ensure_plugin_root_allowed(
    app: &AppHandle,
    state: &AppState,
    root: &Path,
) -> Result<(), String> {
    let user_dir = user_plugins_dir(app)?;
    let user_canon = canonicalize_lossy(&user_dir);
    let root_canon = canonicalize_lossy(root);
    if is_under(&root_canon, &user_canon) || root_canon == user_canon {
        return Ok(());
    }
    // Must live under an allowed vault: <vault>/.markelle/plugins[/...]
    let access = state
        .access
        .lock()
        .map_err(|_| "访问控制锁失败".to_string())?;
    for vault in &access.vault_roots {
        let plugins_dir = vault.join(".markelle").join("plugins");
        let plugins_canon = canonicalize_lossy(&plugins_dir);
        if root_canon == plugins_canon || is_under(&root_canon, &plugins_canon) {
            return Ok(());
        }
    }
    Err("拒绝访问未授权插件目录".into())
}

#[tauri::command]
pub(crate) async fn read_plugin_file(
    app: AppHandle,
    state: State<'_, AppState>,
    root: String,
    relative: String,
) -> Result<String, String> {
    let root = PathBuf::from(root);
    ensure_plugin_root_allowed(&app, &state, &root)?;
    let rel = PathBuf::from(relative.replace('\\', "/"));
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("非法插件路径".into());
    }
    let path = root.join(&rel);
    tauri::async_runtime::spawn_blocking(move || {
        if is_symlink(&path) {
            return Err("拒绝读取符号链接插件资源".into());
        }
        let root_canon = fs::canonicalize(&root).map_err(|e| format!("无法解析插件根: {e}"))?;
        let path_canon = fs::canonicalize(&path).map_err(|e| format!("无法解析插件文件: {e}"))?;
        if !path_canon.starts_with(&root_canon) {
            return Err("非法插件路径".into());
        }
        if !path_canon.is_file() {
            return Err(format!("文件不存在: {}", path.display()));
        }
        // Plugins are CSS-only: never hand back scripts / HTML / SVG (scriptable
        // surfaces) even though the response is text.
        if !plugin_res_ext_allowed(&path_canon) {
            let ext = path_canon
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("(无扩展名)");
            return Err(format!(
                "插件资源仅允许 .css / .json（拒绝脚本或可执行资源: .{ext}）"
            ));
        }
        let meta = fs::metadata(&path_canon).map_err(|e| format!("无法读取: {e}"))?;
        if meta.len() > MAX_PLUGIN_FILE_BYTES {
            return Err("插件资源过大".into());
        }
        fs::read_to_string(&path_canon).map_err(|e| format!("无法读取插件文件: {e}"))
    })
    .await
    .map_err(|e| format!("读取插件文件任务失败: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn parse_minimal_plugin_manifest() {
        let raw = r#"{
            "id": "demo-plugin",
            "name": "Demo",
            "version": "1.2.3",
            "contributes": {
                "css": ["theme.css"],
                "commands": [{ "id": "demo.run", "title": "Run Demo" }]
            }
        }"#;
        let info = parse_plugin_manifest_str(raw, Path::new("/tmp/demo-plugin"), "user")
            .expect("manifest should parse");
        assert_eq!(info.id, "demo-plugin");
        assert_eq!(info.name, "Demo");
        assert_eq!(info.version, "1.2.3");
        assert_eq!(info.source, "user");
        assert_eq!(info.contributes.css, vec!["theme.css".to_string()]);
        assert_eq!(info.contributes.commands.len(), 1);
        assert_eq!(info.contributes.commands[0].id, "demo.run");
        assert_eq!(
            info.contributes.body_class.as_deref(),
            Some("plugin-demo-plugin")
        );
    }

    #[test]
    fn parse_rejects_missing_id() {
        let raw = r#"{ "name": "No Id" }"#;
        assert!(parse_plugin_manifest_str(raw, Path::new("/tmp/x"), "user").is_none());
    }

    #[test]
    fn plugin_resources_only_css_and_json() {
        assert!(plugin_res_ext_allowed(Path::new("theme.css")));
        assert!(plugin_res_ext_allowed(Path::new("THEME.CSS")));
        assert!(plugin_res_ext_allowed(Path::new("settings.json")));
        // Scriptable / executable surfaces must never be served.
        assert!(!plugin_res_ext_allowed(Path::new("plugin.js")));
        assert!(!plugin_res_ext_allowed(Path::new("plugin.mjs")));
        assert!(!plugin_res_ext_allowed(Path::new("plugin.cjs")));
        assert!(!plugin_res_ext_allowed(Path::new("index.html")));
        assert!(!plugin_res_ext_allowed(Path::new("logo.svg")));
        assert!(!plugin_res_ext_allowed(Path::new("run.exe")));
        assert!(!plugin_res_ext_allowed(Path::new("noext")));
    }
}
