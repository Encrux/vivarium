//! Per-window shared-memory frames and the software compositor that fills them.
//!
//! File layout (one file per window, little-endian header; the frame_ready message is the
//! source of truth, the header is there for debugging and for a reader that lost track):
//!
//!   0   [u8;4]  magic "VVFB"
//!   4   u32     version (1)
//!   8   u32     format (0 = BGRA8 premultiplied)
//!   12  u32     front slot (last published)
//!   16  u64     slot 0 offset
//!   24  u64     slot 1 offset
//!   32  u64     slot capacity in bytes
//!   40  u32     seq of the front slot
//!   44  u32     width
//!   48  u32     height
//!   52  u32     stride
//!   4096        slot 0 pixels, then slot 1 at 4096 + capacity (page aligned)
//!
//! Two slots: the helper only ever writes the slot that is *not* the last published one, and it
//! publishes the next frame only after the plugin acked the previous one (`frame_ack`), so the
//! reader never sees a half-written frame and never needs a lock. Rows are tightly packed
//! (stride = width * 4) so the damaged rows of a frame are one contiguous range of the file.
use memmap2::MmapMut;
use smithay::reexports::wayland_server::protocol::{wl_buffer::WlBuffer, wl_shm};
use smithay::utils::{Logical, Rectangle, Size};
use smithay::wayland::shm::with_buffer_contents;
use std::fs::{File, OpenOptions};
use std::path::PathBuf;

pub const HEADER: usize = 4096;
const PAGE: usize = 4096;

pub struct FrameFile {
    pub path: PathBuf,
    _file: File,
    map: MmapMut,
    pub capacity: usize,
}

/// Where frame files go: /dev/shm (tmpfs, never touches disk), else XDG_RUNTIME_DIR (also tmpfs on
/// systemd distros).
pub fn shm_dir() -> PathBuf {
    let shm = PathBuf::from("/dev/shm");
    if shm.is_dir() {
        return shm;
    }
    std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir)
}

/// Frame files are removed when their window goes and when we exit; a crash (SIGKILL) leaves them
/// behind, so sweep files of helpers that no longer run.
pub fn sweep_stale() {
    let Ok(dir) = std::fs::read_dir(shm_dir()) else { return };
    for e in dir.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(rest) = name.strip_prefix("vivarium-") else { continue };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<i32>().ok()) else { continue };
        // kill(pid, 0) == -1 with ESRCH: no such process
        if unsafe { libc::kill(pid, 0) } == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

impl FrameFile {
    pub fn create(window: u32, generation: u32, bytes_per_slot: usize) -> std::io::Result<Self> {
        let capacity = bytes_per_slot.div_ceil(PAGE).max(1) * PAGE;
        let path = shm_dir().join(format!("vivarium-{}-w{}-{}", std::process::id(), window, generation));
        let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path)?;
        // Readable by our user only: frames are screen contents.
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        file.set_len((HEADER + 2 * capacity) as u64)?;
        let mut map = unsafe { MmapMut::map_mut(&file)? };
        map[0..4].copy_from_slice(b"VVFB");
        map[4..8].copy_from_slice(&1u32.to_le_bytes());
        map[16..24].copy_from_slice(&(HEADER as u64).to_le_bytes());
        map[24..32].copy_from_slice(&((HEADER + capacity) as u64).to_le_bytes());
        map[32..40].copy_from_slice(&(capacity as u64).to_le_bytes());
        Ok(Self { path, _file: file, map, capacity })
    }

    pub fn slot_offset(&self, slot: usize) -> usize {
        HEADER + slot * self.capacity
    }

    pub fn slot_mut(&mut self, slot: usize) -> &mut [u8] {
        let off = self.slot_offset(slot);
        &mut self.map[off..off + self.capacity]
    }

    /// (slot, the other slot)
    pub fn slots(&self) -> (&[u8], &[u8]) {
        let (a, b) = self.map[HEADER..HEADER + 2 * self.capacity].split_at(self.capacity);
        (a, b)
    }

    pub fn publish_header(&mut self, slot: u32, seq: u32, w: u32, h: u32, stride: u32) {
        let m = &mut self.map;
        m[12..16].copy_from_slice(&slot.to_le_bytes());
        m[40..44].copy_from_slice(&seq.to_le_bytes());
        m[44..48].copy_from_slice(&w.to_le_bytes());
        m[48..52].copy_from_slice(&h.to_le_bytes());
        m[52..56].copy_from_slice(&stride.to_le_bytes());
    }
}

