# mend

One patch tool for every AI edit format: unified diffs (with wrong line
numbers), SEARCH/REPLACE blocks, V4A patches, and JSON tool-call edits.
Applies a patch to the tree in the working directory — every file or none.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`PATCH` is a patch file, or `-` / absent for standard input. `--format` picks
one format (`auto` by default, which detects it). `--check` prints what would
change without writing anything. `--strict` matches lines exactly.

See `SPEC.md` for the full contract. Node 22, standard library only.
`runner.ts` is the kit's trial runner, kept as-is.
