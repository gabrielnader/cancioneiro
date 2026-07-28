pub mod commands;
pub mod db;
pub mod enrich;
pub mod error;
pub mod indexer;
pub mod lyrics_fetch;
pub mod search;
pub mod vagalume;
pub mod writer;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());

    // V7/F16 — atualização automática. Só faz sentido no desktop; a checagem em
    // si é disparada pelo frontend DEPOIS que a janela abre (nunca no setup),
    // e falha em silêncio quando não há rede.
    #[cfg(desktop)]
    {
        builder = builder
            .plugin(tauri_plugin_updater::Builder::new().build())
            .plugin(tauri_plugin_process::init());
    }

    builder
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let db_path = data_dir.join("cancioneiro.db");
            let conn = db::open_at(&db_path)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
            app.manage(commands::Db::new(conn, Some(db_path)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::add_folder,
            commands::remove_folder,
            commands::list_folders,
            commands::scan,
            commands::list_songs,
            commands::search,
            commands::get_lyrics,
            commands::file_exists,
            commands::create_playlist,
            commands::delete_playlist,
            commands::list_playlists,
            commands::get_playlist_items,
            commands::add_to_playlist,
            commands::remove_playlist_item,
            commands::reorder_playlist,
            commands::write_tags,
            commands::fetch_lyrics_online,
            commands::enrich_folder_scan,
            commands::enrich_song_scan,
            commands::enrich_cancel_scan,
            commands::enrich_apply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
