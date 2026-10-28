fn main() {
    // [phase2-convert] Test binaries have no app manifest, so Windows loads comctl32 v5, which lacks
    // TaskDialogIndirect (imported by the dialog plugin): every unit-test exe died at load with
    // STATUS_ENTRYPOINT_NOT_FOUND. Delay-loading comctl32 resolves it on first call instead; the app
    // (which has tauri-build's common-controls v6 manifest) behaves exactly as before.
    println!("cargo:rustc-link-arg=/DELAYLOAD:comctl32.dll");
    println!("cargo:rustc-link-arg=delayimp.lib");
    tauri_build::build()
}
