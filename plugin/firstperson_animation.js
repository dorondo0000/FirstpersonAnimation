/**
 * Firstperson Animation — Blockbench plugin
 *
 * Bakes a Blockbench bone animation into a vanilla Minecraft (26.1+) items model
 * definition. Client side it is a plain resource pack; server side it is three
 * things on an item stack and nothing else:
 *
 *   minecraft:item_model    -> which model definition to use
 *   minecraft:custom_data   -> which animation (a string under one key)
 *   a vanilla item cooldown -> the playback head
 *
 * No base item requirement, no datapack, no commands, no /give templates.
 * Nothing is written under assets/minecraft.
 *
 * How the clock works, and its hard limit
 * ---------------------------------------
 * `minecraft:cooldown` returns (endTime - tickCount) / (endTime - startTime).
 * Cooldown.get() hands getCooldownPercent a partial tick of exactly 0.0F — that
 * is `fconst_0` in the bytecode of 26.1.2, 26.2 and 26.3 alike — so the value is
 * a staircase with (cooldown ticks + 1) steps, not a ramp. 20 poses per second
 * is the ceiling; more entries than that are unreachable. What you CAN do is
 * make the cooldown longer: the frame budget follows the cooldown, not the
 * Blockbench timeline. See docs/clocks.md.
 */
