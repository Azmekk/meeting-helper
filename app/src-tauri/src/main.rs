// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Started by Claude Code, Codex or another MCP client instead of by the user.
    if std::env::args().any(|a| a == "--mcp") {
        app_lib::run_mcp();
        return;
    }
    app_lib::run()
}
