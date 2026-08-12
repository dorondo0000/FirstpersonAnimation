<#
.SYNOPSIS
    Builds the "cooldown hider" core-shader sub-pack.

.DESCRIPTION
    The vanilla hotbar cooldown overlay is a flat fill of ARGB 0x7FFFFFFF
    (white, alpha 127/255) drawn through the `gui` core shader. This script
    takes YOUR client's vanilla gui.fsh, inserts a discard for exactly that
    colour, and writes it into a resource pack.

    It patches the real vanilla source instead of shipping a guessed copy,
    because a core shader that fails to compile takes the whole GUI with it.

.PARAMETER Jar
    Path to the Minecraft client jar. Defaults to the newest jar found in
    %APPDATA%\.minecraft\versions.

.PARAMETER Source
    Path to an already-extracted gui.fsh, used instead of -Jar.

.PARAMETER OutDir
    Where to write the pack. Defaults to ..\examples\cooldown_hider

.PARAMETER MinFormat
.PARAMETER MaxFormat
    pack.mcmeta format range. A pack declaring support for anything newer than
    format 64 MUST use min_format/max_format, or the whole pack fails to load.
    resource_major per version: 26.1 = 84, 26.2 = 88, 26.3-snapshot-5 = 93
    (client jar -> version.json -> pack_version.resource_major).

.EXAMPLE
    .\tools\make_cooldown_hider.ps1
    .\tools\make_cooldown_hider.ps1 -Jar "D:\PrismLauncher\...\26.3.jar"
#>
[CmdletBinding()]
param(
    [string]$Jar,
    [string]$Source,
    [string]$OutDir,
    [int]$MinFormat = 84,
    [int]$MaxFormat = 93
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $scriptDir) 'examples\cooldown_hider' }

$shaderPathInJar = 'assets/minecraft/shaders/core/gui.fsh'

# ---------------------------------------------------------------------------
# 1. get the vanilla source
# ---------------------------------------------------------------------------

function Get-VanillaShader {
    param([string]$JarPath)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($JarPath)
    try {
        $entry = $zip.Entries | Where-Object { $_.FullName -eq $shaderPathInJar }
        if (-not $entry) {
            $candidates = $zip.Entries |
                Where-Object { $_.FullName -like 'assets/minecraft/shaders/core/*.fsh' } |
                ForEach-Object { $_.FullName }
            throw "$shaderPathInJar not found in $JarPath.`nCore shaders present:`n  $($candidates -join "`n  ")"
        }
        $reader = New-Object System.IO.StreamReader($entry.Open())
        try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
    } finally {
        $zip.Dispose()
    }
}

if ($Source) {
    if (-not (Test-Path $Source)) { throw "Source shader not found: $Source" }
    $text = Get-Content -Raw -Path $Source
    Write-Host "source : $Source"
} else {
    if (-not $Jar) {
        $versionsDir = Join-Path $env:APPDATA '.minecraft\versions'
        if (-not (Test-Path $versionsDir)) {
            throw "No -Jar or -Source given and $versionsDir does not exist. Pass -Jar explicitly."
        }
        $Jar = Get-ChildItem -Path $versionsDir -Filter '*.jar' -Recurse |
            Sort-Object LastWriteTime -Descending |
            Select-Object -First 1 -ExpandProperty FullName
        if (-not $Jar) { throw "No client jar found under $versionsDir. Pass -Jar explicitly." }
    }
    if (-not (Test-Path $Jar)) { throw "Client jar not found: $Jar" }
    Write-Host "jar    : $Jar"
    $text = Get-VanillaShader -JarPath $Jar
}

# ---------------------------------------------------------------------------
# 2. find the colour varying and insert the discard
# ---------------------------------------------------------------------------

$varyingMatch = [regex]::Match($text, '(?m)^\s*(?:layout\s*\([^)]*\)\s*)?in\s+vec4\s+(\w*[Cc]olor\w*)\s*;')
if (-not $varyingMatch.Success) {
    Write-Host ''
    Write-Host '--- vanilla gui.fsh ---'
    Write-Host $text
    Write-Host '-----------------------'
    throw 'Could not find an `in vec4 <something>Color;` varying in gui.fsh. Patch it by hand using tools\cooldown_discard.glsl.'
}
$colorVar = $varyingMatch.Groups[1].Value
Write-Host "varying: $colorVar"

if ($text -match 'FIRSTPERSON ANIMATION') {
    throw 'That gui.fsh is already patched.'
}

$mainMatch = [regex]::Match($text, '(?m)void\s+main\s*\(\s*\)\s*\{')
if (-not $mainMatch.Success) { throw 'Could not find main() in gui.fsh.' }

$snippet = @"

    // --- FIRSTPERSON ANIMATION -------------------------------------------
    // The hotbar item cooldown overlay is a flat fill of ARGB 0x7FFFFFFF:
    // pure white at alpha 127/255. Drop exactly that colour so the merged
    // model in the item definition can draw the bar instead.
    if ($colorVar.r > 0.99 && $colorVar.g > 0.99 && $colorVar.b > 0.99 &&
        abs($colorVar.a - 0.49803922) < 0.004) {
        discard;
    }
    // ---------------------------------------------------------------------
"@

$insertAt = $mainMatch.Index + $mainMatch.Length
$patched = $text.Substring(0, $insertAt) + $snippet + $text.Substring($insertAt)

# ---------------------------------------------------------------------------
# 3. write the pack
# ---------------------------------------------------------------------------

# Windows PowerShell's -Encoding utf8 writes a BOM. A BOM before `#version`
# fails GLSL compilation and breaks pack.mcmeta parsing, so write UTF-8 without one.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
function Write-Text($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
}

$shaderDir = Join-Path $OutDir 'assets\minecraft\shaders\core'
New-Item -ItemType Directory -Force -Path $shaderDir | Out-Null
Write-Text (Join-Path $shaderDir 'gui.fsh') $patched

$mcmeta = @"
{
	"pack": {
		"description": "Firstperson Animation - hides the vanilla hotbar cooldown overlay",
		"min_format": $MinFormat,
		"max_format": $MaxFormat
	}
}
"@
Write-Text (Join-Path $OutDir 'pack.mcmeta') $mcmeta

$readme = @"
Cooldown Hider
==============

Removes the vanilla white hotbar cooldown overlay by discarding its exact
colour (white, alpha 127/255) in the `gui` core shader.

Generated from : $(if ($Source) { $Source } else { $Jar })
Colour varying : $colorVar

Load this pack ABOVE your Firstperson Animation pack. The item cooldown itself
still runs — only its default hotbar rendering is hidden — so the animation
keeps playing and the replacement bar from the item model definition (gated by
custom_model_data flags) is the only cooldown you see.

Side effect: any other pure-white 50%-alpha flat GUI fill is hidden too.
Vanilla does not use that colour anywhere else in the HUD.

Regenerate this pack whenever you change Minecraft version — core shaders are
version specific, and a stale one either fails to compile or silently stops
matching.
"@
Write-Text (Join-Path $OutDir 'README.txt') $readme

Write-Host "pack   : $OutDir"
Write-Host 'done.'
