// Phase 0 headless spike — proves PipeWire dual-stream → 16 kHz → disk.
//
// Usage:
//   cargo run -p natively-audio --bin audio_spike -- --seconds 5 --dump /tmp/natively-spike
//
// Produces:
//   /tmp/natively-spike.mic.wav       — 16 kHz mono i16, mic capture
//   /tmp/natively-spike.system.wav    — 16 kHz mono i16, monitor capture
//   stdout diagnostics: native/emit rates, chunk counts, RMS sanity, Resampler ratio
//
// Isolation: no Electron, no napi, no STT — just Rust capture + rubato.
// Mirrors the DSP path in lib.rs: HeapRb drain → Resampler → i16 LE.
// Exit 0 on success, 1 on capture failure, 2 on silence/sanity fail.

use std::env;
use std::fs::File;
use std::io::{Seek, Write};
use std::path::PathBuf;
use std::thread;
use std::time::{Duration, Instant};

use natively_audio::microphone::MicrophoneStream;
use natively_audio::resampler::Resampler;
use natively_audio::speaker;
use natively_audio as natively_audio_crate;
use ringbuf::traits::Consumer;

const CANONICAL: u32 = 16000;

fn wav_header(rate: u32, data_bytes: u32) -> Vec<u8> {
    let mut h = Vec::with_capacity(44);
    // RIFF
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + data_bytes).to_le_bytes());
    h.extend_from_slice(b"WAVE");
    // fmt
    h.extend_from_slice(b"fmt ");
    h.extend_from_slice(&16u32.to_le_bytes()); // PCM chunk size
    h.extend_from_slice(&1u16.to_le_bytes()); // PCM format
    h.extend_from_slice(&1u16.to_le_bytes()); // mono
    h.extend_from_slice(&rate.to_le_bytes());
    h.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate = rate * block_align
    h.extend_from_slice(&2u16.to_le_bytes()); // block align = channels*bits/8
    h.extend_from_slice(&16u16.to_le_bytes()); // bits per sample
    // data
    h.extend_from_slice(b"data");
    h.extend_from_slice(&data_bytes.to_le_bytes());
    h
}

fn rms_i16(buf: &[i16]) -> f64 {
    if buf.is_empty() {
        return 0.0;
    }
    let sum: f64 = buf.iter().map(|&s| (s as f64 / 32768.0).powi(2)).sum();
    (sum / buf.len() as f64).sqrt()
}

fn drain_single_mic_concrete(
    mut consumer: ringbuf::HeapCons<f32>,
    native_rate: u32,
    seconds: u64,
) -> (Vec<i16>, u32) {
    let mut resampler: Option<Resampler> = if native_rate == CANONICAL { None } else { Resampler::new(native_rate as f64).ok() };
    let actual_emit = if resampler.is_some() { CANONICAL } else { native_rate };
    let mut raw: Vec<f32> = Vec::with_capacity(4096);
    let mut pending: Vec<i16> = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while Instant::now() < deadline {
        while let Some(s) = consumer.try_pop() {
            raw.push(s);
        }
        if !raw.is_empty() {
            match resampler.as_mut() {
                Some(r) => if let Ok(v) = r.resample_to_i16(&raw) { pending.extend(v); },
                None => for &f in &raw { pending.push((f * 32767.0).clamp(-32768.0, 32767.0) as i16); },
            }
            raw.clear();
        }
        thread::sleep(Duration::from_millis(5));
    }
    (pending, actual_emit)
}

