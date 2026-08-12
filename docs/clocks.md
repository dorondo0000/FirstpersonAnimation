# Playback clocks — why cooldown, and where the ceiling is

The numeric property a `range_dispatch` reads is the animation's playhead. This plugin implements exactly one of them, `minecraft:cooldown`. This page records why, and what the alternatives actually do — every claim here was read out of the 26.3-snapshot-5 client jar rather than inferred.

The complete list, straight from `RangeSelectItemModelProperties.class`:

```
bundle/fullness   compass   cooldown   count   crossbow/pull
custom_model_data   damage   time   use_cycle   use_duration
```

## There is no gametime

`minecraft:time` has three sources in the `Time$TimeSource` enum and no more:

```
daytime   moon_phase   random
```

So **there is no way to read a raw game-tick counter.** (`Time.class` does reference `getGameTime`, but that drives the wobbler's update check, not the source value.)

The closest thing to a free-running clock is `daytime`, whose period is **24000 ticks = 20 real minutes**. Usable for a slow idle, useless for an action.

`local_time` (a select property) looked promising too, but `LocalTime.class` carries `UPDATE_INTERVAL_MS` with `TimeUnit.SECONDS` — it refreshes **once per second**. Not a clock.

## The candidates

| Property | Value | Resolution | Trigger | Needs a server | Good for |
|---|---|---|---|---|---|
| **`cooldown`** | 1.0 → 0.0 (remaining) | tick (20 fps) | a successful item use, or `setCooldown` | ✗ | **one-shot actions** — fire, swing, reload |
| `use_duration` | ticks in use (↑) | tick (20 fps) | holding right click | ✗ | held actions — aiming, drawing a bow |
| `use_cycle` | sawtooth over `period` | tick | holding right click | ✗ | looping while in use |
| `time` (daytime) | 0.0 → 1.0 per 24000 ticks | tick | none, always running | ✗ | very slow idles |
| `custom_model_data` (floats) | anything you write | tick | **none — code writes it** | datapack or plugin | arbitrary scrubbing |
| `damage` / `count` | durability / stack size | — | server | ✓ | heavy side effects, avoid |
| `crossbow/pull` | 0.0 → 1.0 | tick | crossbows only | ✗ | crossbows |
| `compass` | needle angle | tick | — | ✗ | `wobble` gives a damped oscillation |
| `bundle/fullness` | 0.0 → 1.0 | — | — | ✗ | not a clock |

## Why cooldown

1. **Already normalised 0–1.** The other triggerable clocks return raw tick counts and need a `scale` divisor.
2. **Speed is data.** Playback length lives in the cooldown you hand out, so one pack drives several items at different speeds.
3. **The trigger is free.** A server calls `setCooldown` once; nothing runs per tick afterwards.

### Its real downsides

- **The item cannot be used while the cooldown runs.** For a gun that is exactly what you want; for a pure cosmetic animation it is a forced side effect.
- **One cooldown per `cooldown_group` per player.** Two animations cannot overlap on the same group.
- **Vanilla draws its hotbar overlay.** Hiding it needs the optional core-shader pack.

## 20 fps is a hard ceiling, on every clock

The property interface has no partial tick at all:

```java
RangeSelectItemModelProperty.get(ItemStack, ClientLevel, ItemOwner, int seed) -> float
```

and scanning every class under `client/renderer/item/properties/` turns up **no implementation that reaches a `DeltaTracker`**. The three that touch `Minecraft.getInstance()` are `ExtendedView`, `IsViewEntity` and `LocalTime`, none of them a clock.

Concretely, in bytecode:

```
Cooldown.get()    -> fconst_0 ; ItemCooldowns.getCooldownPercent(stack, 0.0F)
UseDuration.get() -> LivingEntity.getUseItemRemainingTicks():I ; i2f
UseCycle.get()    -> getUseItemRemainingTicks():I ; i2f ; frem
```

and the implementation it feeds:

```java
float f = endTime - startTime;
float g = endTime - (tickCount + partialTick);
return Mth.clamp(g / f, 0.0F, 1.0F);
```

`endTime`, `startTime` and `tickCount` are all **ints**, and `tickCount` advances once per `ItemCooldowns.tick()`. With the partial tick pinned to zero the result is `integer / D` — a **staircase with D+1 steps**, not a ramp. Packing entries between the steps does nothing, because the value never lands there.

The giveaway is that the same jar calls the same method the other way for the hotbar overlay:

```java
getCooldownPercent(stack, minecraft.getDeltaTracker().getGameTimeDeltaPartialTick(true))
```

Vanilla's own overlay is smooth. The item model property was deliberately handed a zero. The likely reason is render-state identity caching — `TrackingItemStackRenderState` collects `modelIdentityElements` and `RangeSelectItemModel.update()` appends to it, so a value that moved every frame would invalidate that cache every frame. That last part is inference; the staircase itself is not.

### Confirmed three ways

| Check | Result |
|---|---|
| Bytecode, 26.1.2 / 26.2 / 26.3 | `fconst_0` in all three |
| In-game probe | 180 entries over a 60-tick cooldown, poses cycling with period 3. Under quantisation only multiples of 3 are reachable, all neutral, so the item must sit perfectly still — and it did |
| Frame counting a 60 fps capture | 26 of 90 frames changed (29% ≈ 1/3). Per-render-frame updates would be ~100% |

### What you can actually do about it

Lengthen the cooldown. The denominator is `endTime - startTime`, so a longer playback has more steps:

```
1s cooldown = 20 ticks -> 21 frames
3s cooldown = 60 ticks -> 61 frames
```

Total frame count scales with duration; **poses per real-time second stays capped at 20.**

Perceived smoothness is set by change per step, not by fps. A spin covering 6° per step reads as smooth; the same 20 Hz covering 22° per step reads as steppy. Slowing the fast segments buys more than any amount of extra entries.

## Triggering without a right click

**No vanilla command sets an item cooldown.** There is no such command class anywhere under `net/minecraft/server/commands/`, and `ItemCooldowns.addCooldown()` is server-side Java only.

### Plugin (Paper / Spigot / Folia)

```java
player.setCooldown(itemStack, 8);   // 8 ticks = the 0.4s "fire" animation
```

The item needs neither a `use_cooldown` component nor a usable base item — only `minecraft:item_model`. Call it from a right click, a skill, a scheduler, anything.

> Use the **`ItemStack` overload**, not the `Material` one. Cooldowns are keyed by `cooldown_group` (`ItemCooldowns.getCooldownGroup`), and the `Material` overload will target the wrong group for an item that sets one.

### Datapack only

Read the frame index straight out of `custom_model_data.floats[i]` instead. There is no trigger at all — writing 0.0 → 1.0 *is* the playback:

```
/item modify entity @s weapon.mainhand <ns>:<modifier>
```

The `minecraft:set_custom_model_data` item modifier exists in 26.3 (`LootItemFunctions`), and its list wrapper is `{ values, mode }` where `values` accepts number providers — so a scoreboard can be the frame index directly:

```json
{
  "function": "minecraft:set_custom_model_data",
  "floats": {
    "values": [{ "type": "minecraft:score", "target": "this", "score": "<objective>" }],
    "mode": "replace_all"
  }
}
```

(Schema confirmed against the working datapack in `rieyi/display-anim-preview`.)

The costs are real: **one item rewrite per tick per player**, still 20 fps, still no sub-tick interpolation. This plugin does not implement it — if you can run a plugin, `setCooldown` is strictly better.

## Not a clock, but worth knowing: `keybind_down`

`ConditionalItemModelProperties` includes **`keybind_down`** (`IsKeybindDown.class` → `KeyMapping.isDown()`). It is a boolean, so not a playhead, but it reads the key **on the client with zero latency and zero server involvement**. For an instant state flip like aim on/off that beats any animation.

```json
{ "type": "minecraft:condition", "property": "minecraft:keybind_down",
  "keybind": "key.use",
  "on_true":  { "…aimed pose…": "" },
  "on_false": { "…default pose…": "" } }
```

## Confidence

| Claim | Basis |
|---|---|
| Full property list, `TimeSource` values | read from the jar |
| `cooldown` direction | `getCooldownPercent(ItemStack,F)F` call site |
| **20 fps ceiling on every clock** | javap: `Cooldown.get()` passes `fconst_0`; `UseDuration.get()` is `getUseItemRemainingTicks():I` + `i2f` |
| **20 fps ceiling, in game** | discriminator probe described above |
| Frame budget follows the cooldown, not the timeline | `getCooldownPercent`'s denominator is `endTime - startTime` |
| `local_time` throttled to 1 Hz | `UPDATE_INTERVAL_MS` + `TimeUnit.SECONDS` |
| Why Mojang passes zero | **inference.** The caching machinery is real; the causation is not proven |
| **`use_cycle`'s exact modulo semantics** | **unverified** — only the `period` field and the `getUseItemRemainingTicks` source were confirmed |
| `daytime` accuracy with `wobble: false` | unverified |
