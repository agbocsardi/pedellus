# Local transcription: offline proof run on whisper.cpp

Date: 2026-10-30. Companion to
[the backend decision](./2026-10-30_local-transcription-backend-decision.md).
This note records what was actually executed, measured and observed, and what it
does **not** establish. It changes no source, config, dependency or test.

## Authorization and bounds

- Owner authorization (owner asleep): trusted public downloads and local
  provisioning allowed; **no** live provider/API inference calls, paid operations,
  credentials, settings, personal workspace, deployment or publication.
- Caps: 2 GiB of downloads, 20 min of build/test wall time, no sudo, no
  system-wide modification, no delegation, no merge.
- Result: ≈454 MiB downloaded (five public artifacts plus release-metadata
  reads), ≈1 min 12 s of compile, a few minutes of transcription. Caps
  respected, no retry loops.
- All artifacts live in an untracked scratch directory inside this worktree,
  excluded through the repository-local `info/exclude` (not a tracked file). No
  model, binary or audio file is committed. Nothing outside the scratch directory
  and `/tmp` logs was written; no package was installed into the project.

## Host tooling (inventory only, nothing installed)

| Tool | Version | Used for |
|---|---|---|
| gcc/g++ | 13.3.0 | own whisper.cpp build |
| cmake | 4.4.0 | configure/build; configure took 1.9 s |
| make | 4.3 | generator |
| ffmpeg/ffprobe | 7.0.2 static (GPLv3 build, `libopus` present) | Opus encode/decode, duration probe |
| node | 26.13.0 | present, unused |
| uv | 0.11.6 | present, **unused** (deliberately: the point is to avoid it) |
| TTS | none available (no espeak/festival/flite/piper) | — used a real recorded clip instead |

Host: 4-core/8-thread low-power x86-64 laptop CPU, 7 GiB RAM. A subprocess
process-group kill, `bwrap --unshare-net` and `unshare -rn` were **not**
available to this unprivileged session (user namespaces/loopback setup denied),
so reproduction of a no-network namespace is left open; a syscall trace was used
instead (see T9).

## Artifacts (provenance, licence, size, checksum)

| Artifact | Source | Licence | Size | SHA-256 |
|---|---|---|---|---|
| `whisper.cpp` v1.9.5 source | `ggml-org/whisper.cpp` tag `v1.9.5` (codeload tarball) | MIT | 9,626,464 B | `ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720` |
| `whisper-bin-ubuntu-x64.tar.gz` | release `b5454` (nightly prerelease), Ubuntu 22.04 build | MIT | 10,364,195 B | `a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c` |
| `ggml-small-q5_1.bin` | `ggerganov/whisper.cpp` model repo | MIT (Whisper weights) | 190,085,487 B | `ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb` |
| `ggml-small-q8_0.bin` | same | MIT | 264,464,607 B | `49c8fb02b65e6049d5fa6c04f81f53b867b5ec9540406812c643f177317f779f` |
| `ggml-silero-v6.2.0.bin` | `ggml-org/whisper-vad` | model card in that repo (Silero VAD lineage) | 885,098 B | `2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987` |

Licences are per-artifact and not interchangeable: the engine is MIT, the weights
are MIT, the VAD model needs its own notice if it is ever shipped or downloaded by
an installer, and the host FFmpeg used here is a **GPLv3** build that the project
does not ship. A future `THIRD_PARTY_NOTICES.md` entry must list these separately,
not under one umbrella.

## Speech fixture (third-party, not committed, not bundled)

