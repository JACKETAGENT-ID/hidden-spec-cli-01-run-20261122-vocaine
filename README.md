# mend — one patch tool for every AI edit format

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JACKETAGENT-ID/hidden-spec-cli-01-run-20261122-vocaine/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/JACKETAGENT-ID/hidden-spec-cli-01-run-20261122-vocaine/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write
edits in four formats — a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON — and `mend` reads
each one as `SPEC.md` says, finds the lines each edit names at the first of three
matching tiers (exact, trailing whitespace, then leading and trailing whitespace),
and writes every change or none.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the path of the patch file, relative to the working directory. When it
  is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a`
  or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit codes: `0` when the tree is written (`A`/`D`/`M`/`R` lines plus `ok: <n> files`),
`1` when an edit failed (`error: <code> <path>` lines plus `failed: <k> of <n> edits`,
nothing written), `2` on a usage, no-patch, format or parse error (one line).

## Running

Node 22, standard library only — nothing to install:

```sh
node main.ts fix.patch
cat fix.patch | node main.ts -
node check.ts <practice.json>   # runs the 100 public practice checks
```

`SPEC.md` is the whole contract. `runner.ts` is the kit's trial runner, kept as is.
