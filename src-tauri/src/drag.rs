//! The "dragging something, then tapped a modifier" state machine.
//!
//! Pure logic with no OS calls, so it can be unit-tested with synthetic events. The low-level
//! hooks in `hooks.rs` translate raw Windows input into [`Input`] and act on the returned
//! [`Output`]s. Same semantics as Orange 1.x's `drag-watcher.ts`:
//! - a drag is the left button held and the pointer moved more than [`DRAG_THRESHOLD`] px;
//! - only a fresh press of Shift/Ctrl/Alt during a drag counts: a modifier held since before the
//!   drag (Ctrl+drag to copy) is not a tap, and keyboard auto-repeat is ignored;
//! - right and middle drags never start a drag and never leave one stuck;
//! - arrows, Enter, Tab and Esc are reported only while the wheel listens for them.

use std::collections::HashSet;

/// Physical pixels (Manhattan distance) the pointer must travel before it is a drag.
pub const DRAG_THRESHOLD: i32 = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Button {
    Left,
    Right,
    Middle,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mod {
    Shift,
    Ctrl,
    Alt,
}

impl Mod {
    pub fn name(self) -> &'static str {
        match self {
            Mod::Shift => "shift",
            Mod::Ctrl => "ctrl",
            Mod::Alt => "alt",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Nav {
    Left,
    Right,
    Up,
    Down,
    Enter,
    Escape,
    Tab,
}

impl Nav {
    pub fn name(self) -> &'static str {
        match self {
            Nav::Left => "left",
            Nav::Right => "right",
            Nav::Up => "up",
            Nav::Down => "down",
            Nav::Enter => "enter",
            Nav::Escape => "escape",
            Nav::Tab => "tab",
        }
    }
}

/// A key as the state machine sees it. `code` is the Windows virtual-key code, so left and right
/// Shift are tracked separately (releasing one doesn't forget the other).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Mod(Mod, u32),
    Nav(Nav),
    Other(u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    Down(Button, i32, i32),
    Up(Button),
    Move(i32, i32),
    KeyDown(Key),
    KeyUp(Key),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Output {
    DragStart,
    Modifier(Mod),
    /// The left button went up after a drag (the drag ended somewhere).
    Release,
    Nav(Nav),
}

#[derive(Default)]
pub struct DragState {
    down: Option<Button>,
    dragging: bool,
    origin: (i32, i32),
    held: HashSet<u32>,
    /// Set by the app while the wheel is open.
    pub listening_nav: bool,
}

impl DragState {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_dragging(&self) -> bool {
        self.dragging
    }

    /// Feeds one input event. Returns at most one output; the hot path (moves with no button
    /// down) returns at once and allocates nothing.
    pub fn feed(&mut self, input: Input) -> Option<Output> {
        match input {
            Input::Move(x, y) => {
                if self.dragging || self.down != Some(Button::Left) {
                    return None;
                }
                if (x - self.origin.0).abs() + (y - self.origin.1).abs() > DRAG_THRESHOLD {
                    self.dragging = true;
                    return Some(Output::DragStart);
                }
                None
            }
            Input::Down(b, x, y) => {
                if b == Button::Left {
                    self.down = Some(Button::Left);
                    self.dragging = false;
                    self.origin = (x, y);
                } else if self.down.is_none() {
                    // Remembered only so its release is recognised; never starts a drag.
                    self.down = Some(b);
                }
                None
            }
            Input::Up(b) => {
                // Another button released during a left drag doesn't end it.
                if b != Button::Left && self.down == Some(Button::Left) {
                    return None;
                }
                let was = self.dragging;
                self.down = None;
                self.dragging = false;
                was.then_some(Output::Release)
            }
            Input::KeyDown(key) => {
                if let Key::Nav(n) = key {
                    return self.listening_nav.then_some(Output::Nav(n));
                }
                let Key::Mod(m, code) = key else { return None };
                // Auto-repeat sends keydown continuously while held: react once per press. Presses
                // outside drags are tracked too, so a key held since before the drag is no tap.
                if !self.held.insert(code) {
                    return None;
                }
                self.dragging.then_some(Output::Modifier(m))
            }
            Input::KeyUp(key) => {
                if let Key::Mod(_, code) | Key::Other(code) = key {
                    self.held.remove(&code);
                }
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LSHIFT: Key = Key::Mod(Mod::Shift, 0xA0);
    const RSHIFT: Key = Key::Mod(Mod::Shift, 0xA1);
    const LCTRL: Key = Key::Mod(Mod::Ctrl, 0xA2);
    const LALT: Key = Key::Mod(Mod::Alt, 0xA4);

    fn run(s: &mut DragState, inputs: &[Input]) -> Vec<Output> {
        inputs.iter().filter_map(|i| s.feed(*i)).collect()
    }

    fn drag(s: &mut DragState) -> Vec<Output> {
        run(s, &[Input::Down(Button::Left, 100, 100), Input::Move(103, 102), Input::Move(110, 104)])
    }

    #[test]
    fn small_moves_are_not_a_drag() {
        let mut s = DragState::new();
        let out = run(&mut s, &[Input::Down(Button::Left, 0, 0), Input::Move(4, 4), Input::KeyDown(LSHIFT)]);
        assert!(out.is_empty());
        assert!(!s.is_dragging());
    }

    #[test]
    fn threshold_is_exclusive() {
        let mut s = DragState::new();
        assert_eq!(run(&mut s, &[Input::Down(Button::Left, 0, 0), Input::Move(5, 3)]), vec![]);
        assert_eq!(run(&mut s, &[Input::Move(5, 4)]), vec![Output::DragStart]);
    }

    #[test]
    fn tap_mid_drag_fires_once() {
        let mut s = DragState::new();
        assert_eq!(drag(&mut s), vec![Output::DragStart]);
        // Auto-repeat: three keydowns, one modifier.
        let out = run(&mut s, &[Input::KeyDown(LSHIFT), Input::KeyDown(LSHIFT), Input::KeyDown(LSHIFT), Input::KeyUp(LSHIFT)]);
        assert_eq!(out, vec![Output::Modifier(Mod::Shift)]);
        // A second tap switches wheels.
        assert_eq!(run(&mut s, &[Input::KeyDown(LCTRL)]), vec![Output::Modifier(Mod::Ctrl)]);
        assert_eq!(run(&mut s, &[Input::Up(Button::Left)]), vec![Output::Release]);
        assert!(!s.is_dragging());
    }

    #[test]
    fn modifier_held_before_drag_does_not_trigger() {
        let mut s = DragState::new();
        run(&mut s, &[Input::KeyDown(LCTRL)]);
        drag(&mut s);
        // Its auto-repeat keeps arriving during the drag.
        assert_eq!(run(&mut s, &[Input::KeyDown(LCTRL), Input::KeyDown(LCTRL)]), vec![]);
        // A different key is a real tap.
        assert_eq!(run(&mut s, &[Input::KeyDown(LALT)]), vec![Output::Modifier(Mod::Alt)]);
        // Released and pressed again mid-drag: that is a tap.
        assert_eq!(run(&mut s, &[Input::KeyUp(LCTRL), Input::KeyDown(LCTRL)]), vec![Output::Modifier(Mod::Ctrl)]);
    }

    #[test]
    fn left_and_right_shift_are_separate_keys() {
        let mut s = DragState::new();
        run(&mut s, &[Input::KeyDown(LSHIFT)]);
        drag(&mut s);
        assert_eq!(run(&mut s, &[Input::KeyDown(RSHIFT)]), vec![Output::Modifier(Mod::Shift)]);
    }

    #[test]
    fn right_and_middle_drags_never_start_or_stick() {
        for b in [Button::Right, Button::Middle] {
            let mut s = DragState::new();
            let out = run(&mut s, &[Input::Down(b, 0, 0), Input::Move(50, 50), Input::KeyDown(LSHIFT), Input::Up(b)]);
            assert!(out.is_empty(), "{b:?}");
            assert!(!s.is_dragging());
            // A later small left click is still not a drag.
            assert!(run(&mut s, &[Input::KeyUp(LSHIFT), Input::Down(Button::Left, 0, 0), Input::Move(2, 2), Input::KeyDown(LSHIFT)]).is_empty());
        }
    }

    #[test]
    fn other_button_released_mid_left_drag_does_not_end_it() {
        let mut s = DragState::new();
        drag(&mut s);
        assert_eq!(run(&mut s, &[Input::Down(Button::Right, 0, 0), Input::Up(Button::Right)]), vec![]);
        assert!(s.is_dragging());
        assert_eq!(run(&mut s, &[Input::KeyDown(LSHIFT)]), vec![Output::Modifier(Mod::Shift)]);
    }

    #[test]
    fn missed_left_up_recovers_on_next_press() {
        // If a button-up is lost (e.g. a UAC prompt ate it), the next press starts over.
        let mut s = DragState::new();
        drag(&mut s);
        run(&mut s, &[Input::Down(Button::Left, 500, 500)]);
        assert!(!s.is_dragging());
        assert!(run(&mut s, &[Input::Move(502, 501), Input::KeyDown(LSHIFT)]).is_empty());
    }

    #[test]
    fn nav_keys_only_while_listening() {
        let mut s = DragState::new();
        assert_eq!(s.feed(Input::KeyDown(Key::Nav(Nav::Left))), None);
        s.listening_nav = true;
        assert_eq!(s.feed(Input::KeyDown(Key::Nav(Nav::Left))), Some(Output::Nav(Nav::Left)));
        assert_eq!(s.feed(Input::KeyDown(Key::Nav(Nav::Escape))), Some(Output::Nav(Nav::Escape)));
    }

    #[test]
    fn release_without_drag_is_silent() {
        let mut s = DragState::new();
        assert!(run(&mut s, &[Input::Down(Button::Left, 0, 0), Input::Up(Button::Left)]).is_empty());
    }
}