impl Drop for FrameFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Where a layer's pixels come from.
pub enum Src {
    /// the client's shm buffer, read in place
    Shm(WlBuffer),
    /// a GPU-rendered buffer's CPU copy (see gpu.rs)
    Pixels(std::rc::Rc<crate::gpu::Pixels>),
}

/// One surface to draw, in frame coordinates, bottom to top.
pub struct Layer {
    pub src: Src,
    /// destination rectangle (logical == pixels in M0: output scale 1)
    pub dst: Rectangle<i32, Logical>,
}

/// Draw `layers` into `dst` (a w×h BGRA frame with `stride`) within `rect` only.
pub fn composite(dst: &mut [u8], stride: usize, rect: Rectangle<i32, Logical>, layers: &[Layer]) {
    // The bottom layer is copied, not blended, so whatever it covers needs no clearing. Clear the
    // rest (nothing mapped there yet). In the common case the toplevel covers the whole rect.
    let covered = layers.first().is_some_and(|l| l.dst.contains_rect(rect));
    if !covered {
        for y in rect.loc.y..rect.loc.y + rect.size.h {
            let row = y as usize * stride + rect.loc.x as usize * 4;
            dst[row..row + rect.size.w as usize * 4].fill(0);
        }
    }
    for (i, l) in layers.iter().enumerate() {
        let Some(r) = l.dst.intersection(rect) else { continue };
        // The first layer lands on a cleared (or fully covered) area: plain copy is exact.
        draw(dst, stride, r, l, i == 0);
    }
}

