# Third-party notices

## BermTheSequel/ns2jb2 (not included)

<https://gitlab.com/BermTheSequel/ns2jb2>, pinned at `fc2a2932ec77e31715dbb6616bf04e942f21079b`, by BermTheSequel. It is based on [kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb).

At that revision the repository has no licence file. This project therefore redistributes none of its files. `baseline.json` lists SHA-256 digests only. `patches/` holds unified diffs of our changes to six of its modules, with the minimal surrounding context needed to apply them. `install.cjs` applies them to a checkout you obtain from the authors. Your use of the host is subject to its authors' terms.

## dougchansan/ns2-savekit (MIT)

<https://github.com/dougchansan/ns2-savekit> at `700814ff37fa8f11f12e77b65dc8a33d421e8dd1`, by dougchansan and contributors.

- `backup/vendor/save-attr.cjs` and `backup/vendor/save-tree.cjs` are unmodified copies of `tools/lib/save-attr.cjs` and `tools/lib/save-tree.cjs`.
- `tests/upstream/tools/` holds unmodified copies of `pull-inventory.cjs`, `save-inventory.cjs`, `save-pull-root.cjs` and `lib/{save-attr,save-tree,titles}.cjs`. They are used only by the offline fixture to reproduce the old behavior.

Both directories carry the upstream MIT licence (`backup/vendor/LICENSE.txt`, `tests/upstream/LICENSE.txt`):

> MIT License. Copyright (c) 2026 dougchansan.

## switchbrew/libnx (reference only)

<https://github.com/switchbrew/libnx> at `b156b4774fb2df7b93402169509266da7547fc4c` was consulted for `FsSaveDataInfo`, `SaveDataAttribute`, HIPC/CMIF layout and FS commands 53 and 61. No libnx code is included.

## Nintendo Switch 2, SmileBASIC 4, games

The project is not affiliated with or endorsed by Nintendo, SmileBoom or any game publisher. It includes no keys, firmware, system files, game code, game assets or save data. The offline tests use only invented identifiers and synthetic bytes. The ACNH application ID in `backup/cli.cjs` is a public title identifier, used only to put that title first.
