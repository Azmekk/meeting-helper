//! Moves and resizes a window in one step. The overlay grows upward when its
//! answer bubble opens, which needs both; two separate calls show a frame
//! where the window has moved but not yet grown, so the overlay flickers.

#[tauri::command]
pub fn set_window_bounds(window: tauri::WebviewWindow, x: i32, y: i32, width: u32, height: u32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos};
        let raw = window.hwnd().map_err(|e| e.to_string())?;
        let hwnd = HWND(raw.0 as _);
        // SAFETY: the handle belongs to this live window; SetWindowPos only reads it.
        unsafe { SetWindowPos(hwnd, None, x, y, width as i32, height as i32, SWP_NOZORDER | SWP_NOACTIVATE) }
            .map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    {
        window.set_position(tauri::PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
        window.set_size(tauri::PhysicalSize::new(width, height)).map_err(|e| e.to_string())
    }
}