- Source clip: `samples/jfk.wav` from the whisper.cpp v1.9.5 source tree — 16 kHz
  mono PCM, 11.0 s, audible speech throughout. Upstream ships it as a
  public-domain US-government recording of the JFK inaugural address (the same
  clip OpenAI's Whisper uses in its test material); the repository distributing it
  is MIT-licensed. It is **not** redistributed by this project.
- Derived Telegram-shaped fixture: the same speech re-encoded to Ogg/Opus (48 kHz
  mono, 32 kbit/s) — 11.0 s, 44,215 B — to exercise the real voice-note container
  rather than a convenient WAV.
- Derived long fixture: the clip plus 0.35 s of silence, repeated nine times →
  102.15 s, then encoded to Ogg/Opus and decoded back, to test the 120 s envelope
  and real-time factor. This is one clip repeated, so it is a timing and mechanics
  fixture, **not** a quality corpus.
- Commands (run from the scratch directory; no secrets, no network):

```
ffmpeg -i jfk-source.wav -c:a libopus -b:a 32k -ar 48000 -ac 1 jfk-voice.oga
ffmpeg -i jfk-voice.oga -ar 16000 -ac 1 -c:a pcm_s16le jfk-canonical.wav
ffmpeg -i jfk-canonical.wav -f lavfi -i anullsrc=r=16000:cl=mono \
  -filter_complex "[1:a]atrim=0:0.35[g];[0:a][g]concat=n=2:v=0:a=1[a]" -map "[a]" seg.wav
ffmpeg -f concat -safe 0 -i list.txt -c copy long-src.wav     # 9 repetitions
ffmpeg -i long-src.wav -c:a libopus -b:a 32k -ar 48000 -ac 1 long-voice.oga
ffmpeg -i long-voice.oga -ar 16000 -ac 1 -c:a pcm_s16le long-canonical.wav
```

## Build (own) versus prebuilt (compiler-free)

- Own build: `cmake -B <temporary build dir> -DCMAKE_BUILD_TYPE=Release
  -DGGML_NATIVE=OFF -DWHISPER_BUILD_TESTS=OFF` then
  `cmake --build … --target whisper-cli`. That build directory was a separate
  temporary path outside the scratch tree and is not part of the repository.
  Clean configure+build: **1 min 12 s** wall, 2 min 56 s user. Output:
  `whisper-cli` 998,368 B plus shared `libwhisper`/`libggml*` (3.8 MB in `bin/`),
  which needs `LD_LIBRARY_PATH` because a local build does not install an rpath.
- Prebuilt nightly: 27 MB extracted, contains the CLI and per-microarchitecture
  `libggml-cpu-*.so` backends loaded from the sibling directory via `$ORIGIN`
  rpath. It ran with `LD_LIBRARY_PATH` explicitly unset — the compiler-free route
  works, but it is a **prerelease tag**, not a stable one, and it selects a CPU
  backend at runtime.

## Results

Own build (shared libs, `LD_LIBRARY_PATH` set), `-np -nt` (plain text only).
Every wall figure in this table is **engine only**: it excludes the duration
probe, the FFmpeg decode and (where applicable) VAD work, so it is not a
full-route latency figure.

| # | Input / flags | Outcome | Wall | Peak RSS |
|---|---|---|---|---|
| T1 | Ogg/Opus `.oga` directly, `-l en` | **exit 11**, no text: `failed to read audio data` | — | — |
| T2 | MP3 directly, `-l en` | correct transcript | — | — |
| T3 | `.oga` → ffmpeg → 16 kHz mono `pcm_s16le` WAV, `q5_1` | correct transcript (11.0 s audio) | 6.37 s | 474 MB |
| T4 | 102.15 s Ogg/Opus → ffmpeg → WAV, `q5_1` | 199 words, coherent | 36.82 s (RTF 0.360) | 571 MB |
| T5 | 15 s digital silence, no VAD, `q5_1` | 5 bytes: `" you"` (hallucination) | 12.88 s | 474 MB |
| T6 | jfk WAV, `-l auto` | correct transcript, language detected | — | — |
| T8 | 15 s silence, **Silero VAD** `--vad -vm …`, `q5_1` | **0 bytes**, no text | 0.24 s | 290 MB |
| T9 | jfk WAV under `strace -f -e trace=socket,connect,sendto,sendmsg` (own build only) | **0 network syscalls** | — | — |
| T10 | jfk WAV, `q8_0` | correct transcript | 12.41 s | 547 MB |
| T11 | 102.15 s fixture, `q8_0` | 198 words | 36.90 s (RTF 0.361) | 644 MB |
| T12 | jfk WAV, 4 pinned cores, two runs each | `q5_1` 8.98 s / 13.66 s; `q8_0` 17.45 s / 8.37 s | — | — |
| T13 | nonexistent model path | **exit 3** + usage text on stderr | — | — |
| T14 | 102.15 s fixture with `-d 5000` | 58 words processed, **exit 0** (truncated, not refused) | 11.03 s | 483 MB |
| T15 | raw 16 kHz `s16le` PCM on stdin (`-f -`) | **exit 11**, no text | — | — |
| T16 | WAV bytes on stdin (`-f -`) | exit 0, transcript | — | — |

Prebuilt nightly, `LD_LIBRARY_PATH` unset:

| # | Input | Outcome | Wall | Peak RSS |
|---|---|---|---|---|
| T17 | Ogg/Opus `.oga` directly | **exit 11**, same decode failure | — | — |
| T18 | jfk WAV, `q5_1` | correct transcript | 8.83 s | 475 MB |
| T19 | 102.15 s fixture, `q5_1` | 198 words | 40.49 s (RTF 0.396) | 571 MB |

`q5_1` vs `q8_0` on the same 102.15 s input produced 199 vs 198 words and differed
by a token (`you. Ask` vs `you. ask`); on that same 102.15 s fixture the prebuilt
build differed from the own build by a word. Same weights, different quantization
and different CPU backend selection — no bit-identical output claim is available
across tiers or builds. The short 11 s clip produced identical text on every
variant tried.

## Full-route measurement (probe + decode + VAD + engine)

The table above is engine-only. The implemented route was then measured as one
operation, using the real provisioned engine, model and VAD model through the
compiled transcriber with no stubs:

| Input | Outcome | Full-route wall |
|---|---|---|
| 11.0 s Ogg/Opus | text, 22 words | 11.75 s |
| 102.15 s Ogg/Opus | text, 204 words | 32.01 s (RTF 0.31) |
| 15 s digital silence | `empty` (VAD suppressed everything) | 0.30 s |
| 124.86 s Ogg/Opus | `too-large` refusal, no decode | <0.01 s |
| 11.0 s Ogg/Opus, model path missing | `unavailable` | 0.03 s |
| all five | no temporary directory left behind | — |

The full route is *not* slower than the engine-only runs above; it measured
faster on the same host at a later time, because those earlier runs were noisy
and unpinned. Neither set is a controlled comparison against the Python baseline,
which was never provisioned. The 180 s deadline covers probe, decode and
inference together — verified separately by a synthetic three-leg test where
three 1 s legs stop near the single 1.2 s deadline rather than at 3 s.

## What this establishes

1. The Opus gap is real for a default whisper.cpp build, independently of how it
   is built: both the own build and the upstream prebuilt fail on a genuine
   Ogg/Opus voice note (`exit 11`). Pre-decoding with FFmpeg to 16 kHz mono WAV is
   a working route, and it is the only Opus route this run exercised. The Python
   helper never had this problem because PyAV bundles FFmpeg, and it also enforces
   its own 20 MiB input cap. The adapter's download cap is `20 * 1024 * 1024`
   bytes; the new route re-applies that same cap to every caller.
2. The compiler-free route exists but is a rolling prerelease: the nightly
   `whisper-bin-ubuntu-x64` tarball runs without a compiler, without
   `LD_LIBRARY_PATH`, and transcribes correctly on this host.
3. Throughput fits the existing envelope on this modest CPU: engine-only
   ≈37–40 s and full-route 32.0 s for a 102 s clip with `small`, i.e. RTF
   ≈0.31–0.40 including model load, well inside the current 180 s timeout. Peak
   RSS 474–644 MB for the engine and ≈570 MB for the whole wrapper.
4. VAD is not optional for this design: without it, digital silence produced a
   phantom token; with the Silero VAD model the same input produced nothing in
   0.24 s. The Python baseline runs `vad_filter=True`, so parity requires VAD.
5. At least on this workload the engine performed no network syscalls, and the
   binary contains no downloader unless built with `WHISPER_CURL` (off by
   default). Combined with model paths being explicit, offline operation is
   plausible; a namespace-isolated run remains unverified.
6. The contract gaps are reproducible facts, not documentation lore: exit 4 is a
   grammar error, `-d` truncates and still succeeds, raw PCM is rejected, and a
   missing model is exit 3 with usage text on stderr.

## What this does not establish

- **No quality comparison against the shipped baseline.** faster-whisper was not
  provisioned (out of scope, and `uv` was deliberately unused), so there is no
  paired transcript, WER or latency figure for `small`/CTranslate2 `int8`. The
  correct transcript on one clean public-domain clip says the pipeline works, not
  that quality matches.
- **No corpus.** One speaker, one recording, repeated. No noise, accent, language
  mix, music, telephony narrowband, or real Telegram voice note.
- **No stable-version prebuilt.** Only the `b5454` nightly tarball was run;
  `v1.9.5` has no assets, so a stable pin means building from source.
- **No resident-engine measurement**: every figure includes a per-turn model load.
- **Timing on short audio is noisy** (8.4–17.5 s for the same 11 s file on 4
  pinned cores); medians on an idle machine are still required. Long-audio figures
  were stable across three independent runs (36.8–40.5 s).
- **No namespace-level offline proof** (user namespaces unavailable here), and no
  glibc/musl portability test of the prebuilt tarball beyond this host.
- No ONNX/transformers.js, sherpa-onnx, Node-addon or WASM path was installed or
  measured. Statements about their cost remain documentation-based.

## Verdict

**Go, conditional**, for whisper.cpp `whisper-cli` reached through FFmpeg
pre-decoding: every mechanical requirement the current design depends on was
demonstrated (Ogg/Opus input, correct speech, VAD, no-network behaviour, bounded
wall time and memory, offline after provisioning), and the compiler-free prebuilt
route exists. The conditions are (a) an operator-provisioned FFmpeg binary is an
accepted dependency, (b) a prerelease or self-built engine pin is accepted, and
(c) quality parity against the current baseline is still unmeasured. This branch
implements that route as an explicit opt-in and leaves the default untouched.

**No-go if** FFmpeg cannot be a second provisioned executable and the Node WASM
Opus route is not acceptable — in that case the Python helper stays, because PyAV
is what currently makes voice notes work.

## Implementation now in this branch (pending review)

One slice, no new architecture, and the default is untouched:

1. `src/media/transcription.ts` keeps the bounded `spawn`, process-group kill,
   settle-after-reap and outcome vocabulary; the shared child runner is used by
   both backends, and the CLI mapping is `1/2 → failed`, `3 → unavailable`,
   `4/10/11 → failed`, spawn `ENOENT → unavailable`.
2. Selection is explicit: `media.transcription.backend` is `"faster-whisper"`
   (default when absent) or `"whisper-cli"`, and `whisperCli` is required exactly
   when the latter is selected. An engine block without the matching backend is a
   configuration error, so no existing config changes behaviour.
3. The CLI route does `ffprobe` (early duration refusal) → `ffmpeg`
   (`-protocol_whitelist file`, 16 kHz mono `pcm_s16le`, `-fs` size fence) →
   `whisper-cli` (`--vad -vm <model> -np -nt -l <configured|auto>`), all under one
   deadline, with one private temporary WAV removed on every path.
4. `maxDurationSeconds` refuses; the decoded PCM size is a second fence so wrong
   metadata cannot smuggle an over-long file through; the 20 MiB input cap is
   enforced in the transcriber for direct callers as well.
5. Children get a small fixed environment (locale/temp keys); Hugging Face, `uv`
   and `LD_LIBRARY_PATH` are not inherited on the CLI route.
6. Provisioning is operator-explicit and checksum-pinned in `SETUP.md`; nothing is
   downloaded, built or discovered at message time, and there is no engine
   fallback.
7. Tests stay offline: stubbed `ffprobe`/`ffmpeg`/`whisper-cli` cover exit
   mapping, both refusal fences, the shared deadline, cancellation with kill-group
   cleanup, the stdout cap, environment isolation, config compatibility and the
   opt-in requirement. No live model runs in CI.
8. Model tier: `q5_1` (181 MiB) is documented as the default provisioning choice
   and `q8_0` (252 MiB) as the alternative; this run showed no throughput reason to
   prefer the larger tier, and quality was not compared with the baseline.

That is a behavioural addition behind the existing boundary plus docs and licence
entries — not a new subsystem, config hierarchy or provider registry. The
faster-whisper helper remains the default and the compatibility path.

## Sources (accessed 2026-10-30)

- whisper.cpp repository, v1.9.5 tag and model list: https://github.com/ggml-org/whisper.cpp
- CLI flags and documented `-d` semantics: https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/README.md
- CLI exit returns 3/4/10/11: https://github.com/ggml-org/whisper.cpp/blob/master/examples/cli/cli.cpp
- Audio decode path and FFmpeg fallback: https://github.com/ggml-org/whisper.cpp/blob/master/examples/common-whisper.cpp
- Nightly `b5454` release assets: https://github.com/ggml-org/whisper.cpp/releases/tag/b5454
- Release build recipe (Ubuntu 22.04, `$ORIGIN` rpath, dl backends): https://github.com/ggml-org/whisper.cpp/blob/master/.github/workflows/release.yml
- `ggml` model files and sizes: https://huggingface.co/ggerganov/whisper.cpp/tree/main
- Silero VAD model for whisper.cpp: https://huggingface.co/ggml-org/whisper-vad
- miniaudio decoding formats (WAV/FLAC/MP3): https://github.com/mackron/miniaudio
