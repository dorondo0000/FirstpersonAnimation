#version 330
#extension GL_ARB_separate_shader_objects : require

// Can't moj_import in things used during startup, when resource packs don't exist.
// This is a copy of dynamicimports.glsl
layout(std140) uniform DynamicTransforms {
    mat4 ModelViewMat;
    vec4 ColorModulator;
    vec3 ModelOffset;
    mat4 TextureMat;
};

layout(location = 0) in vec4 vertexColor;

layout(location = 0) out vec4 fragColor;

void main() {
    // --- FIRSTPERSON ANIMATION -------------------------------------------
    // The hotbar item cooldown overlay is a flat fill of ARGB 0x7FFFFFFF:
    // pure white at alpha 127/255. Drop exactly that colour so the merged
    // model in the item definition can draw the bar instead.
    if (vertexColor.r > 0.99 && vertexColor.g > 0.99 && vertexColor.b > 0.99 &&
        abs(vertexColor.a - 0.49803922) < 0.004) {
        discard;
    }
    // ---------------------------------------------------------------------
    vec4 color = vertexColor;
    if (color.a == 0.0) {
        discard;
    }
    fragColor = color * ColorModulator;
}
