#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod commands;
mod data_url;
mod editing;
mod frontend;
mod text_lines;

use std::sync::{Arc, Mutex};

pub(crate) fn document_changed(handle: &izumo::AppHandle, pages: usize) {
    let reply = serde_json::json!({ "pages": pages });
    if let Err(error) = handle.emit("document_changed", &reply) {
        eprintln!("pdf-viewer: could not announce the changed document: {error}");
    }
}

fn window_spec() -> izumo::WindowSpec {
    izumo::WindowSpec {
        label: "main".to_owned(),
        identifier: "com.pathscale.pdf-viewer".to_owned(),
        url: frontend::UI_URL.to_owned(),
        title: "PDF Viewer".to_owned(),
        width: 1200.0,
        height: 900.0,
        min_width: Some(720.0),
        min_height: Some(480.0),
        visible: false,
        resizable: true,
        title_bar_style: izumo::TitleBarStyle::Overlay,
        hidden_title: true,
        background_color: None,
        ..Default::default()
    }
}

fn run() -> izumo::AppResult {
    let _runtime = nagoya::runtime::background();
    let state: commands::State = Arc::new(Mutex::new(None));
    let mut startup = None;

    if let Some(path) = std::env::args_os().nth(1) {
        match commands::open_path(&state, std::path::Path::new(&path)) {
            Ok(reply) => startup = Some(reply),
            Err(error) => eprintln!("pdf-viewer: {error}"),
        }
    }

    izumo::set_document_factory(frontend::document);

    let builder = izumo::App::builder().manage(Arc::clone(&state));
    let handle = builder.handle();
    let mut command_table = commands::table(Arc::clone(&state), handle);
    command_table.push(("text_lines", text_lines::handler(state)));

    builder
        .commands(command_table)
        .window(window_spec())
        .setup(move |app| {
            // Local agent control (inspection, screenshots) is off unless asked
            // for, as in chuzz: PDF_VIEWER_CONTROL=1 for QA runs.
            let control = matches!(
                std::env::var("PDF_VIEWER_CONTROL").ok().as_deref(),
                Some("1") | Some("true") | Some("on")
            );
            if control {
                izumo::apply_runtime_debug_options(izumo::RuntimeDebugOptions {
                    inspection_and_agent_control: true,
                    deep_intrusive_profiling: false,
                })
                .map_err(|error| format!("could not enable agent control: {error}"))?;
            }
            app.show()?;
            if let Some(reply) = startup {
                app.emit("document_opened", reply)?;
            }
            Ok(())
        })
        .run()
}

fn main() {
    if let Err(error) = run() {
        eprintln!("pdf-viewer: {error}");
        std::process::exit(1);
    }
}

