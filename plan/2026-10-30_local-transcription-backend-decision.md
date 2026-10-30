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
- Packaging: two routes, and they are not the same artifact. **Compiler-free:**
  the rolling nightly prereleases ship `whisper-bin-ubuntu-x64.tar.gz` (9.9 MiB)
  and `-arm64` (4.4 MiB) (nightly `b5454`), built on Ubuntu 22.04 images with
  `-DCMAKE_INSTALL_RPATH='$ORIGIN' -DCMAKE_BUILD_WITH_INSTALL_RPATH=ON
  -DGGML_BACKEND_DL=ON -DGGML_NATIVE=OFF` and `-DGGML_CPU_ALL_VARIANTS=ON` on x64,
  i.e. the CLI plus sibling dl-loaded `ggml` backends under a `$ORIGIN` rpath and
  the upstream `LICENSE` copied in. Those are prerelease tags, not stable ones.
  **Stable pin:** `v1.9.5` publishes no assets, so a stable version means
  `cmake -B build && cmake --build build` from source (or a distro package);
  `-DGGML_NATIVE=OFF` is required for a redistributable binary. Either way the
  provisioning unit is an external engine directory, not a package manager unit.
- Node fit: one `spawn` of a path, exactly like today's `uv` spawn; text-only
  stdout with `-np`/`-nt`, `-oj` for JSON, `-l auto|xx` for language,
  `--vad --vad-model` for VAD, nonzero exit on failure. No npm dependency for the
  FFmpeg-predecode route. A Node WASM Opus route would add dependencies, so that
  variant no longer has "npm 0".

### B. whisper.cpp as a Node native addon (`nodejs-whisper`, `smart-whisper`)

- Same engine, worse packaging. `nodejs-whisper` 0.4.1 (MIT, recent) runs
  `scripts/build-native.js --optional` on install and falls back to a CLI backend;
  its README still requires host FFmpeg for non-WAV conversion. It carries three
  runtime dependencies (`shelljs`, `readline-sync`, `node-addon-api`) and an
  optional `cmake-js`. `smart-whisper` 0.8.1 (MIT) has one runtime dependency
  (`node-addon-api`) and always runs `node-gyp rebuild` on install; it was last
  published 2024-10, i.e. unmaintained for this purpose. Both put native
  inference inside the gateway process, which the current design deliberately
  avoids (upstream documents that a fatal native crash terminates Node). Callers
  must supply mono 16 kHz Float32 PCM, so the Opus problem is unchanged and the
  caller additionally owns decoding.

### C. sherpa-onnx (`sherpa-onnx-node` 2.0.1, Apache-2.0)

- Prebuilt native libraries per platform through npm optional dependencies
  (`sherpa-onnx-linux-x64`, `-linux-arm64`, `-darwin-*`, `-win-*`), no compiler on
  the host — compiler-free without depending on a project's nightly channel.
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
- Model: `onnx-community/whisper-small` int8 is 88 MiB encoder + 149 MiB decoder
  ≈ 237 MiB, with a 149 MiB merged-decoder variant fetched only if the runtime
  path needs it; fp16 is 168 + 294 MiB; the fp32 encoder alone is 336 MiB. Offline
  requires `env.allowRemoteModels=false` with a local model directory.
- Net effect: strictly more native and npm surface than option A, a second
  quantization scheme to validate, and per-token decoder overhead that is a
  plausible but **unmeasured** reason to expect slower CPU turns than a native
  encoder-decoder engine. Not the place to start.

### E. Pure JS/WASM only (transformers.js WASM/WebGPU, whisper.cpp emscripten)

- Removes native artifacts of the engine, keeps the model download.
  `onnxruntime-web` WASM on a CPU `small` model is expected to be far slower than
  a native engine, and the published whisper.cpp npm binding (`whisper.cpp`
  1.0.3) is a 2022 emscripten build. Whether WASM can still hold the "bounded
  180 s turn" envelope for 120 s audio is an **unmeasured judgment**, not a
  measurement; the ranking against A–D in this section is opinion based on
  architecture, not benchmarked here. Rejected as a likely quality/latency
  regression and as the wrong reason to choose a backend.

### F. Keep Python/uv (status quo)

- Known contract, best-documented decoders (PyAV covers Opus), pinned by a PEP 723
  script. Cost: a Python 3.11+ toolchain plus `uv` on the host and a
  `uv`-managed environment (CTranslate2, PyAV, ONNX Runtime, tokenizers).

## Comparison