(function () {

const PLUGIN_ID = 'firstperson_animation';
const PLUGIN_VERSION = '2.0.0';

// The item-model `transformation` is anchored at model (0,0,0) and its
// translation is in blocks. Confirmed against vanilla: black_shulker_box.json
// carries exactly the PoseStack ops ShulkerBoxRenderer performs, to 4 decimals.
const PIVOT = [0, 0, 0];

const FIRSTPERSON_CONTEXTS = ['firstperson_righthand', 'firstperson_lefthand'];
const IDENTITY_EPS = 1e-5;

const DEFAULTS = {
	namespace: 'fpa',
	item_name: 'example',
	pack_description: 'Firstperson Animation',
	// A pack supporting anything past format 64 MUST carry min_format/max_format,
	// or it fails to load outright. [major, minor] arrays are accepted.
	// resource_major: 26.1 = 84, 26.2 = 88, 26.3 = 93.
	min_format: 84,
	max_format: 2147483647,

	// custom_data key holding the animation name. The model tests it with a real
	// DataComponentPredicate, so matching is PARTIAL — whatever else the server
	// keeps in custom_data is ignored.
	anim_key: 'fpa',

	// 20 is the engine ceiling, not a preference.
	fps: 20,
	max_frames: 128,
	// In-game playback length in ticks. 0 = derive from the Blockbench timeline.
	// Set this when the cooldown you hand out differs from the authored length.
	playback_ticks: 0,
	precision: 5,

	cooldown_bar: true,
	cooldown_bar_key: 'fpa_bar',

};

let exporting = false;

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------

function clamp(v, a, b) {
	if (!Number.isFinite(v)) return a;
	return v < a ? a : (v > b ? b : v);
}

function rnd(v, digits) {
	const f = Math.pow(10, digits);
	const r = Math.round(v * f) / f;
	return Object.is(r, -0) ? 0 : r;
}

function safeId(str) {
	return String(str == null ? '' : str)
		.toLowerCase()
		.replace(/[^a-z0-9_\-.]/g, '_')
		.replace(/^_+|_+$/g, '') || 'unnamed';
}

function isGroup(node) {
	return typeof Group !== 'undefined' && node instanceof Group;
}

function settings() {
	if (typeof Project === 'undefined' || !Project) return Object.assign({}, DEFAULTS);
	if (!Project.fpa_settings || typeof Project.fpa_settings !== 'object') {
		Project.fpa_settings = Object.assign({}, DEFAULTS);
	}
	for (const key in DEFAULTS) {
		const def = DEFAULTS[key];
		const cur = Project.fpa_settings[key];
		const broken = cur === undefined || cur === null ||
			(typeof def === 'number' && !Number.isFinite(cur));
		if (broken) Project.fpa_settings[key] = def;
	}
	return Project.fpa_settings;
}

// ---------------------------------------------------------------------------
// geometry: Blockbench cube -> java model element
// ---------------------------------------------------------------------------

function cubeToElement(cube, textureKeys, prec) {
	const uvw = (Project && Project.texture_width) || 16;
	const uvh = (Project && Project.texture_height) || 16;
	const sx = 16 / uvw, sy = 16 / uvh;
	const inf = cube.inflate || 0;

	const el = {
		from: [cube.from[0] - inf, cube.from[1] - inf, cube.from[2] - inf].map(v => rnd(v, prec)),
		to: [cube.to[0] + inf, cube.to[1] + inf, cube.to[2] + inf].map(v => rnd(v, prec)),
	};
	if (cube.name && cube.name !== 'cube') el.name = cube.name;

	const rot = cube.rotation || [0, 0, 0];
	const axis = rot.findIndex(v => v !== 0);
	if (axis !== -1) {
		el.rotation = {
			angle: rnd(rot[axis], prec),
			axis: ['x', 'y', 'z'][axis],
			origin: (cube.origin || [8, 8, 8]).map(v => rnd(v, prec)),
		};
		if (cube.rescale) el.rotation.rescale = true;
	}
	if (cube.shade === false) el.shade = false;
	if (cube.light_emission) el.light_emission = cube.light_emission;

	el.faces = {};
	for (const key in cube.faces) {
		const face = cube.faces[key];
		if (!face) continue;
		let tex = null;
		try { tex = typeof face.getTexture === 'function' ? face.getTexture() : null; } catch (e) { tex = null; }
		if (!tex) continue;
		const uv = face.uv || [0, 0, 16, 16];
		const f = {
			uv: [rnd(uv[0] * sx, prec), rnd(uv[1] * sy, prec), rnd(uv[2] * sx, prec), rnd(uv[3] * sy, prec)],
			texture: '#' + textureKeys.get(tex.uuid),
		};
		if (face.rotation) f.rotation = face.rotation;
		if (face.tint !== undefined && face.tint >= 0) f.tintindex = face.tint;
		if (face.cullface) f.cullface = face.cullface;
		el.faces[key] = f;
	}
	return Object.keys(el.faces).length ? el : null;
}

/** every part model must carry the SAME display section or the bones drift apart */
function exportDisplaySection(prec) {
	const out = {};
	const ds = (Project && Project.display_settings) || {};
	for (const key in ds) {
		const slot = ds[key];
		if (!slot) continue;
		let obj = null;
		if (typeof slot.export === 'function') {
			try { obj = slot.export(); } catch (e) { obj = null; }
		}
		if (!obj) {
			obj = {};
			if (slot.rotation && slot.rotation.some(v => v !== 0)) obj.rotation = slot.rotation.map(v => rnd(v, prec));
			if (slot.translation && slot.translation.some(v => v !== 0)) obj.translation = slot.translation.map(v => rnd(v, prec));
			if (slot.scale && slot.scale.some(v => v !== 1)) obj.scale = slot.scale.map(v => rnd(v, prec));
		}
		if (obj && Object.keys(obj).length) out[key] = obj;
	}
	return out;
}

// ---------------------------------------------------------------------------
// pose sampling
// ---------------------------------------------------------------------------

function exportableCubesOf(group) {
	if (!group.children) return [];
	return group.children.filter(c => !isGroup(c) && c.export !== false && c.visibility !== false);
}

function collectBones() {
	if (typeof Group === 'undefined' || !Group.all) return [];
	return Group.all.filter(g => exportableCubesOf(g).length > 0);
}

function rootCubes() {
	if (typeof Cube === 'undefined' || !Cube.all) return [];
	return Cube.all.filter(c => !isGroup(c.parent) && c.export !== false && c.visibility !== false);
}

/**
 * World matrices with every group rotation, scale and animation neutralised —
 * the pose the exported raw model coordinates correspond to. Group rest
 * rotations therefore end up baked into every frame's transformation, which is
 * correct: a plain java model cannot express a rotated bone.
 */
function captureZeroPose() {
	try { Animator.showDefaultPose(true); } catch (e) { /* not in animate mode */ }

	const all = (typeof Group !== 'undefined' && Group.all) ? Group.all : [];
	const saved = all.map(g => ({
		r: g.mesh.rotation.clone(), s: g.mesh.scale.clone(), p: g.mesh.position.clone(),
	}));
	all.forEach(g => { g.mesh.rotation.set(0, 0, 0); g.mesh.scale.set(1, 1, 1); });
	Canvas.scene.updateMatrixWorld(true);

	const map = new Map();
	all.forEach(g => map.set(g.uuid, g.mesh.matrixWorld.clone()));

	all.forEach((g, i) => {
		g.mesh.rotation.copy(saved[i].r);
		g.mesh.scale.copy(saved[i].s);
		g.mesh.position.copy(saved[i].p);
	});
	Canvas.scene.updateMatrixWorld(true);
	return map;
}

/**
 * Blockbench's scene and Minecraft model space differ by a constant translation.
 * Measure it instead of guessing: at the zero pose a root group's world position
 * is its own pivot, in scene coordinates.
 */
function computeSceneOffset(zeroPose) {
	const all = (typeof Group !== 'undefined' && Group.all) ? Group.all : [];
	const roots = all.filter(g => !isGroup(g.parent));
	let offset = null, deviation = 0;
	roots.forEach(g => {
		const m = zeroPose.get(g.uuid);
		if (!m) return;
		const p = new THREE.Vector3().setFromMatrixPosition(m);
		const o = new THREE.Vector3(g.origin[0] - p.x, g.origin[1] - p.y, g.origin[2] - p.z);
		if (!offset) offset = o;
		else deviation = Math.max(deviation, offset.distanceTo(o));
	});
	return { offset: offset || new THREE.Vector3(0, 0, 0), deviation, samples: roots.length };
}

function samplePose(bones, time) {
	setTimelineTimeRaw(time);
	Animator.preview();
	Canvas.scene.updateMatrixWorld(true);
	const map = new Map();
	bones.forEach(g => map.set(g.uuid, g.mesh.matrixWorld.clone()));
	return map;
}

// ---------------------------------------------------------------------------
// matrix -> minecraft `transformation`
// ---------------------------------------------------------------------------

function matrix4FromMatrix3(m3) {
	// Matrix3.elements is column-major, Matrix4.set() takes row-major arguments
	const e = m3.elements;
	return new THREE.Matrix4().set(
		e[0], e[3], e[6], 0,
		e[1], e[4], e[7], 0,
		e[2], e[5], e[8], 0,
		0, 0, 0, 1
	);
}

/**
 * model space  v' = linear*v + tModel   ->   minecraft `transformation`
 *   v'_local = t + L*S*R * v_local, v_local = (v - pivot)/16
 *   => t = (linear*pivot + tModel - pivot) / 16
 *
 * The field itself is optional, but once present the decomposed form needs ALL
 * FOUR keys — a partial one is rejected with "No key right_rotation in MapLike".
 */
function toItemTransformation(linear, tModel, prec) {
	const pivot = new THREE.Vector3(PIVOT[0], PIVOT[1], PIVOT[2]);
	const t = pivot.clone().applyMatrix3(linear).add(tModel).sub(pivot).multiplyScalar(1 / 16);

	const pos = new THREE.Vector3();
	const quat = new THREE.Quaternion();
	const scl = new THREE.Vector3();
	matrix4FromMatrix3(linear).decompose(pos, quat, scl);
	if (quat.w < 0) { quat.x *= -1; quat.y *= -1; quat.z *= -1; quat.w *= -1; }

	const movedT = Math.abs(t.x) >= IDENTITY_EPS || Math.abs(t.y) >= IDENTITY_EPS || Math.abs(t.z) >= IDENTITY_EPS;
	const movedR = Math.abs(quat.x) >= IDENTITY_EPS || Math.abs(quat.y) >= IDENTITY_EPS ||
		Math.abs(quat.z) >= IDENTITY_EPS || Math.abs(quat.w - 1) >= IDENTITY_EPS;
	const movedS = Math.abs(scl.x - 1) >= IDENTITY_EPS || Math.abs(scl.y - 1) >= IDENTITY_EPS ||
		Math.abs(scl.z - 1) >= IDENTITY_EPS;
	if (!movedT && !movedR && !movedS) return null;

	return {
		translation: [rnd(t.x, prec), rnd(t.y, prec), rnd(t.z, prec)],
		left_rotation: [rnd(quat.x, prec), rnd(quat.y, prec), rnd(quat.z, prec), rnd(quat.w, prec)],
		scale: [rnd(scl.x, prec), rnd(scl.y, prec), rnd(scl.z, prec)],
		right_rotation: [0, 0, 0, 1],
	};
}

function deltaToTransformation(deltaScene, sceneOffset, prec) {
	const linear = new THREE.Matrix3().setFromMatrix4(deltaScene);
	const tScene = new THREE.Vector3().setFromMatrixPosition(deltaScene);
	// model = scene + offset  =>  tModel = tScene + (I - linear) * offset
	const tModel = tScene.clone().add(sceneOffset).sub(sceneOffset.clone().applyMatrix3(linear));
	return toItemTransformation(linear, tModel, prec);
}

/** decompose() silently drops shear — measure how much we lost */
function shearError(deltaScene) {
	const m = deltaScene.clone();
	m.setPosition(0, 0, 0);
	const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
	m.decompose(pos, quat, scl);
	const rebuilt = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 0), quat, scl);
	let err = 0;
	for (let i = 0; i < 16; i++) err = Math.max(err, Math.abs(rebuilt.elements[i] - m.elements[i]));
	return err;
}

// ---------------------------------------------------------------------------
// item model definition
// ---------------------------------------------------------------------------

function modelRef(path, transformation) {
	const node = { type: 'minecraft:model', model: path };
	if (transformation) node.transformation = transformation;
	return node;
}

function composite(models) {
	const list = models.filter(Boolean);
	if (!list.length) return { type: 'minecraft:empty' };
	if (list.length === 1) return list[0];
	return { type: 'minecraft:composite', models: list };
}

