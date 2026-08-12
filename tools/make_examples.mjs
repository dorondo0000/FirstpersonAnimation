/**
 * Generates the example resource pack and the matching .bbmodel sources.
 *
 *   node tools/make_examples.mjs
 *
 * This is also the readable reference implementation of what the Blockbench
 * plugin emits: same frame clock, same transformation math, same JSON shape.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = join(ROOT, 'examples', 'fpa_examples');
const SRC = join(ROOT, 'examples', 'bbmodel');

const NS = 'fpa';
// pack.mcmeta since 1.21.9-ish: a pack declaring support for anything newer than
// format 64 MUST use min_format/max_format and may drop pack_format entirely.
// Vanilla's own bundled datapacks are written exactly this way.
// resource_major per version: 26.1 = 84, 26.2 = 88, 26.3-snapshot-5 = 93.
const MIN_FORMAT = 84;
const MAX_FORMAT = 93;
const COOLDOWN_BAR_KEY = 'fpa_bar'; // custom_data key that switches the replacement bar on
const ANIM_KEY = 'fpa';             // custom_data key holding the animation name
const PRECISION = 5;

// pivot of the item-model `transformation`, in model units.
// 'corner' = (0,0,0), 'center' = (8,8,8). See docs/calibration.md
const PIVOT = process.env.FPA_PIVOT === 'center' ? [8, 8, 8] : [0, 0, 0];

// ---------------------------------------------------------------------------
// tiny math
// ---------------------------------------------------------------------------

const DEG = Math.PI / 180;
const rnd = (v, p = PRECISION) => {
	const f = 10 ** p;
	const r = Math.round(v * f) / f;
	return Object.is(r, -0) ? 0 : r;
};

/** column-major 3x3, m[col][row] flattened as [r0c0,r0c1,r0c2, r1c0,...] (row-major here) */
const mat3 = {
	identity: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
	mul: (a, b) => {
		const out = new Array(9).fill(0);
		for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
			let s = 0;
			for (let k = 0; k < 3; k++) s += a[r * 3 + k] * b[k * 3 + c];
			out[r * 3 + c] = s;
		}
		return out;
	},
	apply: (m, v) => [
		m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
		m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
		m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
	],
	rotX: d => { const c = Math.cos(d * DEG), s = Math.sin(d * DEG); return [1, 0, 0, 0, c, -s, 0, s, c]; },
	rotY: d => { const c = Math.cos(d * DEG), s = Math.sin(d * DEG); return [c, 0, s, 0, 1, 0, -s, 0, c]; },
	rotZ: d => { const c = Math.cos(d * DEG), s = Math.sin(d * DEG); return [c, -s, 0, s, c, 0, 0, 0, 1]; },
	scale: (x, y, z) => [x, 0, 0, 0, y, 0, 0, 0, z],
};

/** rotation matrix -> quaternion [x,y,z,w] */
function matToQuat(m) {
	const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
	const tr = m00 + m11 + m22;
	let x, y, z, w;
	if (tr > 0) {
		const s = Math.sqrt(tr + 1) * 2;
		w = 0.25 * s; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s;
	} else if (m00 > m11 && m00 > m22) {
		const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
		w = (m21 - m12) / s; x = 0.25 * s; y = (m01 + m10) / s; z = (m02 + m20) / s;
	} else if (m11 > m22) {
		const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
		w = (m02 - m20) / s; x = (m01 + m10) / s; y = 0.25 * s; z = (m12 + m21) / s;
	} else {
		const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
		w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = 0.25 * s;
	}
	if (w < 0) { x = -x; y = -y; z = -z; w = -w; }
	return [x, y, z, w];
}

const EPS = 1e-5;

/**
 * model-space affine  v' = (rot*diag(scale))*v + tModel  ->  minecraft `transformation`
 *   v'_local = t_mc + L*S*R * v_local, with v_local = (v - pivot)/16
 *   => t_mc = (rot*diag(scale)*pivot + tModel - pivot) / 16
 */
function toTransformation(rot, scale, tModel) {
	const p = PIVOT;
	const full = mat3.mul(rot, mat3.scale(scale[0], scale[1], scale[2]));
	const lp = mat3.apply(full, p);
	const t = [0, 1, 2].map(i => (lp[i] + tModel[i] - p[i]) / 16);
	const q = matToQuat(rot);

	const movedT = t.some(v => Math.abs(v) >= EPS);
	const movedR = Math.abs(q[0]) >= EPS || Math.abs(q[1]) >= EPS || Math.abs(q[2]) >= EPS || Math.abs(q[3] - 1) >= EPS;
	const movedS = scale.some(v => Math.abs(v - 1) >= EPS);

	// The `transformation` field itself is optional, but once present the decomposed
	// form requires ALL FOUR keys — a partial one is rejected with
	// "No key right_rotation in MapLike[...]". Vanilla's own item definitions spell
	// out every identity value for exactly this reason.
	if (!movedT && !movedR && !movedS) return null;

	return {
		translation: t.map(v => rnd(v)),
		left_rotation: q.map(v => rnd(v)),
		scale: scale.map(v => rnd(v)),
		right_rotation: [0, 0, 0, 1],
	};
}