| | A whisper.cpp CLI | B whisper.cpp addon | C sherpa-onnx | D transformers.js | F uv + faster-whisper |
|---|---|---|---|---|---|
| Python/uv needed | no | no | no | no | **yes** |
| Native artifact | CLI + sibling `ggml` `.so`, prebuilt nightly tarball or own build | addon, install-time build or prebuild | prebuilt `.so` via npm | prebuilt ONNX Runtime (≈308 MB unpacked) | Python wheels |
| Compiler-free host | yes, on a nightly prerelease pin; no on a stable pin | only if a matching prebuild exists | yes | yes | n/a (needs Python toolchain) |
| New npm dependencies | 0 (FFmpeg-predecode route); ≥1 for a Node WASM Opus decoder | 3 + optional `cmake-js` (`nodejs-whisper`) / 1 (`smart-whisper`) | 3+ optional platform packages | 5 + `sharp` | 0 |
| CPU/Linux x64 | yes (runtime CPU variants in the prebuilt, AVX/NEON builds) | yes | yes | yes | yes |
| `small` multilingual model | 181 MiB `q5_1` / 252 MiB `q8_0` / 465 MiB fp16 | same | 610 MiB archive | ≈237 MiB int8 ONNX | 461 MiB CT2 |
| Ogg/Opus decode | **no** by default; pre-decode with FFmpeg (host binary) or build `WHISPER_COMMON_FFMPEG` (adds runtime libav*.so) | no (caller decodes) | no (caller decodes) | no (caller decodes) | **yes** (PyAV) |
| Offline after provisioning | yes (`-m`, no network code unless built `WHISPER_CURL`) | yes | yes | yes (`allowRemoteModels=false`) | yes |
| Process isolation | separate child process (crash contained, not absent — the engine is native either way) | in-process | in-process | in-process | separate child process |
| Licence | MIT | MIT | Apache-2.0 | Apache-2.0 + MIT | MIT |
| Maintenance | active (v1.9.5 stable, 2026-10; rolling nightlies) | mixed (one stale, one recent) | active (2.0.1) | active (4.3.2) | active |

## What does not carry over from the Python helper

These are contract differences, not cosmetics, and were confirmed in source and
by local trial (see the empirical note linked at the end):

- **Exit codes.** The Python helper's map is 1 usage / 2 failed / 3 unavailable /
  4 too-large. `whisper-cli` uses 3 for init or model-load failure, 4 for a
  **grammar parse error**, 10 for a processing failure and 11 for an input-read
  failure. Code 4 in the new engine does not mean "too large", so the existing
  map cannot be reused unchanged; a new adapter needs its own mapping, and
  `too-large` must come from an explicit check rather than an exit code.
- **`-d` is truncation, not refusal.** It is documented as "duration of audio to
  process in milliseconds" and behaves that way: the run still succeeds with a
  shorter transcript. The promised `maxDurationSeconds` refusal has to be enforced
  by probing the decoded audio first (or by bounding the decode), not by the flag.
- **Input format.** The CLI takes file paths or piped bytes that it decodes as a
  container; it does not accept raw PCM. Supplying 16 kHz PCM without a WAV header
  fails as an input-read error; a WAV container works.
- **Environment.** The current allowlist exists for `uv`, `HF_HUB_OFFLINE` and the
  Hugging Face cache variables. Those mean nothing to a C++ CLI, which needs no
  cache or hub configuration at all; keeping them would be cargo cult. What must
  survive is the shape, not the keys: bounded `spawn`, no shell, bounded stdout,
  killed process group, and a small outcome vocabulary (`unavailable`, `timeout`,
  `cancelled`, `too-large`, `failed`, `empty`).

## Recommendation

**Treat whisper.cpp `whisper-cli` (option A) as the intended replacement, and make
the Ogg/Opus decode path the go/no-go gate.** It is the only option that removes
Python and `uv` without adding an npm dependency on the FFmpeg-predecode route,
keeps inference in a killable child process as today, ships under MIT with the
same Whisper `small` weights, and offers a model size tier (252 MiB `q8_0`, 181
MiB `q5_1`) close to the current footprint.

Route (a) — FFmpeg pre-decode — is no longer hypothetical: it was executed
locally and produced correct transcripts from a real Ogg/Opus voice-shaped file,
with VAD, in bounded time and memory (see the empirical note). What still blocks
adoption is not mechanics but policy and evidence: accepting a second provisioned
executable (FFmpeg), accepting a nightly-prebuilt or self-built engine pin, and
measuring quality against the current `small`/`int8` baseline. If FFmpeg cannot be
that second executable and the Node WASM Opus route is unacceptable, the honest
answer is that Python stays, because PyAV is what currently makes Telegram voice
work.

Compiler-free ranking (revised): **A** is available compiler-free too, but only
from a rolling nightly prerelease tarball (`b5454`), so it trades a compiler for a
prerelease pin; **C** is compiler-free on a normal release line; **B** only if a
matching prebuild exists; **D** is last, since it trades a Python dependency for a
bigger native one. Option E should not be revived as a "pure JS" argument.

## Explicit non-claim

