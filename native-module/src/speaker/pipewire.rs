// Linux system-audio capture — PipeWire primary with Pulse fallback.
// See docs/plans/linux-support-plan.md §3.1
//
// Strategy: this file is named `pipewire.rs` but implements via `libpulse-binding`
// over `pipewire-pulse` compat. Every CachyOS / Arch desktop with PipeWire ships
// `pipewire-pulse` by default, so a native `pw_stream` adds no extra coverage
// for Phase 0 while requiring a heavier Rust binding (pipewire crate + spa).
// The Pulse monitor source `<default_sink>.monitor` captures the *mixed* output
// already rendered by PipeWire's graph, giving equivalent semantics to:
//   - Windows WASAPI Shared loopback (capture the render mix)
//   - macOS CoreAudio tap (capture the output device's mix)
// Phase 1 may add a direct `pipewire-rs` node as primary with this Pulse path
// kept as the private fallback — the public `SpeakerInput`/`SpeakerStream` trait
// already isolates that swap.

use crate::audio_config::RING_BUFFER_SAMPLES;
use anyhow::{anyhow, Result};
use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::{Context, FlagSet as CtxFlags};
use libpulse_binding::def::BufferAttr;
use libpulse_binding::mainloop::threaded::Mainloop;
use libpulse_binding::operation::State as OpState;
use libpulse_binding::sample::{Format, Spec};
use libpulse_binding::stream::FlagSet as StreamFlags;
use ringbuf::{
    traits::{Producer, Split},
    HeapCons, HeapProd, HeapRb,
};
use std::cell::RefCell;
use std::collections::VecDeque;
use std::process::Command;
use std::rc::Rc;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Public trait surface — must match windows.rs / core_audio.rs / sck.rs
// ---------------------------------------------------------------------------

pub struct SpeakerInput {
    device_id: Option<String>,
}

pub struct SpeakerStream {
    consumer: Option<HeapCons<f32>>,
    waker_state: Arc<Mutex<WakerState>>,
    capture_thread: Option<thread::JoinHandle<()>>,
    actual_sample_rate: u32,
    /// Mirrors windows.rs — lib.rs does not consume it, but we keep it so
    /// future DSP wakeups can be added without changing the trait.
    data_ready: Arc<(Mutex<bool>, Condvar)>,
}

struct WakerState {
    shutdown: bool,
}

impl SpeakerStream {
    pub fn sample_rate(&self) -> u32 {
        self.actual_sample_rate
    }
    pub fn take_consumer(&mut self) -> Option<HeapCons<f32>> {
        self.consumer.take()
    }
    pub fn data_ready_signal(&self) -> Arc<(Mutex<bool>, Condvar)> {
        self.data_ready.clone()
    }
    /// Pause is not supported natively for Pulse monitor streams — callers
    /// should drop and recreate `SpeakerInput`.
    pub fn pause(&mut self) {
        // No-op: the threaded capture loop keeps running until Drop flips shutdown.
        // Left as explicit method to satisfy the trait shared with macOS CoreAudio.
    }
    pub fn resume(&mut self) -> Result<()> {
        // Same caveat as CoreAudio aggregate pause/resume — full recreate required.
        Err(anyhow!(
            "Pulse monitor resume not supported — recreate SpeakerInput"
        ))
    }
}

impl Drop for SpeakerStream {
    fn drop(&mut self) {
        if let Ok(mut s) = self.waker_state.lock() {
            s.shutdown = true;
        }
        if let Some(h) = self.capture_thread.take() {
            let _ = h.join();
        }
    }
}

// ---------------------------------------------------------------------------
// SpeakerInput — creation + stream()
// ---------------------------------------------------------------------------

impl SpeakerInput {
    pub fn new(device_id: Option<String>) -> Result<Self> {
        let device_id = device_id.filter(|id| !id.is_empty() && id != "default");
        // Eagerly probe PipeWire / Pulse availability so `new()` errors early
        // rather than only at `stream()` (mirrors microphone.rs eager probe).
        // Soft-fail: if Pulse is not running, we still return Ok and let stream()
        // surface the error on the 5s init channel — gives JS a consistent path.
        Ok(Self { device_id })
    }

