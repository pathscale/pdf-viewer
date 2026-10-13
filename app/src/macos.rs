use block2 as _;
use objc2::define_class;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2::{msg_send, sel, ClassType};
use objc2_app_kit as _;
use objc2_foundation::{NSObject, NSObjectProtocol};
use std::ffi::{c_char, c_void, CStr, OsStr};
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

const DIRECT_OBJECT: u32 = u32::from_be_bytes(*b"----");
const FILE_URL_TYPE: u32 = u32::from_be_bytes(*b"furl");
const OPEN_DOCUMENTS_CLASS: u32 = u32::from_be_bytes(*b"aevt");
const OPEN_DOCUMENTS_ID: u32 = u32::from_be_bytes(*b"odoc");
const MAX_EVENT_FILES: isize = 4096;
const LSREGISTER_PATH: &str = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

type CFStringRef = *const c_void;

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFStringCreateWithBytes(
        allocator: *const c_void,
        bytes: *const u8,
        num_bytes: isize,
        encoding: u32,
        is_external_representation: u8,
    ) -> CFStringRef;
    fn CFRelease(value: *const c_void);
}

#[link(name = "CoreServices", kind = "framework")]
unsafe extern "C" {
    fn LSSetDefaultRoleHandlerForContentType(
        content_type: CFStringRef,
        role_mask: u32,
        bundle_identifier: CFStringRef,
    ) -> i32;
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "PDFViewerOpenDocumentEventHandler"]
    struct OpenDocumentEventHandler;

    unsafe impl NSObjectProtocol for OpenDocumentEventHandler {}

    impl OpenDocumentEventHandler {
        #[unsafe(method(handleEvent:withReplyEvent:))]
        fn handle_event(&self, event: &AnyObject, _reply_event: &AnyObject) {
            let paths = paths_from_event(event);
            if !paths.is_empty() {
                pending_paths()
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .extend(paths);
                schedule_pending_paths();
            }
        }
    }
);

#[derive(Clone)]
struct DeliveryTarget {
    state: crate::commands::State,
    handle: izumo::AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "PDFViewerLaunchObserver"]
    struct LaunchObserver;

    unsafe impl NSObjectProtocol for LaunchObserver {}

    impl LaunchObserver {
        #[unsafe(method(willFinishLaunching:))]
        fn will_finish_launching(&self, _notification: &AnyObject) {
            if let Err(error) = install_open_document_handler() {
                eprintln!("pdf-viewer: {error}");
            }
        }
    }
);

static WINDOW_READY: AtomicBool = AtomicBool::new(false);
static DELIVERY_RUNNING: AtomicBool = AtomicBool::new(false);

fn pending_paths() -> &'static Mutex<Vec<PathBuf>> {
    static PATHS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
    PATHS.get_or_init(|| Mutex::new(Vec::new()))
}

fn delivery_target() -> &'static Mutex<Option<DeliveryTarget>> {
    static TARGET: OnceLock<Mutex<Option<DeliveryTarget>>> = OnceLock::new();
    TARGET.get_or_init(|| Mutex::new(None))
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

pub(crate) fn enqueue_path(path: PathBuf) {
    lock(pending_paths()).push(path);
}

pub(crate) fn set_delivery_target(state: crate::commands::State, handle: izumo::AppHandle) {
    *lock(delivery_target()) = Some(DeliveryTarget { state, handle });
}

pub(crate) fn window_is_ready() {
    WINDOW_READY.store(true, Ordering::Release);
    schedule_pending_paths();
}

fn take_latest_path() -> Option<PathBuf> {
    let mut paths = lock(pending_paths());
    let latest = paths.pop();
    paths.clear();
    latest
}

fn has_pending_paths() -> bool {
    !lock(pending_paths()).is_empty()
}

fn schedule_pending_paths() {
    if !WINDOW_READY.load(Ordering::Acquire)
        || DELIVERY_RUNNING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return;
    }

    let target = lock(delivery_target()).clone();
    let Some(target) = target else {
        DELIVERY_RUNNING.store(false, Ordering::Release);
        return;
    };

    drop(nagoya::runtime::background().spawn(async move {
        loop {
            let Some(path) = take_latest_path() else {
                DELIVERY_RUNNING.store(false, Ordering::Release);
                if has_pending_paths() {
                    schedule_pending_paths();
                }
                return;
            };

            match crate::commands::open_path(&target.state, &path) {
                Ok(reply) => {
                    if let Err(error) = target.handle.emit("document_opened", &reply) {
                        eprintln!("pdf-viewer: could not announce the opened document: {error}");
                    }
                }
                Err(error) => eprintln!("pdf-viewer: {error}"),
            }
        }
    }));
}

