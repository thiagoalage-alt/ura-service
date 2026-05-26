import argparse
import asyncio
import os
import socket
import sys


def is_online(host="8.8.8.8", port=53, timeout=3):
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(timeout)
        s.connect((host, port))
        s.close()
        return True
    except OSError:
        return False


LANG_MAP = {
    "pt-BR-FranciscaNeural": "pt",
    "pt-BR-AntonioNeural": "pt",
    "pt-BR-ThalitaMultilingualNeural": "pt",
    "pt-BR-BrendaNeural": "pt",
    "pt-BR-DonatoNeural": "pt",
    "pt-BR-ElzaNeural": "pt",
    "pt-BR-GiovannaNeural": "pt",
    "pt-BR-HumbertoNeural": "pt",
    "pt-BR-JulioNeural": "pt",
    "pt-BR-LeilaNeural": "pt",
    "pt-BR-LeticiaNeural": "pt",
    "pt-BR-ManuelaNeural": "pt",
    "pt-BR-NicolauNeural": "pt",
    "pt-BR-ValerioNeural": "pt",
    "pt-BR-YaraNeural": "pt",
}


async def generate_edge_tts(text, voice, rate, pitch, out_path):
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
    await communicate.save(out_path)


def generate_gtts(text, voice, out_path):
    from gtts import gTTS
    lang = LANG_MAP.get(voice, "pt")
    tts = gTTS(text=text, lang=lang, slow=False)
    tts.save(out_path)


def main():
    parser = argparse.ArgumentParser(description="URA +Inteligente — Motor com redundância")
    parser.add_argument("--text",  required=True,  help="Texto para sintetizar")
    parser.add_argument("--voice", default="pt-BR-FranciscaNeural")
    parser.add_argument("--model", default="default")
    parser.add_argument("--rate",  default="+0%",  help="Velocidade: ex. +10%, -20%")
    parser.add_argument("--pitch", default="+0Hz", help="Tom: ex. +5Hz, -10Hz")
    parser.add_argument("--out",   required=True,  help="Arquivo de saída (.mp3)")
    args = parser.parse_args()

    out_path = args.out
    if out_path.lower().endswith(".wav"):
        out_path = out_path[:-4] + ".mp3"

    engine_used = "unknown"
    online = is_online()

    if online:
        try:
            asyncio.run(generate_edge_tts(args.text, args.voice, args.rate, args.pitch, out_path))
            engine_used = "edge-tts"
            print(f"[INFO] Motor: edge-tts Neural (online)", file=sys.stderr)
        except Exception as e:
            print(f"[WARN] edge-tts falhou: {e} — usando gTTS como fallback", file=sys.stderr)
            try:
                generate_gtts(args.text, args.voice, out_path)
                engine_used = "gtts-fallback"
            except Exception as e2:
                print(f"[ERROR] gTTS também falhou: {e2}", file=sys.stderr)
                sys.exit(1)
    else:
        print("[INFO] Sem conexão — usando gTTS offline", file=sys.stderr)
        try:
            generate_gtts(args.text, args.voice, out_path)
            engine_used = "gtts-offline"
        except Exception as e:
            print(f"[ERROR] gTTS falhou: {e}", file=sys.stderr)
            sys.exit(1)

    print(f"engine={engine_used}")
    print(f"out={out_path}")
    print(f"Áudio gerado com sucesso: {out_path}")


if __name__ == "__main__":
    main()
