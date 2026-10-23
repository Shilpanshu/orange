//! The drag state machine driven through whole user flows: the same input sequences the
//! `--selftest-scenarios` runner injects (see `src/selftest.rs`), checked here headlessly.
//! The OLE drop and the wheel page itself are covered by the self-test, which needs a desktop.

use orange_lib::drag::{Button, DragState, Input, Key, Mod, Nav, Output};

const LSHIFT: Key = Key::Mod(Mod::Shift, 0xA0);
const LCTRL: Key = Key::Mod(Mod::Ctrl, 0xA2);
const LALT: Key = Key::Mod(Mod::Alt, 0xA4);

fn feed(s: &mut DragState, inputs: &[Input]) -> Vec<Output> {
    inputs.iter().filter_map(|i| s.feed(*i)).collect()
}

fn start(s: &mut DragState, x: i32, y: i32) -> Vec<Output> {
    feed(s, &[Input::Down(Button::Left, x, y), Input::Move(x + 6, y + 2), Input::Move(x + 12, y + 4)])
}

/// Corner drop: the wheel opened, the user lets go off the wheel. The machine reports one
/// Release (the app then closes the wheel) and nothing else.
#[test]
fn corner_drop_is_one_release() {
    let mut s = DragState::new();
    assert_eq!(start(&mut s, 500, 500), [Output::DragStart]);
    assert_eq!(feed(&mut s, &[Input::KeyDown(LSHIFT), Input::KeyUp(LSHIFT)]), [Output::Modifier(Mod::Shift)]);
    s.listening_nav = true;
    assert_eq!(feed(&mut s, &[Input::Move(300, 300), Input::Move(290, 290), Input::Up(Button::Left)]), [Output::Release]);
    assert!(!s.is_dragging());
    // A later click is not a drag and reports nothing.
    assert!(feed(&mut s, &[Input::Down(Button::Left, 1, 1), Input::Up(Button::Left)]).is_empty());
}

/// Ctrl switches the wheel: Shift then Ctrl in one drag give two modifiers, no release between.
#[test]
fn ctrl_switches_the_wheel() {
    let mut s = DragState::new();
    start(&mut s, 0, 0);
    let out = feed(&mut s, &[Input::KeyDown(LSHIFT), Input::KeyUp(LSHIFT), Input::KeyDown(LCTRL), Input::KeyUp(LCTRL), Input::KeyDown(LALT)]);
    assert_eq!(out, [Output::Modifier(Mod::Shift), Output::Modifier(Mod::Ctrl), Output::Modifier(Mod::Alt)]);
    assert!(s.is_dragging());
    // Back to Shift (released earlier, so it is a fresh tap).
    assert_eq!(feed(&mut s, &[Input::KeyDown(LSHIFT)]), [Output::Modifier(Mod::Shift)]);
}

/// Arrow keys while the wheel listens, then the drop on the hub ends the drag.
#[test]
fn arrows_then_hub_drop() {
    let mut s = DragState::new();
    start(&mut s, 100, 100);
    feed(&mut s, &[Input::KeyDown(LSHIFT)]);
    s.listening_nav = true;
    let keys = [Nav::Right, Nav::Right, Nav::Left, Nav::Up, Nav::Down, Nav::Tab];
    let out = feed(&mut s, &keys.map(|n| Input::KeyDown(Key::Nav(n))));
    assert_eq!(out, keys.map(Output::Nav));
    assert_eq!(feed(&mut s, &[Input::Up(Button::Left)]), [Output::Release]);
}

/// Escape and Enter reach the wheel too; nav keys never start or end a drag.
#[test]
fn enter_and_escape_are_nav_only() {
    let mut s = DragState::new();
    start(&mut s, 0, 0);
    s.listening_nav = true;
    assert_eq!(feed(&mut s, &[Input::KeyDown(Key::Nav(Nav::Escape)), Input::KeyDown(Key::Nav(Nav::Enter))]), [Output::Nav(Nav::Escape), Output::Nav(Nav::Enter)]);
    assert!(s.is_dragging());
}

/// Arrow keys outside an open wheel are the user's, not Orange's.
#[test]
fn arrows_ignored_when_not_listening() {
    let mut s = DragState::new();
    start(&mut s, 0, 0);
    assert!(feed(&mut s, &[Input::KeyDown(Key::Nav(Nav::Left)), Input::KeyDown(Key::Nav(Nav::Right))]).is_empty());
}

/// Several drags in a row (the scenario runner does one per scenario) each start cleanly.
#[test]
fn consecutive_drags_reset() {
    let mut s = DragState::new();
    for i in 0..5 {
        assert_eq!(start(&mut s, i * 100, 0), [Output::DragStart], "drag {i}");
        assert_eq!(feed(&mut s, &[Input::KeyDown(LSHIFT), Input::KeyUp(LSHIFT)]), [Output::Modifier(Mod::Shift)]);
        assert_eq!(feed(&mut s, &[Input::Up(Button::Left)]), [Output::Release]);
    }
}

/// Other keys (letters) mid-drag do nothing, and don't block a later modifier tap.
#[test]
fn other_keys_are_ignored() {
    let mut s = DragState::new();
    start(&mut s, 0, 0);
    assert!(feed(&mut s, &[Input::KeyDown(Key::Other(0x41)), Input::KeyUp(Key::Other(0x41))]).is_empty());
    assert_eq!(feed(&mut s, &[Input::KeyDown(LCTRL)]), [Output::Modifier(Mod::Ctrl)]);
}

#[test]
fn mod_names_match_the_wheel_keys() {
    assert_eq!([Mod::Shift, Mod::Ctrl, Mod::Alt].map(Mod::name), ["shift", "ctrl", "alt"]);
    assert_eq!([Nav::Left, Nav::Right, Nav::Up, Nav::Down, Nav::Enter, Nav::Escape, Nav::Tab].map(Nav::name), ["left", "right", "up", "down", "enter", "escape", "tab"]);
}