fn paths_from_event(event: &AnyObject) -> Vec<PathBuf> {
    let direct_object: *mut AnyObject = unsafe {
        // SAFETY: The Apple event handler receives a valid event descriptor for its callback.
        msg_send![event, paramDescriptorForKeyword: DIRECT_OBJECT]
    };
    if direct_object.is_null() {
        return Vec::new();
    }

    let item_count: isize = unsafe {
        // SAFETY: The direct object is a valid NSAppleEventDescriptor.
        msg_send![direct_object, numberOfItems]
    };

    if item_count <= 0 {
        let mut paths = Vec::new();
        append_file_url(direct_object, &mut paths);
        return paths;
    }

    let mut paths = Vec::new();
    for index in 1..=item_count.min(MAX_EVENT_FILES) {
        let item: *mut AnyObject = unsafe {
            // SAFETY: Apple event list indices are one-based and bounded by numberOfItems.
            msg_send![direct_object, descriptorAtIndex: index]
        };
        if !item.is_null() {
            append_file_url(item, &mut paths);
        }
    }
    paths
}

fn append_file_url(item: *mut AnyObject, paths: &mut Vec<PathBuf>) {
    let file_url_descriptor: *mut AnyObject = unsafe {
        // SAFETY: The item is a valid Apple event descriptor and the requested type is typeFileURL.
        msg_send![item, coerceToDescriptorType: FILE_URL_TYPE]
    };
    if file_url_descriptor.is_null() {
        return;
    }

    let url: *mut AnyObject = unsafe {
        // SAFETY: A descriptor coerced to typeFileURL can provide its NSURL value.
        msg_send![file_url_descriptor, fileURLValue]
    };
    if url.is_null() {
        return;
    }

    let representation: *const c_char = unsafe {
        // SAFETY: The URL is live for the duration of the Apple event callback.
        msg_send![url, fileSystemRepresentation]
    };
    if representation.is_null() {
        return;
    }

    // SAFETY: NSURL returns a NUL-terminated file system representation for a live file URL.
    let bytes = unsafe { CStr::from_ptr(representation).to_bytes() };
    paths.push(PathBuf::from(OsStr::from_bytes(bytes)));
}

/// AppKit installs its own open-documents handler while it finishes launching, replacing any handler set earlier,
/// so the handler is installed again from NSApplicationWillFinishLaunchingNotification, before the launch event is
/// dispatched.
pub(crate) fn register_open_document_handler() -> Result<(), String> {
    install_open_document_handler()?;
    let observer: Retained<LaunchObserver> = unsafe {
        // SAFETY: LaunchObserver inherits NSObject and new returns an initialized instance.
        msg_send![LaunchObserver::class(), new]
    };
    let center = objc2_foundation::NSNotificationCenter::defaultCenter();
    let name = objc2_foundation::NSString::from_str("NSApplicationWillFinishLaunchingNotification");
    let _: () = unsafe {
        // SAFETY: The observer lives for the process and implements willFinishLaunching:.
        msg_send![&*center, addObserver: &*observer, selector: sel!(willFinishLaunching:), name: &*name, object: std::ptr::null::<AnyObject>()]
    };
    std::mem::forget(observer);
    Ok(())
}

fn install_open_document_handler() -> Result<(), String> {
    let manager_class = AnyClass::get(c"NSAppleEventManager")
        .ok_or_else(|| "NSAppleEventManager is unavailable".to_owned())?;
    let manager: *mut AnyObject = unsafe {
        // SAFETY: NSAppleEventManager is an AppKit singleton accessed from the main thread.
        msg_send![manager_class, sharedAppleEventManager]
    };
    if manager.is_null() {
        return Err("NSAppleEventManager could not be initialized".to_owned());
    }

    let handler_class = OpenDocumentEventHandler::class();
    let handler: Retained<OpenDocumentEventHandler> = unsafe {
        // SAFETY: The registered class inherits NSObject and new returns an initialized instance.
        msg_send![handler_class, new]
    };
    let handler_pointer = &*handler as *const OpenDocumentEventHandler as *mut AnyObject;
    let _: () = unsafe {
        // SAFETY: The handler remains alive for the process and implements the registered selector.
        msg_send![
            manager,
            setEventHandler: handler_pointer,
            andSelector: sel!(handleEvent:withReplyEvent:),
            forEventClass: OPEN_DOCUMENTS_CLASS,
            andEventID: OPEN_DOCUMENTS_ID
        ]
    };
    std::mem::forget(handler);
    Ok(())
}

fn app_bundle_path() -> Result<PathBuf, String> {
    let home =
        std::env::var_os("HOME").ok_or_else(|| "the home directory is unavailable".to_owned())?;
    Ok(PathBuf::from(home)
        .join("Applications")
        .join("PDF Viewer.app"))
}

fn remove_bundle(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(path)
            .map(|()| true)
            .map_err(|error| format!("could not remove {}: {error}", path.display())),
        Ok(_) => fs::remove_file(path)
            .map(|()| true)
            .map_err(|error| format!("could not remove {}: {error}", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("could not inspect {}: {error}", path.display())),
    }
}