/**
 * A bone pose expressed the way an animator thinks about it:
 * rotate by `rot` (model-space degrees, applied Z then Y then X) around the bone
 * pivot, then translate by `pos` (model units).
 */
function poseToAffine(pivot, rot = [0, 0, 0], pos = [0, 0, 0], scale = [1, 1, 1]) {
	let linear = mat3.identity();
	if (rot[0]) linear = mat3.mul(linear, mat3.rotX(rot[0]));
	if (rot[1]) linear = mat3.mul(linear, mat3.rotY(rot[1]));
	if (rot[2]) linear = mat3.mul(linear, mat3.rotZ(rot[2]));
	const scaled = mat3.mul(linear, mat3.scale(scale[0], scale[1], scale[2]));
	// v' = scaled*(v - pivot) + pivot + pos
	const lp = mat3.apply(scaled, pivot);
	const tModel = [0, 1, 2].map(i => pivot[i] - lp[i] + pos[i]);
	return { linear, scaled, tModel };
}

function boneTransformation(pivot, rot, pos, scale = [1, 1, 1]) {
	const { linear, tModel } = poseToAffine(pivot, rot, pos, scale);
	return toTransformation(linear, scale, tModel);
}

// ---------------------------------------------------------------------------
// PNG writer (RGBA8)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([len, body, crc]);
}

function encodePNG(width, height, rgba) {
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0; // filter: none
		rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;  // bit depth
	ihdr[9] = 6;  // colour type: RGBA
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function makeCanvas(w, h) {
	const buf = Buffer.alloc(w * h * 4, 0);
	return {
		w, h, buf,
		rect(x0, y0, x1, y1, [r, g, b, a = 255]) {
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
				const i = (y * w + x) * 4;
				buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
			}
			return this;
		},
		checker(x0, y0, x1, y1, [r, g, b, a = 255]) {
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
				if ((x + y) % 2) continue;
				const i = (y * w + x) * 4;
				buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
			}
			return this;
		},
		png() { return encodePNG(w, h, buf); },
	};
}

// ---------------------------------------------------------------------------
// item model definition helpers  (mirrors the plugin)
// ---------------------------------------------------------------------------

const EMPTY = { type: 'minecraft:empty' };

function modelRef(path, transformation) {
	const n = { type: 'minecraft:model', model: path };
	if (transformation) n.transformation = transformation;
	return n;
}

function composite(models) {
	const list = models.filter(Boolean);
	if (!list.length) return EMPTY;
	if (list.length === 1) return list[0];
	return { type: 'minecraft:composite', models: list };
}

/**
 * Playback clocks. Every one of these was read out of the 26.3-snapshot-5 client
 * jar; see docs/clocks.md for the full survey.
 *
 * `descending` means the property runs 1 -> 0 during playback, so entry j maps to
 * frame N-1-j and the rest pose has to be the LAST keyframe. Ascending clocks map
 * entry j to frame j, so their rest pose is the FIRST keyframe.
 */
const CLOCKS = {
	// remaining cooldown, 1.0 -> 0.0. Normalised, and the only clock that feeds a
	// partial tick into its source call, so the only one that is sub-tick smooth.
	cooldown: anim => ({
		node: { type: 'minecraft:range_dispatch', property: 'minecraft:cooldown' },
		descending: true,
	}),
	// ticks the item has been in use, counting up. Integer ticks, so 20 fps.
};

/**
 * One dispatch per bone instead of one dispatch over whole-rig composites.
 *
 * The naive shape is `range_dispatch -> composite(every bone)`, which costs
 * frames x bones nodes. Giving each bone its own dispatch costs only the number
 * of poses that bone actually takes: a bone that holds still for half the
 * animation collapses those frames into a single entry, and a bone that never
 * moves collapses to a plain model reference with no dispatch at all.
 */
function boneTrack(path, tfs, clock) {
	const n = tfs.length;
	const entries = [];
	let prevKey = null;
	for (let j = 0; j < n; j++) {
		const tf = tfs[clock.descending ? n - 1 - j : j];
		const key = JSON.stringify(tf ?? null);
		if (key === prevKey) continue;
		prevKey = key;
		entries.push({ threshold: rnd(j / n, 6), model: modelRef(path, tf) });
	}
	if (entries.length === 1) return entries[0].model;
	return { ...clock.node, entries, fallback: entries[0].model };
}

