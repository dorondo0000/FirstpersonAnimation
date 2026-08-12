# Firstperson Animation

Blockbench plugin. Bakes a first-person item animation into a plain vanilla resource pack for Minecraft Java **26.1+**. No mod, no datapack.

`File > Plugins > Load Plugin from File` → `plugin/firstperson_animation.js`, then `File > New > Firstperson Animation`. One group is one bone. Set the first-person display transform, animate, and `File > Export > Export Firstperson Animation Pack`. `Shift + F` aims the viewport at the in-game framing. The exported zip holds the pack and a ready-to-use Skript file.

## How it works

26.1 snapshot 11 added a `transformation` field to items model definitions, and `minecraft:range_dispatch` can read `minecraft:cooldown`. So **the vanilla item cooldown is the playhead**.

`minecraft:cooldown` returns the *remaining* cooldown, 1.0 → 0.0. Progress is `1 - cooldown`, so frame 0 is the moment of use and the last frame is what you see while idle — **author the last keyframe as the rest pose**. Playback length is simply the cooldown length, so one pack drives different items at different speeds.

Geometry is written **once per bone** and moved by a per-frame `transformation`; nothing is duplicated per frame. Each bone also gets its own dispatch, so it costs only the number of distinct poses that bone actually takes rather than frames × bones — 121 → 55 nodes on the example rig.

The server sets three things on the stack and nothing else:

```
minecraft:item_model    which model definition to use
minecraft:custom_data   which animation — one string under one key
minecraft:use_cooldown  carried for its cooldown_group only
```

then starts a cooldown. Any item type works. Animations are switched by nested `minecraft:component` conditions on `custom_data`, which run a real `DataComponentPredicate` and therefore match **partially** — whatever else you keep in `custom_data` is ignored.

The `cooldown_group` is not optional in practice: `ItemCooldowns` keys a cooldown by group when the stack has one and by **item type** otherwise, so without it a stick-based weapon would share its cooldown, and its animation, with every other stick on the server.

```skript
function fpa_pistol_fire(p: player):
    set {_i} to {_p}'s tool
    set string tag "{@anim}" of custom nbt of {_i} to "fire"
    set {_p}'s tool to {_i}
    set item cooldown of {_i} for {_p} to 8 ticks
```

## Cooldown bar

**Most packs should leave this off.**

Driving the animation from a cooldown has a visible side effect: vanilla sweeps its hotbar overlay every time the animation plays. If that reads fine, do nothing — vanilla's overlay is already correct and is *smoother than the replacement*, because it gets a real partial tick while `minecraft:cooldown` is quantised to ticks.

Turn it on only if you want the sweep gone on weapons but kept on items where the cooldown is genuine. Two pieces:

**1. Hide vanilla's.** A core shader, which has to sit at the vanilla path `assets/minecraft/shaders/core/gui.fsh` — which is why it is a **separate pack** and not part of the export:

```powershell
.\tools\make_cooldown_hider.ps1 -Jar "…\minecraft-26.3-snapshot-5-client.jar"
```

It pulls the vanilla `gui.fsh` out of your own client jar and inserts a discard for `0x7FFFFFFF`. No guessed shader is ever shipped: one that fails to compile takes the whole GUI down with it. Regenerate it whenever you change Minecraft version.

Blast radius: this hides the overlay for **every** item in the game, ender pearls and food included.

**2. Put it back selectively.** The exported pack carries a merged model that redraws the overlay in the GUI context, switched on by a `custom_data` key. It reproduces `GuiGraphicsExtractor` exactly — white at `0x7FFFFFFF`, bottom aligned, height `ceil(16f)` pixels:

```java
if (f > 0.0F) {
    int top    = y + Mth.floor(16.0F * (1.0F - f));
    int bottom = top + Mth.ceil(16.0F * f);
    fill(RenderPipelines.GUI, x, top, x + 16, bottom, 0x7FFFFFFF);
}
```

That is 17 possible looks and no others, which is why there is nothing to configure beyond on/off and the key.

## Limits

**20 poses per second is a hard ceiling.** `Cooldown.get()` hands `getCooldownPercent` a partial tick of exactly `0.0F` — `fconst_0` in the bytecode of 26.1.2, 26.2 and 26.3 alike — so the value is a staircase with `cooldown ticks + 1` steps, not a ramp. Confirmed three ways: bytecode across three versions, an in-game probe (180 entries over a 60-tick cooldown, only every third reachable, item sat perfectly still), and frame-counting a 60 fps capture (26 of 90 frames changed, ≈ 1/3).

To get more frames, **lengthen the cooldown, not the entry list** — the exporter sizes the budget as `ticks + 1` automatically. Perceived choppiness is set by change per step, not by fps: 6°/step reads as smooth, 22°/step does not.

- **No interpolation.** The whole `client/renderer/item` package contains zero `lerp`, and the property interface `get(ItemStack, ClientLevel, ItemOwner, int)` has no partial-tick parameter at all
- **No shear.** Non-uniform scale on a rotated bone cannot be expressed; the exporter warns
- **One cooldown per `cooldown_group`** — two animations cannot overlap on the same group
- **26.1+ only**, since `transformation` does not exist before it

## Related work

[rieyi/display-anim-preview](https://github.com/rieyi/display-anim-preview) solves the same problem the other way: whole geometry baked per frame, routed on `custom_model_data`, index driven by a datapack tick loop. That buys arbitrary per-frame geometry and works before 26.1, at the cost of duplicated geometry, a −16..32 coordinate limit, and an `item modify` every tick per player. Both hit the same 20 fps ceiling, for different reasons.
