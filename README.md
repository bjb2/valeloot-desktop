# ValeLoot Desktop

ValeLoot Desktop is a Windows and Linux x64 desktop loot ledger for **Spirit
Vale**. It passively observes the game's inventory traffic through Npcap on
Windows or libpcap on Linux, applies local ValeLoot rules, and plays local alert
sounds for new matching drops.

![ValeLoot Desktop filter editor and live bag](docs/valeloot-desktop.png)

## Install and run

### Windows

Requirements:

- Windows 10 or 11, x64
- [Npcap](https://npcap.com/#download), installed separately
- Spirit Vale

Download `ValeLoot-Desktop-<version>-windows-x64.exe` from the [latest
release](https://github.com/bjb2/valeloot-desktop/releases/latest) and run it.
Npcap is not bundled. Without Npcap, ValeLoot still opens its ledger and
settings but cannot observe inventory traffic.

### Linux

Requirements:

- x86-64 Linux with libpcap
- Spirit Vale running through Wine or Proton

For direct capture, download the `.deb` or `.rpm` release and install it with
your package manager:

```sh
sudo apt install ./ValeLoot-Desktop-<version>-linux-amd64.deb
# or
sudo dnf install ./ValeLoot-Desktop-<version>-linux-x86_64.rpm
```

The native package installs a root-owned Bun collector runtime with
`CAP_NET_RAW` and `CAP_NET_ADMIN`; run ValeLoot itself as your normal user.

The AppImage remains available for portable use, but AppImage files cannot
carry usable Linux file capabilities. AppImage users need FUSE plus a
distribution-configured `dumpcap` helper. Install your distribution's libpcap
and Wireshark/dumpcap packages, configure dumpcap for non-root packet capture,
then sign out and back in so the group change takes effect. On Debian or Ubuntu,
install `libpcap0.8` and `wireshark-common`, allow non-superusers to capture when
prompted, and add your account to the `wireshark` group. Run the AppImage as
your normal user; **do not run it with `sudo`.**

The app keeps settings and profiles in the operating system's application-data
directory. To keep data beside the executable or AppImage, place an empty
`.valeloot-portable` file beside it. Alert history is kept only for the current
app session.
Verbose diagnostics are written to the folder shown under **Settings →
Diagnostic logs**. `desktop.log` records Electron and renderer lifecycle events;
`collector.log` records capture status, target and connection changes, warnings,
errors, and shutdown. Each log rotates at 5 MiB and retains one previous file.


Start ValeLoot before starting Spirit Vale when possible, so capture observes
the session setup as well as inventory updates.

Custom alert sounds are loaded from the folder shown under **Settings →
Available sounds**. Drop a `.wav` file there; it appears automatically without
a restart. Reference it as `Sound filename` or `Sound filename.wav`. Filenames
may use letters, numbers, dots, underscores, and hyphens; built-in names remain
reserved.

## Rules guide

ValeLoot uses an ordered, text-based filter: **the first matching rule wins**.
Rules only change presentation inside ValeLoot—colour, tag, emphasis, and alert
sound. They never modify, move, sell, dismantle, or otherwise act on an item.

### Start with the shipped filter

A fresh installation creates its `Default` profile from the focused
[28-rule starter ruleset](docs/starter-ruleset.txt). It separates artifacts,
physical damage, magic damage, defence, magic defence, and general high rolls
into visible tiers. Existing settings and profiles are never replaced.

The release also includes `starter-ruleset.txt`. To restore or customize it:

1. Open `starter-ruleset.txt`.
2. Copy its contents into **Filters → Rules · text**.
3. Save it to the current profile, or create a profile first and save there.
4. Select an item in the bag to inspect the winning rule and each condition.

### Rule structure

```text
# Comments start with #
Threshold 90

Show "Great AGI kunais"
    Name       Kunai
    Type       Dagger
    Stat       Agi >= 3
    AvgRollPct >= 70
    Tag        KEEP
    Color      #4ade80
    Highlight  glow
    Background fill
    Border     off
    Sound      chime

Hide "Low-roll leftovers"
    AvgRollPct < 35
    HighRolls  < 1
```

`Show` presents a matching item. `Hide` claims it without drawing a match or
playing a sound. Put narrow, valuable rules first and broad fallback rules
last. An item that reaches no rule remains unmarked.

Indentation makes lines part of the preceding `Show` or `Hide` block.
Blank lines are optional. A `#` starts a comment except when it is the
six-digit value in `Color #rrggbb`. Comparisons support `<`, `<=`, `=`, `>=`,
and `>`.

ValeLoot refuses to save a filter containing an invalid line. It rejects the
whole affected block rather than silently dropping a condition and making the
rule broader than intended.

### File-level directive

| Syntax | Meaning |
|---|---|
| `Threshold 90` | Whole percentage from 1–100 used by `HighRolls`. The default is 90. |

`TopRolls` is independent of `Threshold`: it counts lines at the stat's
maximum displayed value. `HighRolls` counts raw roll percentages at or above
the configured threshold.

### Item conditions

Conditions in the same block are combined with **AND** unless a stat grouping
keyword says otherwise.

| Syntax | Meaning |
|---|---|
| `Name Kunai, "Master Sword"` | Case-insensitive name substring; any listed value may match. |
| `Type Dagger, Sword` | Any listed item type may match. |
| `Stat Agi >= 3` | Match the displayed stat value, such as `+3 AGI`. |
| `Stat Agi >= 90%` | Match the stat's roll quality rather than its displayed value. |
| `RequireStat Vit >= 3` | Require a stat without including it in `StatMatches`. |
| `AvgRollPct >= 70` | Compare the item's whole-number average roll percentage. `AvgRoll` is an alias. |
| `TopRolls >= 3` | Compare the number of lines at their displayed maximum. |
| `HighRolls >= 3` | Compare the number of raw rolls meeting `Threshold`. |
| `Refine >= 5` | Require at least the specified refine level. |
| `SharedStats >= 2` | Require this many stats shared with equipped gear. |
| `Favorite` / `NotFavorite` | Match the in-game favourite flag. British `Favourite` spellings also work. |
| `Chaos` / `NoChaos` | Match whether the item has a Chaos effect. |
| `OverRoll` / `NoOverRoll` | Match whether a line exceeds its normal maximum. |
| `Unknown` / `Known` | Match whether the catalog recognizes the item. |
| `Verdict upgrade, sidegrade` | Match equipment comparison results: `upgrade`, `better-rolls`, `sidegrade`, or `worse`. |

`Type` uses the names shown by ValeLoot. Current equipment types are
`Accessory`, `Axe`, `Back`, `Book`, `Bow`, `Chest`, `Dagger`, `Eyewear`,
`Feet`, `GatlingGun`, `Grimoire`, `Head`, `Katar`, `Launcher`, `Legs`, `Mace`,
`Pistol`, `Rifle`, `Scythe`, `Shield`, `Shotgun`, `Spear`, `Sword`,
`Twinblade`, and `Wand`; artifact rules use `Artifact`.

Stat names are case-insensitive. The item inspector shows the canonical name.
The friendly aliases `AttackSpeed`, `AttackSpeedLimit`, `CastSpeed`,
`AutoAttackChain`, `MagicDamage`, `MeleeDamage`, `RangedDamage`,
`Multistrike`, `HealthLeech`, and `MovementSpeed` are also accepted.

### Combining stat conditions

Ordinary `Stat` lines require every listed stat by default:

```text
Show "STR and VIT"
    Stat Str >= 3
    Stat Vit >= 3
```

Use `AnyStat` to require any ordinary `Stat` line, or `StatMatches` to count
how many match:

```text
Show "Two useful attack stats"
    Stat Atk >= 3
    Stat Crit >= 5
    Stat Hit >= 10
    StatMatches >= 2
```

`AllStats` explicitly restores the default all-stat behavior. Do not combine
`AnyStat` or `AllStats` with `StatMatches`.

`AnyOf` creates a nested OR group. Every separate `AnyOf` group must produce
one match, while other conditions remain required:

```text
Show "Physical and magic hybrid"
    AnyOf
        Stat Atk >= 3
        Stat DamageMelee >= 5
    AnyOf
        Stat Matk >= 3
        Stat DamageMagic >= 5
```

Only indented `Stat` lines may appear inside `AnyOf`.

### Presentation directives

Presentation directives belong on `Show` rules. A `Hide` rule cannot display
or play them.

| Syntax | Values and behavior |
|---|---|
| `Tag KEEP` | Short label shown on the item; limited to 12 characters. |
| `Color #4ade80` | Six-digit RGB colour used by the tag, border, and background. |
| `Highlight dot` | Quiet colour/tag treatment. |
| `Highlight mark` | Adds the keep mark. |
| `Highlight glow` | Adds animated emphasis. |
| `Background border` | Colour the border only; this is the default. |
| `Background fill` | Add a solid full-cell background. |
| `Background holo` | Add the animated holographic background. |
| `Border on` / `Border off` | Keep or remove the selection frame. |
| `Sound chime` | Play `blip`, `chime`, `ding`, `alert`, `thud`, or a custom WAV name on arrival. |

Only newly observed items generate sounds. Repainting an existing bag after a
rule edit does not replay alerts. When several matching items arrive in one
inventory update, ValeLoot plays one winning sound rather than all of them.

### Safe catch-all

A conditionless `Hide` would silence the whole bag, so ValeLoot accepts it only
when deliberately named `everything`:

```text
Hide "everything"
```

Keep that rule last. It is the final line of the shipped starter filter.

## Privacy and game boundary

ValeLoot is a passive, local-only companion:

- It observes packets through the installed Npcap driver on Windows or
  libpcap/dumpcap on Linux; it never writes packets or sends game traffic.
- It decodes only the inventory information needed for the local ledger and
  rule alerts; it does not retain raw packets.
- It does not upload captured data, account identifiers, character details,
  installation paths, or inventory data. Its backend binds only to
  `127.0.0.1`.
- It does not use BepInEx, injection, game-memory access, automation, or game
  file modification.

The app deliberately does **not** recolor in-game item cells or add in-game
tooltips. ValeLoot's rule colors and inspection live in its own desktop ledger,
leaving the Spirit Vale client untouched.

## Build from source

Use a clean x64 checkout with Bun 1.4 or newer:

```text
bun run setup
bun run check
bun run package:win      # Windows host
bun run package:linux    # Linux host
```

`setup` installs the pinned Bun dependencies. `check` runs the TypeScript
checks and test suite. Packaging must run on the target operating system
because each artifact embeds that platform's Bun collector runtime.

The package commands write:

```text
dist/ValeLoot-Desktop-<version>-windows-x64.exe
dist/ValeLoot-Desktop-<version>-linux-x86_64.AppImage
dist/ValeLoot-Desktop-<version>-linux-amd64.deb
dist/ValeLoot-Desktop-<version>-linux-x86_64.rpm
```

### Useful commands

```text
bun run dev             Prepare and launch an Electron development window
bun run build           Build the renderer, collector, and Electron shell
bun run check           Run TypeScript checks and tests
bun run package:win     Build the Windows x64 portable executable
bun run package:linux   Build the Linux x64 AppImage, DEB, and RPM
```

Generated `build/`, `dist/`, and installed dependencies are ignored by Git.

## Licensing and source

ValeLoot Desktop is licensed under the GNU Affero General Public License,
version 3 or later. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Each release
publishes the application Corresponding Source, exact dependency manifest and
lockfile, and build scripts; see [SOURCE-OFFER.txt](SOURCE-OFFER.txt). Npcap,
libpcap, and dumpcap are separately licensed system dependencies and are not
included.