/**
 * One dispatch per bone rather than one dispatch over whole-rig composites.
 *
 * The naive shape costs frames x bones nodes. Per-bone costs only the number of
 * distinct poses that bone actually takes: a bone that holds still collapses
 * those frames into one entry, and a bone that never moves collapses to a plain
 * model reference.
 *
 * `minecraft:cooldown` counts DOWN from 1.0, so entry j maps to frame N-1-j and
 * the LAST keyframe is what shows while idle. Author it as the rest pose.
 */
function boneTrack(path, tfs) {
	const n = tfs.length;
	const entries = [];
	let prevKey = null;
	for (let j = 0; j < n; j++) {
		const tf = tfs[n - 1 - j];
		const key = JSON.stringify(tf || null);
		if (key === prevKey) continue;
		prevKey = key;
		entries.push({ threshold: rnd(j / n, 6), model: modelRef(path, tf) });
	}
	if (entries.length === 1) return entries[0].model;
	return {
		type: 'minecraft:range_dispatch',
		property: 'minecraft:cooldown',
		entries: entries,
		fallback: entries[0].model,
	};
}

/**
 * Animation switching, entirely through minecraft:custom_data.
 *
 * The `minecraft:component` CONDITION runs a DataComponentPredicate, so unlike
 * the select property it matches PARTIALLY — the server can keep anything else
 * it likes in custom_data. `predicate` is the predicate type id (a string) and
 * the match data lives in `value`; that shape comes straight from
 * ComponentMatches.MAP_CODEC = DataComponentPredicate.singleCodec("predicate").
 *
 * No key set, or a name nothing matches, falls through to the rest pose.
 */
function buildBranch(cases, key, restModel) {
	if (cases.length === 1) return cases[0].model;
	let node = restModel;
	for (let i = cases.length - 1; i >= 0; i--) {
		const value = {};
		value[key] = cases[i].name;
		node = {
			type: 'minecraft:condition',
			property: 'minecraft:component',
			predicate: 'minecraft:custom_data',
			value: value,
			on_true: cases[i].model,
			on_false: node,
		};
	}
	return node;
}

function countModelNodes(node) {
	if (!node || typeof node !== 'object') return 0;
	let n = node.type === 'minecraft:model' ? 1 : 0;
	for (const key in node) {
		const v = node[key];
		if (Array.isArray(v)) v.forEach(x => { n += countModelNodes(x); });
		else if (v && typeof v === 'object') n += countModelNodes(v);
	}
	return n;
}

// ---------------------------------------------------------------------------
// cooldown bar — a merged model standing in for the hotbar overlay
// ---------------------------------------------------------------------------
//
// Straight from GuiGraphicsExtractor in 26.3, nothing invented:
//
//   float f = getCooldownPercent(stack, deltaTracker.getGameTimeDeltaPartialTick(true));
//   if (f > 0.0F) {
//       int top    = y + Mth.floor(16.0F * (1.0F - f));
//       int bottom = top + Mth.ceil(16.0F * f);
//       fill(RenderPipelines.GUI, x, top, x + 16, bottom, 0x7FFFFFFF);
//   }
//
// So: white at alpha 127/255, full slot width, bottom aligned, height ceil(16f)
// PIXELS. That is 17 possible looks (0..16 px) and no others — which is why this
// has no style or step count to configure.
//
// range_dispatch picks the last entry whose threshold <= value, i.e. intervals
// closed on the left, while ceil() wants them closed on the right. Nudging each
// threshold just past (j-1)/16 reproduces ceil() exactly on every value the clock
// can actually produce.
//
// One honest difference: vanilla passes a real partial tick here, so its overlay
// is smooth. Ours rides minecraft:cooldown, which is quantised to ticks.

const COOLDOWN_BAR_PIXELS = 16;
const COOLDOWN_BAR_EPS = 1e-6;

/** vanilla's overlay colour: 0x7FFFFFFF */
function cooldownOverlayPNG() {
	const c = document.createElement('canvas');
	c.width = 16; c.height = 16;
	const ctx = c.getContext('2d');
	ctx.clearRect(0, 0, 16, 16);
	ctx.fillStyle = 'rgba(255,255,255,' + (127 / 255) + ')';
	ctx.fillRect(0, 0, 16, 16);
	return c.toDataURL('image/png').split(',')[1];
}

function cooldownBarModel(texturePath) {
	// z = 20 keeps the plate in front of the 0..16 item volume; the gui context is
	// an orthographic projection so z only affects depth ordering
	return {
		texture_size: [16, 16],
		textures: { 0: texturePath, particle: texturePath },
		elements: [{
			name: 'cooldown_plate',
			from: [0, 0, 19.99],
			to: [16, 16, 20],
			shade: false,
			faces: {
				north: { uv: [0, 0, 16, 16], texture: '#0' },
				south: { uv: [0, 0, 16, 16], texture: '#0' },
			},
		}],
		gui_light: 'front',
		display: { gui: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] } },
	};
}

function buildCooldownBar(cfg, modelPath) {
	const entries = [{ threshold: 0, model: { type: 'minecraft:empty' } }];
	for (let px = 1; px <= COOLDOWN_BAR_PIXELS; px++) {
		// height ceil(16f) px, bottom aligned. The corner pivot means scaling y keeps
		// the bottom edge where it is, which is exactly what vanilla draws.
		const linear = new THREE.Matrix3().set(1, 0, 0, 0, px / COOLDOWN_BAR_PIXELS, 0, 0, 0, 1);
		entries.push({
			threshold: rnd((px - 1) / COOLDOWN_BAR_PIXELS + COOLDOWN_BAR_EPS, 8),
			model: modelRef(modelPath, toItemTransformation(linear, new THREE.Vector3(0, 0, 0), cfg.precision)),
		});
	}
	const value = {};
	value[cfg.cooldown_bar_key] = true;
	return {
		type: 'minecraft:condition',
		property: 'minecraft:component',
		predicate: 'minecraft:custom_data',
		value: value,
		on_true: {
			type: 'minecraft:range_dispatch',
			property: 'minecraft:cooldown',
			entries: entries,
			fallback: { type: 'minecraft:empty' },
		},
		on_false: { type: 'minecraft:empty' },
	};
}

// ---------------------------------------------------------------------------
// exporter
// ---------------------------------------------------------------------------

function playbackTicksFor(animation, cfg) {
	const override = cfg.playback_ticks | 0;
	if (override > 0) return override;
	return Math.max(1, Math.round(Math.max(animation.length || 0, 1 / 20) * 20));
}

/**
 * Every clock is an integer tick counter, so a D-tick playback can only ever
 * take D+1 distinct values. More entries than that are dead weight.
 */
function frameCountFor(animation, cfg) {
	const ticks = playbackTicksFor(animation, cfg);
	const optimal = ticks + 1;
	const requested = Math.round((ticks / 20) * cfg.fps) + 1;
	return clamp(Math.min(requested, optimal), 2, clamp(cfg.max_frames | 0, 2, 512));
}

