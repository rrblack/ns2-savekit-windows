# ns2-savekit-windows

A read-only Switch 2 save exporter for Windows 11. It plugs into the BermTheSequel/ns2jb2 SmileBASIC host. You supply your own checkout of that host, and the installer builds a **new** copy with six small reviewed changes and a dedicated backup client.

- The exporter reads each archive from the console's save-data index (`OpenSaveDataInfoReader`, cmd 61). It opens each archive with **read-only FS command 53** using its exact attributes and full UID, and copies the logical files to the PC. It never calls savekit's write, restore, delete, launcher, `--keep-open` or system open (cmd 52) paths.
- **The exploit host is not read-only.** ns2jb2 writes and commits temporary data on SmileBASIC's *own* filesystem while it acquires and releases its session. On a demo build with no `tmp` mount, this includes the SmileBASIC save. Only the backup step is read-only. A zero-write console run is outside what this host can do.
- This repository contains **none of the host's files**. `patches/` holds unified diffs against the pinned revision. `install.cjs` checks your checkout byte for byte, applies the diffs strictly, and checks each result against `overlays.json` before writing anything.

## Tested hardware result

A Windows 11 user running Node 24.13.0 with the Japanese SmileBASIC 4 Demo 4.4.6 used the reviewed build on an actual Switch 2. The run listed 175 archives and verified 110. The Animal Crossing: New Horizons device archive verified with 89 files and 43,988,390 bytes. Exit 2 recorded coverage gaps. This shows that real exports work with that build. Restoring saves to the console, and other hardware, firmware or SmileBASIC configurations, have not been tested.

This repository changes only how the reviewed build is delivered. The installer reproduces the six reviewed host modules byte for byte (`overlays.json` holds their SHA-256), and the backup client and tests are the reviewed files. The runtime behavior is the build that was tested on hardware.

## Requirements

| Item | Version |
| --- | --- |
| Windows | 11 (Linux works for the offline tests) |
| Node.js | 24 (hardware run used 24.13.0). No npm packages are installed. |
| Host | [BermTheSequel/ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2) at `fc2a2932ec77e31715dbb6616bf04e942f21079b`, in its own folder |
| Console | Switch 2 with SmileBASIC 4. Japanese Demo 4.4.6 is the tested configuration. |

Get the host at the pinned commit as a ZIP: <https://gitlab.com/BermTheSequel/ns2jb2/-/archive/fc2a2932ec77e31715dbb6616bf04e942f21079b/ns2jb2-fc2a2932ec77e31715dbb6616bf04e942f21079b.zip>. Extract it, and extract this repository's ZIP from GitHub too. If you clone either one with git, turn off line-ending conversion first (`git config --global core.autocrlf false`). Otherwise the hash checks will refuse the files.

## Install and test offline

Run this from any folder. The first path is the extracted host, the second is a new destination that must not exist yet:

```powershell
node C:\Switch2\ns2-savekit-windows-main\install.cjs C:\Switch2\ns2jb2-fc2a2932ec77e31715dbb6616bf04e942f21079b "C:\Switch2\ns2jb2 savekit"
```

The installer:

