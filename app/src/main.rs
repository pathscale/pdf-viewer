#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod commands;
mod data_url;
mod editing;
mod frontend;
#[cfg(target_os = "macos")]
mod macos;
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

    #[cfg(not(target_os = "macos"))]
    let mut startup = None;

    #[cfg(target_os = "macos")]
    {
        if let Some(path) = std::env::args_os().nth(1) {
            macos::enqueue_path(std::path::PathBuf::from(path));
        }
        if let Err(error) = macos::register_open_document_handler() {
            eprintln!("pdf-viewer: {error}");
            std::process::exit(1);
        }
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(path) = std::env::args_os().nth(1) {
        match commands::open_path(&state, std::path::Path::new(&path)) {
            Ok(reply) => startup = Some(reply),
            Err(error) => eprintln!("pdf-viewer: {error}"),
        }
    }

    izumo::set_document_factory(frontend::document);

    let builder = izumo::App::builder().manage(Arc::clone(&state));
    let handle = builder.handle();

    #[cfg(target_os = "macos")]
    macos::set_delivery_target(Arc::clone(&state), handle.clone());

    let mut command_table = commands::table(Arc::clone(&state), handle.clone());
    command_table.push(("text_lines", text_lines::handler(Arc::clone(&state))));

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
            #[cfg(target_os = "macos")]
            macos::window_is_ready();
            #[cfg(not(target_os = "macos"))]
            if let Some(reply) = startup {
                app.emit("document_opened", reply)?;
            }
            Ok(())
        })
        .run()
}

#[global_allocator]
static ALLOC: rusty_alloc::RustyAlloc = rusty_alloc::RustyAlloc;

fn main() {
    let first_argument = std::env::args_os().nth(1);

    #[cfg(target_os = "macos")]
    {
        if first_argument.as_deref() == Some(std::ffi::OsStr::new("--install-app")) {
            if let Err(error) = macos::install_app() {
                eprintln!("pdf-viewer: {error}");
                std::process::exit(1);
            }
            return;
        }
        if first_argument.as_deref() == Some(std::ffi::OsStr::new("--uninstall-app")) {
            if let Err(error) = macos::uninstall_app() {
                eprintln!("pdf-viewer: {error}");
                std::process::exit(1);
            }
            return;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if first_argument.as_deref() == Some(std::ffi::OsStr::new("--install-app")) {
            eprintln!("pdf-viewer: --install-app is macOS-only");
            std::process::exit(1);
        }
        if first_argument.as_deref() == Some(std::ffi::OsStr::new("--uninstall-app")) {
            eprintln!("pdf-viewer: --uninstall-app is macOS-only");
            std::process::exit(1);
        }
    }

    if let Err(error) = run() {
        eprintln!("pdf-viewer: {error}");
        std::process::exit(1);
    }
}

