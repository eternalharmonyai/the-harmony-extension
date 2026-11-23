// Harmony Native Control — Tauri 2 shell.
//
// ARCHITECTURE: there is exactly one rendering authority for the chat UI: the HTML
// app served by the local Harmony backend on http://127.0.0.1:8789. This shell
// DISPLAYS that app. It must never contain a second copy of the chat UI, because two
// frontends drift apart and the drift is silent.
//
// SECURITY — read before changing anything below:
// The chat page renders MODEL-GENERATED content, which is untrusted. Therefore the
// "chat" window must hold ZERO IPC. Tauri 2 grants no IPC to remote URLs unless a
// capability explicitly adds a `remote.urls` block, and capabilities/default.json
// lists only the privileged "main" window. Concretely:
//   - never add "chat" to any capability's `windows`
//   - never add a `remote` block to a capability
//   - never set `withGlobalTauri: true`
// If any of those change, an XSS in a model reply becomes native code execution.

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use url::Url;

/// Default port for Harmony Studio standalone backend.
const DEFAULT_STUDIO_PORT: u16 = 8789;
/// Privileged control window label (bound in capabilities/default.json).
const MAIN_WINDOW_LABEL: &str = "main";
/// Zero-IPC Studio window label (MUST NEVER appear in capabilities/default.json).
const STUDIO_WINDOW_LABEL: &str = "chat";

/// True only for an explicit http:// loopback origin on the pinned Studio port.
fn is_pinned_studio_origin(url: &Url, allowed_port: u16) -> bool {
    if url.scheme() != "http" {
        return false;
    }
    if url.port() != Some(allowed_port) {
        return false;
    }
    matches!(url.host_str(), Some("127.0.0.1") | Some("localhost"))
}

/// True only for http://127.0.0.1:8789 or http://localhost:8789 (default origin check).
#[cfg_attr(not(test), allow(dead_code))]
fn is_chat_origin(url: &Url) -> bool {
    is_pinned_studio_origin(url, DEFAULT_STUDIO_PORT)
}

/// Parse CLI args (`--studio`, `--url <http://127.0.0.1:PORT/>`) safely.
/// Fails closed onto `http://127.0.0.1:8789/` if `--url` is missing or non-loopback.
fn parse_launch_config(args: &[String], env_studio_url: Option<&str>) -> (bool, Url, u16) {
    let mut studio_only = false;
    let mut raw_url: Option<String> = None;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--studio" => {
                studio_only = true;
            }
            "--url" => {
                if let Some(val) = args.get(i + 1) {
                    raw_url = Some(val.clone());
                    i += 1;
                }
            }
            arg if arg.starts_with("--url=") => {
                raw_url = Some(arg["--url=".len()..].to_string());
            }
            _ => {}
        }
        i += 1;
    }

    if raw_url.is_none() {
        if let Some(env_val) = env_studio_url {
            if !env_val.trim().is_empty() {
                raw_url = Some(env_val.trim().to_string());
            }
        }
    }

    if let Some(candidate) = raw_url {
        if let Ok(parsed) = Url::parse(&candidate) {
            if parsed.scheme() == "http"
                && matches!(parsed.host_str(), Some("127.0.0.1") | Some("localhost"))
            {
                if let Some(port) = parsed.port() {
                    if port > 0 {
                        return (studio_only, parsed, port);
                    }
                }
            }
        }
    }

    let fallback = Url::parse("http://127.0.0.1:8789/").expect("valid default loopback url");
    (studio_only, fallback, DEFAULT_STUDIO_PORT)
}

#[cfg(windows)]
fn build_sovereign_webview2_args() -> String {
    // Preserve wry's default SmartScreen/OOUI suppressions inside a single
    // consolidated --disable-features flag while disabling implicit sign-in,
    // ForcedColors monochrome override, and background networking.
    let mut args = String::from(
        "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,msImplicitSignin,ForcedColors,WebContentsForceDark --no-first-run --disable-sync --disable-background-networking",
    );
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        let trimmed = extra.trim();
        if !trimmed.is_empty() {
            args.push(' ');
            args.push_str(trimmed);
        }
    }
    args
}

