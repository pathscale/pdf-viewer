#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

mod commands;
mod data_url;
mod editing;
mod frontend;
#[cfg(target_os = "macos")]
mod macos;
mod text_lines;

use std::io::Write;
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
        if let Some(path) = app_caps::args_os().nth(1) {
            macos::enqueue_path(std::path::PathBuf::from(path));
        }
        if let Err(error) = macos::register_open_document_handler() {
            eprintln!("pdf-viewer: {error}");
            std::process::exit(1);
        }
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(path) = app_caps::args_os().nth(1) {
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

#[path = "app_caps.rs"]
mod app_caps;

fn usage() -> &'static str {
    concat!(
        "Usage: pdf-viewer [OPTIONS] [FILE.pdf]\n\n",
        "Options:\n",
        "  -h, --help                 Print this help and exit\n",
        "  -V, --version              Print version information and exit\n",
        "      --bench-first-page FILE.pdf\n",
        "                             Benchmark opening and rendering the first page\n",
        "      --install-app          Install the macOS application bundle\n",
        "      --uninstall-app        Remove the macOS application bundle\n",
    )
}

fn is_option_like(argument: &std::ffi::OsStr) -> bool {
    argument.to_string_lossy().starts_with('-')
}

fn main() {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();

    if arguments.len() == 1 && matches!(arguments[0].to_str(), Some("--version" | "-V")) {
        println!("pdf-viewer {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if arguments.len() == 1 && matches!(arguments[0].to_str(), Some("--help" | "-h")) {
        print!("{}", usage());
        return;
    }
    if arguments
        .first()
        .is_some_and(|argument| matches!(argument.to_str(), Some("--version" | "-V")))
    {
        eprintln!("pdf-viewer: --version does not accept arguments");
        std::process::exit(2);
    }
    if arguments
        .first()
        .is_some_and(|argument| matches!(argument.to_str(), Some("--help" | "-h")))
    {
        eprintln!("pdf-viewer: --help does not accept arguments");
        std::process::exit(2);
    }

    if arguments
        .first()
        .is_some_and(|argument| is_option_like(argument) && argument != "--bench-first-page")
    {
        let option = arguments[0].to_string_lossy();
        if !matches!(option.as_ref(), "--install-app" | "--uninstall-app") {
            eprintln!("pdf-viewer: unknown option {option}\n{}", usage());
            std::process::exit(2);
        }
        if arguments.len() != 1 {
            eprintln!("pdf-viewer: {option} does not accept arguments");
            std::process::exit(2);
        }
    }
    if let Some(option) = arguments
        .iter()
        .skip(1)
        .find(|argument| is_option_like(argument))
    {
        eprintln!("pdf-viewer: unexpected option {}", option.to_string_lossy());
        std::process::exit(2);
    }
    if arguments.len() > 1
        && !matches!(arguments[0].to_str(), Some("--bench-first-page"))
        && !matches!(
            arguments[0].to_str(),
            Some("--install-app" | "--uninstall-app")
        )
    {
        eprintln!("pdf-viewer: expected at most one PDF path\n{}", usage());
        std::process::exit(2);
    }
    if arguments
        .first()
        .is_some_and(|argument| argument == "--bench-first-page")
        && arguments.len() != 2
    {
        eprintln!("pdf-viewer: --bench-first-page requires exactly one PDF path");
        std::process::exit(2);
    }
    if arguments
        .first()
        .is_some_and(|argument| !is_option_like(argument))
        && arguments.len() > 1
    {
        eprintln!("pdf-viewer: expected at most one PDF path\n{}", usage());
        std::process::exit(2);
    }

    let _caps = app_caps::start([
        2147483648, 3600, 43200, 512, 2, 64, 268435456, 10000, 10000, 16000000,
    ]);
    app_caps::stage("app/src/main.rs: running");
    let first_argument = arguments.first();

    #[cfg(target_os = "macos")]
    {
        if first_argument.is_some_and(|arg| arg == "--install-app") {
            if let Err(error) = macos::install_app() {
                eprintln!("pdf-viewer: {error}");
                std::process::exit(1);
            }
            return;
        }
        if first_argument.is_some_and(|arg| arg == "--uninstall-app") {
            if let Err(error) = macos::uninstall_app() {
                eprintln!("pdf-viewer: {error}");
                std::process::exit(1);
            }
            return;
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        if first_argument.is_some_and(|arg| arg == "--install-app") {
            eprintln!("pdf-viewer: --install-app is macOS-only");
            std::process::exit(1);
        }
        if first_argument.is_some_and(|arg| arg == "--uninstall-app") {
            eprintln!("pdf-viewer: --uninstall-app is macOS-only");
            std::process::exit(1);
        }
    }

    let result = if first_argument.is_some_and(|arg| arg == "--bench-first-page") {
        (|| {
            let path = &arguments[1];
            let reply = commands::bench_first_page(std::path::Path::new(&path))?;
            writeln!(std::io::stdout().lock(), "{reply}")
                .map_err(|error| format!("could not write benchmark result: {error}"))
        })()
    } else {
        run().map_err(|error| error.to_string())
    };

    if let Err(error) = result {
        eprintln!("pdf-viewer: {error}");
        std::process::exit(1);
    }
}