function buildPack() {
	const cfg = settings();
	const prec = clamp(cfg.precision | 0, 2, 8);
	const ns = safeId(cfg.namespace);
	const item = safeId(cfg.item_name);
	const dir = 'item/' + item;

	const warnings = [];
	const files = {};
	const binFiles = {};

	// --- textures -----------------------------------------------------------
	const textureKeys = new Map();
	const textureRefs = {};
	(Texture.all || []).forEach((tex, i) => {
		const key = String(i);
		textureKeys.set(tex.uuid, key);
		const name = safeId(tex.name.replace(/\.png$/i, ''));
		const path = ns + ':' + dir + '/' + name;
		textureRefs[key] = path;
		let b64 = '';
		try {
			b64 = typeof tex.getBase64 === 'function' ? tex.getBase64() : (tex.source || '');
		} catch (e) { b64 = tex.source || ''; }
		b64 = String(b64).replace(/^data:image\/\w+;base64,/, '');
		if (b64) binFiles['assets/' + ns + '/textures/' + dir + '/' + name + '.png'] = b64;
		if (tex.particle) textureRefs.particle = path;
	});
	if (!textureRefs.particle && textureRefs['0']) textureRefs.particle = textureRefs['0'];

	// --- one model file per bone --------------------------------------------
	const bones = collectBones();
	const loose = rootCubes();
	const displaySection = exportDisplaySection(prec);
	const partPaths = new Map();
	const usedNames = new Set();

	function writePart(name, cubes) {
		let n = safeId(name), i = 2;
		while (usedNames.has(n)) n = safeId(name) + '_' + (i++);
		usedNames.add(n);

		const elements = [];
		cubes.forEach(c => {
			const el = cubeToElement(c, textureKeys, prec);
			if (el) elements.push(el);
		});
		if (!elements.length) return null;

		files['assets/' + ns + '/models/' + dir + '/parts/' + n + '.json'] = JSON.stringify({
			credit: 'Made with Blockbench + Firstperson Animation',
			texture_size: [(Project.texture_width || 16), (Project.texture_height || 16)],
			textures: textureRefs,
			elements: elements,
			display: displaySection,
		}, null, '\t');
		return ns + ':' + dir + '/parts/' + n;
	}

	bones.forEach(g => {
		const p = writePart(g.name, exportableCubesOf(g));
		if (p) partPaths.set(g.uuid, p);
	});
	const loosePath = loose.length ? writePart('static', loose) : null;

	const animatedBones = bones.filter(g => partPaths.has(g.uuid));
	if (!animatedBones.length && !loosePath) {
		throw new Error('No exportable geometry found — add at least one cube with a texture.');
	}
	if (!animatedBones.length) warnings.push('No group contains cubes, so nothing can be animated.');
	if (!Object.keys(displaySection).length) {
		warnings.push('No display transforms are set. Open Display mode and place "First person right hand", ' +
			'otherwise the item renders at raw model scale.');
	}

	// --- reference pose & scene offset --------------------------------------
	const zeroPose = captureZeroPose();
	const off = computeSceneOffset(zeroPose);
	if (off.samples === 0) warnings.push('No group found; assuming a scene offset of (0,0,0).');
	else if (off.samples === 1) warnings.push('Only one root group — the scene/model offset could not be cross-checked.');
	if (off.deviation > 1e-3) {
		warnings.push('Scene/model offset differs between root groups by ' + off.deviation.toFixed(4) +
			' — exported translations are probably wrong.');
	}

	function poseComposite(poseMap) {
		const models = [];
		if (loosePath) models.push(modelRef(loosePath));
		animatedBones.forEach(g => {
			const zero = zeroPose.get(g.uuid), now = poseMap.get(g.uuid);
			if (!zero || !now) return;
			const delta = now.clone().multiply(zero.clone().invert());
			models.push(modelRef(partPaths.get(g.uuid), deltaToTransformation(delta, off.offset, prec)));
		});
		return composite(models);
	}
	const restModel = poseComposite(zeroPose);

	// --- animations ---------------------------------------------------------
	const animations = (typeof Animation !== 'undefined' && Animation.all) ? Animation.all.slice() : [];
	const prevMode = (typeof Mode !== 'undefined') ? Mode.selected : null;
	const prevSelected = (typeof Animation !== 'undefined') ? Animation.selected : null;
	const prevTime = (typeof Timeline !== 'undefined') ? Timeline.time : 0;
	if (typeof Timeline !== 'undefined' && Timeline.playing) Timeline.pause();

	const cases = [];
	const animInfo = [];
	let maxShear = 0;

	exporting = true;
	try {
		if (animations.length && Modes.options.animate) Modes.options.animate.select();

		animations.forEach(animation => {
			animation.select();
			const length = Math.max(animation.length || 0, 1 / 20);
			const ticks = playbackTicksFor(animation, cfg);
			const frames = frameCountFor(animation, cfg);

			if (frames < ticks + 1) {
				warnings.push('"' + animation.name + '" baked at ' + frames + ' frames but a ' + ticks +
					'-tick playback resolves ' + (ticks + 1) +
					(cfg.fps < 20 ? ' (fps is ' + cfg.fps + ')' : ' (raise Max frames)') + '.');
			}

			const framePoses = [];
			for (let i = 0; i < frames; i++) {
				framePoses.push(samplePose(animatedBones, (i / (frames - 1)) * length));
			}

			const layers = [];
			if (loosePath) layers.push(modelRef(loosePath));
			animatedBones.forEach(g => {
				const zero = zeroPose.get(g.uuid);
				if (!zero) return;
				const inv = zero.clone().invert();
				const tfs = framePoses.map(pose => {
					const delta = pose.get(g.uuid).clone().multiply(inv);
					maxShear = Math.max(maxShear, shearError(delta));
					return deltaToTransformation(delta, off.offset, prec);
				});
				layers.push(boneTrack(partPaths.get(g.uuid), tfs));
			});

			const model = composite(layers);
			const name = safeId(animation.name);
			cases.push({ name: name, model: model });
			animInfo.push({
				name: name, frames: frames, ticks: ticks,
				nodes: countModelNodes(model), naiveNodes: frames * animatedBones.length,
			});
		});
	} finally {
		exporting = false;
		try {
			if (prevSelected) prevSelected.select();
			setTimelineTimeRaw(prevTime || 0);
			Animator.preview();
			if (prevMode && prevMode.select) prevMode.select();
		} catch (e) { /* ignore */ }
	}

	if (maxShear > 1e-3) {
		warnings.push('A bone produces a sheared matrix (error ' + maxShear.toFixed(4) +
			'). Minecraft transformations cannot express shear — avoid non-uniform scale on rotated bones.');
	}
	if (!animations.length) warnings.push('No animations in this project — only the static model was exported.');

	// --- item model definition ----------------------------------------------
	const firstPerson = cases.length ? buildBranch(cases, cfg.anim_key, restModel) : restModel;

	const displayCases = [{ when: FIRSTPERSON_CONTEXTS, model: firstPerson }];
	if (cfg.cooldown_bar) {
		const texName = '_cooldown_overlay';
		binFiles['assets/' + ns + '/textures/' + dir + '/' + texName + '.png'] = cooldownOverlayPNG();
		files['assets/' + ns + '/models/' + dir + '/cooldown_bar.json'] =
			JSON.stringify(cooldownBarModel(ns + ':' + dir + '/' + texName), null, '\t');
		displayCases.push({
			when: ['gui'],
			model: composite([restModel, buildCooldownBar(cfg, ns + ':' + dir + '/cooldown_bar')]),
		});
	}

	files['assets/' + ns + '/items/' + item + '.json'] = JSON.stringify({
		hand_animation_on_swap: false,
		// The model identity changes on every tick the cooldown advances. Without
		// this vanilla plays its equip bob on each change — rieyi/display-anim-preview
		// hit the same thing and verified swap_animation_scale: 0 kills it in 26.2.
		swap_animation_scale: 0,
		model: {
			type: 'minecraft:select',
			property: 'minecraft:display_context',
			cases: displayCases,
			fallback: restModel,
		},
	}, null, '\t');

	files['pack.mcmeta'] = JSON.stringify({
		pack: {
			description: cfg.pack_description,
			min_format: cfg.min_format | 0,
			max_format: cfg.max_format | 0,
		},
	}, null, '\t');

	files[ns + '_' + item + '.sk'] = buildSkript(cfg, ns, item, animInfo);
	files['README.txt'] = buildReadme(cfg, ns, item, animInfo, warnings, off);

	return { files, binFiles, warnings, animInfo, ns, item };
}

