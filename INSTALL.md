# Installing cs-tracer

`cs-tracer` is a single static binary with no runtime dependencies. The viewer it writes is compiled
into it, so nothing else has to be on the machine: no Node, no browser engine, no configuration
file. Get the binary, put it on your PATH, and run it. Then read the [README](README.md) for what to
do with it, and [MANUAL.md](MANUAL.md) for the full surface.

## 1. Install the binary

Three routes. Take the first one that fits your machine.

### Download a release

Grab the archive for your OS and architecture (`cs-tracer_<version>_<os>_<arch>.tar.gz`) together
with `checksums.txt`, check it, then install:

```bash
sha256sum -c --ignore-missing checksums.txt      # releases are checksummed and cosign-signed
tar xzf cs-tracer_*.tar.gz cs-tracer
install -m755 cs-tracer ~/.local/bin/cs-tracer   # anywhere on your PATH
```

To verify the signature over the checksum file as well:

```bash
cosign verify-blob checksums.txt \
  --signature checksums.txt.sig --certificate checksums.txt.pem \
  --certificate-identity-regexp 'https://github.com/codesweep-ai/tracer/.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

**No version has been tagged yet, so there is nothing on the releases page today.** This route
starts working at the first tag, which is what cuts the archives, the checksum file and the
signature. Until then, take one of the two below.

### Or with `go install`

```bash
go install github.com/codesweep-ai/tracer/cmd/cs-tracer@latest
```

The binary lands in `$(go env GOBIN)`, or in `$(go env GOPATH)/bin` when that is unset. This route
builds from source, so it needs the Go toolchain, and it stamps no version: `cs-tracer version`
prints `dev`.

### Or build from source

Needs **Go 1.26 or newer**. The viewer's compiled assets are committed, so a clone with no Node
toolchain still builds a complete binary:

```bash
git clone https://github.com/codesweep-ai/tracer && cd tracer
make build         # -> bin/cs-tracer, version-stamped from `git describe`
make install       # -> ~/.local/bin/cs-tracer (override with PREFIX=)
```

**`make build` rebuilds the viewer whenever `npm` is on your PATH.** It runs `npm ci` and the Vite
builds before the Go build, so on that path you also need **Node 20 or newer** and a network
connection for `npm ci`. Skip that work and embed the committed artifacts instead:

```bash
make -o viewer build      # treat the viewer target as already up to date
```

Both routes produce the same binary from a clean checkout. Rebuild the viewer when you edit its
sources under `apps/viewer`, which [CONTRIBUTING.md](CONTRIBUTING.md) covers.

**Use `make build` rather than a plain `go build`.** The version is injected at link time, and the
Go linker silently ignores an injection naming a symbol that does not exist. A plain `go build`
therefore produces a working binary that reports its version as `dev`.

`make install` says where it put the file, and warns when that directory is not on your PATH:

```console
$ make install PREFIX=/tmp/demo
install -m 0755 bin/cs-tracer /tmp/demo/bin/cs-tracer
installed /tmp/demo/bin/cs-tracer (a1cb275-dirty)
note: add /tmp/demo/bin to PATH
```

`make uninstall` removes it again, and `make help` lists every target.

## 2. Verify the installation

First, check that the binary runs and knows its own version:

```console
$ cs-tracer version
a1cb275-dirty
```

A tagged build prints the tag. A source build from an untagged clone prints what `git describe`
gives, and `go install` prints `dev`.

Now build a page. Make a two-line session to work on, so the check needs no real transcript:

```bash
mkdir -p /tmp/demo-session
cat > /tmp/demo-session/session.jsonl <<'EOF'
{"type":"user","uuid":"a1","sessionId":"demo","timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":"say hello"}}
{"type":"assistant","uuid":"a2","parentUuid":"a1","sessionId":"demo","timestamp":"2026-01-01T00:00:02.000Z","message":{"id":"m1","role":"assistant","model":"claude-sonnet-4","content":[{"type":"text","text":"Hello."}],"usage":{"input_tokens":12,"output_tokens":3}}}
EOF
```

Export it. The size line goes to stderr on every run, and the confirmation to stdout:

```console
$ cs-tracer /tmp/demo-session -o /tmp/demo.html
/tmp/demo.html will be … KB (1 traces, 2 events)
wrote /tmp/demo.html (… KB) in 0.0s
```

The size is elided because it is mostly the compiled viewer, and it moves whenever the viewer does.

Open `/tmp/demo.html` in a browser. You should see one trajectory with two events, and the page
should work with no network connection, because everything it needs is inside the file.

The normalized JSON behind that page is one command away:

```console
$ cs-tracer normalize /tmp/demo-session 2>/dev/null | head -c 200
{"schemaVersion":2,"meta":{"source":"claude-code","sessionId":"demo","model":"claude-sonnet-4","startedAt":"2026-01-01T00:00:00.000Z","endedAt":"2026-01-01T00:00:02.000Z","durationMs":2000,"autoTitle"
```

Remove the two paths with `rm -r /tmp/demo-session /tmp/demo.html`, then point the tool at a real
session. [MANUAL.md](MANUAL.md#files) says where each supported CLI keeps its own, and
`cs-tracer manual` prints that reference from inside the binary.

## Where the output goes

`cs-tracer` writes to the destination you name with `-o`, and nowhere else. With no `-o` it writes
into the current directory under a name taken from the input. It never writes beside the input,
because a session directory belongs to another tool and holds live state.

Nothing is cached, no state is kept between runs, and no configuration file is read or created. The
only other path the tool touches is one scratch directory under `$TMPDIR`, which the run removes
before it exits. Uninstalling is deleting the binary.

## Moving to a newer version

Repeat whichever route you used. Each one puts a new binary in place:

```bash
go install github.com/codesweep-ai/tracer/cmd/cs-tracer@latest     # or
git pull && make install
```

An exported page carries the schema version it was written with, and the viewer inside it refuses a
document it does not implement. A page exported by an older `cs-tracer` therefore keeps working,
because it carries its own viewer. Re-export from the session when you want a newer one.