/**
 * Does the rig actually fit on screen in first person?
 *
 * ItemInHandRenderer places the item frame at (0.56, -0.52, -0.72) blocks from
 * the camera, then the display transform runs and the 0..1 model box is centred
 * with translate(-0.5,-0.5,-0.5). So for a model point p in 0..16 units:
 *
 *     view = camOffset + translation/16 + R * S * (p/16 - 0.5)
 *
 * Checked against a 70 degrees vertical FOV at 16:9. This is the check that was
 * missing when the examples first shipped with the vanilla `handheld` transform.
 */
function checkFirstPersonFraming(rig) {
	const slot = rig.display.firstperson_righthand;
	if (!slot) return ['no firstperson_righthand display transform'];
	const cam = [0.56, -0.52, -0.72];
	const T = (slot.translation || [0, 0, 0]).map(v => v / 16);
	const S = slot.scale || [1, 1, 1];
	const [rx, ry, rz] = slot.rotation || [0, 0, 0];
	// ItemTransform uses JOML rotationXYZ, i.e. Rx * Ry * Rz
	const R = mat3.mul(mat3.mul(mat3.rotX(rx), mat3.rotY(ry)), mat3.rotZ(rz));

	const tanHalf = Math.tan(35 * DEG);
	const aspect = 16 / 9;
	const issues = [];
	let minZ = -Infinity, worstX = 0, worstY = 0;

	for (const bone of rig.bones) {
		for (const cube of bone.cubes) {
			for (let i = 0; i < 8; i++) {
				const p = [
					(i & 1 ? cube.to : cube.from)[0],
					(i & 2 ? cube.to : cube.from)[1],
					(i & 4 ? cube.to : cube.from)[2],
				];
				const q = [0, 1, 2].map(k => p[k] / 16 - 0.5);
				const scaled = [0, 1, 2].map(k => q[k] * S[k]);
				const r = mat3.apply(R, scaled);
				const v = [0, 1, 2].map(k => cam[k] + T[k] + r[k]);
				minZ = Math.max(minZ, v[2]);
				const depth = Math.abs(v[2]);
				worstX = Math.max(worstX, Math.abs(v[0]) / (depth * tanHalf * aspect));
				worstY = Math.max(worstY, Math.abs(v[1]) / (depth * tanHalf));
			}
		}
	}
	if (minZ > -0.05) issues.push(`geometry reaches z=${minZ.toFixed(2)} (at or behind the camera)`);
	if (worstX > 1) issues.push(`${Math.round((worstX - 1) * 100)}% past the left/right edge`);
	if (worstY > 1) issues.push(`${Math.round((worstY - 1) * 100)}% past the top/bottom edge`);
	return issues;
}

function countModelNodes(node) {
	if (!node || typeof node !== 'object') return 0;
	let n = node.type === 'minecraft:model' ? 1 : 0;
	for (const k of Object.keys(node)) {
		const v = node[k];
		if (Array.isArray(v)) v.forEach(x => { n += countModelNodes(x); });
		else if (v && typeof v === 'object') n += countModelNodes(v);
	}
	return n;
}

/**
 * Animation switching, entirely through minecraft:custom_data.
 *
 * The `minecraft:component` CONDITION runs a DataComponentPredicate, so unlike
 * the select property it matches PARTIALLY — the server keeps whatever else it
 * likes in custom_data. `predicate` is the predicate type id (a string) and the
 * match data lives in `value`, straight out of
 * ComponentMatches.MAP_CODEC = DataComponentPredicate.singleCodec("predicate").
 */
function animationSelect(cases, fallback) {
	if (cases.length <= 1) return cases[0]?.model ?? fallback;
	let node = fallback;
	for (let i = cases.length - 1; i >= 0; i--) {
		node = {
			type: 'minecraft:condition',
			property: 'minecraft:component',
			predicate: 'minecraft:custom_data',
			value: { [ANIM_KEY]: cases[i].name },
			on_true: cases[i].model,
			on_false: node,
		};
	}
	return node;
}

/**
 * Straight from GuiGraphicsExtractor in 26.3:
 *
 *   if (f > 0.0F) {
 *       int top    = y + Mth.floor(16.0F * (1.0F - f));
 *       int bottom = top + Mth.ceil(16.0F * f);
 *       fill(RenderPipelines.GUI, x, top, x + 16, bottom, 0x7FFFFFFF);
 *   }
 *
 * White at alpha 127/255, bottom aligned, height ceil(16f) PIXELS — 17 possible
 * looks and no others, so there is nothing to configure. range_dispatch closes its
 * intervals on the left while ceil() wants them closed on the right, so each
 * threshold sits a hair past (px-1)/16 to reproduce ceil() exactly.
 */