// ---------------------------------------------------------------------------
// Skript example — Skript 2.13+ and SkBee 3.12+
// ---------------------------------------------------------------------------

function buildSkript(cfg, ns, item, animInfo) {
	const model = ns + ':' + item;
	const fn = 'fpa_' + item;
	const L = [];

	L.push('# ' + '='.repeat(70));
	L.push('# Firstperson Animation — ' + model);
	L.push('# generated by the Blockbench plugin');
	L.push('#');
	L.push('# needs: Skript 2.13+   (set item cooldown of ... for ...)');
	L.push('#        SkBee  3.12+   (item model of ... / custom nbt of ... / use cooldown)');
	L.push('#        Paper  1.21.3+ (the use_cooldown component)');
	L.push('#');
	L.push('# The pack does everything client side. The server only sets three things:');
	L.push('#   1. minecraft:item_model   -> which model definition to use');
	L.push('#   2. minecraft:custom_data  -> which animation, one string under "' + cfg.anim_key + '"');
	L.push('#   3. a vanilla item cooldown -> the playback head');
	L.push('# Any item type works; the model replaces its appearance entirely.');
	L.push('# ' + '='.repeat(70));
	L.push('');
	const firstTicks = animInfo[0] ? animInfo[0].ticks : 20;
	L.push('options:');
	L.push('\tmodel: ' + model);
	L.push('\tanim: ' + cfg.anim_key);
	if (cfg.cooldown_bar) L.push('\tbar: ' + cfg.cooldown_bar_key);
	L.push('\tgroup: ' + model);
	L.push('\tbase: stick   # cosmetic only — the item model replaces it');
	L.push('');
	L.push('# --- build ' + '-'.repeat(60));
	L.push('#');
	L.push('# The use_cooldown component is here for its \'group\' and nothing else.');
	L.push('# Without a group the cooldown is keyed by the BASE ITEM TYPE, so every other');
	L.push('# stick on the server would share this weapon\'s cooldown - and therefore its');
	L.push('# animation. \'seconds\' is required by the component but only ever fires if the');
	L.push('# base item is actually usable; the play functions below set the cooldown');
	L.push('# explicitly either way.');
	L.push('');
	L.push('function ' + fn + '_item() :: item:');
	L.push('\tset {_i} to {@base}');
	L.push('\tset item model of {_i} to "{@model}"');
	L.push('\tapply use cooldown to {_i}:');
	L.push('\t\tseconds: ' + firstTicks + ' ticks');
	L.push('\t\tgroup: "{@group}"');
	L.push('\treturn {_i}');
	L.push('');
	L.push('function ' + fn + '_give(p: player):');
	L.push('\tgive ' + fn + '_item() to {_p}');
	L.push('');

	if (cfg.cooldown_bar) {
		L.push('# --- cooldown display on/off ' + '-'.repeat(43));
		L.push('#');
		L.push('# The pack draws its own cooldown bar in the hotbar, off unless custom_data');
		L.push('# carries "' + cfg.cooldown_bar_key + '". The model checks it with a real predicate, so the match is');
		L.push('# PARTIAL — anything else you keep in custom_data is left alone.');
		L.push('#');
		L.push('# Vanilla still draws its own white overlay on top. To remove that you need');
		L.push('# the optional core-shader sub-pack (tools/make_cooldown_hider.ps1); it is a');
		L.push('# separate pack because it has to live under assets/minecraft.');
		L.push('');
		L.push('function ' + fn + '_bar(i: item, show: boolean) :: item:');
		L.push('\tif {_show} is true:');
		L.push('\t\tset byte tag "{@bar}" of custom nbt of {_i} to 1');
		L.push('\telse:');
		L.push('\t\tdelete byte tag "{@bar}" of custom nbt of {_i}');
		L.push('\treturn {_i}');
		L.push('');
	}

	L.push('# --- play ' + '-'.repeat(61));
	L.push('#');
	L.push('# The cooldown IS the playback head: its length sets both the speed and how');
	L.push('# many distinct poses the client can resolve (ticks + 1, hard ceiling 20/sec).');
	L.push('# Nothing else has to happen — no right click, no use_cooldown component.');
	L.push('');
	animInfo.forEach(a => {
		L.push('function ' + fn + '_' + a.name + '(p: player):');
		L.push('\tset {_i} to {_p}\'s tool');
		L.push('\tset string tag "{@anim}" of custom nbt of {_i} to "' + a.name + '"');
		L.push('\tset {_p}\'s tool to {_i}');
		L.push('\tset item cooldown of {_i} for {_p} to ' + a.ticks + ' ticks   # ' + a.frames + ' baked frames');
		L.push('');
	});

	L.push('# --- example wiring ' + '-'.repeat(51));
	L.push('');
	L.push('command /' + fn + ':');
	L.push('\ttrigger:');
	L.push('\t\t' + fn + '_give(player)');
	L.push('');
	L.push('on right click:');
	L.push('\titem model of player\'s tool is "{@model}"');
	L.push('\tplayer doesn\'t have an item cooldown on player\'s tool');
	L.push('\t' + fn + '_' + (animInfo[0] ? animInfo[0].name : 'idle') + '(player)');
	return L.join('\n');
}

function buildReadme(cfg, ns, item, animInfo, warnings, off) {
	const L = [];
	L.push('Firstperson Animation — ' + ns + ':' + item);
	L.push('='.repeat(50));
	L.push('');
	L.push('item model definition : assets/' + ns + '/items/' + item + '.json');
	L.push('bone models           : assets/' + ns + '/models/item/' + item + '/parts/');
	L.push('scene offset measured : ' + [off.offset.x, off.offset.y, off.offset.z].join(', '));
	L.push('animation key         : custom_data "' + cfg.anim_key + '"');
	if (cfg.cooldown_bar) L.push('cooldown bar key      : custom_data "' + cfg.cooldown_bar_key + '"');
	L.push('');
	L.push('Animations');
	let nodes = 0, naive = 0;
	animInfo.forEach(a => {
		nodes += a.nodes; naive += a.naiveNodes;
		L.push('  - ' + a.name + ': ' + a.ticks + ' tick playback, ' + a.frames + ' frames, ' + a.nodes + ' model nodes');
	});
	if (naive) {
		L.push('  total ' + nodes + ' nodes (naive frames x bones would be ' + naive + ', ' +
			Math.round((1 - nodes / naive) * 100) + '% saved by the per-bone dispatch)');
	}
	L.push('');
	L.push('Server side: see ' + ns + '_' + item + '.sk — set item_model, set the');
	L.push('custom_data key, start a vanilla cooldown. Nothing else.');
	L.push('');
	L.push('minecraft:cooldown counts DOWN from 1.0, so the LAST keyframe is what shows');
	L.push('while idle. 20 poses per second is the engine ceiling; to get more frames');
	L.push('make the cooldown longer, not the entry list.');
	if (warnings.length) {
		L.push('');
		L.push('Warnings');
		warnings.forEach(w => L.push('  ! ' + w));
	}
	return L.join('\n');
}

