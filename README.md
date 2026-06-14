# Rasaec's Q.O.L.

A quality-of-life module for **Pathfinder 2E** and **Starfinder 2E** on Foundry VTT. Designed to keep combat flowing by putting the right buttons in front of the right people at the right time.

---

## Features

### 1 — Auto-Clear Targets on Turn End
When a token you own ends its turn in combat, all of your current targets are automatically cleared. No more manually untargeting between turns.

### 2 — Per-Target Damage Tray
Every damage roll chat card gets a tray appended below it with one row per targeted token. Each row has five buttons:

| Button | Effect |
|--------|--------|
| **½** | Half damage (basic save success / resistance) |
| **×1** | Full damage |
| **×2** | Double damage (critical hit) |
| **🛡** | Toggle Shield Block (reduces damage by shield hardness) |
| **♥** | Apply as healing |

All damage routes through the system's full typed-damage and IWR (immunities / weaknesses / resistances) pipeline — no re-implementation. HP totals are visible to the GM only.

### 3 — AoE Template Target Picker
When a measured template is placed on the canvas, a dialog lists every visible token in the affected area with checkboxes so you can confirm who is actually hit. Features:

- **All / None** quick-select buttons
- Tokens already targeted are pre-checked
- Hidden tokens shown to GM with an *(hidden)* tag, invisible to players
- **Duration field (rounds):** set how many rounds the template lasts; it is automatically deleted at the end of the appropriate combatant's turn. `0` = expires at the end of the current turn.

### 4 — Per-Target Saving Throw Buttons
After AoE targets are confirmed, save buttons are injected into the originating spell/item chat card — one row per target showing the save type and DC. Clicking a button rolls through PF2E's full save pipeline, including all active conditions and modifiers. Enemy saves are forwarded to the GM client automatically.

---

## Compatibility

| Software | Version |
|----------|---------|
| Foundry VTT | 11 – 14 (verified 14) |
| Pathfinder 2E system | 6.x – 8.x |
| Starfinder 2E system | 1.x |

---

## Installation

**Method 1 — Manifest URL** *(once listed on the package repository)*

Paste the manifest URL into Foundry's **Add-on Modules → Install Module** dialog.

**Method 2 — Manual**

1. Download the latest release zip from the [Releases](../../releases) page.
2. Extract the folder into your Foundry `Data/modules/` directory so the path reads `Data/modules/rasaecs-qol/module.json`.
3. Restart Foundry and enable the module in your world's **Manage Modules** settings.

---

## Usage Notes

- **Damage tray:** buttons are disabled for tokens you don't own; unowned enemy tokens are forwarded to the GM via socket.
- **AoE picker:** only appears for the user who placed the template. On other clients, targets are synced automatically.
- **Save tray:** appears on spell/item cast cards that have a saving throw. If you cast without targets set, confirm targets via the AoE picker first — the tray re-injects itself after you confirm.
- The module adds no settings UI — everything works out of the box.

---

## Known Limitations / Planned Work

- Vitality Network support for SF2E Mystics (in progress)

---

## License

This module is released for personal and community use. See [LICENSE](LICENSE) if present, or contact the author.

---

*Created by Rasaec*