function cooldownBar(modelPath) {
	const PX = 16, EPS = 1e-6;
	const entries = [{ threshold: 0, model: EMPTY }];
	for (let px = 1; px <= PX; px++) {
		entries.push({
			threshold: rnd((px - 1) / PX + EPS, 8),
			model: modelRef(modelPath, toTransformation(mat3.identity(), [1, px / PX, 1], [0, 0, 0])),
		});
	}
	// `minecraft:component` condition -> DataComponentPredicate.singleCodec("predicate"),
	// i.e. Type.CODEC.dispatchMap("predicate", ...) with the dispatched value under
	// "value". So `predicate` holds the predicate TYPE ID as a string and the match
	// data goes in `value`. Being a real predicate it matches PARTIALLY, so other
	// custom_data keys on the item are ignored and omitting the key means "off".
	// custom_model_data.flags would work too, but flags slots are scarce and shared.
	return {
		type: 'minecraft:condition',
		property: 'minecraft:component',
		predicate: 'minecraft:custom_data',
		value: { [COOLDOWN_BAR_KEY]: true },
		on_true: { type: 'minecraft:range_dispatch', property: 'minecraft:cooldown', entries, fallback: EMPTY },
		on_false: EMPTY,
	};
}

// ---------------------------------------------------------------------------
// rig definition -> pack + bbmodel
// ---------------------------------------------------------------------------

/** linear interpolation over a keyframe track */
function sampleTrack(track, t) {
	if (!track || !track.length) return { rot: [0, 0, 0], pos: [0, 0, 0], scale: [1, 1, 1] };
	if (t <= track[0].t) return norm(track[0]);
	if (t >= track[track.length - 1].t) return norm(track[track.length - 1]);
	for (let i = 0; i < track.length - 1; i++) {
		const a = track[i], b = track[i + 1];
		if (t >= a.t && t <= b.t) {
			const k = (b.t - a.t) === 0 ? 0 : (t - a.t) / (b.t - a.t);
			const A = norm(a), B = norm(b);
			return {
				rot: [0, 1, 2].map(j => A.rot[j] + (B.rot[j] - A.rot[j]) * k),
				pos: [0, 1, 2].map(j => A.pos[j] + (B.pos[j] - A.pos[j]) * k),
				scale: [0, 1, 2].map(j => A.scale[j] + (B.scale[j] - A.scale[j]) * k),
			};
		}
	}
	return norm(track[track.length - 1]);
}

function norm(kf) {
	return { rot: kf.rot || [0, 0, 0], pos: kf.pos || [0, 0, 0], scale: kf.scale || [1, 1, 1] };
}

