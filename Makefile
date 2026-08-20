# cs-tracer — build/test/install.
# `make build` produces bin/cs-tracer (version-stamped, CGO_ENABLED=0), with the
# viewer's two Vite builds ordered strictly before it so //go:embed can reach the
# artifacts. `make check` runs every gate; `make test` runs Go tests only.
# Follows the cs-ledger Makefile conventions.

CS_LINT    ?= cs-lint
BIN        := bin/cs-tracer
PKG        := ./cmd/cs-tracer
PREFIX     ?= $(HOME)/.local
VERSION    := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
# The -X path names the module path exactly: the Go linker SILENTLY ignores an
# -X naming a symbol that does not exist, so a wrong path builds fine and ships
# an empty version. `make check-version` is the only real verification.
LDFLAGS    := -s -w -X github.com/codesweep-ai/tracer/internal/cli.version=$(VERSION)
GO_FILES   := $(shell git ls-files '*.go')
VIEWER_OUT := internal/cli/viewer

# Coverage is not a separate mode: the test target below writes Go binary
# coverage data into its own tier directory under $(COVERDIR), and `make
# coverage` merges whichever tiers are present. Separate tier directories are
# what would let a second tier aggregate with this one rather than overwrite
# it. scripts/coverage.sh documents the layout.
# -test.gocoverdir must be absolute: `go test` runs each package's test binary
# with that package's directory as its working directory, so a relative path
# would scatter the data one directory per package.
COVERDIR   ?= .coverage
COVER_ABS  := $(abspath $(COVERDIR))
# node_modules/flatted ships Go under a directory `go list ./...` walks like any
# other, so -coverpkg=./... would instrument a vendored JavaScript dependency
# and mix its statements into this repo's number. Naming the packages instead
# also makes the number the same on a machine that has run `npm ci` and one that
# has not. Recursive `=`, so `go list` runs only for the targets that use it.
COVERPKG    = $(shell go list ./... | grep -v '/node_modules/' | paste -sd, -)
COVERFLAGS  = -covermode=atomic -coverpkg=$(COVERPKG)

GORELEASER ?= goreleaser

.PHONY: help build viewer viewer-build test coverage coverage-check coverage-baseline check check-version vet fmt fmt-check docs oss walkthrough cs-lint-installed lint deadcode install uninstall snapshot release release-check clean

.DEFAULT_GOAL := help

## help: list available targets (this menu)
help:
	@echo "cs-tracer make targets:"
	@grep -E '^## [a-z][a-z0-9-]*: ' $(MAKEFILE_LIST) | sed -E 's/^## ([^:]+): (.*)/  \1|\2/' | column -t -s '|'
	@echo ""
	@echo "  PREFIX=$(PREFIX) (install location; override with make install PREFIX=/usr/local)"

# The viewer build is ordered STRICTLY before build: //go:embed needs the
# artifacts inside the module tree at compile time.
#
# Both Vite builds AND their byte-level assertions run on every build, with no
# stamp file short-circuiting them. An earlier stamp-based version had no
# prerequisites and could silently retain STALE embedded assets — producing a
# binary that passed every gate while shipping an old viewer. Do not reintroduce
# a stamp here without prerequisites that actually track the viewer sources.
#
# The artifacts under internal/cli/viewer are COMMITTED, so a clone with no Node
# toolchain still builds the binary. They are rebuilt from apps/viewer wherever
# npm is available; the design system it imports is vendored under vendor/, so
# no second checkout is involved.
viewer:
ifeq ($(and $(wildcard apps/viewer/package.json),$(shell command -v npm 2>/dev/null)),)
	@test -f $(VIEWER_OUT)/single/index.html -a -f $(VIEWER_OUT)/split/index.html \
		-a -f $(VIEWER_OUT)/split/assets/app.js -a -f $(VIEWER_OUT)/split/assets/app.css \
		|| { echo "the embedded viewer artifacts are missing, and the sources cannot be built here" >&2; exit 1; }
	@echo "viewer: building from the committed artifacts under $(VIEWER_OUT)"
else
	$(MAKE) viewer-build
endif

## viewer-build: run both Vite builds and assert the artifact constraints
viewer-build:
	npm ci
	npm run build:single --workspace apps/viewer
	npm run build:split --workspace apps/viewer
	npm run assert:builds --workspace apps/viewer

## build: host binary at bin/cs-tracer (use this, never plain `go build`)
build: viewer
	@mkdir -p $(dir $(BIN))
	CGO_ENABLED=0 go build -trimpath -ldflags '$(LDFLAGS)' -o $(BIN) $(PKG)

## test: Go tests only — NOT the full suite. Use `make check` before pushing.
test: viewer
	@scripts/coverage.sh reset unit
	go test $(COVERFLAGS) ./... -args -test.gocoverdir=$(COVER_ABS)/unit

## coverage: merge every tier present under $(COVERDIR) and print the report
coverage:
	@scripts/coverage.sh report

## coverage-check: report, then fail if a package .coverage-baseline records as
## covered has stopped being reached. It checks presence, never a percentage:
## what it exists to catch is a suite that quietly stopped running.
coverage-check: coverage
	@scripts/coverage.sh check