`int8` CTranslate2, `ggml` `q5_1`/`q8_0` and ONNX `int8` are three different
quantizations of the same weights. Nothing here establishes transcript equality,
and no option is allowed to be presented as "matching the current quality"
without measurement. The two `ggml` tiers already disagree by a token on a
repeated 102 s fixture, which is exactly why this stays a measurement obligation.

No speed ranking in this document is a benchmark. The local proof run measured
only whisper.cpp `q5_1`/`q8_0` against itself; faster-whisper was never
provisioned, sherpa-onnx and ONNX Runtime were never installed, and WASM was never
run. Statements about D and E being slower are architectural expectation.

## Empirical status and remaining checks

A bounded local proof (separate note: `2026-10-30_local-transcription-offline-proof.md`)
answered parts of this list on one host: Opus pre-decode works, `q5_1`/`q8_0`
transcribe correctly, VAD removes the silence hallucination, no network syscalls
occur, 102 s of audio finished in ≈37 s, and the contract gaps above were
reproduced. Still open:

1. **Native Opus routes**: build with `WHISPER_COMMON_FFMPEG` (plus libav runtime
   dependency) and the Node WASM Opus route, against the same fixture.
2. **Prebuilt vs own build**: verify the nightly `whisper-bin-ubuntu-x64` tarball
   on a clean host (glibc baseline, `$ORIGIN` rpath, dl-loaded CPU variants, no
   compiler) and decide how a prerelease pin is recorded and upgraded.
3. **Quality corpus**: real recordings — noisy, accented, non-English, music-only
   — against the current `small`/`int8` transcript baseline; the existing corpus
   here is one public-domain clip, repeated.
4. **Quantization choice**: `q5_1` vs `q8_0` vs fp16 on that corpus; the two tiers
   already differ on the repeated fixture, so this is a real decision.
5. **Latency envelope**: the 120 s duration bound and the 180 s timeout under a
   cold model load and a loaded host; measured variance on short utterances here
   was 2x, so medians on an idle machine are required.
6. **Resident vs per-turn engine**: per-turn CLI load costs seconds; a resident
   helper would need a different process design.
7. **If D is ever revisited**: ONNX int8 transcript quality, Node N-API
   compatibility, and local-model-path behaviour with remote loading disabled.

## Minimal readiness work

- This document and the empirical note: the comparison, the gate, and measured
  contract gaps. Neither changes a backend.
- The empirical note also records the licence/provenance facts a future slice must
  not lose: the engine and model licences are separate, and any test speech is a
  third-party artifact that is not committed or bundled.
- If a slice is later scoped, the code shape that survives is the existing one:
  `src/media/transcription.ts` stays a bounded `spawn` with the same outcome
  vocabulary; the command, argv, helper path and exit mapping change, the
  Hugging Face variables leave the environment allowlist, and `maxDurationSeconds`
  is enforced by an explicit probe instead of an engine flag.
- Documentation touchpoints for that slice: `SETUP.md` (§8 voice provisioning),
  `TELEGRAM.md` (§attachments), `README.md` (§Media), `AGENTS.md` (invariants),
  `THIRD_PARTY_NOTICES.md` (engine and model licences, separately).
- Decide and record, before coding: nightly-prebuilt pin (A) versus own build (A)
  versus npm platform package (C). That choice fixes installation docs, licence
  entries and the failure messages.

## Sources (accessed 2026-10-30)

- whisper.cpp repository and README (MIT, CPU inference, model/memory table,
  build from source): https://github.com/ggml-org/whisper.cpp
- whisper.cpp CLI flags and supported formats: https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md
- whisper.cpp audio decode path (miniaudio first, FFmpeg only when compiled in): https://github.com/ggml-org/whisper.cpp/blob/master/examples/common-whisper.cpp
- whisper.cpp CMake option `WHISPER_COMMON_FFMPEG` (Linux-only, default OFF): https://github.com/ggml-org/whisper.cpp/blob/master/CMakeLists.txt
- whisper.cpp release v1.9.5 (2026-10-06, stable, no binary assets): https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.5
- whisper.cpp nightly `b5454` assets, including `whisper-bin-ubuntu-x64.tar.gz` (9.9 MiB) and `-arm64` (4.4 MiB): https://github.com/ggml-org/whisper.cpp/releases/tag/b5454
- whisper.cpp release workflow (Ubuntu 22.04 images, `$ORIGIN` rpath, `GGML_BACKEND_DL`, `GGML_CPU_ALL_VARIANTS`, `GGML_NATIVE=OFF`): https://github.com/ggml-org/whisper.cpp/blob/master/.github/workflows/release.yml
- whisper.cpp CLI exit codes (3 init/model, 4 grammar, 10 processing, 11 input): https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp
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
- `onnx-community/whisper-small` file sizes (int8 88+149 MiB, fp16 168+294 MiB, fp32 encoder 336 MiB, merged decoder as a separate variant): https://huggingface.co/onnx-community/whisper-small
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