fn draw(dst: &mut [u8], stride: usize, r: Rectangle<i32, Logical>, l: &Layer, first: bool) {
    match &l.src {
        Src::Shm(buffer) => {
            let _ = with_buffer_contents(buffer, |ptr, len, d| {
                let src = unsafe { std::slice::from_raw_parts(ptr, len) };
                let (bw, bh, bstride, boff) = (d.width as usize, d.height as usize, d.stride as usize, d.offset as usize);
                if boff + bstride * bh.saturating_sub(1) + bw * 4 > len {
                    return; // client lied about its pool size
                }
                let opaque = d.format == wl_shm::Format::Xrgb8888;
                draw_from(dst, stride, r, l, first, &src[boff..], bw, bh, bstride, opaque);
            });
        }
        Src::Pixels(p) => {
            if p.data.len() >= p.stride() * p.height && p.width > 0 {
                draw_from(dst, stride, r, l, first, &p.data, p.width, p.height, p.stride(), p.opaque);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn draw_from(
    dst: &mut [u8],
    stride: usize,
    r: Rectangle<i32, Logical>,
    l: &Layer,
    first: bool,
    src: &[u8],
    bw: usize,
    bh: usize,
    bstride: usize,
    opaque: bool,
) {
    let boff = 0;
    {
        let (dw, dh) = (l.dst.size.w as usize, l.dst.size.h as usize);
        let scaled = dw != bw || dh != bh;
        let x0 = (r.loc.x - l.dst.loc.x) as usize; // first column inside the layer
        let w = r.size.w as usize;
        for y in 0..r.size.h as usize {
            let ly = (r.loc.y - l.dst.loc.y) as usize + y;
            let sy = if scaled { ly * bh / dh } else { ly };
            let srow = &src[boff + sy * bstride..boff + sy * bstride + bw * 4];
            let drow_off = (r.loc.y as usize + y) * stride + r.loc.x as usize * 4;
            let drow = &mut dst[drow_off..drow_off + w * 4];
            if !scaled {
                let s = &srow[x0 * 4..(x0 + w) * 4];
                if opaque {
                    copy_opaque(drow, s);
                } else if first {
                    drow.copy_from_slice(s);
                } else {
                    blend(drow, s);
                }
            } else {
                // Nearest-neighbour fallback for buffer_scale/viewport mismatches (rare in M0).
                for x in 0..w {
                    let sx = (x0 + x) * bw / dw;
                    let px = &srow[sx * 4..sx * 4 + 4];
                    let dpx = &mut drow[x * 4..x * 4 + 4];
                    if opaque {
                        copy_opaque(dpx, px);
                    } else if first {
                        dpx.copy_from_slice(px);
                    } else {
                        blend(dpx, px);
                    }
                }
            }
        }
    }
}

/// XRGB: the X byte is undefined, force alpha to 255.
/// Two pixels per u64 so the compiler vectorizes it (SSE2/NEON).
#[inline]
fn copy_opaque(d: &mut [u8], s: &[u8]) {
    let n = d.len().min(s.len());
    let mut dc = d[..n].chunks_exact_mut(8);
    let mut sc = s[..n].chunks_exact(8);
    for (dp, sp) in (&mut dc).zip(&mut sc) {
        let v = u64::from_le_bytes(sp.try_into().unwrap()) | 0xff00_0000_ff00_0000;
        dp.copy_from_slice(&v.to_le_bytes());
    }
    for (dp, sp) in dc.into_remainder().chunks_exact_mut(4).zip(sc.remainder().chunks_exact(4)) {
        let v = u32::from_le_bytes(sp.try_into().unwrap()) | 0xff00_0000;
        dp.copy_from_slice(&v.to_le_bytes());
    }
}

/// Premultiplied source-over, two channels per multiply (valid premultiplied input can't
/// overflow a channel).
#[inline]
fn blend(d: &mut [u8], s: &[u8]) {
    for (dp, sp) in d.chunks_exact_mut(4).zip(s.chunks_exact(4)) {
        let sv = u32::from_le_bytes(sp.try_into().unwrap());
        let a = sv >> 24;
        if a == 255 {
            dp.copy_from_slice(sp);
        } else if a != 0 {
            let dv = u32::from_le_bytes((&*dp).try_into().unwrap());
            let inv = 255 - a;
            // d * inv / 255 for channels 0,2 and 1,3, rounded, no division
            let mut rb = (dv & 0x00ff_00ff) * inv + 0x0080_0080;
            rb = ((rb + ((rb >> 8) & 0x00ff_00ff)) >> 8) & 0x00ff_00ff;
            let mut ag = ((dv >> 8) & 0x00ff_00ff) * inv + 0x0080_0080;
            ag = (ag + ((ag >> 8) & 0x00ff_00ff)) & 0xff00_ff00;
            dp.copy_from_slice(&sv.wrapping_add(rb | ag).to_le_bytes());
        }
    }
}

/// Damage bookkeeping: merge overlapping rectangles, and give up on precision (one bounding box)
/// when there are many; the reader pays per range, not per pixel.
pub fn coalesce(mut rects: Vec<Rectangle<i32, Logical>>, bounds: Size<i32, Logical>) -> Vec<Rectangle<i32, Logical>> {
    let full = Rectangle::from_size(bounds);
    rects = rects.into_iter().filter_map(|r| r.intersection(full)).filter(|r| !r.is_empty()).collect();
    let mut merged = true;
    while merged {
        merged = false;
        'outer: for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                if rects[i].overlaps_or_touches(rects[j]) {
                    let m = rects[i].merge(rects[j]);
                    rects[i] = m;
                    rects.swap_remove(j);
                    merged = true;
                    break 'outer;
                }
            }
        }
    }
    if rects.len() > 8 {
        let bb = rects.iter().skip(1).fold(rects[0], |a, r| a.merge(*r));
        rects = vec![bb];
    }
    rects
}

/// Shrink `r` to the bounding box of pixels that differ between frames `a` and `b` (same size and
/// stride), or None if nothing does. Many clients damage their whole surface every frame (GTK4,
/// Mesa's software EGL); comparing in the helper costs a fraction of what the plugin would spend
/// reading and uploading the unchanged pixels.
pub fn shrink_to_diff(a: &[u8], b: &[u8], stride: usize, r: Rectangle<i32, Logical>) -> Option<Rectangle<i32, Logical>> {
    let (x0, w) = (r.loc.x as usize * 4, r.size.w as usize * 4);
    let row = |y: usize| (&a[y * stride + x0..y * stride + x0 + w], &b[y * stride + x0..y * stride + x0 + w]);
    let ys = r.loc.y as usize..(r.loc.y + r.size.h) as usize;
    let top = ys.clone().find(|&y| {
        let (p, q) = row(y);
        p != q
    })?;
    let bottom = ys.rev().find(|&y| {
        let (p, q) = row(y);
        p != q
    })?;
    // Columns: per differing row, first/last differing pixel; 8 bytes at a time.
    let (mut left, mut right) = (w / 4, 0usize);
    for y in top..=bottom {
        let (p, q) = row(y);
        if p == q {
            continue;
        }
        let px = |i: usize| p[i * 4..i * 4 + 4] != q[i * 4..i * 4 + 4];
        let n = w / 4;
        let mut l = 0;
        while l < left && !px(l) {
            l += 1;
        }
        left = left.min(l);
        let mut rr = n;
        while rr > right + 1 && !px(rr - 1) {
            rr -= 1;
        }
        right = right.max(rr);
    }
    if right <= left {
        return None;
    }
    Some(Rectangle::new(
        (r.loc.x + left as i32, top as i32).into(),
        ((right - left) as i32, (bottom - top + 1) as i32).into(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diff_box() {
        let (w, h) = (16usize, 8usize);
        let a = vec![0u8; w * h * 4];
        let mut b = a.clone();
        b[(3 * w + 5) * 4] = 1;
        b[(5 * w + 9) * 4 + 2] = 1;
        let r = shrink_to_diff(&a, &b, w * 4, Rectangle::from_size((w as i32, h as i32).into())).unwrap();
        assert_eq!((r.loc.x, r.loc.y, r.size.w, r.size.h), (5, 3, 5, 3));
        assert!(shrink_to_diff(&a, &a, w * 4, Rectangle::from_size((w as i32, h as i32).into())).is_none());
    }

    #[test]
    fn blend_matches_reference() {
        for (s, d) in [([10u8, 20, 30, 128], [200u8, 100, 50, 255]), ([0, 0, 0, 0], [1, 2, 3, 4]), ([5, 6, 7, 255], [9, 9, 9, 9])] {
            let mut out = d;
            blend(&mut out, &s);
            let inv = 255 - s[3] as u32;
            for c in 0..4 {
                let want = s[c] as u32 + (d[c] as u32 * inv + 127) / 255;
                assert!((out[c] as i32 - want as i32).abs() <= 1, "{s:?} over {d:?}: {out:?}");
            }
        }
    }

    /// cargo test --release -- --ignored --nocapture bench
    #[test]
    #[ignore]
    fn bench() {
        let (w, h) = (1280usize, 800usize);
        let n = w * h * 4;
        // premultiplied pixels with varied alpha
        let src: Vec<u8> = (0..n / 4)
            .flat_map(|i| {
                let a = (i * 37 % 256) as u8;
                [a / 2, a / 3, a, a]
            })
            .collect();
        let mut dst = vec![0u8; n];
        let time = |name: &str, f: &mut dyn FnMut()| {
            for _ in 0..5 {
                f();
            }
            let t = std::time::Instant::now();
            let k = 50;
            for _ in 0..k {
                f();
            }
            println!("{name:>28}: {:7.3} ms", t.elapsed().as_secs_f64() * 1000.0 / k as f64);
        };
        time("memcpy 1280x800", &mut || {
            dst.copy_from_slice(std::hint::black_box(&src));
            std::hint::black_box(&mut dst);
        });
        time("copy_opaque (XRGB→A=255)", &mut || copy_opaque(&mut dst, &src));
        time("blend (src-over)", &mut || blend(&mut dst, &src));
        let full = Rectangle::from_size((w as i32, h as i32).into());
        let a = src.clone();
        time("diff, identical", &mut || {
            std::hint::black_box(shrink_to_diff(&a, &src, w * 4, full));
        });
        let mut b = src.clone();
        for y in 100..140 {
            b[(y * w + 300) * 4] ^= 1;
            b[(y * w + 700) * 4] ^= 1;
        }
        time("diff, 40 rows changed", &mut || {
            std::hint::black_box(shrink_to_diff(&a, &b, w * 4, full));
        });
    }
}