function exportPack() {
	if (!Project) return;
	if (typeof JSZip === 'undefined') {
		Blockbench.showMessageBox({ title: 'Firstperson Animation', message: 'JSZip is not available in this Blockbench build.' });
		return;
	}
	let result;
	try {
		result = buildPack();
	} catch (err) {
		console.error(err);
		Blockbench.showMessageBox({ title: 'Firstperson Animation — export failed', message: String((err && err.message) || err) });
		return;
	}

	const zip = new JSZip();
	for (const p in result.files) zip.file(p, result.files[p]);
	for (const p in result.binFiles) zip.file(p, result.binFiles[p], { base64: true });

	zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }).then(blob => {
		Blockbench.export({
			type: 'Resource Pack', extensions: ['zip'],
			name: result.ns + '_' + result.item + '_pack',
			content: blob, savetype: 'zip',
		}, () => {
			let msg = 'Exported ' + result.animInfo.length + ' animation(s) + Skript example.';
			if (result.warnings.length) msg += ' ' + result.warnings.length + ' warning(s) — see README.txt.';
			Blockbench.showQuickMessage(msg, 3500);
		});
	}).catch(err => {
		console.error(err);
		Blockbench.showMessageBox({ title: 'Firstperson Animation — zip failed', message: String((err && err.message) || err) });
	});
}

// ---------------------------------------------------------------------------
// timeline
// ---------------------------------------------------------------------------
//
// This plugin does NOT patch Timeline.setTime. An earlier version wrapped it to
// snap the playhead onto exported frames, and a single bad value slipping through
// poisoned Timeline.time — after which Animation.select() runs
// `Timeline.setTime(Timeline.time % this.length)`, keeps producing NaN, and
// animations can never be selected again for the rest of the session. Not worth
// it for a preview convenience.

function setTimelineTimeRaw(time) {
	Timeline.setTime(time, true);
}

