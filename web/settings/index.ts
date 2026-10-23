// Orange 2 Settings: the 1.x settings page (every tab, including How it works and Automation, and
// the shortcut recorder), bundled unchanged. The Tauri bridge (web/bridge.ts) provides
// `window.orange`; the Rust side answers the same channels as 1.x (settings.rs, presets.rs).
import '../../src/renderer/settings/settings.css';
import '../../src/renderer/settings/index';