1. Checks the SHA-256 of all 103 host runtime files against `baseline.json`. A mismatch means you have a different revision or converted line endings. Keep that checkout for comparison and get the pinned one.
2. Applies the six patches with no fuzz and checks each result against `overlays.json`.
3. Claims the destination with an exclusive `mkdir`, copies the host and the patched modules into it, and adds `backup\` and `backup-tests\`.
4. Syntax-checks every module and runs the offline fixture (simulated console, real host bridge, real named pipe on Windows). It prints **OFFLINE PASS** only if that fixture passes.

**If the destination already exists**, the installer stops without touching it. An existing destination is never adopted or replaced. Pick another new sibling, such as `"C:\Switch2\ns2jb2 savekit 2"`, and use that path in every later command. If the installer fails after creating the folder, don't launch that copy. Delete it, or keep it for diagnosis, and install to a fresh path.

The installer doesn't run PowerShell scripts, change execution policy, install packages or contact the console. Your original checkout is only read.

To rerun only the offline fixture against an installed copy:

```powershell
node "C:\Switch2\ns2jb2 savekit\backup-tests\check.cjs" C:\Switch2\ns2jb2-fc2a2932ec77e31715dbb6616bf04e942f21079b "C:\Switch2\ns2jb2 savekit"
```

The commands below use only built-in cmdlets and avoid PowerShell 7-only syntax. Set the paths once in each window:

```powershell
$installed = 'C:\Switch2\ns2jb2 savekit'
```

## Start one held run (first window)

1. Use a wired network for the PC and the console, as the host README advises. Start a fresh SmileBASIC in Direct mode and load the host's bootstrap as the host README describes. For the demo's saved text variable, that is `PRGEDIT 0:LOADV "TXT:NS2" OUT C$:PRGSET C$`.
2. In the first PowerShell window, start the host with your PC's Ethernet IPv4 address:

   ```powershell
   Set-Location -LiteralPath $installed
   node .\backup\host.cjs 192.0.2.10
   ```

3. Enter the same three Direct-mode commands the host uses, with your PC's address in `START`. An out-of-memory reply to `REMOVE` is expected.

   ```basic
   RUN
   REMOVE NSR,&H60000000,&H3FFFFFFF
   V=START(39380,192,0,2,10)
   ```

4. Wait for the host's **4/4 verified** message saying the RPC and FS endpoint are still live. Copy the printed run folder. Keep SmileBASIC and this window open.

The startup cleanup in this copy won't delete anything it didn't create. The stock host deletes every pre-existing `NS2_GAP*` entry. This copy stops instead if the SmileBASIC save already holds `NS2_GAP*`, or `main`/`main.npdm` when there is no `tmp` mount and the donor uses that save. It also refuses to remove a stale donor-name file from the application save. If either guard stops the run, keep the run logs and inspect the save. Run one backup client at a time. Each client takes an exclusive lock on the run, and the stock savekit and diagnostic tools would otherwise compete for the same session.

## Inventory and export (second window)

```powershell
$installed = 'C:\Switch2\ns2jb2 savekit'
Set-Location -LiteralPath $installed
$run = (Read-Host 'Paste the full run folder path from the first window').Trim().Trim('"')
$out = Join-Path $env:USERPROFILE ('Switch2-Backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
node .\rpc.cjs "$run" status
if ($LASTEXITCODE -ne 0) { throw 'RPC status failed' }
node .\backup\cli.cjs inventory "$run" "$out"
if ($LASTEXITCODE -ne 0) { throw 'Inventory stopped. Inspect the error and run logs.' }
node .\backup\cli.cjs export "$run" "$out"
$exportExit = $LASTEXITCODE
Write-Host "Export exit $exportExit. Snapshot $out"
```

Each `inventory` writes a new snapshot folder and never reuses an existing one. Before any native call, the client checks several things. The run must come from this installed engine (source digest and per-module hashes). The held, restored execution proof must be present. Every recorded session ID must match. The promoted pid-1 root proof, bridge readiness, and the retained worker's idle state must all check out.

Inventory reads the save index in spaces 1, 4, 0, 2, 3, 100, 101 and 102 and keeps all 96 raw bytes of each record. It decodes the record as documented: static ID at `0x20`, application ID at `0x28`, index (u16) at `0x38`, rank (u8) at `0x3a`. A refused space is reported separately, and its row count is unknown.

Export makes one cmd 53 attempt for each unique inventory identity. ACNH comes first, then other device and account saves. All-zero UIDs, nonzero cache indices and ranks are kept. Two kinds of rows get no open and are recorded as unsupported: a tuple that matches more than one record (cmd 53 opens by attributes, not by dynamic ID), and a record with an unknown type or rank, or with both application and static ID zero. Each archive is staged under `.partial-…`. The client checks short reads and writes, uses the console-computed chunk hashes, then reopens and rehashes the PC files before promoting the folder to `space-N-id-N`. An uncertain transport error blocks every later native call on that run (`backup-stop.txt`). There is no automatic retry.

Files appear in `space-N-id-N\data` under their game paths where Windows can represent them. `manifest.json` maps reserved names, case collisions and long paths to `escaped\` and records original directory names, empty directories included. Keep each snapshot folder together.

## Finish the host

After the export command returns, type **finish** and press Enter in the **first** window. This calls the original runner's release handler, and its child retires the FS endpoint. If a backup client still holds the lock, finish waits. Keep SmileBASIC open until the runner prints **Original instructions restored and scratch cleaned up**, then restart the console as the runner instructs. If cleanup reports an error, keep the run folder and its logs.

To read the local evidence of release:

```powershell
$r = Get-Content -Raw -LiteralPath (Join-Path $run 'result.json') | ConvertFrom-Json
[pscustomobject]@{ Verified=$r.verified; Restored=$r.fs.restored; CleanedUp=$r.fs.cleanup.cleanedUp; RPC=$r.rpc.state; Error=$r.error; CleanupErrors=$r.cleanupErrors }
```

Expect `True` for Verified, Restored and CleanedUp, `closed` for RPC, and no errors.

## Verify offline

Verification needs no console. It rehashes every file and checks sizes, archive identity, and missing or extra files and directories, including in empty archives.

```powershell
node .\backup\cli.cjs verify "$out"
$v = Get-Content -Raw -LiteralPath (Join-Path $out 'verification.json') | ConvertFrom-Json
$v | Select-Object listed,verified
$v.unavailableSpaces | Format-Table
$v.rows | Where-Object { $_.state -notin @('verified','verified-empty') } |
  Format-Table applicationId,space,type,id,state,error,stage -AutoSize
```

| State | Meaning |
| --- | --- |
| `verified` | Every listed file and directory passed the local checks. |
| `verified-empty` | The archive opened and holds zero files. An empty row alone holds no game data. |
| `refused` | The index listed the archive, and the read-only open returned the recorded code. `0xe02` is the running app's locked save. |
| `partial` | At least one file or directory could not be read fully. The staging manifest lists them. |
| `unsupported` | The record could not be addressed uniquely or has unknown attributes. |
| `pending`, `in-progress`, `stopped`, `invalid` | No complete verified backup for this row. Check its error, stage folder and the run logs. |
| `unavailableSpaces` | The index reader was refused or didn't finish for that space. How many rows are missing is unknown. |

### Exit codes (`export` and `verify`)

| Code | Meaning |
| --- | --- |
| 0 | Every listed archive verified, at least one was listed, and no space was unavailable. |
| 2 | Coverage gap: some rows are refused, partial, unsupported or unverified, or a space was unavailable. Successful rows are still valid. |
| 1 | Stopped: the run, lock, inventory or transport failed. `verify` can still report finished archives if inventory and progress were written. A stopped inventory keeps `inventory.partial.json`. |

For ACNH (`0x01006f8002326000`), look for a **nonempty, verified** device archive (type 3). An empty or unreadable row alone is not an island backup. These are logical archive contents. Save metadata outside the mounted filesystem, and restoring to hardware, have not been validated.

## Continuing interrupted work

Running `export` again in the same held run rechecks archives that already finished and tries rows that were never attempted. It skips recorded refusals and failures. On a later boot of **the same console**, run `inventory` into a new folder and `export` normally. If the games haven't been played since, you can carry forward verified archives from an earlier snapshot:

```powershell
$prior = (Read-Host 'Full path of the previous snapshot from this console').Trim().Trim('"')
node .\backup\cli.cjs export "$run" "$out" --carry-from "$prior"
```

Carry-forward requires a matching nonzero account UID across both inventories, identical raw records, and successful rehashing before and after copying. Matching records can't detect a game that changed data in place, so use a fresh export when you need current bytes.

## Repository contents

| Path | What |
| --- | --- |
| `install.cjs` | Hash-checked installer and strict patch applier |
| `baseline.json` | SHA-256 of the 103 pinned host runtime files |
| `patches/`, `overlays.json` | Six host changes as unified diffs and the expected SHA-256 of each result. [docs/REVIEW.md](docs/REVIEW.md) explains each one. |
| `backup/` | Exporter: `cli.cjs` (inventory/export/verify), `live.cjs` (run checks, lock, index reader), `archive.cjs` (cmd 53 pull, offline verify), `host.cjs` (held-run front end with `finish`) |
| `backup/vendor/` | `save-attr.cjs` and `save-tree.cjs` from dougchansan/ns2-savekit, unmodified, MIT |
| `tests/` | Offline fixture run by the installer |
| `tests/upstream/` | Unmodified ns2-savekit tools at `700814ff`, used only to reproduce the **old** wrong-UID behavior. These are not part of the exporter. |

## Tests

| Evidence | Where it came from |
| --- | --- |
| 780 legacy IPC packet comparisons, mixed-descriptor byte offsets, NCM filters, host-save collision guards, missing-tmp mount inspection, the pinned savekit CLI and child reproducing the old wrong-UID result, finish/lock handling, and an exporter run over seven synthetic archives (tampering, empty, partial, locked, carry-forward, stale run, transport failure) | `tests/check.cjs`, run by the installer. Rerun for this repository with Node 24.13.0 on Linux from a clean clone into a path with spaces. CI runs it on `ubuntu-latest` and `windows-latest` (Windows named pipe). |
| The six installed modules are byte-identical to the reviewed build. Apart from three added files under `backup-tests\` (`overlays.cjs`, `upstream\LICENSE.txt`, `upstream\README.md`), the whole installed tree matches the reviewed installer's output. | Checked when this repository was built |
| The host's own 28 tests (18 in `test.cjs`, 10 retained/layout) against a copy holding the six patched modules | Rerun for this repository with Node 24.13.0 on Linux. They need the host's `test.cjs`, which isn't redistributed: copy it into a scratch copy of an installed folder and run `node --test test.cjs`. |
| 59 checks across eight savekit test programs | Original offline review (see docs/REVIEW.md). Not rerun as part of this packaging. |
| Hardware export | See *Tested hardware result* above |

The line labeled **REPRODUCED upstream wrong-UID fallback** is a test of the pinned old savekit code, not of this exporter. The upstream fix is proposed in dougchansan/ns2-savekit.

## Credits and licence

- **BermTheSequel**: [ns2jb2](https://gitlab.com/BermTheSequel/ns2jb2), the Windows-capable SmileBASIC 4 / Demo 4.4.6 FS host this integrates with. It is built on [kurumuz/ns2jb](https://gitlab.com/kurumuz/ns2jb). This repository includes none of their files. Get the host from its authors and follow their terms.
- **dougchansan and ns2-savekit contributors**: [ns2-savekit](https://github.com/dougchansan/ns2-savekit). The attribute packer, tree walker and save-access approach this exporter reuses, and the stock tools in `tests/upstream/` (MIT).
- **switchbrew/libnx**: reference for the FS structures and CMIF layout.

Code written for this repository is under the MIT licence in [LICENSE](LICENSE). Third-party notices are in [NOTICE.md](NOTICE.md). The project isn't affiliated with Nintendo or SmileBoom. It contains no keys, firmware, game code, game assets or save data.
