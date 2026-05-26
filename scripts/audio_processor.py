import argparse, json, os, sys
import numpy as np
from pydub import AudioSegment
try:
    from scipy import signal
    HAS_SCIPY = True
except ImportError:
    HAS_SCIPY = False
    print("[WARN] scipy não instalado — EQ e reverb desativados", file=sys.stderr)
def apply_eq(samples, sr, bands):
    if not HAS_SCIPY:
        return samples
    configs = [(80,'bass'),(250,'low_mid'),(1000,'mid'),(4000,'high_mid'),(8000,'treble')]
    result  = samples.copy().astype(np.float64)
    for fc, key in configs:
        g = float(bands.get(key, 0))
        if abs(g) < 0.1 or fc >= sr / 2:
            continue
        A     = 10 ** (g / 40)
        w0    = 2 * np.pi * fc / sr
        alpha = np.sin(w0) / (2 * 0.707)
        b = [(1 + alpha*A), (-2*np.cos(w0)), (1 - alpha*A)]
        a = [(1 + alpha/A), (-2*np.cos(w0)), (1 - alpha/A)]
        result = signal.lfilter([x/a[0] for x in b], [1, a[1]/a[0], a[2]/a[0]], result)
    return result
def apply_reverb(samples, sr, wet=0.3, decay=0.5):
    if not HAS_SCIPY or wet < 0.01:
        return samples
    n  = int(max(0.5, decay * 3) * sr)
    t  = np.linspace(0, decay * 3, n)
    ir = np.random.randn(n) * np.exp(-6 * t / decay)
    ir[0] = 1.0
    ir   /= (np.max(np.abs(ir)) + 1e-10)
    rev   = signal.fftconvolve(samples, ir, mode='full')[:len(samples)]
    return samples * (1 - wet) + rev * wet
def to_mono_samples(seg, target_sr):
    seg = seg.set_channels(1).set_frame_rate(target_sr).set_sample_width(2)
    return np.frombuffer(seg.raw_data, dtype=np.int16).astype(np.float64) / 32768.0
def main():
    p = argparse.ArgumentParser()
    p.add_argument('--input',        required=True)
    p.add_argument('--output',       required=True)
    p.add_argument('--music',        default='')
    p.add_argument('--music-start',  type=float, default=0.0)
    p.add_argument('--music-duration', type=float, default=0.0)
    p.add_argument('--music-vol',    type=float, default=0.3)
    p.add_argument('--eq',           default='{}')
    p.add_argument('--reverb',       type=float, default=0.0)
    p.add_argument('--reverb-decay', type=float, default=0.5)
    p.add_argument('--format',       default='wav16k', choices=['wav16k','wav8k8bit','mp3'])
    args = p.parse_args()
    if args.format == 'wav16k':
        target_sr = 16000
    elif args.format == 'wav8k8bit':
        target_sr = 8000
    else:
        target_sr = 22050
    eq_bands  = json.loads(args.eq)
    tts  = AudioSegment.from_file(args.input)
    samp = to_mono_samples(tts, target_sr)
    samp = apply_eq(samp, target_sr, eq_bands)
    samp = apply_reverb(samp, target_sr, args.reverb, args.reverb_decay)
    if args.music and os.path.exists(args.music):
        music = AudioSegment.from_file(args.music)
        start_ms = int(args.music_start * 1000)
        dur_ms   = int(args.music_duration * 1000)
        if dur_ms > 0:
            music = music[start_ms : start_ms + dur_ms]
        else:
            music = music[start_ms :]

        msamp = to_mono_samples(music, target_sr)
        
        if len(msamp) > len(samp):
            pad = np.zeros(len(msamp) - len(samp))
            samp = np.concatenate((samp, pad))
        else:
            reps  = (len(samp) // len(msamp)) + 2
            msamp = np.tile(msamp, reps)[:len(samp)]
            
        fade = min(int(0.5 * target_sr), len(msamp) // 4)
        if fade > 0:
            msamp[:fade]  *= np.linspace(0, 1, fade)
            msamp[-fade:] *= np.linspace(1, 0, fade)
            
        samp = samp + msamp * args.music_vol
    peak = np.max(np.abs(samp))
    if peak > 1e-10:
        samp = samp * (0.95 / peak)
    pcm = np.clip(samp * 32767, -32768, 32767).astype(np.int16)
    out = AudioSegment(pcm.tobytes(), frame_rate=target_sr, sample_width=2, channels=1)
    if args.format == 'wav16k':
        out.export(args.output, format='wav')
    elif args.format == 'wav8k8bit':
        out = out.set_sample_width(1)
        out.export(args.output, format='wav')
    else:
        out.export(args.output, format='mp3', bitrate='128k')
    print(f"format={args.format}")
    print(f"out={args.output}")
    print("Processamento concluído.", file=sys.stderr)
if __name__ == '__main__':
    main()
