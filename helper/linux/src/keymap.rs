//! DOM `KeyboardEvent.code` → Linux evdev keycode (input-event-codes.h).
//!
//! `code` names a physical key position, which is exactly what evdev keycodes are, so the
//! layout (what the key types) is decided by the xkb keymap we hand to clients, not here.

pub fn evdev(code: &str) -> Option<u32> {
    // Letters and digits follow the keyboard rows, not the alphabet.
    if let Some(l) = code.strip_prefix("Key") {
        const ROWS: &[(char, u32)] = &[
            ('Q', 16), ('W', 17), ('E', 18), ('R', 19), ('T', 20), ('Y', 21), ('U', 22), ('I', 23), ('O', 24), ('P', 25),
            ('A', 30), ('S', 31), ('D', 32), ('F', 33), ('G', 34), ('H', 35), ('J', 36), ('K', 37), ('L', 38),
            ('Z', 44), ('X', 45), ('C', 46), ('V', 47), ('B', 48), ('N', 49), ('M', 50),
        ];
        let c = l.chars().next()?;
        return ROWS.iter().find(|(k, _)| *k == c).map(|(_, v)| *v);
    }
    if let Some(d) = code.strip_prefix("Digit") {
        let n: u32 = d.parse().ok()?;
        return Some(if n == 0 { 11 } else { n + 1 });
    }
    if let Some(f) = code.strip_prefix('F') {
        if let Ok(n) = f.parse::<u32>() {
            return match n {
                1..=10 => Some(58 + n),
                11 => Some(87),
                12 => Some(88),
                13..=24 => Some(170 + n), // KEY_F13 = 183
                _ => None,
            };
        }
    }
    Some(match code {
        "Escape" => 1,
        "Minus" => 12,
        "Equal" => 13,
        "Backspace" => 14,
        "Tab" => 15,
        "BracketLeft" => 26,
        "BracketRight" => 27,
        "Enter" => 28,
        "ControlLeft" => 29,
        "Semicolon" => 39,
        "Quote" => 40,
        "Backquote" => 41,
        "ShiftLeft" => 42,
        "Backslash" => 43,
        "Comma" => 51,
        "Period" => 52,
        "Slash" => 53,
        "ShiftRight" => 54,
        "NumpadMultiply" => 55,
        "AltLeft" => 56,
        "Space" => 57,
        "CapsLock" => 58,
        "NumLock" => 69,
        "ScrollLock" => 70,
        "Numpad7" => 71,
        "Numpad8" => 72,
        "Numpad9" => 73,
        "NumpadSubtract" => 74,
        "Numpad4" => 75,
        "Numpad5" => 76,
        "Numpad6" => 77,
        "NumpadAdd" => 78,
        "Numpad1" => 79,
        "Numpad2" => 80,
        "Numpad3" => 81,
        "Numpad0" => 82,
        "NumpadDecimal" => 83,
        "Lang5" => 85, // KEY_ZENKAKUHANKAKU
        "IntlBackslash" => 86,
        "IntlRo" => 89,
        "Lang3" => 90, // KEY_KATAKANA
        "Lang4" => 91, // KEY_HIRAGANA
        "Convert" => 92,
        "KanaMode" => 93,
        "NonConvert" => 94,
        "NumpadEnter" => 96,
        "ControlRight" => 97,
        "NumpadDivide" => 98,
        "PrintScreen" => 99,
        "AltRight" => 100,
        "Home" => 102,
        "ArrowUp" => 103,
        "PageUp" => 104,
        "ArrowLeft" => 105,
        "ArrowRight" => 106,
        "End" => 107,
        "ArrowDown" => 108,
        "PageDown" => 109,
        "Insert" => 110,
        "Delete" => 111,
        "AudioVolumeMute" => 113,
        "AudioVolumeDown" => 114,
        "AudioVolumeUp" => 115,
        "Power" => 116,
        "NumpadEqual" => 117,
        "Pause" => 119,
        "NumpadComma" => 121,
        "Lang1" => 122, // KEY_HANGEUL
        "Lang2" => 123, // KEY_HANJA
        "IntlYen" => 124,
        "MetaLeft" | "OSLeft" => 125,
        "MetaRight" | "OSRight" => 126,
        "ContextMenu" => 127,
        "BrowserStop" => 128,
        "Help" => 138,
        "BrowserBack" => 158,
        "BrowserForward" => 159,
        "MediaTrackNext" => 163,
        "MediaPlayPause" => 164,
        "MediaTrackPrevious" => 165,
        "MediaStop" => 166,
        "BrowserRefresh" => 173,
        "BrowserHome" => 172,
        "NumpadParenLeft" => 179,
        "NumpadParenRight" => 180,
        "BrowserSearch" => 217,
        _ => return None,
    })
}

/// DOM `MouseEvent.button` → evdev button code.
pub fn button(dom: u64) -> u32 {
    match dom {
        0 => 0x110, // BTN_LEFT
        1 => 0x112, // BTN_MIDDLE
        2 => 0x111, // BTN_RIGHT
        3 => 0x113, // BTN_SIDE (browser back)
        4 => 0x114, // BTN_EXTRA (browser forward)
        n => 0x110 + n as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rows() {
        assert_eq!(evdev("KeyA"), Some(30));
        assert_eq!(evdev("KeyQ"), Some(16));
        assert_eq!(evdev("Digit1"), Some(2));
        assert_eq!(evdev("Digit0"), Some(11));
        assert_eq!(evdev("F1"), Some(59));
        assert_eq!(evdev("F12"), Some(88));
        assert_eq!(evdev("F13"), Some(183));
        assert_eq!(evdev("Enter"), Some(28));
        assert_eq!(evdev("Nope"), None);
    }
}
