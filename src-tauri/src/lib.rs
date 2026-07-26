pub mod commands;
pub mod db;
pub mod error;
pub mod indexer;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let conn = db::open_at(&data_dir.join("cancioneiro.db"))
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(commands::Db(Mutex::new(conn)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_folder,
            commands::remove_folder,
            commands::list_folders,
            commands::scan,
            commands::list_songs,
            commands::get_lyrics,
            commands::file_exists,
            commands::create_playlist,
            commands::delete_playlist,
            commands::list_playlists,
            commands::get_playlist_items,
            commands::add_to_playlist,
            commands::remove_playlist_item,
            commands::reorder_playlist,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