/** undo a poisoned playhead from an older build of this plugin */
function repairTimeline() {
	try {
		if (typeof Timeline !== 'undefined' && !Number.isFinite(Timeline.time)) {
			Timeline.setTime(0, true);
			Blockbench.showQuickMessage('Timeline playhead was NaN — reset to 0.', 3000);
		}
	} catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// cooldown hider — the other half of the cooldown bar
// ---------------------------------------------------------------------------
//
// Vanilla sweeps its hotbar overlay every time the animation plays, because the
// animation IS a cooldown. Hiding it needs a core shader, and a core shader has
// to sit at the vanilla path assets/minecraft/shaders/core/gui.fsh — which is
// why this is a second, separate pack rather than part of the export.
//
// The shader is never shipped pre-made. Core shader sources change between
// versions and one that fails to compile takes the whole GUI down, so this
// patches the vanilla gui.fsh out of YOUR client jar.

function patchGuiShader(source) {
	if (/FIRSTPERSON ANIMATION/.test(source)) {
		throw new Error('That gui.fsh is already patched.');
	}
	// 26.3 writes it as `layout(location = 0) in vec4 vertexColor;`
	const varying = source.match(/^[^\S\n]*(?:layout\s*\([^)]*\)\s*)?in\s+vec4\s+(\w*[Cc]olor\w*)\s*;/m);
	if (!varying) {
		throw new Error('No "in vec4 <something>Color;" varying found in gui.fsh. ' +
			'The shader layout changed — patch it by hand instead.');
	}
	const main = source.match(/void\s+main\s*\(\s*\)\s*\{/);
	if (!main) throw new Error('No main() found in gui.fsh.');

	const name = varying[1];
	const snippet = '\n' +
		'    // --- FIRSTPERSON ANIMATION -------------------------------------------\n' +
		'    // The hotbar item cooldown overlay is a flat fill of ARGB 0x7FFFFFFF:\n' +
		'    // pure white at alpha 127/255. Drop exactly that colour so the merged\n' +
		'    // model in the item definition can draw the bar instead.\n' +
		'    if (' + name + '.r > 0.99 && ' + name + '.g > 0.99 && ' + name + '.b > 0.99 &&\n' +
		'        abs(' + name + '.a - 0.49803922) < 0.004) {\n' +
		'        discard;\n' +
		'    }\n' +
		'    // ---------------------------------------------------------------------\n';

	const at = main.index + main[0].length;
	return { source: source.slice(0, at) + snippet + source.slice(at), varying: name };
}

function generateCooldownHider() {
	if (typeof JSZip === 'undefined') {
		Blockbench.showMessageBox({ title: 'Firstperson Animation', message: 'JSZip is not available in this Blockbench build.' });
		return;
	}
	const cfg = settings();
	Blockbench.import({
		resource_id: 'fpa_client_jar',
		extensions: ['jar'],
		type: 'Minecraft client jar',
		readtype: 'buffer',
	}, files => {
		const file = files && files[0];
		if (!file || !file.content) return;

		JSZip.loadAsync(file.content).then(jar => {
			const entry = jar.file('assets/minecraft/shaders/core/gui.fsh');
			if (!entry) {
				const names = Object.keys(jar.files).filter(n => /shaders\/core\/.*\.fsh$/.test(n));
				throw new Error('assets/minecraft/shaders/core/gui.fsh is not in that file.' +
					(names.length ? '\n\nCore shaders present:\n  ' + names.slice(0, 12).join('\n  ')
						: '\n\nNo core shaders at all — is that really a client jar?'));
			}
			return entry.async('string');
		}).then(src => {
			const patched = patchGuiShader(src);
			const zip = new JSZip();
			zip.file('pack.mcmeta', JSON.stringify({
				pack: {
					description: 'Firstperson Animation - hides the vanilla hotbar cooldown overlay',
					min_format: cfg.min_format | 0,
					max_format: cfg.max_format | 0,
				},
			}, null, '\t'));
			zip.file('assets/minecraft/shaders/core/gui.fsh', patched.source);
			zip.file('README.txt', [
				'Cooldown Hider',
				'==============',
				'',
				'Discards the vanilla white hotbar cooldown overlay (ARGB 0x7FFFFFFF) in the',
				'gui core shader, so the replacement bar in the item definition is the only',
				'cooldown you see.',
				'',
				'Generated from : ' + (file.name || 'the client jar you picked'),
				'Colour varying : ' + patched.varying,
				'',
				'Load this pack ABOVE your Firstperson Animation pack.',
				'',
				'Blast radius: this hides that overlay for EVERY item, ender pearls and food',
				'included, not just yours.',
				'',
				'Core shaders are version specific. Regenerate this whenever you change',
				'Minecraft version, or it will either fail to compile or silently stop',
				'matching.',
			].join('\n'));
			return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
		}).then(blob => {
			Blockbench.export({
				type: 'Resource Pack', extensions: ['zip'],
				name: 'cooldown_hider', content: blob, savetype: 'zip',
			}, () => Blockbench.showQuickMessage('Cooldown hider pack written. Load it above your animation pack.', 4000));
		}).catch(err => {
			console.error(err);
			Blockbench.showMessageBox({
				title: 'Firstperson Animation — cooldown hider',
				message: String((err && err.message) || err),
			});
		});
	});
}

// ---------------------------------------------------------------------------
// first-person viewport
// ---------------------------------------------------------------------------
//
// Reproduces the IN-GAME first-person framing, not Blockbench's Display preview.
// Those are not the same thing: Display mode parks the camera dead centre at
// (0,24,32.4) and transforms the model instead, so it has no hand offset and the
// two hands look identical there. Minecraft actually places the item frame at
// (±0.56, -0.52, -0.72) blocks from the eye, x negated for the off hand, which is
// what puts the weapon in the lower right (or lower left).
//
//   view(p) = 16*C + T + Rd*s*(p - 8)     Blockbench units, p = model coords
//   p = q + offset                        q = scene coords
//   => camera world matrix = view^-1
//
// Only the CAMERA moves. The scene graph and the animation pose are untouched, so
// the exporter (which reads group.mesh.matrixWorld) is unaffected.
//
// Why a camera move reproduces the display transform at all: applying a similarity
// (rotation + uniform scale + translation) to the object and viewing from the
// origin gives the same image as leaving the object alone and viewing from the
// inverse similarity.

// ItemInHandRenderer: poseStack.translate(sign * 0.56F, -0.52F, -0.72F)
const HAND_FRAME_OFFSET = [0.56, -0.52, -0.72];

/** Identity slot, matching `new DisplaySlot()` — what Blockbench itself creates on first visit. */
function displaySlotOrDefault(key) {
	const slot = (Project && Project.display_settings) ? Project.display_settings[key] : null;
	if (slot) return { slot: slot, wasMissing: false };
	return {
		slot: { rotation: [0, 0, 0], translation: [0, 0, 0], scale: [1, 1, 1] },
		wasMissing: true,
	};
}

/**
 * Model space minus scene space. ModelFormat.select() sets
 * scene.position = (-block_size/2, 0, -block_size/2) for non-centered formats, so
 * world = model + scene.position and the offset is simply its negation. Reading it
 * beats measuring it from a root bone: no pose has to be disturbed.
 */
function sceneOffset() {
	if (typeof Canvas === 'undefined' || !Canvas.scene) return new THREE.Vector3(0, 0, 0);
	return Canvas.scene.position.clone().negate();
}

function applyFirstPersonCamera(slotKey) {
	if (!Project) return;
	const preview = (typeof Preview !== 'undefined') && Preview.selected;
	if (!preview || !preview.camera) {
		Blockbench.showQuickMessage('No 3D preview to aim.', 2000);
		return;
	}
	const key = slotKey || 'firstperson_righthand';
	const leftHand = key === 'firstperson_lefthand';
	const found = displaySlotOrDefault(key);
	const slot = found.slot;

	// ItemTransform.apply(leftHand, pose) mirrors the off hand for you: it negates
	// translation.x, rotation.y and rotation.z of whatever the display section says,
	// and ItemInHandRenderer flips the frame to -0.56 on x. That is why vanilla
	// writes the SAME numbers for both hands. Reproduce both effects here.
	const sign = leftHand ? -1 : 1;
	const rawRot = slot.rotation || [0, 0, 0];
	const rawTr = slot.translation || [0, 0, 0];
	const rot = leftHand ? [rawRot[0], -rawRot[1], -rawRot[2]] : rawRot;
	const tr = leftHand ? [-rawTr[0], rawTr[1], rawTr[2]] : rawTr;
	const scl = slot.scale || [1, 1, 1];
	const uniform = (scl[0] + scl[1] + scl[2]) / 3;
	if (Math.abs(scl[0] - scl[1]) > 1e-4 || Math.abs(scl[1] - scl[2]) > 1e-4) {
		Blockbench.showQuickMessage('Display scale is not uniform — framing is approximate.', 4000);
	}

	const offset = sceneOffset();
	const RAD = Math.PI / 180;
	// ItemTransform uses JOML rotationXYZ, i.e. Rx * Ry * Rz
	const A = new THREE.Matrix4()
		.makeRotationFromEuler(new THREE.Euler(rot[0] * RAD, rot[1] * RAD, rot[2] * RAD, 'XYZ'))
		.scale(new THREE.Vector3(uniform, uniform, uniform));

	const t = offset.clone().addScalar(-8).applyMatrix4(A)
		.add(new THREE.Vector3(HAND_FRAME_OFFSET[0] * sign, HAND_FRAME_OFFSET[1], HAND_FRAME_OFFSET[2]).multiplyScalar(16))
		.add(new THREE.Vector3(tr[0], tr[1], tr[2]));

	const camWorld = A.clone().setPosition(t).invert();
	const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), dropped = new THREE.Vector3();
	camWorld.decompose(pos, quat, dropped);

	try {
		if (preview.isOrtho && typeof preview.setProjectionMode === 'function') preview.setProjectionMode(false);
		preview.camera.position.copy(pos);
		preview.camera.quaternion.copy(quat);
		if (typeof preview.setFOV === 'function') preview.setFOV(70);
		else preview.camera.fov = 70;             // Minecraft's default vertical FOV
		preview.camera.updateProjectionMatrix();
		// give the orbit controls a sensible pivot in front of the eye so dragging
		// starts from here instead of snapping somewhere else
		if (preview.controls && preview.controls.target) {
			const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quat).multiplyScalar(24 / (uniform || 1));
			preview.controls.target.copy(pos.clone().add(forward));
		}
	} catch (e) {
		console.error(e);
		Blockbench.showQuickMessage('Could not move the camera — see the console.', 3000);
		return;
	}

	const hand = leftHand ? 'Left' : 'Right';
	Blockbench.showQuickMessage(found.wasMissing
		? hand + ' hand view — this slot had no transform, using defaults (rotation 0, translation 0, scale 1).'
		: hand + ' hand view.', 3500);
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

