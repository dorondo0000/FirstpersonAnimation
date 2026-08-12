# Firstperson Animation

**Author first-person item animations in Blockbench and bake them into a plain vanilla resource pack.** Built for servers.

Minecraft 26.1 snapshot 11 added a `transformation` field to items model definitions, and `minecraft:range_dispatch` can read `minecraft:cooldown` (1.0 → 0.0). Put those together and **the vanilla item cooldown becomes the animation playhead**.

## The server contract is three things

```
minecraft:item_model      which model definition to use
minecraft:custom_data     which animation — one string under one key
a vanilla item cooldown   the playhead
```

**No base-item requirement** — any item works. No datapack, no commands. Nothing is written under `assets/minecraft`.

One caveat worth knowing up front: cooldowns are keyed by **item type** unless the stack carries a `use_cooldown` component with a `group`. Without one, a stick-based weapon shares its cooldown — and therefore its animation — with every other stick on the server. The generated Skript sets a group of `<ns>:<item>`; the component is there for that alone, never to trigger anything.

```skript
function fpa_pistol_fire(p: player):
    set {_i} to {_p}'s tool
    set string tag "{@anim}" of custom nbt of {_i} to "fire"
    set {_p}'s tool to {_i}
    set item cooldown of {_i} for {_p} to 8 ticks
```

The export ships that Skript file alongside the pack — one function to give the weapon, one to toggle the cooldown display, one per animation to play it.

---

## Layout

```
FirstpersonAnimation/
├─ plugin/firstperson_animation.js   the Blockbench plugin (single file)
├─ examples/
│  ├─ fpa_examples/                  ready-made pack (+ .sk), drop it in resourcepacks/
│  ├─ bbmodel/                       sources to open in Blockbench
│  └─ cooldown_hider/                core-shader sub-pack — optional, separate pack
├─ tools/
│  ├─ make_examples.mjs              example generator = reference implementation
│  ├─ make_cooldown_hider.ps1        patches gui.fsh out of your own client jar
│  ├─ cooldown_discard.glsl          snippet for patching by hand
│  └─ diagnose.js                    paste into Blockbench's DevTools console
└─ docs/
   ├─ output-format.md               every file the exporter writes
   └─ clocks.md                      why cooldown, and the 20 fps ceiling
```

## Usage

1. `File > Plugins > Load Plugin from File` → `plugin/firstperson_animation.js`
2. `File > New > Firstperson Animation`
3. **One group = one bone = one model file.** Make a group per moving part and put its cubes inside
4. In `Display` mode set up `First person right hand`. **Point the model down −Z** (muzzle at low z)
5. `Shift + F` (or the timeline toolbar button) aims the viewport at the **in-game first-person framing**. Animate against that. `Shift + G` for the off hand
6. Animate in `Animate` mode
   - **the animation name is the string you put in `custom_data`**
   - **make the last keyframe the rest pose** — with no cooldown running, the last frame is what you see
7. `File > Export > Firstperson Animation Settings...` → namespace and item name
8. `File > Export > Export Firstperson Animation Pack` → a zip holding the pack, `<ns>_<item>.sk`, and a README

After updating the plugin, **restart Blockbench and reopen the project**. Reloading a plugin deletes the old `ModelFormat` object while an open project still points at it, and the animation UI stops responding.

---

## How it works

### The cooldown is the playhead

`minecraft:cooldown` returns the **remaining** cooldown: 1.0 the instant it is applied, 0.0 when it expires.

- progress is `1 - cooldown`, so frame 0 is the moment of use and **the last frame is the idle pose**
- `range_dispatch` picks the last entry whose threshold is ≤ the value, so threshold `j/N` maps to frame `N-1-j`
- **playback length = cooldown length.** The same pack runs at different speeds per item

### 20 fps is the engine ceiling

`Cooldown.get()` hands `getCooldownPercent` a partial tick of exactly **`0.0F`** — `fconst_0` in the bytecode of 26.1.2, 26.2 and 26.3 alike. The value is a **staircase** with `cooldown ticks + 1` steps, not a ramp.

Three independent confirmations:

1. **Bytecode**, three versions
2. **In-game probe** — 180 entries over a 60-tick cooldown with a 3-pose cycle. Under quantisation only multiples of 3 are reachable, all mapping to the neutral pose, so the item must sit perfectly still. It did
3. **Frame counting a 60 fps capture** — 26 of 90 frames changed (29% ≈ 1/3). Per-render-frame updates would be ~100%

**To get more frames, lengthen the cooldown, not the entry list.** The exporter sizes the frame budget as `ticks + 1` automatically.

Perceived choppiness is set by **change per step**, not by fps. 6°/step reads as smooth; 22°/step reads as steppy.

