// Manual patch for assets/minecraft/shaders/core/gui.fsh
//
// Copy your version's vanilla gui.fsh out of the client jar, paste this block
// as the FIRST thing inside main(), and rename `vertexColor` if your version
// calls the varying something else.
//
// Why this works: the hotbar item cooldown overlay is drawn as a flat fill with
// colour Integer.MAX_VALUE = 0x7FFFFFFF, i.e. pure white at alpha 127/255, and
// flat GUI fills go through the `gui` core shader.

    // --- FIRSTPERSON ANIMATION -------------------------------------------
    if (vertexColor.r > 0.99 && vertexColor.g > 0.99 && vertexColor.b > 0.99 &&
        abs(vertexColor.a - 0.49803922) < 0.004) {
        discard;
    }
    // ---------------------------------------------------------------------
