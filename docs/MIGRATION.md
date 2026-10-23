# Orange 1.x to 2.0 migration and the 2.x release pipeline

## 1. Updates in 2.x

- Plugin: `tauri-plugin-updater`, driven from Rust (`src-tauri/src/updater.rs`). No JS permissions.
- Endpoint: `https://github.com/Shilpanshu/orange/releases/latest/download/latest.json`
  (`plugins.updater` in `src-tauri/tauri.conf.json`, with the minisign public key).
- UX, same as 1.x: first check 30 s after launch, then every 6 h; downloads in the background
  (signature checked); a HUD notice says it is ready; a "Restart to update (x.y.z)" item is
  inserted at the top of the tray menu; otherwise the installer runs silently (`/S /UPDATE`) when
  Orange quits, without relaunching. "Restart to update" runs it and relaunches (`/R`).
  `updater::check_from_user` is there for Settings' "Check for updates" button.
- Off in debug builds and when `ORANGE_NO_UPDATE=1`.

### Signing key

Generated with `cargo tauri signer generate` (password protected). It is stored **outside the repo**:

    C:\Users\<you>\AppData\Local\Temp\claude\d--git-orange\095b1c8e-...\scratchpad\tauri-keys\
      orange-updater.key            private key: secret
      orange-updater.password.txt   its password: secret
      orange-updater.key.pub        public key (already in tauri.conf.json)

That folder is temporary. Move the two secret files to a password manager or other safe place.
If the private key or password is lost, installed 2.x copies can never auto-update again (the
public key is baked into them).

Repository secrets to add (Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the full contents of `orange-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the contents of `orange-updater.password.txt` |

## 2. Release pipeline (`.github/workflows/release-v2.yml`)

On a `v2.*` tag (the tag must equal `src-tauri/tauri.conf.json` `version`): windows-latest,
`npm ci`, `cargo test`, `npm test`, `cargo tauri build --bundles nsis` (signs the updater
artifact), then a GitHub Release marked **latest** with:

- `Orange_<v>_x64-setup.exe` and `.sig`
- `latest.json` for 2.x
- `latest.yml` for 1.x electron-updater (the bridge, below)

`release.yml` (1.x) now ignores `v2.*` tags.

Both updaters follow GitHub's "latest release". After 2.0 ships, **never publish a 1.x release
as latest** (a 1.x hotfix must be created with `--latest=false`), or 2.x clients will 404 on
`latest.json` and 1.x clients would see a lower version.

## 3. Identity and install location

| | 1.x (electron-builder) | 2.x (Tauri NSIS) |
|---|---|---|
| Product name | Orange | Orange |
| Identifier / AppUserModelId | `app.orange.converter` | `app.orange.converter` (kept) |
| Exe | `Orange.exe` | `Orange.exe` (`mainBinaryName`) |
| Install dir (per user) | `%LOCALAPPDATA%\Programs\Orange` | `%LOCALAPPDATA%\Orange` |
| Uninstall key (HKCU) | `...\Uninstall\{GUID from appId}` | `...\Uninstall\Orange` |
| Settings | `%APPDATA%\Orange\settings.json` | `%APPDATA%\app.orange.converter\` |

The folders and uninstall keys differ, so 2.0 never overwrites 1.x files in place; instead its
installer removes 1.x first. Keeping the identifier keeps taskbar pinning and notification identity.
Dev builds now share the identifier with the installed 2.x (single-instance lock, data folder),
so quit an installed 2.x before `cargo tauri dev`.

## 4. What the 2.0 installer does to a 1.x install (`src-tauri/windows/hooks.nsh`)

`NSIS_HOOK_PREINSTALL`, only when a 1.x install is found (an HKCU uninstall entry whose
`UninstallString` contains `Uninstall Orange.exe`, or that file at the default 1.x path):

1. Runs the 1.x uninstaller silently (`/S _?=<dir>`, waits; it closes a running 1.x), then deletes
   its folder. It only deletes a folder that contains `Uninstall Orange.exe`.
2. Deletes 1.x's Explorer menu: `HKCU\Software\Classes\*\shell\Orange` and
   `HKCU\Software\Classes\Directory\shell\Orange`.
3. Deletes 1.x's login item: values `app.orange.converter` / `electron.app.Orange` under
   `HKCU\...\CurrentVersion\Run` and `...\Explorer\StartupApproved\Run`.
4. Writes `HKCU\Software\Orange\MigratedFrom1x = 1` for the app's first run.

User settings are kept: 1.x is built with `deleteAppDataOnUninstall: false`, so
`%APPDATA%\Orange\settings.json` survives, and 2.x's settings store (`settings.rs`,
`v1_settings_file`) imports it once. The 2.x app then re-registers its own Explorer menu and
autostart from the imported settings (launch at login, menu on/off), so users keep the same
behaviour without stale 1.x entries pointing at a deleted exe.

`NSIS_HOOK_POSTINSTALL`: when run silently with `--force-run` (what electron-updater passes),
start Orange 2.x afterwards, since Tauri's installer only knows `/R`.

## 5. Bridging 1.x auto-update users to 2.0

How 1.x updates: electron-updater (GitHub provider) fetches `latest.yml` from the latest release,
compares versions, downloads the `path` file, checks `sha512`, then on quit (or "Restart to
update") runs it as `<installer> --updated /S [--force-run]`. 1.x is unsigned, so no publisher check.

So the bridge is mostly data, and works even for users still on 1.2.x:

- Every 2.x release also ships a `latest.yml` that points at the Tauri setup exe (the workflow
  writes it with base64 SHA-512 and size, the format electron-builder uses). No `.blockmap`, so
  electron-updater does a full download.
- The Tauri installer accepts `/S`, ignores `--updated`, runs the 1.x-removal hook, and
  relaunches on `--force-run`.

A final 1.x release, **1.3.0**, ships before 2.0 to make the hop safe and visible:

1. Release 1.3.0 normally (via `release.yml`, `v1.3.0` tag) and let it propagate for a week or two.
2. 1.3.0 changes in `src/main/updater.ts`:
   - On `update-available` with a major version >= 2, show a HUD notice ("Orange 2.0 is
     downloading: faster, smaller. Your settings come with you.") even for automatic checks.
   - Before `quitAndInstall` / install-on-quit to a 2.x version, flush settings to disk, unregister
     its own Explorer menu (`context-menu.ts` with `launcher = null`) and login item
     (`setLoginItemSettings({ openAtLogin: false })`). The installer hook does this too; doing it
     from 1.3.0 covers non-default registry names.
   - Set `autoUpdater.disableDifferentialDownload = true` (no 2.x blockmap).
3. Then tag `v2.0.0` from `v2-tauri`. Its release becomes latest; 1.2.x and 1.3.0 both pick it up.

Testing the bridge before shipping: install 1.3.0 in a VM, point it at a test repo/release
containing 2.0's `latest.yml` and setup exe (electron-updater's `setFeedURL` or a
`dev-app-update.yml` can point it there), confirm: download, silent install, 1.x folder gone, no 1.x menu/Run
entries, 2.x started, settings imported.

## 6. Remaining risks

- SmartScreen: the 2.x installer is unsigned like 1.x; silent bridge installs avoid the prompt, but
  manual downloads see it. Code-signing secrets (Azure/CSC) from 1.x can be added later.
- If a user moved 1.x to a custom folder, the hook finds it through the uninstall key.
- Rollback: a user can reinstall 1.x by hand; 2.x would then be found and offered again by 1.x's
  updater. Nothing downgrades automatically.
