#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "faster-whisper==1.1.1",
# ]
# ///
"""Local speech recognition for durable-nanobot (faster-whisper, CPU, small, int8).

Run with `uv run --script scripts/local-transcribe.py <audio> [options]`.
The runtime invokes it through `uv run --script --offline` with Hugging Face hub
offline mode forced, so nothing is installed or downloaded while a chat message
is being handled: provision the environment and model once as SETUP.md describes.

Usage:
    local-transcribe.py <audio-file> [--max-duration-seconds N] [--language L]
    local-transcribe.py <audio-file> --allow-model-download   # one-time provisioning

Outside provisioning, the model is loaded with `local_files_only=True` and hub
offline mode forced, so a missing model fails instead of downloading.

Prints the recognized text to stdout (nothing else) and exits:
    0  success
    1  bad arguments or unreadable input
    2  transcription failed
    3  backend or model unavailable (faster-whisper missing, model not present)
    4  audio exceeds the configured duration or size bound

The model (`small`), device (`cpu`) and compute type (`int8`) are fixed here.
This helper never falls back to a cloud provider.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

MODEL = "small"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"
MAX_AUDIO_BYTES = 20 * 1024 * 1024

EXIT_USAGE = 1
EXIT_FAILED = 2
EXIT_UNAVAILABLE = 3
EXIT_TOO_LARGE = 4


def fail(code: int, message: str) -> None:
    print(message, file=sys.stderr, flush=True)
    sys.exit(code)


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("audio")
    parser.add_argument("--max-duration-seconds", type=float, default=120.0)
    parser.add_argument("--language", default=None)
    parser.add_argument(
        "--allow-model-download",
        action="store_true",
        help="one-time provisioning only: allow fetching the model to the local cache",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    if not args.allow_model_download:
        # Never download a model while a message is being handled: a missing local
        # model is an operational setup problem, reported as unavailable.
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    audio_path = Path(args.audio)
    try:
        size = audio_path.stat().st_size
    except OSError as error:
        fail(EXIT_USAGE, f"unreadable audio input: {error.__class__.__name__}")
    if size == 0:
        fail(EXIT_USAGE, "audio input is empty")
    if size > MAX_AUDIO_BYTES:
        fail(EXIT_TOO_LARGE, "audio input exceeds the size limit")
    if args.max_duration_seconds <= 0:
        fail(EXIT_USAGE, "duration limit must be positive")

    try:
        from faster_whisper import WhisperModel
    except Exception:
        fail(EXIT_UNAVAILABLE, "faster-whisper is not available")

    try:
        model = WhisperModel(
            MODEL,
            device=DEVICE,
            compute_type=COMPUTE_TYPE,
            local_files_only=not args.allow_model_download,
        )
    except Exception as error:
        # A missing model or an incompatible runtime is an operational setup problem.
        fail(EXIT_UNAVAILABLE, f"whisper model unavailable: {error.__class__.__name__}")

    try:
        # Transcription is lazy: the duration is known before any segment is decoded.
        segments, info = model.transcribe(
            str(audio_path), language=args.language, vad_filter=True
        )
        duration = float(getattr(info, "duration", 0.0) or 0.0)
        if duration > args.max_duration_seconds:
            fail(EXIT_TOO_LARGE, "audio exceeds the duration limit")
        text = " ".join(segment.text.strip() for segment in segments).strip()
    except SystemExit:
        raise
    except Exception as error:
        fail(EXIT_FAILED, f"transcription failed: {error.__class__.__name__}")

    if text:
        print(text, flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