function buildItem(rig) {
	const files = {};
	const modelDir = `item/${rig.name}`;
	const texRef = `${NS}:${modelDir}/${rig.texture}`;
	const textures = { 0: texRef, particle: texRef };

	// one model file per bone
	const partPath = {};
	for (const bone of rig.bones) {
		partPath[bone.name] = `${NS}:${modelDir}/parts/${bone.name}`;
		files[`assets/${NS}/models/${modelDir}/parts/${bone.name}.json`] = {
			credit: 'Firstperson Animation example',
			texture_size: [16, 16],
			textures,
			elements: bone.cubes,
			display: rig.display,
		};
	}

	const restModel = composite(rig.bones.map(b => modelRef(partPath[b.name])));

	// each animation becomes one branch of the custom_model_data select
	const cases = [];
	const info = [];
	for (const anim of rig.animations) {
		// Every clock is an integer tick counter (Cooldown passes partialTick=0.0F,
		// UseDuration reads getUseItemRemainingTicks():I), so a D-tick animation only
		// ever takes D+1 distinct values. More entries than that are unreachable.
		const frames = anim.framesOverride || Math.round(anim.length * 20) + 1;
		const clock = CLOCKS[anim.clock || 'cooldown'](anim);

		const layers = rig.bones.map(b => {
			const track = anim.tracks[b.name];
			if (!track || !track.length) return modelRef(partPath[b.name]);
			const tfs = [];
			for (let i = 0; i < frames; i++) {
				const s = sampleTrack(track, (i / (frames - 1)) * anim.length);
				tfs.push(boneTransformation(b.origin, s.rot, s.pos, s.scale));
			}
			return boneTrack(partPath[b.name], tfs, clock);
		});

		cases.push({ name: anim.name, model: composite(layers) });
		info.push({
			name: anim.name,
			frames,
			length: anim.length,
			ticks: Math.round(anim.length * 20),
			clock: anim.clock || 'cooldown',
			nodes: countModelNodes(composite(layers)),
		});
	}

	// gui: rest pose plus the optional replacement cooldown bar
	const guiLayers = [restModel];
	if (rig.cooldown_bar) {
		files[`assets/${NS}/models/${modelDir}/cooldown_bar.json`] = {
			texture_size: [16, 16],
			textures: {
				0: `${NS}:${modelDir}/_cooldown_overlay`,
				particle: `${NS}:${modelDir}/_cooldown_overlay`,
			},
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
		guiLayers.push(cooldownBar(`${NS}:${modelDir}/cooldown_bar`));
	}

	files[`assets/${NS}/items/${rig.name}.json`] = {
		hand_animation_on_swap: false,
		// the model identity changes every tick the cooldown advances; without this
		// vanilla plays its equip bob on each change
		swap_animation_scale: 0,
		model: {
			type: 'minecraft:select',
			property: 'minecraft:display_context',
			cases: [
				{ when: ['firstperson_righthand', 'firstperson_lefthand'], model: animationSelect(cases, restModel) },
				{ when: ['gui'], model: composite(guiLayers) },
			],
			fallback: restModel,
		},
	};

	return { files, info };
}

// ---------------------------------------------------------------------------
// .bbmodel writer
// ---------------------------------------------------------------------------

let uuidCounter = 0;
function uuid() {
	// deterministic so regenerating does not churn the files
	uuidCounter++;
	const hex = (n, len) => n.toString(16).padStart(len, '0');
	return `${hex(uuidCounter, 8)}-0000-4000-8000-${hex(uuidCounter, 12)}`;
}

function toBBModel(rig, textureBase64) {
	uuidCounter = 0;
	const elements = [];
	const outliner = [];

	for (const bone of rig.bones) {
		const childUuids = [];
		for (const cube of bone.cubes) {
			const id = uuid();
			childUuids.push(id);
			const el = {
				name: cube.name || 'cube',
				box_uv: false,
				rescale: false,
				locked: false,
				render_order: 'default',
				allow_mirror_modeling: true,
				from: cube.from,
				to: cube.to,
				autouv: 0,
				color: 0,
				origin: cube.rotation ? cube.rotation.origin : bone.origin,
				faces: Object.fromEntries(Object.entries(cube.faces).map(([k, f]) => [k, {
					uv: f.uv, texture: 0, rotation: f.rotation || 0,
				}])),
				uuid: id,
				type: 'cube',
			};
			if (cube.rotation) {
				const r = [0, 0, 0];
				r['xyz'.indexOf(cube.rotation.axis)] = cube.rotation.angle;
				el.rotation = r;
			}
			elements.push(el);
		}
		outliner.push({
			name: bone.name,
			origin: bone.origin,
			color: 0,
			uuid: uuid(),
			export: true,
			mirror_uv: false,
			isOpen: true,
			locked: false,
			visibility: true,
			autouv: 0,
			children: childUuids,
		});
	}

	// Blockbench bone-animation convention: X and Y rotation are negated and X
	// position is negated relative to model space, so convert back here.
	const animations = rig.animations.map(anim => {
		const animators = {};
		for (const bone of rig.bones) {
			const track = anim.tracks[bone.name];
			if (!track || !track.length) continue;
			const group = outliner.find(o => o.name === bone.name);
			const usesRot = track.some(kf => (kf.rot || []).some(v => v !== 0));
			const usesPos = track.some(kf => (kf.pos || []).some(v => v !== 0));
			const usesScale = track.some(kf => (kf.scale || []).some(v => v !== 1));
			const keyframes = [];
			for (const kf of track) {
				const k = norm(kf);
				const push = (channel, xyz) => keyframes.push({
					channel,
					data_points: [{ x: String(xyz[0]), y: String(xyz[1]), z: String(xyz[2]) }],
					uuid: uuid(), time: kf.t, color: -1, interpolation: 'linear',
				});
				// Blockbench's bone-animation convention negates X and Y rotation and
				// X position relative to model space, so convert back here.
				if (usesRot) push('rotation', [-k.rot[0], -k.rot[1], k.rot[2]]);
				if (usesPos) push('position', [-k.pos[0], k.pos[1], k.pos[2]]);
				if (usesScale) push('scale', k.scale);
			}
			animators[group.uuid] = { name: bone.name, type: 'bone', keyframes };
		}
		return {
			uuid: uuid(),
			name: anim.name,
			loop: 'once',
			override: false,
			length: anim.length,
			snapping: 20,
			selected: false,
			saved: true,
			path: '',
			anim_time_update: '',
			blend_weight: '',
			start_delay: '',
			loop_delay: '',
			animators,
		};
	});

	return {
		meta: {
			format_version: '4.10',
			model_format: 'firstperson_animation',
			box_uv: false,
		},
		name: rig.name,
		model_identifier: '',
		visible_box: [1, 1, 0],
		variable_placeholders: '',
		variable_placeholder_buttons: [],
		timeline_setups: [],
		unhandled_root_fields: {},
		resolution: { width: 16, height: 16 },
		fpa_settings: {
			namespace: NS,
			item_name: rig.name,
			min_format: MIN_FORMAT,
			max_format: MAX_FORMAT,
			fps: 20,
			pivot: PIVOT[0] === 0 ? 'corner' : 'center',
			cooldown_bar: !!rig.cooldown_bar,
			branch_property: 'custom_model_data',
		},
		elements,
		outliner,
		textures: [{
			path: '',
			name: `${rig.texture}.png`,
			folder: `item/${rig.name}`,
			namespace: NS,
			id: '0',
			group: '',
			width: 16,
			height: 16,
			uv_width: 16,
			uv_height: 16,
			particle: true,
			use_as_default: false,
			layers_enabled: false,
			sync_to_project: '',
			render_mode: 'default',
			render_sides: 'auto',
			frame_time: 1,
			frame_order_type: 'loop',
			frame_order: '',
			frame_interpolate: false,
			visible: true,
			internal: true,
			saved: false,
			uuid: uuid(),
			relative_path: '',
			source: `data:image/png;base64,${textureBase64}`,
		}],
		display: rig.display,
		animations,
	};
}

// ---------------------------------------------------------------------------
// the rigs
// ---------------------------------------------------------------------------

// texture atlas layout (16x16):
//   0..4   x 0..4  dark   (frame)
//   4..8   x 0..4  light  (slide)
//   8..12  x 0..4  mid    (magazine)
//   12..16 x 0..4  black  (muzzle / details)
//   0..8   x 8..16 wood   (minimal example)
const pistolTexture = makeCanvas(16, 16)
	.rect(0, 0, 4, 4, [58, 60, 66])
	.rect(4, 0, 8, 4, [116, 120, 128])
	.rect(8, 0, 12, 4, [92, 74, 52])
	.rect(12, 0, 16, 4, [24, 24, 26])
	.rect(0, 4, 8, 8, [40, 42, 46])
	.rect(8, 4, 16, 8, [150, 154, 162])
	.rect(0, 8, 8, 16, [124, 96, 58])
	.rect(8, 8, 16, 16, [180, 60, 55]);

// Partial alpha on item textures works (verified in game on 26.3), so this is
// literally vanilla's overlay colour: ARGB 0x7FFFFFFF = white at alpha 127/255.
const overlayTexture = makeCanvas(16, 16).rect(0, 0, 16, 16, [255, 255, 255, 127]);

const UV = {
	frame: [0, 0, 4, 4],
	slide: [4, 0, 8, 4],
	mag: [8, 0, 12, 4],
	dark: [12, 0, 16, 4],
	body: [0, 4, 8, 8],
	metal: [8, 4, 16, 8],
	wood: [0, 8, 8, 16],
	red: [8, 8, 16, 16],
};

function box(from, to, uvKey, name) {
	const faces = {};
	for (const f of ['north', 'east', 'south', 'west', 'up', 'down']) {
		faces[f] = { uv: UV[uvKey], texture: '#0' };
	}
	return { name, from, to, faces };
}

// First-person display transform shared by every part of a weapon rig.
//
// NOT the vanilla `handheld` transform: that one is built for flat sprites and
// its [0,-90,25] rotation turns a forward-pointing 3D model sideways, throwing
// it off the edge of the screen. These rigs are authored pointing along -Z
// (muzzle at low z, grip at high z), which is already "into the screen" in the
// first-person item frame, so no rotation is needed at all.
//
// These numbers are not eyeballed — checkFirstPersonFraming() below projects every
// cube corner through this transform and reports how close it gets to the edge of
// a 70 degrees / 16:9 frustum. T=[2,4,-8] at scale 0.6 leaves about 24% margin on
// the worst axis for all three weapon rigs.
const HAND_DISPLAY = {
	// Both hands carry the SAME numbers on purpose: ItemTransform.apply(leftHand, ...)
	// already negates translation.x / rotation.y / rotation.z for the off hand, and
	// ItemInHandRenderer flips the frame to -0.56 on x. Writing mirrored values here
	// too would cancel that out. Vanilla's item/generated does exactly this.
	firstperson_righthand: { rotation: [0, 0, 0], translation: [2, 4, -8], scale: [0.6, 0.6, 0.6] },
	firstperson_lefthand: { rotation: [0, 0, 0], translation: [2, 4, -8], scale: [0.6, 0.6, 0.6] },
	thirdperson_righthand: { rotation: [0, -90, 0], translation: [0, 4, 1], scale: [0.7, 0.7, 0.7] },
	thirdperson_lefthand: { rotation: [0, 90, 0], translation: [0, 4, 1], scale: [0.7, 0.7, 0.7] },
	gui: { rotation: [0, -90, 0], translation: [0, 0, 0], scale: [0.8, 0.8, 0.8] },
	ground: { rotation: [0, 0, 0], translation: [0, 3, 0], scale: [0.5, 0.5, 0.5] },
	fixed: { rotation: [0, -90, 0], translation: [0, 0, 0], scale: [0.9, 0.9, 0.9] },
};


const PISTOL = {
	name: 'pistol',
	texture: 'pistol',
	cooldown_bar: true,
	display: HAND_DISPLAY,
	bones: [
		{
			name: 'frame',
			origin: [8, 4, 10],
			cubes: [
				box([6, 3, 4], [10, 6, 12], 'body', 'receiver'),
				box([6.5, 0, 8], [9.5, 3.5, 12], 'frame', 'grip'),
				box([7, 4, 0], [9, 5.5, 5], 'dark', 'barrel'),
			],
		},
		{
			name: 'slide',
			origin: [8, 6, 10],
			cubes: [box([6, 6, 3], [10, 8, 12], 'slide', 'slide')],
		},
		{
			name: 'mag',
			origin: [8, 3.5, 10],
			cubes: [box([6.75, 0.5, 8.5], [9.25, 3.5, 11.5], 'mag', 'magazine')],
		},
	],
	animations: [
		{
			// 0.4s recoil: whole gun kicks up and back, slide cycles once,
			// last keyframe returns to the rest pose (idle shows the last frame).
			name: 'fire',
			length: 0.4,
			tracks: {
				frame: [
					{ t: 0.0, rot: [0, 0, 0], pos: [0, 0, 0] },
					{ t: 0.05, rot: [12, 0, 0], pos: [0, 0.6, 2.2] },
					{ t: 0.15, rot: [6, 0, 0], pos: [0, 0.3, 1.0] },
					{ t: 0.4, rot: [0, 0, 0], pos: [0, 0, 0] },
				],
				slide: [
					{ t: 0.0, pos: [0, 0, 0] },
					{ t: 0.06, pos: [0, 0, 4] },
					{ t: 0.18, pos: [0, 0, 0] },
					{ t: 0.4, pos: [0, 0, 0] },
				],
			},
		},
		{
			// 1.4s reload: gun tilts toward the camera, magazine drops and returns.
			name: 'reload',
			length: 1.4,
			tracks: {
				frame: [
					{ t: 0.0, rot: [0, 0, 0], pos: [0, 0, 0] },
					{ t: 0.25, rot: [-18, 22, 8], pos: [-1.5, -2.5, 1.5] },
					{ t: 1.0, rot: [-18, 22, 8], pos: [-1.5, -2.5, 1.5] },
					{ t: 1.4, rot: [0, 0, 0], pos: [0, 0, 0] },
				],
				mag: [
					{ t: 0.0, pos: [0, 0, 0] },
					{ t: 0.2, pos: [0, 0, 0] },
					{ t: 0.5, pos: [0, -14, 0] },
					{ t: 0.6, pos: [0, -14, 0] },
					{ t: 0.95, pos: [0, 0, 0] },
					{ t: 1.4, pos: [0, 0, 0] },
				],
			},
		},
	],
};

const MINIMAL = {
	name: 'minimal',
	texture: 'pistol',
	cooldown_bar: false,
	display: HAND_DISPLAY,
	bones: [
		{
			// chunky and pointing forward, so the swing is unmistakable on screen
			name: 'stick',
			origin: [8, 4, 13],
			cubes: [box([6, 2, 1], [10, 6, 13], 'wood', 'stick')],
		},
	],
	animations: [
		{
			// the smallest useful example: one bone, six frames, a single swing
			name: 'swing',
			length: 0.3,
			tracks: {
				stick: [
					{ t: 0.0, rot: [0, 0, 0] },
					{ t: 0.12, rot: [-55, 0, 0] },
					{ t: 0.3, rot: [0, 0, 0] },
				],
			},
		},
	],
};



// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

function write(path, content) {
	const full = join(PACK, path);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, typeof content === 'string' || Buffer.isBuffer(content)
		? content
		: JSON.stringify(content, null, '\t') + '\n');
}