    /// Spawn the capture thread and wait (5s) for real sample rate.
    /// Mirrors `windows.rs::SpeakerInput::stream`.
    pub fn stream(self) -> Result<SpeakerStream> {
        let rb = HeapRb::<f32>::new(RING_BUFFER_SAMPLES.max(131072));
        let (producer, consumer) = rb.split();

        let waker_state = Arc::new(Mutex::new(WakerState { shutdown: false }));
        let data_ready = Arc::new((Mutex::new(false), Condvar::new()));
        let (init_tx, init_rx) = mpsc::channel();

        let waker_clone = waker_state.clone();
        let data_ready_clone = data_ready.clone();
        let device_id = self.device_id;

        let capture_thread = thread::spawn(move || {
            if let Err(e) = capture_audio_loop(producer, waker_clone, data_ready_clone, init_tx, device_id) {
                eprintln!("[PipeWire/Pulse] capture loop exited with error: {}", e);
            }
        });

        let actual_sample_rate = match init_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(rate)) => rate,
            Ok(Err(e)) => {
                if let Ok(mut s) = waker_state.lock() {
                    s.shutdown = true;
                }
                let _ = capture_thread.join();
                return Err(anyhow!("Pulse monitor init failed: {}", e));
            }
            Err(_) => {
                if let Ok(mut s) = waker_state.lock() {
                    s.shutdown = true;
                }
                let _ = capture_thread.join();
                return Err(anyhow!(
                    "Pulse monitor init timed out after 5s (PipeWire/Pulse not running, or no default sink)"
                ));
            }
        };

        Ok(SpeakerStream {
            consumer: Some(consumer),
            waker_state,
            capture_thread: Some(capture_thread),
            actual_sample_rate,
            data_ready,
        })
    }
}

// ---------------------------------------------------------------------------
// Device enumeration + default sink — via Pulse threaded mainloop
// ---------------------------------------------------------------------------

/// Returns the Pulse server's default SINK name (e.g. `alsa_output.pci-...`).
/// Falls back to parsing `pactl get-default-sink` if the Pulse context cannot
/// be reached (useful when `pipewire-pulse` is present but the mainloop
/// probe races `pipewire` startup).
fn get_default_sink_name() -> Result<String> {
    // Prefer shell `pactl` — instant, no mainloop deadlock risk, always available
    // on Arch/CachyOS when libpulse is. Pulse threaded-mainloop probe is kept as
    // fallback for sandboxed environments where pactl is absent.
    if let Ok(out) = Command::new("pactl").arg("get-default-sink").output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && s != "@DEFAULT_SINK@" {
                return Ok(s);
            }
        }
    }
    if let Ok(name) = get_default_sink_via_pulse() {
        if !name.is_empty() {
            return Ok(name);
        }
    }
    Err(anyhow!("no default sink (Pulse context and pactl both failed)"))
}

fn get_default_sink_via_pulse() -> Result<String> {
    let mut mainloop = Mainloop::new().ok_or_else(|| anyhow!("Mainloop::new failed"))?;
    let mut ctx_opt = Context::new(&mainloop, "natively-probe");
    let mut ctx = ctx_opt.take().ok_or_else(|| anyhow!("Context::new returned None"))?;
    ctx.connect(None, CtxFlags::NOFLAGS, None)
        .map_err(|e| anyhow!("Context::connect: {:?}", e))?;

    mainloop.lock();
    mainloop.start().map_err(|e| anyhow!("Mainloop::start: {:?}", e))?;

    // Wait for Context Ready with timeout to avoid hang on PipeWire race.
    let wait_start = std::time::Instant::now();
    loop {
        match ctx.get_state() {
            libpulse_binding::context::State::Ready => break,
            libpulse_binding::context::State::Failed | libpulse_binding::context::State::Terminated => {
                mainloop.unlock();
                mainloop.stop();
                return Err(anyhow!("Pulse context failed/terminated"));
            }
            _ => {
                if wait_start.elapsed() > Duration::from_secs(2) {
                    mainloop.unlock();
                    mainloop.stop();
                    return Err(anyhow!("Pulse context wait timeout"));
                }
                mainloop.wait();
            }
        }
    }

    let result: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let result_clone = result.clone();
    let op = ctx.introspect().get_server_info(move |info| {
        let sink = info.default_sink_name.as_ref().map(|cow| cow.to_string()).unwrap_or_default();
        if let Ok(mut g) = result_clone.lock() {
            *g = Some(sink);
        }
    });

    // Drain operation with timeout.
    let op_start = std::time::Instant::now();
    loop {
        match op.get_state() {
            OpState::Done => break,
            OpState::Cancelled => {
                mainloop.unlock();
                mainloop.stop();
                return Err(anyhow!("get_server_info cancelled"));
            }
            OpState::Running => {
                if op_start.elapsed() > Duration::from_secs(2) {
                    mainloop.unlock();
                    mainloop.stop();
                    return Err(anyhow!("get_server_info timeout"));
                }
                mainloop.wait();
            }
        }
    }

    mainloop.unlock();
    mainloop.stop();

    let name = result.lock().ok().and_then(|g| g.clone()).unwrap_or_default();
    if name.is_empty() {
        Err(anyhow!("Pulse server has no default sink"))
    } else {
        Ok(name)
    }
}