fn main() {
    let raw_args: Vec<String> = std::env::args().skip(1).collect();
    let env_url = std::env::var("HARMONY_STUDIO_URL").ok();
    let (studio_only, studio_url, pinned_port) =
        parse_launch_config(&raw_args, env_url.as_deref());

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            if !studio_only {
                WebviewWindowBuilder::new(
                    app,
                    MAIN_WINDOW_LABEL,
                    WebviewUrl::App("index.html".into()),
                )
                .title("Harmony Control")
                .inner_size(1160.0, 820.0)
                .min_inner_size(760.0, 540.0)
                .build()?;
            }

            let (target_w, target_h) = if studio_only {
                let mut w = 1420.0_f64;
                let mut h = 900.0_f64;
                if let Ok(Some(monitor)) = app.primary_monitor() {
                    let scale = monitor.scale_factor().max(1.0);
                    let logical_w = (monitor.size().width as f64) / scale;
                    let logical_h = (monitor.size().height as f64) / scale;
                    if logical_w > 400.0 && logical_h > 400.0 {
                        w = w.min((logical_w * 0.92).floor()).max(760.0);
                        h = h.min((logical_h * 0.90).floor()).max(540.0);
                    }
                }
                (w, h)
            } else {
                (1180.0, 860.0)
            };

            let window_title = if studio_only {
                "Harmony Studio"
            } else {
                "Harmony Chat"
            };

            let mut studio_builder = WebviewWindowBuilder::new(
                app,
                STUDIO_WINDOW_LABEL,
                WebviewUrl::External(studio_url),
            )
            .title(window_title)
            .inner_size(target_w, target_h)
            .min_inner_size(720.0, 520.0)
            // Pin navigation strictly to the loopback Studio origin & port.
            .on_navigation(move |url| is_pinned_studio_origin(url, pinned_port))
            // Refuse every popup so untrusted content cannot spawn secondary windows.
            .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);

            #[cfg(windows)]
            {
                studio_builder =
                    studio_builder.additional_browser_args(&build_sovereign_webview2_args());
                if let Ok(local_data) = app.path().app_local_data_dir() {
                    let isolated_wv2 = local_data.join(format!("studio-webview2-p{}", pinned_port));
                    let _ = std::fs::create_dir_all(&isolated_wv2);
                    studio_builder = studio_builder.data_directory(isolated_wv2);
                }
            }

            let _ = app;
            studio_builder.build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Harmony Native Control");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_ipc_invariant_holds() {
        let caps = include_str!("../capabilities/default.json");
        assert!(
            !caps.contains("\"chat\""),
            "chat window must never be listed in any Tauri capability"
        );
        assert!(
            !caps.contains("\"remote\""),
            "no remote capability block may exist"
        );
        let conf = include_str!("../tauri.conf.json");
        assert!(
            !conf.contains("\"withGlobalTauri\": true"),
            "withGlobalTauri must never be enabled"
        );
        assert!(is_chat_origin(
            &Url::parse("http://127.0.0.1:8789/").unwrap()
        ));
        assert!(is_chat_origin(
            &Url::parse("http://localhost:8789/").unwrap()
        ));
        assert!(!is_chat_origin(
            &Url::parse("http://127.0.0.1:8788/").unwrap()
        ));
        assert!(!is_chat_origin(
            &Url::parse("https://127.0.0.1:8789/").unwrap()
        ));
        assert!(!is_chat_origin(
            &Url::parse("https://login.microsoftonline.com/").unwrap()
        ));
    }

    #[test]
    fn parse_launch_config_rejects_external_urls() {
        let args = vec![
            "--studio".to_string(),
            "--url".to_string(),
            "https://evil.example.com/".to_string(),
        ];
        let (studio_only, url, port) = parse_launch_config(&args, None);
        assert!(studio_only);
        assert_eq!(port, 8789);
        assert_eq!(url.as_str(), "http://127.0.0.1:8789/");

        let valid_args = vec![
            "--studio".to_string(),
            "--url=http://127.0.0.1:8795/".to_string(),
        ];
        let (studio_only2, url2, port2) = parse_launch_config(&valid_args, None);
        assert!(studio_only2);
        assert_eq!(port2, 8795);
        assert_eq!(url2.as_str(), "http://127.0.0.1:8795/");
    }
}
