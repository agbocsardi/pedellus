# Local speech transcription: can Python/uv be avoided?

Research date: 2026-10-30. Status: decision input, not an approved change. No
source, config, dependency or provisioning change was made while producing it;
every runtime claim below comes from the cited upstream documentation, published
package metadata or repository source, not from an install or a transcription.

## Question

The only Python in this project is the speech helper: `scripts/local-transcribe.py`
(PEP 723, `faster-whisper==1.1.1`) executed as
`uv run --script --offline …` by `src/media/transcription.ts`. Can that dependency
be removed by doing the same work from Node/TypeScript without losing the fixed
CPU/`small`/`int8` baseline?

## What the current baseline actually is

- A bounded subprocess, not in-process inference: 180 s timeout, 64 KiB stdout
  cap, 120 s audio-duration cap, killed process group on abort/timeout, mapped
  exit codes (`unavailable`, `too-large`, `failed`, `empty`).
- Fully offline at message time: `HF_HUB_OFFLINE=1` is forced and the model loads
  with `local_files_only`; provisioning is a separate, explicit operator step.
- Capability: multilingual Whisper `small`, CPU, `int8` (CTranslate2). Model file
  `model.bin` is 461 MiB (fp16; computed as int8 at load). MIT.
- Audio decoding is not a side concern: faster-whisper decodes through PyAV,
  whose wheels bundle the FFmpeg libraries, so Ogg/Opus voice notes, MP3, M4A and
  WAV all work with no system FFmpeg. That is what the current Telegram voice
  path depends on.
- Honest gap: this path has never been provisioned or run live here. So the
  baseline is "unverified but designed", and any replacement inherits the same
  obligation — it must be measured, not asserted.

## What "avoid Python" can mean

Three different claims, which the options satisfy differently:

1. **No Python interpreter or `uv` at runtime** — satisfiable by any native engine.
2. **No compiled native artifact at all (pure JS/WASM)** — satisfiable, but not at
   the `small` CPU quality/speed tier in practice.
3. **Nothing provisioned from the network** — not satisfiable by any Whisper
   backend; every option needs a multi-hundred-MB model on disk.

A TypeScript API is not evidence for claim 2. `@huggingface/transformers` in Node
hard-requires `onnxruntime-node`, i.e. a native N-API shared library
(`packages/transformers/package.json` lists `onnxruntime-node`, `onnxruntime-web`,
`sharp`, `@huggingface/tokenizers`, `@huggingface/jinja` as dependencies).

## Candidates

### A. whisper.cpp `whisper-cli` as an operator-provisioned executable — recommended, conditional

- Engine: MIT, plain C/C++ with no dependencies, CPU-only inference supported,
  x86 AVX / ARM NEON; actively maintained (v1.9.5, 2026-10-06).
- Model: same Whisper `small` weights in `ggml` format — `ggml-small.bin` 465 MiB
  (fp16-equivalent), `q8_0` 252 MiB, `q5_1` 181 MiB. Multilingual.
- Audio decoding: the CLI decodes `flac, mp3, ogg, wav` itself via the bundled
  `miniaudio.h` (WAV/FLAC/MP3) plus `stb_vorbis.c` (Ogg Vorbis), resampling to
  16 kHz. No FFmpeg needed for those formats.
