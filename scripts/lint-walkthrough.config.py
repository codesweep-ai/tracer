# Project-specific knobs for scripts/lint-walkthrough.py.
#
# The linter beside this file carries no project knowledge and is meant to stay
# byte-identical everywhere it lands. This file is the half you edit.

TOOL = "cs-tracer"
TOOL_PATH = "bin/cs-tracer"

DOCS = ["README.md", "INSTALL.md", "MANUAL.md", "SPEC.md", "CONTRIBUTING.md"]
EXTRA_DOCS = []

# cs-tracer reads no variable of its own. TMPDIR is the one path it touches
# outside the destination, and MANUAL.md's Environment section says so.
ENV_PREFIX = "CS_TRACER_"

ENV_INTERNAL = {}

SOURCE_SKIP = {}

# Read-only, offline, and safe to run on every gate. An export writes a page,
# so no export verb belongs here.
SAFE_VERBS = ["version"]

SAMPLE_SKIP = {
    "cs-tracer version": "the sample is a git describe of one build, and"
                         " INSTALL.md says every build reads differently",
}

# MANUAL.md and the README both use a session directory the reader supplies.
PLACEHOLDER_OK = ["/my-project"]

PREREQ_OK = []

AGENT_SECTION = "Notes for agents"

ALLOW = {}
