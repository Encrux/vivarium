//! GPU path: apps render with the GPU (linux-dmabuf) and we read their pixels back.
//!
//! Without this, every client renders into shared memory: GL/Vulkan apps (browsers, GTK4's GL
//! renderer, games, Electron) fall back to Mesa's software rasterizer, which costs a lot of CPU
//! for anything animated. With it:
//!
//!   - we open a render node (/dev/dri/renderD*), create an EGL display on it (GBM) and a GLES
//!     renderer, and advertise zwp_linux_dmabuf_v1 with that node as the main device, so clients'
//!     EGL/Vulkan allocate their buffers on the GPU and render there;
//!   - on commit, a dmabuf buffer is imported as a GL texture (EGLImage, cached per buffer by
//!     Smithay) and only its *damaged* rectangles are read back (glReadPixels through a pixel
//!     buffer object) into a CPU "shadow" image of that surface;
//!   - the shadow then takes the shm buffer's place in the normal compositor (frame.rs), so
//!     frames, damage, diffing and the plugin side are unchanged.
//!
//! The readback is the price of handing frames to a separate process (Electron's WebGL can't
//! import dmabufs): roughly a memcpy of the damaged area, versus the app rasterizing the whole
//! window on the CPU without a GPU.
//!
//! No usable render node (VMs, containers, `--no-gpu`): no dmabuf global, clients use shm as
//! before. `VIVARIUM_GPU=software` uses Mesa's software EGL device instead (no dmabuf either,
//! since there's no device to allocate on) and routes shm buffers through the same GL import +
//! readback; that's how the GL code is exercised in CI/Docker.
use smithay::backend::allocator::{dmabuf::Dmabuf, Buffer as _, Fourcc};
use smithay::backend::egl::{EGLContext, EGLDevice, EGLDisplay};
use smithay::backend::renderer::{gles::GlesRenderer, ExportMem, ImportDma, ImportMemWl, Texture, TextureMapping};
use smithay::reexports::wayland_server::protocol::wl_buffer::WlBuffer;
use smithay::utils::{Buffer as BufferCoord, Rectangle, Size};
use std::rc::Rc;

/// CPU copy of a GPU-rendered surface buffer (BGRA, premultiplied, tightly packed rows).
#[derive(Clone, Default)]
pub struct Pixels {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
    /// XRGB: alpha byte undefined, treat as opaque
    pub opaque: bool,
}

impl Pixels {
    pub fn stride(&self) -> usize {
        self.width * 4
    }
}

pub struct Gpu {
    pub renderer: GlesRenderer,
    /// dev_t of the render node clients should allocate on (None: software device, no dmabuf)
    pub main_device: Option<libc::dev_t>,
    pub description: String,
    /// shm buffers go through GL too (test mode, `VIVARIUM_GPU=software`)
    pub gl_for_shm: bool,
    pub readback_us: u64,
    pub readback_px: u64,
    pub imports: u64,
    pub failures: u64,
    _keep: Option<Box<dyn std::any::Any>>,
}

impl Gpu {
    /// Open the GPU, or None (logged) when there's nothing usable.
    pub fn init(render_node: Option<&str>, software: bool) -> Option<Gpu> {
        if software {
            return Self::init_software().map_err(|e| crate::out::log(format!("gpu: software EGL unavailable: {e}"))).ok();
        }
        let candidates: Vec<String> = match render_node {
            Some(p) => vec![p.to_string()],
            None => {
                let mut v: Vec<String> = std::fs::read_dir("/dev/dri")
                    .map(|rd| rd.flatten().map(|e| e.path().to_string_lossy().into_owned()).filter(|p| p.contains("renderD")).collect())
                    .unwrap_or_default();
                v.sort();
                v
            }
        };
        for path in candidates {
            match Self::init_node(&path) {
                Ok(g) => return Some(g),
                Err(e) => crate::out::log(format!("gpu: {path}: {e}")),
            }
        }
        None
    }

    #[cfg(feature = "gbm")]
    fn init_node(path: &str) -> Result<Gpu, String> {
        use smithay::backend::allocator::gbm::GbmDevice;
        use smithay::utils::DeviceFd;
        use std::os::unix::fs::MetadataExt;
        let file = std::fs::OpenOptions::new().read(true).write(true).open(path).map_err(|e| e.to_string())?;
        let rdev = file.metadata().map_err(|e| e.to_string())?.rdev();
        let gbm = GbmDevice::new(DeviceFd::from(std::os::fd::OwnedFd::from(file))).map_err(|e| format!("gbm: {e}"))?;
        // SAFETY: the display lives as long as the renderer (both owned by Gpu); we never call
        // eglTerminate on it elsewhere.
        let display = unsafe { EGLDisplay::new(gbm.clone()) }.map_err(|e| format!("egl display: {e}"))?;
        let renderer = Self::renderer(&display)?;
        if renderer.dmabuf_formats().iter().next().is_none() {
            return Err("no dmabuf formats (EGL_EXT_image_dma_buf_import missing)".into());
        }
        let description = format!("{path} ({})", gl_renderer_name(&display));
        Ok(Gpu {
            renderer,
            main_device: Some(rdev as libc::dev_t),
            description,
            gl_for_shm: false,
            readback_us: 0,
            readback_px: 0,
            imports: 0,
            failures: 0,
            _keep: Some(Box::new((gbm, display))),
        })
    }

    #[cfg(not(feature = "gbm"))]
    fn init_node(_path: &str) -> Result<Gpu, String> {
        Err("built without the gbm feature".into())
    }

