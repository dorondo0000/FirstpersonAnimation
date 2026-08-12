Cooldown Hider
==============

Removes the vanilla white hotbar cooldown overlay by discarding its exact
colour (white, alpha 127/255) in the gui core shader.

Generated from : C:\Users\User\AppData\Roaming\PrismLauncher\libraries\com\mojang\minecraft\26.3-snapshot-5\minecraft-26.3-snapshot-5-client.jar
Colour varying : vertexColor

Load this pack ABOVE your Firstperson Animation pack. The item cooldown itself
still runs ??only its default hotbar rendering is hidden ??so the animation
keeps playing and the replacement bar from the item model definition (gated by
custom_model_data flags) is the only cooldown you see.

Side effect: any other pure-white 50%-alpha flat GUI fill is hidden too.
Vanilla does not use that colour anywhere else in the HUD.

Regenerate this pack whenever you change Minecraft version ??core shaders are
version specific, and a stale one either fails to compile or silently stops
matching.