function openSettings() {
	if (!Project) return;
	const cfg = settings();
	new Dialog({
		id: 'fpa_settings',
		title: 'Firstperson Animation Settings',
		width: 560,
		form: {
			s1: { type: 'info', text: 'Output' },
			namespace: { label: 'Namespace', type: 'text', value: cfg.namespace },
			item_name: { label: 'Item model name', type: 'text', value: cfg.item_name },
			pack_description: { label: 'Pack description', type: 'text', value: cfg.pack_description },
			min_format: { label: 'min_format (26.1=84, 26.2=88, 26.3=93)', type: 'number', value: cfg.min_format, min: 1, max: 2147483647, step: 1 },
			max_format: { label: 'max_format', type: 'number', value: cfg.max_format, min: 1, max: 2147483647, step: 1 },

			s2: { type: 'info', text: 'Server contract (minecraft:custom_data)' },
			anim_key: { label: 'Animation key', type: 'text', value: cfg.anim_key },

			s3: { type: 'info', text: 'Baking' },
			fps: { label: 'Frames per second (20 = engine ceiling)', type: 'number', value: cfg.fps, min: 2, max: 20, step: 1 },
			playback_ticks: { label: 'Playback ticks (0 = timeline length)', type: 'number', value: cfg.playback_ticks, min: 0, max: 2000, step: 1 },
			max_frames: { label: 'Max frames per animation', type: 'number', value: cfg.max_frames, min: 2, max: 512, step: 1 },
			precision: { label: 'Decimal places', type: 'number', value: cfg.precision, min: 2, max: 8, step: 1 },

			s4: { type: 'info', text: 'Cooldown bar' },
			cooldown_bar: { label: 'Generate cooldown bar (vanilla look)', type: 'checkbox', value: cfg.cooldown_bar },
			cooldown_bar_key: { label: 'custom_data key', type: 'text', value: cfg.cooldown_bar_key },
		},
		onConfirm(form) {
			Object.assign(cfg, form);
			cfg.namespace = safeId(form.namespace);
			cfg.item_name = safeId(form.item_name);
			if (typeof Project !== 'undefined' && Project) Project.saved = false;
			this.hide();
		},
	}).show();
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

let format, actionExport, actionSettings, actionHider, actionCamR, actionCamL, projectProperty;

const CAMERA_ACTION_IDS = ['fpa_cam_right', 'fpa_cam_left'];

function timelineToolbar() {
	if (typeof Toolbars === 'undefined') return null;
	return Toolbars.timeline || Toolbars.animations || null;
}

/** Remove our buttons from the toolbar, including ones from a previous plugin load. */
function stripCameraButtons() {
	try {
		const bar = timelineToolbar();
		if (!bar || !bar.children) return;
		for (let i = bar.children.length - 1; i >= 0; i--) {
			const child = bar.children[i];
			if (child && CAMERA_ACTION_IDS.includes(child.id)) bar.children.splice(i, 1);
		}
		if (typeof bar.update === 'function') bar.update();
	} catch (e) { /* toolbar shape changed; nothing to clean */ }
}

Plugin.register(PLUGIN_ID, {
	title: 'Firstperson Animation',
	icon: 'pan_tool',
	author: '0codex',
	description: 'Author first-person item animations in Blockbench and bake them into a vanilla 26.1+ resource pack. Server side it is just item_model + custom_data + a vanilla cooldown.',
	version: PLUGIN_VERSION,
	min_version: '4.9.0',
	variant: 'both',
	tags: ['Minecraft: Java Edition', 'Animation', 'Item Models'],

	onload() {
		if (typeof Property !== 'undefined') {
			projectProperty = new Property(ModelProject, 'object', 'fpa_settings');
		}

		format = new ModelFormat({
			id: PLUGIN_ID,
			name: 'Firstperson Animation',
			description: 'Animated first-person item model for a vanilla 26.1+ resource pack',
			icon: 'pan_tool',
			category: 'minecraft',
			target: ['Minecraft: Java Edition'],
			show_on_start_screen: true,

			// spelled out rather than relying on defaults, so a Blockbench default
			// change cannot silently alter how this format behaves
			box_uv: false,
			optional_box_uv: true,
			single_texture: false,
			model_identifier: false,
			parent_model_id: false,
			centered_grid: false,
			integer_size: false,
			stretch_cubes: false,
			meshes: false,
			locators: false,
			pose_mode: false,
			animation_files: false,
			animation_controllers: false,
			animated_textures: true,
			bone_rig: true,
			rotate_cubes: true,
			rotation_limit: true,
			uv_rotation: true,
			java_face_properties: true,
			java_cube_shading_properties: true,
			select_texture_for_particles: true,
			texture_mcmeta: true,
			cullfaces: true,
			display_mode: true,
			animation_mode: true,
			edit_mode: true,
			paint_mode: true,
			render_sides: 'front',

			onSetup(project, newModel) {
				if (!project.fpa_settings || typeof project.fpa_settings !== 'object') {
					project.fpa_settings = Object.assign({}, DEFAULTS);
				}
				if (newModel) {
					project.texture_width = project.texture_width || 16;
					project.texture_height = project.texture_height || 16;
				}
			},
			onActivation() { repairTimeline(); },
		});

		const inFormat = () => typeof Format !== 'undefined' && Format && Format.id === PLUGIN_ID;

		actionSettings = new Action('fpa_settings', {
			name: 'Firstperson Animation Settings...',
			description: 'Namespace, custom_data keys, frame budget',
			icon: 'tune', condition: inFormat, click: openSettings,
		});
		actionExport = new Action('fpa_export', {
			name: 'Export Firstperson Animation Pack',
			description: 'Bake every animation into a resource pack + a Skript example',
			icon: 'pan_tool', condition: inFormat, click: exportPack,
		});
		actionHider = new Action('fpa_cooldown_hider', {
			name: 'Generate Cooldown Hider Pack...',
			description: 'Patches the vanilla gui.fsh out of your own client jar into a second pack that hides the hotbar cooldown overlay',
			icon: 'blur_on', condition: inFormat, click: generateCooldownHider,
		});
		actionCamR = new Action('fpa_cam_right', {
			name: 'First Person Camera (Right Hand)',
			description: 'Aim the viewport at the player eye so you animate against the real framing',
			icon: 'photo_camera', condition: inFormat,
			keybind: new Keybind({ key: 'f', shift: true }),
			click() { applyFirstPersonCamera('firstperson_righthand'); },
		});
		actionCamL = new Action('fpa_cam_left', {
			name: 'First Person Camera (Left Hand)',
			description: 'Same for the off hand, including the mirroring vanilla applies',
			icon: 'flip', condition: inFormat,
			keybind: new Keybind({ key: 'g', shift: true }),
			click() { applyFirstPersonCamera('firstperson_lefthand'); },
		});
		MenuBar.addAction(actionSettings, 'file.export');
		MenuBar.addAction(actionExport, 'file.export');
		MenuBar.addAction(actionHider, 'file.export');
		MenuBar.addAction(actionCamR, 'view');
		MenuBar.addAction(actionCamL, 'view');

		// The camera belongs where you are actually animating, not buried in View.
		// Strip any copy left behind by an earlier load first — Action.delete() does not
		// pull the button off a toolbar, so reloading the plugin used to stack duplicates.
		stripCameraButtons();
		try {
			const bar = timelineToolbar();
			if (bar && typeof bar.add === 'function') {
				bar.add(actionCamR, -1);
				bar.add(actionCamL, -1);
			}
		} catch (e) { console.warn('Could not place the camera actions on the timeline toolbar', e); }

		repairTimeline();
	},

	onunload() {
		stripCameraButtons();
		[actionExport, actionSettings, actionHider, actionCamR, actionCamL, format, projectProperty].forEach(x => {
			if (x && typeof x.delete === 'function') x.delete();
		});
	},
});

})();
