#[cfg_attr(mobile, tauri::mobile_entry_point)]

use std::fs;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::Manager;

// ═══════════════════════════════════════════════
// 自定义文件系统命令（绕过插件 scope 限制）
// ═══════════════════════════════════════════════

/// 列出目录内容
#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let dir = Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("读取目录失败: {}", e))?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
        let file_type = entry.file_type().map_err(|e| format!("获取文件类型失败: {}", e))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let entry_path = entry.path();
        result.push(DirEntry {
            name,
            path: entry_path.to_string_lossy().to_string(),
            is_dir: file_type.is_dir(),
        });
    }
    // 目录在前，文件在后，按名称排序
    result.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(result)
}

/// 读取文本文件内容
#[tauri::command]
fn read_file_content(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("读取文件失败: {}", e))
}

/// 写入文本文件内容
#[tauri::command]
fn write_file_content(path: String, content: String) -> Result<(), String> {
    fs::write(&path, &content).map_err(|e| format!("写入文件失败: {}", e))
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

/// 存放 Python 子进程句柄，Tauri 退出时用它来杀进程
struct PythonBackend(Mutex<Option<Child>>);

/// 获取项目根目录
/// 编译时通过 CARGO_MANIFEST_DIR（= src-tauri/）向上推一级
fn project_root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("无法确定项目根目录")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![list_dir, read_file_content, write_file_content])
        .setup(|app| {
            // ═══════════════════════════════════════
            // 第 1 步：清理上次可能残留的孤儿进程
            // ═══════════════════════════════════════
            cleanup_orphan_processes();

            // ═══════════════════════════════════════
            // 第 2 步：启动 Python 后端
            // ═══════════════════════════════════════
            println!("[Lubia] 正在启动 Python 后端...");

            let child = Command::new("python")
                .current_dir(project_root())
                .args([
                    "-m", "uvicorn",
                    "backend.main:app",
                    "--host", "127.0.0.1",
                    "--port", "19800",
                ])
                .spawn()
                .expect("[Lubia] 无法启动 Python 后端，请确认 Python 已安装");

            println!("[Lubia] Python 后端已启动 (PID: {})", child.id());

            // 存入 Tauri 状态管理器
            app.manage(PythonBackend(Mutex::new(Some(child))));

            // ═══════════════════════════════════════
            // 第 3 步：等待后端就绪（轮询 /health）
            // ═══════════════════════════════════════
            wait_for_backend();

            // ═══════════════════════════════════════
            // 第 4 步：debug 模式下启用日志插件
            // ═══════════════════════════════════════
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // ═══════════════════════════════════════
            // Tauri 退出 → 杀 Python 进程
            // ═══════════════════════════════════════
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<PythonBackend>();
                let child_opt = state.0.lock().unwrap().take();
                if let Some(mut child) = child_opt {
                    println!("[Lubia] 正在关闭 Python 后端...");
                    let _ = child.kill();
                    let _ = child.wait();
                    println!("[Lubia] Python 后端已关闭");
                }
            }
        });
}

// ═══════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════

/// 启动时清理可能残留的旧 Python 进程（占用 19800 端口的）
fn cleanup_orphan_processes() {
    #[cfg(target_os = "windows")]
    {
        let output = Command::new("cmd")
            .args(["/C", "netstat -ano | findstr :19800"])
            .output();

        if let Ok(out) = output {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if let Some(pid) = parts.last() {
                    // 跳过 PID 0（System Idle Process）
                    if *pid == "0" {
                        continue;
                    }
                    println!("[Lubia] 清理孤儿进程 PID={}", pid);
                    let _ = Command::new("taskkill")
                        .args(["/F", "/PID", pid])
                        .output();
                }
            }
        }
    }
}

/// 轮询 /health，等待后端就绪（最多等 15 秒）
fn wait_for_backend() {
    let max_retries = 30; // 30 次 × 500ms = 15 秒
    for i in 0..max_retries {
        thread::sleep(Duration::from_millis(500));

        // 用系统 curl 发请求（不引入 reqwest 依赖）
        let output = Command::new("curl")
            .args(["-s", "http://127.0.0.1:19800/health"])
            .output();

        if let Ok(out) = output {
            if out.status.success() {
                let body = String::from_utf8_lossy(&out.stdout);
                if body.contains("\"code\":200") {
                    println!("[Lubia] 后端就绪 ({}ms)", (i + 1) * 500);
                    return;
                }
            }
        }
    }
    println!("[Lubia] 警告：后端在 15 秒内未就绪，继续启动窗口");
}
