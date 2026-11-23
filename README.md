# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tailduck76-cyber/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/tailduck76-cyber/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format. `mend` applies an edit that an AI
model wrote to a tree of text files, in four formats: a unified diff (often
with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and
text-editor tool calls as JSON. Every file is changed or nothing is.

Built for the [make.fun bounty "Build mend, one patch tool for every AI edit format"](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is the path of the patch file, relative to the working directory; when
it is absent or `-`, the patch is read from standard input. `--format` names
one format (`unified`, `search-replace`, `v4a`, `json`); `auto`, the default,
detects it. `--check` does everything but write. `--strict` matches lines
exactly. `SPEC.md` in the kit is the whole contract; see the make.fun bounty
"Build mend, one patch tool for every AI edit format" for the checks.

Node 22 and its standard library alone; nothing is installed.