### One dispatch per bone

The naive shape is `range_dispatch → composite(every bone)`, costing **frames × bones**. Giving each bone its own dispatch costs only the number of distinct poses that bone actually takes.

- consecutive identical frames collapse into one entry
- a bone that never moves collapses to a plain `minecraft:model`
- geometry is stored **once per bone**, never duplicated per frame

Measured on the example pack: **121 → 55 nodes (55% saved)**.

### Animation switching is nested `custom_data` conditions

The `select` form of `minecraft:component` compares the whole compound, so it is unusable here. The **condition** form runs a `DataComponentPredicate`, which matches **partially** — the server can keep anything else it likes in `custom_data`.

```json
{ "type": "minecraft:condition", "property": "minecraft:component",
  "predicate": "minecraft:custom_data",
  "value": { "fpa": "fire" },
  "on_true":  { "…fire…": "" },
  "on_false": { "…next animation, ultimately the rest pose…": "" } }
```

`predicate` holds the **predicate type id as a string** and the match data lives in `value` (`ComponentMatches.MAP_CODEC = DataComponentPredicate.singleCodec("predicate")`). No key, or a name nothing matches, falls through to the rest pose.

### Cooldown bar

Reproduces the hotbar overlay as a merged model. Straight from `GuiGraphicsExtractor`:

```java
if (f > 0.0F) {
    int top    = y + Mth.floor(16.0F * (1.0F - f));
    int bottom = top + Mth.ceil(16.0F * f);
    fill(RenderPipelines.GUI, x, top, x + 16, bottom, 0x7FFFFFFF);
}
```

White at alpha 127/255, bottom aligned, height `ceil(16f)` **pixels** — 17 possible looks and no others, which is why there is nothing to configure beyond on/off and the `custom_data` key. Partial alpha on item textures works fine. Verified against `ceil(16f)` on every reachable value of five cooldown durations: 221 checked, 0 mismatches.

Vanilla still draws its own overlay on top. Removing that needs a **separate** pack, because it has to live under `assets/minecraft`:

```powershell
.\tools\make_cooldown_hider.ps1 -Jar "…\minecraft-26.3-snapshot-5-client.jar"
```

It pulls the vanilla `gui.fsh` out of your own client jar and inserts a discard for `0x7FFFFFFF`. No guessed shader is ever shipped — a core shader that fails to compile takes the whole GUI with it.

---

## Measured against the 26.3 client jar

| Item | Result | Evidence |
|---|---|---|
| `transformation` pivot | **block corner (0,0,0), translation in blocks** | `black_shulker_box.json` matches `ShulkerBoxRenderer`'s PoseStack ops to four decimals |
| `transformation` fields | **all four are mandatory** | omit one and the whole item fails with `No key right_rotation in MapLike[...]` |
| `pack.mcmeta` | past format 64, `min_format`/`max_format` are **required** | without them nothing loads and every model is the missing texture |
| 20 fps clock ceiling | **confirmed** | `fconst_0` across three versions + in-game probe + video frame counting |
| Frame budget | **cooldown ticks + 1**, not the timeline | `getCooldownPercent`'s denominator is `endTime - startTime` |
| `custom_data` condition | `predicate` (string) + `value`, **partial match** | `singleCodec("predicate")` = `dispatchMap`, `Single` uses `fieldOf("value")`; parses in game |
| Partial alpha on item textures | **works** | in game. An inference from jar structure said otherwise and was wrong |
| Off-hand mirroring | `translation.x` / `rotation.y` / `rotation.z` negated, frame x at −0.56 | `ItemTransform.apply` / `ItemInHandRenderer` |
| Cooldown overlay | white `0x7FFFFFFF`, height `ceil(16f)` px | `GuiGraphicsExtractor` |

## Limits

- **No interpolation.** Frames are baked. The whole `client/renderer/item` package contains zero `lerp`, and the property interface `get(ItemStack, ClientLevel, ItemOwner, int)` has no partial-tick parameter at all
- **No shear.** Non-uniform scale on a rotated bone cannot be expressed; the exporter warns
- **One cooldown per `cooldown_group`.** Two animations cannot run at once on the same group
- **26.1+ only** — `transformation` does not exist before that

## Related work

[rieyi/display-anim-preview](https://github.com/rieyi/display-anim-preview) solves the same problem the other way: it bakes whole geometry per frame, routes on `custom_model_data`, and drives the index from a datapack tick loop. That buys arbitrary per-frame geometry and works before 26.1, at the cost of duplicated geometry, a −16..32 coordinate limit, and an `item modify` every tick per player. Both approaches hit the same 20 fps ceiling, for different reasons.
