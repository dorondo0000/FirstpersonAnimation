# Output format

Everything the exporter writes, and why it is shaped that way. `tools/make_examples.mjs` is a readable reference implementation of the same thing.

## Files

```
pack.mcmeta
assets/<ns>/items/<item>.json                          item model definition (entry point)
assets/<ns>/models/item/<item>/parts/<bone>.json       one per bone; geometry lives here once
assets/<ns>/models/item/<item>/cooldown_bar.json       optional
assets/<ns>/textures/item/<item>/<texture>.png
assets/<ns>/textures/item/<item>/_cooldown_overlay.png optional
<ns>_<item>.sk                                         Skript example (harmless inside a pack)
README.txt
```

Nothing lands under `assets/minecraft`. The core-shader sub-pack that hides the vanilla cooldown overlay is a separate pack for exactly that reason.

Every `parts/*.json` carries the **same `display` section**. Each layer of a composite uses the display transform from its own model file, so if they differ the bones drift apart.

## The tree

```
items/<item>.json
├─ hand_animation_on_swap: false
├─ swap_animation_scale: 0          the model identity changes every tick; without
│                                   this vanilla plays its equip bob on each change
└─ model: select  property=minecraft:display_context
   ├─ case ["firstperson_righthand","firstperson_lefthand"]
   │  └─ condition  property=minecraft:component
   │     │          predicate=minecraft:custom_data  value={<key>: "fire"}
   │     ├─ on_true  → composite
   │     │              ├─ model  parts/<bone that never moves>
   │     │              └─ range_dispatch  property=minecraft:cooldown   (per bone)
   │     │                 ├─ threshold 0        → rest pose
   │     │                 ├─ threshold 1/N      → frame N-2
   │     │                 ├─ …
   │     │                 └─ fallback           → rest pose
   │     └─ on_false → condition for the next animation … ultimately the rest pose
   ├─ case ["gui"]                  only when the cooldown bar is enabled
   │  └─ composite
   │     ├─ rest pose
   │     └─ condition  property=minecraft:component (custom_data <bar key>)
   │        ├─ on_true  → range_dispatch  property=minecraft:cooldown  (bar height)
   │        └─ on_false → empty
   └─ fallback → rest pose (ground / fixed / thirdperson / head …)
```

## The frame clock

`minecraft:cooldown` returns the **remaining** cooldown, 0.0–1.0: 1.0 when applied, 0.0 when it expires, 0.0 when there is none.

```
progress = 1 - cooldown
frame    = round(progress × (N-1))
```

`range_dispatch` picks the last entry whose threshold is ≤ the value, so for `j = 0..N-1` the exporter writes

```
threshold j/N   →   frame (N-1-j)
```

| cooldown | entry picked | frame |
|---|---|---|
| 1.0 (just used) | `(N-1)/N` | 0 |
| 0.5 | `⌊N/2⌋/N` | about N/2 |
| 0.0 (idle) | `0` | N-1 |

**That is why the last keyframe must be the rest pose.**

### How many frames are worth baking

Every clock resolves to an integer tick counter — checked in bytecode, not assumed:

```
Cooldown.get()    -> fconst_0 ; ItemCooldowns.getCooldownPercent(stack, 0.0F)
UseDuration.get() -> LivingEntity.getUseItemRemainingTicks():I ; i2f
```

So a D-tick playback only ever takes **D+1 distinct values**, and a dispatch with more entries than that contains entries the client can never select. The exporter sizes the budget as `ticks + 1` and warns when `Max frames` clips it.

The budget follows the **cooldown**, not the Blockbench timeline: `getCooldownPercent`'s denominator is `endTime - startTime`. Author a 1-second animation, hand out a 2-second cooldown, and you get 41 steps at half speed. Set `Playback ticks` when the two differ.

## Computing the transformation

Blockbench's scene and Minecraft model space differ by a constant translation. The exporter **measures** it instead of guessing: at the zero pose a root group's world position is its own pivot, in scene coordinates. With two or more root groups they cross-check each other, and a mismatch is reported.

```
zeroPose(b)  = bone b's world matrix with every group rotation, scale and animation zeroed
Δ_scene(b,t) = pose(b,t) · zeroPose(b)⁻¹
Δ_model      = T(o) · Δ_scene · T(-o)
             → same 3×3, translation becomes t_model = t_scene + (I - A)·o
```

A group's rest rotation is absorbed into every frame's transformation by this, which is correct: a plain java model cannot express a rotated bone.

Model-space affine `v' = A·v + t_model` becomes a Minecraft `transformation` with

```
t = (A·pivot + t_model - pivot) / 16
```

`pivot` is the block corner `(0,0,0)` and the division converts model units (1/16 block) to blocks. **Confirmed against vanilla**: `black_shulker_box.json` carries exactly the PoseStack operations `ShulkerBoxRenderer` performs, to four decimals.

Output is always the decomposed form — all 68 vanilla item definitions that use `transformation` use it too, and the 16-float matrix form has no documented row/column-major convention.

```json
"transformation": {
  "translation":    [x, y, z],
  "left_rotation":  [qx, qy, qz, qw],
  "scale":          [sx, sy, sz],
  "right_rotation": [0, 0, 0, 1]
}
```

> ⚠️ **All four keys are mandatory.** Omit an identity one and the client rejects the entire item:
> ```
> Couldn't parse item model 'fpa:minimal': No key right_rotation in MapLike[{…}]
> ```
> Vanilla spelling out `left_rotation:[0,0,0,1]` everywhere is a requirement, not a style. (Measured on 26.3-snapshot-5.)

The `transformation` **field itself** is optional, so it is dropped entirely when the whole thing is the identity. `right_rotation` always ships as the identity: it is only needed for shear, and shear cannot be represented anyway — the exporter warns when a bone produces one.

## Size

Cost is the number of distinct poses each bone takes, not frames × bones.

Frame counts are `ticks + 1` because anything beyond that is a dead entry. The example `pistol` — fire 9 frames + reload 29 frames over 3 bones — comes to 55 nodes where the naive shape would be 121. Two mechanisms do that work:

- geometry is written **once per bone**, never duplicated per frame
- a bone that holds still collapses those frames into a single entry, and one that never moves collapses to a plain model reference with no dispatch

## Item components

```
minecraft:item_model    = "<ns>:<item>"
minecraft:custom_data   = { "<anim key>": "<animation name>", "<bar key>": true }
minecraft:use_cooldown  = { "cooldown_group": "<ns>:<item>", "seconds": … }
```

plus a vanilla item cooldown, set by the server. No base item is required and nothing has to make a use action succeed.

`use_cooldown` is carried **for its group only**. `ItemCooldowns` keys a cooldown by `cooldown_group` when the stack has one and by the **item type** otherwise, so without a group every stick on the server would share this weapon's cooldown and play its animation. `seconds` is required by the component but only ever fires if the base item happens to be usable; the server sets the cooldown explicitly regardless.

The `custom_data` checks are real `DataComponentPredicate`s, so they match **partially**: anything else the server keeps in `custom_data` is ignored, and omitting a key simply means "off".

Cooldown length sets playback speed. Handing out a different length than the authored one is a **feature**, not a bug — it is how one pack gives several items different speeds.