rmSync(PACK, { recursive: true, force: true });
rmSync(SRC, { recursive: true, force: true });

const rigs = [PISTOL, MINIMAL];
const allInfo = [];

for (const rig of rigs) {
	const framing = checkFirstPersonFraming(rig);
	if (framing.length) console.log(`  ! ${rig.name}: ${framing.join('; ')}`);
	const { files, info } = buildItem(rig);
	for (const [path, content] of Object.entries(files)) write(path, content);
	write(`assets/${NS}/textures/item/${rig.name}/${rig.texture}.png`, pistolTexture.png());
	if (rig.cooldown_bar) {
		write(`assets/${NS}/textures/item/${rig.name}/_cooldown_overlay.png`, overlayTexture.png());
	}
	allInfo.push({ rig, info });

	mkdirSync(SRC, { recursive: true });
	writeFileSync(
		join(SRC, `${rig.name}.bbmodel`),
		JSON.stringify(toBBModel(rig, pistolTexture.png().toString('base64')), null, '\t') + '\n'
	);
}

write('pack.mcmeta', {
	pack: {
		description: 'Firstperson Animation - examples',
		min_format: MIN_FORMAT,
		max_format: MAX_FORMAT,
	},
});

// Server side is three things on an item stack: item_model, one custom_data
// string, and a vanilla cooldown. No base item, no components to trigger a use,
// no commands. Generated for Skript 2.13+ / SkBee 3.12+.
for (const { rig, info } of allInfo) {
	const fn = 'fpa_' + rig.name;
	const L = [];
	L.push('# ' + '='.repeat(70));
	L.push(`# Firstperson Animation — ${NS}:${rig.name}`);
	L.push('#');
	L.push('# needs: Skript 2.13+   (set item cooldown of ... for ...)');
	L.push('#        SkBee  3.12+   (item model of ... / custom nbt of ...)');
	L.push('#');
	L.push('# The pack does everything client side. The server only sets:');
	L.push(`#   1. minecraft:item_model   -> "${NS}:${rig.name}"`);
	L.push(`#   2. minecraft:custom_data  -> the animation name under "${ANIM_KEY}"`);
	L.push('#   3. a vanilla item cooldown -> the playback head');
	L.push('# Any item type works; the model replaces its appearance entirely.');
	L.push('# ' + '='.repeat(70));
	L.push('');
	L.push('options:');
	L.push(`\tmodel: ${NS}:${rig.name}`);
	L.push(`\tanim: ${ANIM_KEY}`);
	if (rig.cooldown_bar) L.push(`\tbar: ${COOLDOWN_BAR_KEY}`);
	L.push('\tbase: stick   # cosmetic only — the item model replaces it');
	L.push('');
	L.push('# --- build ' + '-'.repeat(60));
	L.push('');
	L.push(`function ${fn}_item() :: item:`);
	L.push('\tset {_i} to {@base}');
	L.push('\tset item model of {_i} to "{@model}"');
	L.push('\treturn {_i}');
	L.push('');
	L.push(`function ${fn}_give(p: player):`);
	L.push(`\tgive ${fn}_item() to {_p}`);
	L.push('');
	if (rig.cooldown_bar) {
		L.push('# --- cooldown display on/off ' + '-'.repeat(43));
		L.push('#');
		L.push('# The pack draws its own bar in the hotbar, off unless custom_data carries');
		L.push(`# "${COOLDOWN_BAR_KEY}". The model checks it with a real predicate, so the match is PARTIAL —`);
		L.push('# anything else you keep in custom_data is left alone.');
		L.push('#');
		L.push("# Vanilla still draws its own white overlay on top. Removing that needs the");
		L.push('# optional core-shader sub-pack (tools/make_cooldown_hider.ps1), which is a');
		L.push('# separate pack because it has to live under assets/minecraft.');
		L.push('');
		L.push(`function ${fn}_bar(i: item, show: boolean) :: item:`);
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
	L.push('# many poses the client can resolve (ticks + 1, hard ceiling 20/sec).');
	L.push('');
	for (const a of info) {
		L.push(`function ${fn}_${a.name}(p: player):`);
		L.push("\tset {_i} to {_p}'s tool");
		L.push(`\tset string tag "{@anim}" of custom nbt of {_i} to "${a.name}"`);
		L.push("\tset {_p}'s tool to {_i}");
		L.push(`\tset item cooldown of {_i} for {_p} to ${a.ticks} ticks   # ${a.frames} baked frames`);
		L.push('');
	}
	L.push('# --- example wiring ' + '-'.repeat(51));
	L.push('');
	L.push(`command /${fn}:`);
	L.push('\ttrigger:');
	L.push(`\t\t${fn}_give(player)`);
	L.push('');
	L.push('on right click:');
	L.push('\titem model of player\'s tool is "{@model}"');
	L.push("\tplayer doesn't have an item cooldown on player's tool");
	L.push(`\t${fn}_${info[0].name}(player)`);
	write(`${NS}_${rig.name}.sk`, L.join('\n') + '\n');
}


const totalFrames = allInfo.reduce((n, { info }) => n + info.reduce((m, a) => m + a.frames, 0), 0);
const totalNodes = allInfo.reduce((n, { info }) => n + info.reduce((m, a) => m + a.nodes, 0), 0);
const naiveNodes = allInfo.reduce((n, { rig, info }) =>
	n + info.reduce((m, a) => m + a.frames * rig.bones.length, 0), 0);
console.log(`pack     -> ${PACK}`);
console.log(`bbmodels -> ${SRC}`);
console.log(`pivot    : ${PIVOT[0] === 0 ? 'corner (0,0,0)' : 'center (8,8,8)'}`);
console.log(`items    : ${rigs.map(r => r.name).join(', ')}`);
console.log(`frames   : ${totalFrames}`);
console.log(`nodes    : ${totalNodes} (naive frames x bones would be ${naiveNodes}, ` +
	`${Math.round((1 - totalNodes / naiveNodes) * 100)}% saved)`);