## coverage-baseline: re-record .coverage-baseline. Records every tier present
## by default; pass BASELINE_TIERS to restrict it to the tiers CI actually runs,
## e.g. `make coverage-baseline BASELINE_TIERS="unit race smoke"`. Recording a
## tier CI never runs commits a promise nothing keeps.
coverage-baseline:
	@scripts/coverage.sh baseline $(BASELINE_TIERS)

## check: the full local gate — every check CI runs (scripts/check.sh)
check:
	@scripts/check.sh

## check-version: assert the binary's stamp equals git describe
check-version: build
	@test "$(shell $(BIN) version)" = "$(VERSION)" \
		|| { echo "version mismatch: binary says '$$($(BIN) version)', git says '$(VERSION)'" >&2; exit 1; }
	@echo "version OK: $(VERSION)"

## vet: go vet
vet:
	go vet ./...

## fmt: gofmt all tracked Go files
fmt:
	gofmt -w $(GO_FILES)

## fmt-check: fail if any Go file is unformatted
fmt-check:
	@unformatted="$$(gofmt -l $(GO_FILES))"; \
	if [ -n "$$unformatted" ]; then \
		echo "These files are not gofmt-formatted:"; \
		echo "$$unformatted"; \
		exit 1; \
	fi

## docs: the prose rules from CONTRIBUTING.md, over every doc in the set
docs: cs-lint-installed
	$(CS_LINT) docs

## oss: check that this repo is in a shape it can be published in
oss: cs-lint-installed
	$(CS_LINT) oss

## walkthrough: check the docs against the binary, the code and the build
walkthrough: build cs-lint-installed
	$(CS_LINT) walkthrough

# The three targets above are one shared tool: github.com/codesweep-ai/lint.
# Its knobs for this repo live in .cs-lint.yaml, and `cs-lint <linter> --explain`
# says what each rule wants.
cs-lint-installed:
	@command -v $(CS_LINT) >/dev/null 2>&1 || { \
		echo "cs-lint is not installed: go install github.com/codesweep-ai/lint/cmd/cs-lint@latest" >&2; \
		exit 2; \
	}

## lint: golangci-lint (if installed)
## lint: the Go rules from .golangci.yml (see that file for what is on and why)
## node_modules is excluded for the same reason as deadcode below: flatted ships
## a Go port beside its JavaScript, and linting somebody else's vendored code
## reports findings nobody here can fix. The exclusion belongs at this call and
## not in .golangci.yml, which stays byte-identical across the family. Bare
## `golangci-lint run` looked clean only because CI installs node_modules AFTER
## this gate runs — every contributor who had built once saw the failure.
lint:
	@command -v golangci-lint >/dev/null 2>&1 || { \
		echo "golangci-lint is not installed; see https://golangci-lint.run/welcome/install/" >&2; \
		exit 2; \
	}
	@golangci-lint run $$(go list -f '{{.Dir}}' ./... | grep -v /node_modules/)

## deadcode: functions no entry point reaches. golangci-lint's `unused` cannot
## see this — it reasons one package at a time, so a function whose only caller
## lives in another package looks used. node_modules is excluded: flatted ships
## a Go port beside its JavaScript, and nothing here was ever meant to call it.
deadcode:
	@command -v deadcode >/dev/null 2>&1 || { \
		echo "deadcode is not installed: go install golang.org/x/tools/cmd/deadcode@latest" >&2; \
		exit 2; \
	}
	@pkgs="$$(go list ./... | grep -v /node_modules/)"; \
	out="$$(deadcode -test $$pkgs)"; \
	if [ -n "$$out" ]; then echo "$$out"; exit 1; fi

## install: copy bin/cs-tracer into $(PREFIX)/bin (default ~/.local/bin)
install: build
	@mkdir -p $(PREFIX)/bin
	install -m 0755 $(BIN) $(PREFIX)/bin/cs-tracer
	@echo "installed $(PREFIX)/bin/cs-tracer ($(VERSION))"
	@case ":$(PATH):" in *":$(PREFIX)/bin:"*) : ;; *) echo "note: add $(PREFIX)/bin to PATH" ;; esac

## uninstall: remove the installed binary
uninstall:
	rm -f $(PREFIX)/bin/cs-tracer

## snapshot: local release dry-run into dist/ (all platforms, archives, checksums).
## Skips SBOM + cosign signing (those need cyclonedx-gomod + cosign; run in CI/release).
snapshot:
	VERSION='$(VERSION)' $(GORELEASER) release --snapshot --clean --skip=sbom,sign

## release: tagged release (needs a pushed git tag + credentials). For a full
## signed+SBOM release install: go install github.com/CycloneDX/cyclonedx-gomod/cmd/cyclonedx-gomod@latest and cosign.
release:
	$(GORELEASER) release --clean

## release-check: validate .goreleaser.yaml
release-check:
	$(GORELEASER) check

## clean: remove build output
clean:
	rm -rf bin dist $(COVERDIR)