fn plist_contents() -> String {
    let version = xml_escape(env!("CARGO_PKG_VERSION"));
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleIdentifier</key>
    <string>com.pathscale.pdf-viewer</string>
    <key>CFBundleName</key>
    <string>PDF Viewer</string>
    <key>CFBundleDisplayName</key>
    <string>PDF Viewer</string>
    <key>CFBundleExecutable</key>
    <string>pdf-viewer</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>{version}</string>
    <key>CFBundleVersion</key>
    <string>{version}</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeName</key>
            <string>PDF document</string>
            <key>CFBundleTypeRole</key>
            <string>Viewer</string>
            <key>LSHandlerRank</key>
            <string>Default</string>
            <key>LSItemContentTypes</key>
            <array>
                <string>com.adobe.pdf</string>
            </array>
        </dict>
    </array>
</dict>
</plist>
"#
    )
}

fn xml_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&apos;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn lsregister(action: &str, bundle_path: &Path) -> Result<bool, String> {
    let status = Command::new(LSREGISTER_PATH)
        .arg(action)
        .arg(bundle_path)
        .status()
        .map_err(|error| format!("could not run lsregister: {error}"))?;
    Ok(status.success())
}

pub(crate) fn install_app() -> Result<(), String> {
    let bundle_path = app_bundle_path()?;
    let applications = bundle_path
        .parent()
        .ok_or_else(|| "the Applications directory is unavailable".to_owned())?;
    fs::create_dir_all(applications)
        .map_err(|error| format!("could not create {}: {error}", applications.display()))?;

    let current_executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the running executable: {error}"))?;
    let staging_path = applications.join(".PDF Viewer.app.installing");
    remove_bundle(&staging_path)?;

    let staging_executable = staging_path
        .join("Contents")
        .join("MacOS")
        .join("pdf-viewer");
    let staging_contents = staging_path.join("Contents");
    let install_result = (|| {
        fs::create_dir_all(staging_executable.parent().unwrap())
            .map_err(|error| format!("could not create the app executable directory: {error}"))?;
        fs::copy(&current_executable, &staging_executable)
            .map_err(|error| format!("could not copy the running executable: {error}"))?;
        fs::write(staging_contents.join("Info.plist"), plist_contents())
            .map_err(|error| format!("could not write Info.plist: {error}"))?;
        remove_bundle(&bundle_path)?;
        fs::rename(&staging_path, &bundle_path)
            .map_err(|error| format!("could not install {}: {error}", bundle_path.display()))?;
        Ok::<(), String>(())
    })();

    if install_result.is_err() {
        let _ = remove_bundle(&staging_path);
    }
    install_result?;

    println!("Installed app bundle: {}", bundle_path.display());
    println!("Re-run pdf-viewer --install-app after a cargo upgrade to refresh this app.");

    match lsregister("-f", &bundle_path) {
        Ok(true) => {}
        Ok(false) => eprintln!("pdf-viewer: lsregister did not register the app bundle"),
        Err(error) => eprintln!("pdf-viewer: {error}"),
    }

    match set_default_pdf_handler() {
        Ok(0) => println!("PDF files now open in PDF Viewer"),
        Ok(status) => {
            eprintln!("pdf-viewer: could not set the PDF default handler, OSStatus {status}")
        }
        Err(error) => eprintln!("pdf-viewer: could not set the PDF default handler: {error}"),
    }
    Ok(())
}

pub(crate) fn uninstall_app() -> Result<(), String> {
    let bundle_path = app_bundle_path()?;
    let removal_result = remove_bundle(&bundle_path);

    match lsregister("-u", &bundle_path) {
        Ok(true) => {}
        Ok(false) => eprintln!("pdf-viewer: lsregister did not unregister the app bundle"),
        Err(error) => eprintln!("pdf-viewer: {error}"),
    }

    removal_result?;
    println!("Removed app bundle at {}", bundle_path.display());
    Ok(())
}

fn create_cf_string(value: &str) -> Result<CFStringRef, String> {
    const UTF8_ENCODING: u32 = 0x0800_0100;
    // SAFETY: The byte slice remains valid for the call and uses CoreFoundation's UTF-8 encoding.
    let string = unsafe {
        CFStringCreateWithBytes(
            std::ptr::null(),
            value.as_bytes().as_ptr(),
            value.len() as isize,
            UTF8_ENCODING,
            0,
        )
    };
    if string.is_null() {
        Err("CoreFoundation could not allocate a string".to_owned())
    } else {
        Ok(string)
    }
}

fn release_cf_string(value: CFStringRef) {
    // SAFETY: The caller passes a non-null owned string returned by CFStringCreateWithBytes.
    unsafe { CFRelease(value) };
}

fn set_default_pdf_handler() -> Result<i32, String> {
    let content_type = create_cf_string("com.adobe.pdf")?;
    let bundle_identifier = match create_cf_string("com.pathscale.pdf-viewer") {
        Ok(value) => value,
        Err(error) => {
            release_cf_string(content_type);
            return Err(error);
        }
    };

    // SAFETY: Both arguments are valid CFStrings and the role mask requests all roles.
    let status =
        unsafe { LSSetDefaultRoleHandlerForContentType(content_type, u32::MAX, bundle_identifier) };
    release_cf_string(bundle_identifier);
    release_cf_string(content_type);
    Ok(status)
}