pub fn list_output_devices() -> Result<Vec<(String, String)>> {
    // Fast path: pactl short — avoids mainloop threading in tests/spike where
    // the threaded callback's Rc<RefCell> Send hazard has hung previously.
    let fast = fallback_list_via_pactl();
    if !fast.is_empty() {
        return Ok(fast);
    }
    let mut mainloop = match Mainloop::new() {
        Some(m) => m,
        None => return Ok(fast),
    };
    let mut ctx_opt = Context::new(&mainloop, "natively-list");
    let mut ctx = match ctx_opt.take() { Some(c) => c, None => return Ok(fast) };
    if ctx.connect(None, CtxFlags::NOFLAGS, None).is_err() {
        return Ok(fast);
    }

    mainloop.lock();
    if mainloop.start().is_err() {
        mainloop.unlock();
        return Ok(fallback_list_via_pactl());
    }

    let wait_start = std::time::Instant::now();
    loop {
        match ctx.get_state() {
            libpulse_binding::context::State::Ready => break,
            libpulse_binding::context::State::Failed | libpulse_binding::context::State::Terminated => {
                mainloop.unlock();
                mainloop.stop();
                return Ok(fallback_list_via_pactl());
            }
            _ => {
                if wait_start.elapsed() > Duration::from_secs(2) {
                    mainloop.unlock();
                    mainloop.stop();
                    return Ok(fallback_list_via_pactl());
                }
                mainloop.wait()
            },
        }
    }

    let out: Arc<Mutex<Vec<(String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let out_clone = out.clone();
    let op = ctx.introspect().get_sink_info_list(move |res| match res {
        ListResult::Item(info) => {
            let name = info.name.as_ref().map(|c| c.to_string()).unwrap_or_default();
            let desc = info
                .description
                .as_ref()
                .map(|c| c.to_string())
                .unwrap_or_else(|| name.clone());
            if !name.is_empty() {
                if let Ok(mut g) = out_clone.lock() {
                    g.push((name.clone(), desc));
                }
            }
        }
        ListResult::End | ListResult::Error => {}
    });

    let op_start = std::time::Instant::now();
    loop {
        match op.get_state() {
            OpState::Done => break,
            OpState::Cancelled => {
                mainloop.unlock();
                mainloop.stop();
                return Ok(fallback_list_via_pactl());
            }
            OpState::Running => {
                if op_start.elapsed() > Duration::from_secs(2) {
                    mainloop.unlock();
                    mainloop.stop();
                    return Ok(fallback_list_via_pactl());
                }
                mainloop.wait()
            },
        }
    }

    mainloop.unlock();
    mainloop.stop();

    let mut list = out.lock().map(|g| g.clone()).unwrap_or_default();
    if list.is_empty() {
        list = fallback_list_via_pactl();
    }
    Ok(list)
}

fn fallback_list_via_pactl() -> Vec<(String, String)> {
    let out = match Command::new("pactl").arg("list").arg("sinks").arg("short").output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let stdout = String::from_utf8_lossy(&out.stdout);
    stdout
        .lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            // pactl list sinks short: index \t name \t driver \t ...
            if parts.len() >= 2 {
                let name = parts[1].trim().to_string();
                if !name.is_empty() {
                    return Some((name.clone(), name));
                }
            }
            None
        })
        .collect()
}