    fn init_software() -> Result<Gpu, String> {
        let dev = EGLDevice::enumerate()
            .map_err(|e| e.to_string())?
            .find(|d| d.is_software())
            .ok_or("no software EGL device (EGL_MESA_device_software)")?;
        // SAFETY: as above.
        let display = unsafe { EGLDisplay::new(dev) }.map_err(|e| format!("egl display: {e}"))?;
        let renderer = Self::renderer(&display)?;
        let description = format!("software ({})", gl_renderer_name(&display));
        Ok(Gpu {
            renderer,
            main_device: None,
            description,
            gl_for_shm: true,
            readback_us: 0,
            readback_px: 0,
            imports: 0,
            failures: 0,
            _keep: Some(Box::new(display)),
        })
    }

    fn renderer(display: &EGLDisplay) -> Result<GlesRenderer, String> {
        let ctx = EGLContext::new(display).map_err(|e| format!("egl context: {e}"))?;
        // SAFETY: the context is current only on this (the event loop's) thread.
        unsafe { GlesRenderer::new(ctx) }.map_err(|e| format!("gles: {e}"))
    }

    /// Bring `shadow` up to date with `buffer` within `damage` (buffer coordinates).
    /// Returns false if this buffer can't go through the GPU (caller falls back / skips).
    pub fn update_shadow(
        &mut self,
        buffer: &WlBuffer,
        dmabuf: Option<&Dmabuf>,
        surface: Option<&smithay::wayland::compositor::SurfaceData>,
        size: Size<i32, BufferCoord>,
        damage: &[Rectangle<i32, BufferCoord>],
        shadow: &mut Rc<Pixels>,
    ) -> bool {
        let t0 = std::time::Instant::now();
        let (w, h) = (size.w.max(0) as usize, size.h.max(0) as usize);
        if w == 0 || h == 0 {
            return false;
        }
        let full = Rectangle::<i32, BufferCoord>::from_size(size);
        let px = Rc::make_mut(shadow);
        let resized = px.width != w || px.height != h;
        if resized {
            *px = Pixels { width: w, height: h, data: vec![0; w * h * 4], opaque: false };
        }
        let tex = match dmabuf {
            Some(d) => {
                px.opaque = matches!(d.format().code, Fourcc::Xrgb8888 | Fourcc::Xbgr8888);
                self.renderer.import_dmabuf(d, Some(damage))
            }
            None => self.renderer.import_shm_buffer(buffer, surface, damage),
        };
        let tex = match tex {
            Ok(t) => t,
            Err(e) => {
                self.failures += 1;
                if self.failures < 5 {
                    crate::out::log(format!("gpu: import failed: {e}"));
                }
                return false;
            }
        };
        self.imports += 1;
        // A new size, or no damage info: read everything once.
        let rects: Vec<Rectangle<i32, BufferCoord>> = if resized || damage.is_empty() {
            vec![full]
        } else {
            damage.iter().filter_map(|r| r.intersection(full)).filter(|r| !r.is_empty()).collect()
        };
        // Many small rects: one bounding box costs less than many readbacks.
        let rects = if rects.len() > 8 {
            let mut bb = rects[0];
            for r in &rects[1..] {
                bb = bb.merge(*r);
            }
            vec![bb]
        } else {
            rects
        };
        for r in rects {
            if let Err(e) = self.read_rect(&tex, r, px) {
                self.failures += 1;
                if self.failures < 5 {
                    crate::out::log(format!("gpu: readback failed: {e}"));
                }
                return false;
            }
            self.readback_px += (r.size.w * r.size.h) as u64;
        }
        self.readback_us += t0.elapsed().as_micros() as u64;
        true
    }

    fn read_rect(
        &mut self,
        tex: &smithay::backend::renderer::gles::GlesTexture,
        r: Rectangle<i32, BufferCoord>,
        px: &mut Pixels,
    ) -> Result<(), String> {
        // Argb8888 = BGRA bytes, exactly the shm/frame layout; fall back to RGBA + swizzle.
        let (mapping, swap) = match self.renderer.copy_texture(tex, r, Fourcc::Argb8888) {
            Ok(m) => (m, false),
            Err(_) => (self.renderer.copy_texture(tex, r, Fourcc::Abgr8888).map_err(|e| e.to_string())?, true),
        };
        let fmt = TextureMapping::format(&mapping);
        let swap = swap || fmt == Fourcc::Abgr8888 || fmt == Fourcc::Xbgr8888;
        // Buffer row 0 lands in texture row 0 for shm uploads and dmabuf EGLImages alike, and the
        // region is in those coordinates; Smithay's mapping reports GL's bottom-up convention
        // (flipped == false means "row 0 is the bottom"), so its rows come back in buffer order
        // exactly when it says flipped. Measured with test/gpu-check.mjs.
        let flipped = !mapping.flipped();
        let data = self.renderer.map_texture(&mapping).map_err(|e| e.to_string())?;
        let (rw, rh) = (r.size.w as usize, r.size.h as usize);
        let row = rw * 4;
        if data.len() < row * rh {
            return Err(format!("short readback ({} < {})", data.len(), row * rh));
        }
        let stride = px.stride();
        for y in 0..rh {
            let sy = if flipped { rh - 1 - y } else { y };
            let src = &data[sy * row..sy * row + row];
            let off = (r.loc.y as usize + y) * stride + r.loc.x as usize * 4;
            let dst = &mut px.data[off..off + row];
            if swap {
                for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    d.copy_from_slice(&[s[2], s[1], s[0], s[3]]);
                }
            } else {
                dst.copy_from_slice(src);
            }
        }
        let _ = tex.size();
        Ok(())
    }
}

fn gl_renderer_name(display: &EGLDisplay) -> String {
    // The EGL vendor/version is all we can get without a current GL context here.
    format!("EGL {}.{}", display.get_egl_version().0, display.get_egl_version().1)
}