- **Opus gap (decisive).** Telegram voice notes are Ogg **Opus**. miniaudio
  documents built-in decoding only for WAV, FLAC and MP3, and the ffmpeg fallback
  is compiled only with `WHISPER_COMMON_FFMPEG`, which is a Linux-only CMake
  option defaulting to `OFF` and links libav* at build time. So a default build
  cannot decode a Telegram voice note. Three ways out, all unverified here:
  build with `WHISPER_COMMON_FFMPEG`; provision an FFmpeg binary as a second
  executable (mind `ffmpeg-static`'s GPL-3.0-or-later licence); or decode Opus in
  Node (`opus-decoder`, WASM, MIT) and hand the engine 16 kHz PCM.
- Packaging: releases do not ship a Linux `whisper-cli` binary (v1.9.5 publishes
  no assets; nightly builds ship a macOS xcframework and Windows archives), so
  provisioning means `cmake -B build && cmake --build build` from source, or a
  distro package. `-DGGML_NATIVE=OFF` is required for a redistributable binary.
- Node fit: one `spawn` of a path, exactly like today's `uv` spawn; text-only
  stdout with `-np`/`-nt`, `-oj` for JSON, `-l auto|xx` for language, `-d` for a
  duration bound, `--vad --vad-model` for VAD, nonzero exit on failure. No npm
  dependency and no in-process native crash risk.

### B. whisper.cpp as a Node native addon (`nodejs-whisper`, `smart-whisper`)

- Same engine, worse packaging. `nodejs-whisper` 0.4.1 (MIT, recent) runs
  `scripts/build-native.js --optional` on install and falls back to a CLI backend;
  its README still requires host FFmpeg for non-WAV conversion. `smart-whisper`
  0.8.1 (MIT) always runs `node-gyp rebuild` on install and was last published
  2024-10, i.e. unmaintained for this purpose. Both put native inference inside
  the gateway process, which the current design deliberately avoids (upstream
  docs warn a fatal native crash terminates Node). Callers must supply mono 16 kHz
  Float32 PCM, so the Opus problem is unchanged.

### C. sherpa-onnx (`sherpa-onnx-node` 2.0.1, Apache-2.0)

- Prebuilt native libraries per platform through npm optional dependencies
  (`sherpa-onnx-linux-x64`, `-linux-arm64`, `-darwin-*`, `-win-*`), no compiler on
  the host — the best "no Python, no build" story.
- Whisper support exists (`OfflineRecognizer` with `whisper.encoder/decoder`,
  `language`, `task`, Silero VAD), but is a secondary path in that project: the
  pretrained-model docs demonstrate `tiny.en` and `large-v3`; the
  `sherpa-onnx-whisper-small.tar.bz2` release asset is 610 MiB (multiple
  precisions in one archive), versus 112 MiB for `tiny.en`.
- Costs: the examples require `LD_LIBRARY_PATH` to point at the platform package
  inside `node_modules`, `readWave` is WAV-only so Opus still needs a decode step,
  and inference is in-process. Adoptable, but a larger surface than option A for
  the same model family.

### D. `@huggingface/transformers` + `onnxruntime-node`

- Real TypeScript API, Apache-2.0, active (4.3.2). But: native ONNX Runtime is a
  hard Node dependency (≈308 MB unpacked; CPU binaries are bundled in the package,
  only CUDA extras download at install), plus `sharp`.
- **No audio decoding in Node at all**: `load_audio` throws without `AudioContext`,
  and the official Node guide tells you to bring `wavefile` and do 32-bit float,
  16 kHz, mono conversion yourself. Opus again needs an extra decoder.
- Model: `onnx-community/whisper-small` int8 is 88 MiB encoder + 156 MiB decoder
  (plus a 156 MiB merged decoder variant); fp16 is 336 + 308 MiB. Offline requires
  `env.allowRemoteModels=false` with a local model directory.
- Net effect: strictly more native and npm surface than option A, a second
  quantization scheme to validate, and per-token decoder overhead that makes it
  the least attractive CPU option for short messages — unverified, but it would
  be the wrong place to start.

### E. Pure JS/WASM only (transformers.js WASM/WebGPU, whisper.cpp emscripten)

- Removes native artifacts, keeps the model download. `onnxruntime-web` WASM on a
  CPU `small` model is far slower than a native engine, and the published
  whisper.cpp npm binding (`whisper.cpp` 1.0.3) is a 2022 emscripten build. Does
  not credibly preserve the "bounded 180 s turn" envelope for 120 s audio.
  Rejected as a quality/latency regression, not as a dependency win.

### F. Keep Python/uv (status quo)

- Known contract, best-documented decoders (PyAV covers Opus), pinned by a PEP 723
  script. Cost: a Python 3.11+ toolchain plus `uv` on the host and a
  `uv`-managed environment (CTranslate2, PyAV, ONNX Runtime, tokenizers).

## Comparison

| | A whisper.cpp CLI | B whisper.cpp addon | C sherpa-onnx | D transformers.js | F uv + faster-whisper |
|---|---|---|---|---|---|
| Python/uv needed | no | no | no | no | **yes** |
| Native artifact | one binary (build from source) | addon, install-time build or prebuild | prebuilt .so via npm | prebuilt ONNX Runtime (308 MB) | Python wheels |
| New npm dependencies | 0 | 1–2 | 3+ optional platform pkgs | 5 + `sharp` | 0 |
| CPU/Linux x64 | yes (AVX/NEON builds) | yes | yes | yes | yes |
| `small` multilingual model | 181–465 MiB ggml | same | 610 MiB archive | 244 MiB int8 ONNX | 461 MiB CT2 |
| Ogg/Opus decode | **no** without FFmpeg build/binary | no (needs FFmpeg) | no (needs decode step) | no (needs decode step) | **yes** (PyAV) |
| Offline after provisioning | yes (`-m`) | yes | yes | yes (`allowRemoteModels=false`) | yes |
| Isolation | separate process | in-process | in-process | in-process | separate process |
| Licence | MIT | MIT | Apache-2.0 | Apache-2.0 + MIT | MIT |
| Maintenance | active (v1.9.5, 2026-10) | mixed (one stale, one recent) | active (2.0.1) | active (4.3.2) | active |

## Recommendation

**Treat whisper.cpp `whisper-cli` (option A) as the intended replacement, and make
the Ogg/Opus decode path the go/no-go gate.** It is the only option that removes
Python and `uv` without adding a single npm dependency, keeps inference in a
killable child process exactly as today, ships under MIT with the same Whisper
`small` weights, and offers a model size tier (252 MiB `q8_0`, 181 MiB `q5_1`)
close to the current footprint.

Do **not** adopt it — and do not remove the Python helper — until one Opus route
is proven on the actual host: (a) a build with `WHISPER_COMMON_FFMPEG`, (b) a
provisioned FFmpeg binary alongside the engine, or (c) a Node-side WASM Opus
decoder feeding PCM. If none is acceptable, the honest answer is that Python stays
because PyAV is what currently makes Telegram voice work.

Fallback ranking if a compiler-free host becomes a hard requirement:
sherpa-onnx prebuilt (C) before a whisper.cpp addon (B); `@huggingface/transformers`
(D) is a last resort, since it trades a Python dependency for a bigger native one.
Option E should not be revived as a "pure JS" argument.

## Explicit non-claim

`int8` CTranslate2, `ggml` `q5_1`/`q8_0` and ONNX `int8` are three different
quantizations of the same weights. Nothing here establishes transcript equality,
and no option is allowed to be presented as "matching the current quality"
without measurement. In the same way, this document does not claim any of the new
paths is faster: no CPU benchmark was run.

## Unresolved empirical checks (required before any switch)

1. **Opus**: transcribe a real Ogg/Opus voice fixture with the chosen route on the
   target Linux host, inside the existing subprocess bounds.
2. **Quality**: same 5–10 fixture recordings (short, long, noisy, non-English,
   silence/music-only), transcripts diffed against the current `small`/`int8`
   baseline; check the whisper.cpp failure modes the upstream CLI README
   documents (phantom text on music/silence, language auto-detect drift).
3. **Quantization choice**: `q8_0` vs `q5_1` vs fp16 on the same fixtures; pick the
   smallest tier that holds quality, and record the decision.
4. **Latency/memory**: real-time factor and peak RSS for 120 s audio on the target
   CPU, against the 180 s timeout; measure model load per turn unless a resident
   engine is chosen.
5. **Provisioning**: reproducible build/install recipe, resulting binary size,
   `GGML_NATIVE=OFF` portability, glibc/musl, no runtime network.
6. **Offline proof**: with networking unavailable, a message-sized transcription
   succeeds and a missing model fails cleanly as `unavailable`.
7. **If D is ever revisited**: ONNX int8 transcript quality and Node 22 N-API
   compatibility, plus local-model-path behaviour with remote loading disabled.

## Minimal readiness work that needs no install, download or network

- This document: the comparison, the gate and the measurement plan.
- When scoped, the only code shape worth keeping is the one that already exists:
  `src/media/transcription.ts` stays a bounded `spawn` with the same outcome
  mapping and the same env allowlist; only the command, argv and helper path
  change, and `defaultHelperPath()` points at a provisioned engine instead of
  `scripts/`. No new tool, config key or provider registry is implied.
- Documentation touchpoints for that later slice: `SETUP.md` (§8 voice
  provisioning), `TELEGRAM.md` (§attachments), `README.md` (§Media), `AGENTS.md`
  (invariants), `THIRD_PARTY_NOTICES.md` (engine + model licence).
- Decide and record, before coding: whether the provisioning unit is "operator
  builds a binary" (A) or "npm platform package" (C). That single choice fixes
  installation docs, licence entries and the failure messages.

## Sources (accessed 2026-10-30)

- whisper.cpp repository and README (MIT, CPU inference, model/memory table,
  build from source): https://github.com/ggml-org/whisper.cpp
- whisper.cpp CLI flags and supported formats: https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md
- whisper.cpp audio decode path (miniaudio first, FFmpeg only when compiled in): https://github.com/ggml-org/whisper.cpp/blob/master/examples/common-whisper.cpp
- whisper.cpp CMake option `WHISPER_COMMON_FFMPEG` (Linux-only, default OFF): https://github.com/ggml-org/whisper.cpp/blob/master/CMakeLists.txt
- whisper.cpp release v1.9.5 (2026-10-06, no Linux CLI assets): https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5
- ggml model files and sizes (`ggml-small*`): https://huggingface.co/ggerganov/whisper.cpp/tree/main
- miniaudio built-in decoding formats (WAV, FLAC, MP3): https://github.com/mackron/miniaudio
- nodejs-whisper README (FFmpeg for conversion, model list): https://github.com/ChetanXpro/nodejs-whisper
- nodejs-whisper native-build/packaging docs: https://github.com/ChetanXpro/nodejs-whisper/blob/main/docs/development.md
- nodejs-whisper 0.4.1 package metadata (`install` hook, cmake-js): https://registry.npmjs.org/nodejs-whisper/latest
- smart-whisper README (node-gyp build, PCM-only input): https://github.com/JacobLinCool/smart-whisper
- smart-whisper 0.8.1 package metadata (last publish 2024-10): https://registry.npmjs.org/smart-whisper/latest
- Transformers.js Node audio guide (bring your own WAV decoding; Float32 16 kHz): https://github.com/huggingface/transformers.js/blob/main/packages/transformers/docs/source/guides/node-audio-processing.md
- Transformers.js audio utils (`load_audio` throws without `AudioContext`): https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/utils/audio.js
- Transformers.js package dependencies (onnxruntime-node/web, sharp, tokenizers): https://registry.npmjs.org/@huggingface/transformers/latest
- Transformers.js ONNX backend selection in Node: https://github.com/huggingface/transformers.js/blob/main/packages/transformers/src/backends/onnx.js
- ONNX Runtime Node package size and install script (CPU binaries bundled): https://registry.npmjs.org/onnxruntime-node/latest , https://github.com/microsoft/onnxruntime/blob/main/js/node/script/install.js
- `onnx-community/whisper-small` file sizes (int8/fp16/q4 encoder and decoder): https://huggingface.co/onnx-community/whisper-small
- sherpa-onnx Node addon examples README (`LD_LIBRARY_PATH`, WebAssembly alternative): https://github.com/k2-fsa/sherpa-onnx/blob/master/nodejs-addon-examples/README.md
- sherpa-onnx JS API documentation: https://k2-fsa.github.io/sherpa/onnx/javascript-api/index.html
- sherpa-onnx Whisper model config (`language`, `task`, multilingual behaviour): https://github.com/k2-fsa/sherpa-onnx/blob/master/sherpa-onnx/csrc/offline-whisper-model-config.h
- sherpa-onnx Whisper pretrained models (tiny.en, large-v3 examples): https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/index.html
- sherpa-onnx `asr-models` release assets (`sherpa-onnx-whisper-small.tar.bz2` 610 MiB, tiny.en 112 MiB): https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models
- sherpa-onnx-node 2.0.1 platform packages: https://registry.npmjs.org/sherpa-onnx-node/latest
- faster-whisper audio decoding via PyAV (bundled FFmpeg, no system dependency): https://github.com/SYSTRAN/faster-whisper/blob/master/faster_whisper/audio.py
- faster-whisper requirements: https://github.com/SYSTRAN/faster-whisper/blob/master/requirements.txt
- `Systran/faster-whisper-small` (461 MiB `model.bin`, MIT): https://huggingface.co/Systran/faster-whisper-small
- `ffmpeg-static` licence (GPL-3.0-or-later) if FFmpeg becomes a provisioned executable: https://registry.npmjs.org/ffmpeg-static/latest
- `opus-decoder` (WASM Opus decoder, MIT) for the Node-side decode option: https://registry.npmjs.org/opus-decoder/latest