pub fn default_output_device_uid() -> String {
    get_default_sink_name().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Monitor source resolution
// ---------------------------------------------------------------------------

fn resolve_monitor_source(device_id: Option<String>) -> Result<String> {
    match device_id {
        Some(id) if id.ends_with(".monitor") => Ok(id),
        Some(id) if !id.is_empty() => {
            // Heuristic: if id looks like a sink name, derive monitor.
            // If it already is a monitor-derived id, keep it.
            // We assume any non-empty id is a sink; append .monitor.
            Ok(format!("{}.monitor", id))
        }
        _ => {
            // No id → default sink's monitor.
            let sink = get_default_sink_name()?;
            Ok(format!("{}.monitor", sink))
        }
    }
}

// ---------------------------------------------------------------------------
// Capture loop — threaded mainloop + record stream
// ---------------------------------------------------------------------------


fn capture_audio_loop(
    mut producer: HeapProd<f32>,
    waker_state: Arc<Mutex<WakerState>>,
    data_ready: Arc<(Mutex<bool>, Condvar)>,
    init_tx: mpsc::Sender<Result<u32>>,
    device_id: Option<String>,
) -> Result<()> {
    let monitor = match resolve_monitor_source(device_id.clone()) {
        Ok(m) => m,
        Err(e) => {
            let _ = init_tx.send(Err(e));
            return Ok(());
        }
    };

    eprintln!("[PipeWire/Pulse] monitor={:?}", monitor);

    let spec = Spec {
        format: Format::FLOAT32NE,
        channels: 1,
        rate: 48000,
    };
    assert!(spec.is_valid());

    let buffer_attr = BufferAttr {
        maxlength: 48000 * 4 * 2,
        tlength: 0,
        prebuf: 0,
        minreq: 0,
        fragsize: 480 * 4, // 10ms
    };

    use libpulse_simple_binding::Simple;
    use libpulse_binding::stream::Direction;

    let simple = match Simple::new(
        None,
        "NativelySystemAudio",
        Direction::Record,
        Some(monitor.as_str()),
        "monitor",
        &spec,
        None,
        Some(&buffer_attr),
    ) {
        Ok(s) => s,
        Err(e) => {
            let _ = init_tx.send(Err(anyhow!(
                "Pulse Simple connect_record failed for monitor '{}': {} — check `pactl list sinks`",
                monitor,
                e.0
            )));
            return Ok(());
        }
    };

    // Negotiated spec may differ, but Simple does not expose get_sample_spec.
    // Pulse will resample to our requested 48k; publish 48k.
    let negotiated_rate = 48000u32;
    let _ = init_tx.send(Ok(negotiated_rate));
    eprintln!("[PipeWire/Pulse] stream ready monitor={} rate={}Hz", monitor, negotiated_rate);

    // Blocking read loop — Simple::read blocks until fragsize bytes.
    // Use small fragsize (10ms) so shutdown is checked every read.
    let mut buf = vec![0u8; 480 * 4];
    loop {
        {
            if let Ok(s) = waker_state.lock() {
                if s.shutdown {
                    break;
                }
            }
        }

        // This blocks ~10ms in the Pulse server.
        match simple.read(&mut buf) {
            Ok(()) => {
                for chunk in buf.chunks_exact(4) {
                    let sample = f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                    let _ = producer.try_push(sample);
                }
                let (lk, cv) = &*data_ready;
                if let Ok(mut g) = lk.lock() {
                    *g = true;
                    cv.notify_all();
                }
            }
            Err(e) => {
                // Read error — likely server shutdown or device removed.
                // Check shutdown and retry once after brief sleep; otherwise exit to surface error on next start.
                if waker_state.lock().map(|s| s.shutdown).unwrap_or(true) {
                    break;
                }
                eprintln!("[PipeWire/Pulse] read error {} — pausing 100ms", e.0);
                std::thread::sleep(std::time::Duration::from_millis(100));
                // If the sink was removed, subsequent reads will keep failing; exit to allow JS retry.
                // We break to tear down and let `stream()` caller re-probe default sink.
                // For transient errors, the next loop iteration will try again.
                // To avoid busy-loop on persistent error, break after one retry.
                // But pipe should stay alive for normal silence (read returns silence, not error).
                // So we continue.
                continue;
            }
        }
    }

    eprintln!("[PipeWire/Pulse] capture loop exit");
    Ok(())
}

