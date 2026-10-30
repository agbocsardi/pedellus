# Third-party notices

## OpenClaw Telegram policy references

The Telegram adapter's shared bot-token flood deadline, yielding of replaceable
previews, detailed edit-not-modified handling, and polling/delivery cancellation
separation selectively adapt policies reviewed in the following OpenClaw files:

- Repository: https://github.com/openclaw/openclaw
- Source commit: `5f1d487758a8560d083fbbd07fc1cc4203b7def8`
- `extensions/telegram/src/account-throttler.ts`
- `extensions/telegram/src/network-errors.ts`
- `extensions/telegram/src/polling-session.ts`

The implementation was adapted to this package's Durable admission boundary and
grammY's typed API; no OpenClaw runtime, plugin SDK, queues, or files were copied.

MIT License

Copyright (c) 2026 OpenClaw Foundation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## croner

Calendar expression parsing and recurrence use croner 10.0.1, licensed under MIT.

The MIT License (MIT)

Copyright (c) 2015-2021 Hexagon <github.com/Hexagon>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## grammY

The Telegram API client dependency is grammY 1.46.0, licensed under MIT.

MIT License

Copyright (c) 2021-2024 KnorpelSenf

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## MCP client and Pi MCP tool adaptation

MCP transport, framing, request correlation, cancellation and stdio process-group
teardown come from `@earendil-works/pi-mcp` 1.4.0, licensed under MIT and used as
a pinned dependency. Its OAuth subset is not imported.

The MCP tool registration semantics in `src/mcp/` follow the MIT-licensed Pi
coding agent (repository https://github.com/earendil-works/pi,
`packages/coding-agent/src/extensions/mcp/tools.js`): the
`mcp__<server>__<tool>` sanitized name with a per-tool SHA-256 suffix when
sanitizing collides or the name exceeds the provider limit, and a
`CallToolResult`-shaped output schema so Code Mode scripts receive `content`,
`structuredContent` and `isError`. The code was written against
`@earendil-works/pi-durable`'s registration API rather than copied; no coding
agent session, storage, extension runtime or resource UI is imported.

MIT License

Copyright (c) Earendil Works

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## @juicesharp/rpiv-web-tools (adapted Brave contract)

The native `web_search` tool's Brave endpoint, request parameters, response
normalization, result-count bounds and model-facing framing were adapted from
`@juicesharp/rpiv-web-tools` 2.15.0 (`providers/brave.ts`, `web-tools.ts`). No Pi
host, slash-command, config-discovery or key-persistence code was copied. This
project adds its own Durable tool/hook wiring, fixed sanitized errors, body and
time bounds, and an independently written fetch security path (DNS validation
and pinning, redirect revalidation, private-address refusal). The reference's
generic fetch helper was not reused for shipping behavior.

MIT License

Copyright (c) 2026 juicesharp

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## htmlparser2

`web_fetch` HTML parsing uses htmlparser2 12.0.0, licensed under MIT.

Copyright 2010, 2011, Chris Winberry <chris@winberry.net>. All rights reserved.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to
deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
IN THE SOFTWARE.

## ipaddr.js

`web_fetch` address classification uses ipaddr.js 2.3.0, licensed under MIT.

Copyright (C) 2011-2017 whitequark <whitequark@whitequark.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

## htmlparser2 transitive dependencies

htmlparser2 12.0.0 installs `domhandler` 6.0.1, `domutils` 4.0.2,
`domelementtype` 3.0.0 and `entities` 8.1.0 (BSD-2-Clause) and
`dom-serializer` 3.1.1 (MIT). The BSD-2-Clause text below covers the four
BSD-2-Clause packages; `dom-serializer` is Copyright © 2022 The Cheerio
contributors under the MIT text already stated above.

Copyright (c) Felix Böhm
All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.

Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.

THIS IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Optional whisper.cpp transcription backend (not bundled)

The opt-in `media.transcription.backend: "whisper-cli"` route runs an
operator-provisioned engine. This repository does not ship, vendor or download
any of the following, and the MIT text above covers only the engine:

- **whisper.cpp** (`whisper-cli`), MIT — https://github.com/ggml-org/whisper.cpp.
  The engine directory must be provisioned by the operator, including its sibling
  `libggml*.so` backends.
- **Whisper `ggml` model weights** (`ggml-small-q5_1.bin`, `ggml-small-q8_0.bin`)
  from `ggerganov/whisper.cpp`, MIT (OpenAI Whisper weights) —
  https://huggingface.co/ggerganov/whisper.cpp.
- **Silero VAD `ggml` model** (`ggml-silero-v6.2.0.bin`) from
  `ggml-org/whisper-vad` — https://huggingface.co/ggml-org/whisper-vad. Required
  on this route; check that model repository's own terms before redistributing it.
- **FFmpeg / FFprobe**: not bundled and not redistributed. The operator supplies
  their own build, and its licence is whatever that build carries (a
  `libopus`-enabled static build is typically GPL). Nothing here changes the
  licence of the project or of FFmpeg.

Test speech used during local validation is not part of this repository either:
it is a public-domain US-government recording shipped with whisper.cpp's own
samples, kept out of version control.