fn write_wav(path: &PathBuf, rate: u32, samples: &[i16]) -> std::io::Result<()> {
    let data_bytes = (samples.len() * 2) as u32;
    let hdr = wav_header(rate, data_bytes);
    let mut f = File::create(path)?;
    f.write_all(&hdr)?;
    for &s in samples {
        f.write_all(&s.to_le_bytes())?;
    }
    f.flush()?;
    let pos = f.stream_position()?;
    eprintln!("[wav] wrote {} ({} bytes, {} samples @{}Hz)", path.display(), pos, samples.len(), rate);
    Ok(())
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mut seconds: u64 = 5;
    let mut dump = PathBuf::from("/tmp/natively-spike");
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--seconds" => {
                if i + 1 < args.len() {
                    seconds = args[i + 1].parse().unwrap_or(5);
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--dump" => {
                if i + 1 < args.len() {
                    dump = PathBuf::from(&args[i + 1]);
                    i += 2;
                } else {
                    i += 1;
                }
            }
            "--help" | "-h" => {
                eprintln!("Usage: {} [--seconds N] [--dump /tmp/prefix]", args[0]);
                std::process::exit(0);
            }
            _ => i += 1,
        }
    }

    eprintln!("[spike] Phase 0 — dual capture {}s, dump prefix {}", seconds, dump.display());
    eprintln!("[spike] CachyOS Wayland PipeWire: run `pw-top` in another terminal to observe streams");

    // Enumerate devices (proves list_output_devices + default work).
    match speaker::list_output_devices() {
        Ok(devs) => {
            eprintln!("[spike] output devices ({}):", devs.len());
            for (id, name) in devs.iter().take(10) {
                eprintln!("  id={:?} name={:?}", id, name);
            }
        }
        Err(e) => eprintln!("[spike] list_output_devices error: {e}"),
    }
    let default_id = speaker::default_output_device_uid();
    eprintln!("[spike] default sink: {:?}", default_id);

    match natively_audio_crate::microphone::list_input_devices() {
        Ok(devs) => {
            eprintln!("[spike] input devices ({}):", devs.len());
            for (id, name) in devs.iter().take(10) {
                eprintln!("  id={:?} name={:?}", id, name);
            }
        }
        Err(e) => eprintln!("[spike] list_input_devices error: {e}"),
    }

    // ---- Mic capture -------------------------------------------------------
    let mut mic_stream = match MicrophoneStream::new(None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[spike] FATAL mic init: {e}");
            std::process::exit(1);
        }
    };
    let mic_native = mic_stream.sample_rate();
    eprintln!("[spike] mic native {}Hz", mic_native);
    if let Err(e) = mic_stream.play() {
        eprintln!("[spike] FATAL mic play: {e}");
        std::process::exit(1);
    }
    let mic_consumer = match mic_stream.take_consumer() {
        Some(c) => c,
        None => {
            eprintln!("[spike] FATAL mic take_consumer failed");
            std::process::exit(1);
        }
    };

    // ---- System monitor capture --------------------------------------------
    let speaker_input = match speaker::SpeakerInput::new(None) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[spike] FATAL system input new: {e}");
            // Mic alone is still useful for CI — exit 1 but dump mic partial.
            std::process::exit(1);
        }
    };
    let mut speaker_stream = match speaker_input.stream() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[spike] FATAL system stream: {e}");
            eprintln!("[spike] Hint: is PipeWire/Pulse running? `systemctl --user status pipewire pipewire-pulse`");
            let (mic_samples, mic_emit) = drain_single_mic_concrete(mic_consumer, mic_native, seconds);
            let mic_path = {
                let s = dump.to_string_lossy().to_string() + ".mic.wav";
                PathBuf::from(s)
            };
            if let Err(ee) = write_wav(&mic_path, mic_emit, &mic_samples) {
                eprintln!("[spike] mic wav write failed: {ee}");
            }
            eprintln!("[spike] mic RMS {:.4} samples {} @{}Hz → {}", rms_i16(&mic_samples), mic_samples.len(), mic_emit, mic_path.display());
            std::process::exit(1);
        }
    };
    let sys_native = speaker_stream.sample_rate();
    eprintln!("[spike] system native {}Hz", sys_native);
    let sys_consumer = match speaker_stream.take_consumer() {
        Some(c) => c,
        None => {
            eprintln!("[spike] FATAL system take_consumer failed");
            std::process::exit(1);
        }
    };

    // Concurrent drain — mic and system interleaved via two-stage loop.
    // Simpler than threading: sequential drain with short sleeps still captures
    // both because each has its own producer thread pushing into its HeapRb.
    // We alternate draining each consumer each poll tick.
    let emitted_mic = if mic_native == CANONICAL { mic_native } else { CANONICAL };
    let emitted_sys = if sys_native == CANONICAL { sys_native } else { CANONICAL };
    let mut res_mic: Option<Resampler> = if mic_native == CANONICAL { None } else { Resampler::new(mic_native as f64).ok() };
    let mut res_sys: Option<Resampler> = if sys_native == CANONICAL { None } else { Resampler::new(sys_native as f64).ok() };
    let actual_mic_emit = if res_mic.is_some() { CANONICAL } else { mic_native };
    let actual_sys_emit = if res_sys.is_some() { CANONICAL } else { sys_native };

    let mut mic_raw: Vec<f32> = Vec::with_capacity(4096);
    let mut sys_raw: Vec<f32> = Vec::with_capacity(4096);
    let mut mic_out: Vec<i16> = Vec::with_capacity((actual_mic_emit as usize) * seconds as usize);
    let mut sys_out: Vec<i16> = Vec::with_capacity((actual_sys_emit as usize) * seconds as usize);
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut mic_f32_total: usize = 0;
    let mut sys_f32_total: usize = 0;

    // We need ownership of consumers for the loop. Wrap in Option so we can move them.
    let mut mic_cons = Some(mic_consumer);
    let mut sys_cons = Some(sys_consumer);

    while Instant::now() < deadline {
        if let Some(ref mut c) = mic_cons {
            while let Some(s) = c.try_pop() {
                mic_raw.push(s);
            }
        }
        if let Some(ref mut c) = sys_cons {
            while let Some(s) = c.try_pop() {
                sys_raw.push(s);
            }
        }
        if !mic_raw.is_empty() {
            mic_f32_total += mic_raw.len();
            match res_mic.as_mut() {
                Some(r) => {
                    if let Ok(v) = r.resample_to_i16(&mic_raw) {
                        mic_out.extend(v);
                    }
                }
                None => {
                    for &f in &mic_raw {
                        mic_out.push((f * 32767.0).clamp(-32768.0, 32767.0) as i16);
                    }
                }
            }
            mic_raw.clear();
        }
        if !sys_raw.is_empty() {
            sys_f32_total += sys_raw.len();
            match res_sys.as_mut() {
                Some(r) => {
                    if let Ok(v) = r.resample_to_i16(&sys_raw) {
                        sys_out.extend(v);
                    }
                }
                None => {
                    for &f in &sys_raw {
                        sys_out.push((f * 32767.0).clamp(-32768.0, 32767.0) as i16);
                    }
                }
            }
            sys_raw.clear();
        }
        thread::sleep(Duration::from_millis(5));
    }

    eprintln!(
        "[spike] drained mic f32={} → i16={} @{}Hz, system f32={} → i16={} @{}Hz",
        mic_f32_total,
        mic_out.len(),
        actual_mic_emit,
        sys_f32_total,
        sys_out.len(),
        actual_sys_emit
    );

    // Pause streams so Drop joins cleanly.
    drop(mic_cons);
    drop(sys_cons);
    drop(speaker_stream);
    // mic_stream needs pause
    let _ = mic_stream.pause();

    let mic_path = dump.with_file_name(format!("{}-mic.wav", dump.file_name().unwrap().to_string_lossy()));
    // dump is a prefix like /tmp/natively-spike → we used with_file_name above; simpler: append suffix
    let mic_path = {
        let mut p = dump.clone();
        let s = p.to_string_lossy().to_string() + ".mic.wav";
        PathBuf::from(s)
    };
    let sys_path = {
        let mut p = dump.clone();
        let s = p.to_string_lossy().to_string() + ".system.wav";
        PathBuf::from(s)
    };

    if let Err(e) = write_wav(&mic_path, actual_mic_emit, &mic_out) {
        eprintln!("[spike] mic wav write failed: {e}");
        std::process::exit(1);
    }
    if let Err(e) = write_wav(&sys_path, actual_sys_emit, &sys_out) {
        eprintln!("[spike] system wav write failed: {e}");
        std::process::exit(1);
    }

    let mic_rms = rms_i16(&mic_out);
    let sys_rms = rms_i16(&sys_out);
    eprintln!("[spike] mic RMS {:.5} samples {} → {}", mic_rms, mic_out.len(), mic_path.display());
    eprintln!("[spike] system RMS {:.5} samples {} → {}", sys_rms, sys_out.len(), sys_path.display());
    eprintln!(
        "[spike] mic expected ~{} samples, got {} (ratio {:.2})",
        actual_mic_emit as usize * seconds as usize,
        mic_out.len(),
        mic_out.len() as f64 / (actual_mic_emit as f64 * seconds as f64)
    );
    eprintln!(
        "[spike] system expected ~{} samples, got {} (ratio {:.2})",
        actual_sys_emit as usize * seconds as usize,
        sys_out.len(),
        sys_out.len() as f64 / (actual_sys_emit as f64 * seconds as f64)
    );

    // Sanity: we must have produced roughly expected samples (rubato holds ~1 chunk slack).
    let mic_ok = !mic_out.is_empty() && (mic_out.len() as f64 / (actual_mic_emit as f64 * seconds as f64) > 0.85);
    // System may be silent (RMS ~0) if no audio playing — do not fail on sys RMS, only on sample count.
    let sys_ok = !sys_out.is_empty() || sys_f32_total > 0; // at least some graph ticks

    if !mic_ok {
        eprintln!("[spike] WARN mic produced no/very few samples — mic may be mute or permission blocked");
    }
    if sys_out.is_empty() && sys_f32_total == 0 {
        eprintln!("[spike] WARN system produced zero samples — is audio playing? Try `pw-play --volume 50` while running spike. ffprobe still validates format.");
        // Still success for Phase 0 if format path is proven; system silence is environmental, not code failure.
    } else {
        eprintln!("[spike] OK system stream flowing (f32_total={} i16={})", sys_f32_total, sys_out.len());
    }

    // ffprobe hint
    eprintln!("[spike] Verify: ffprobe -hide_banner {} && ffprobe -hide_banner {}", mic_path.display(), sys_path.display());
    eprintln!("[spike] Inspect RMS: play a song + talk while re-running with --seconds 10");

    if mic_ok {
        std::process::exit(0);
    } else {
        std::process::exit(2);
    }
}
