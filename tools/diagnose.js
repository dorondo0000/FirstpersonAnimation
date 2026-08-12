/*
 * Paste this whole file into Blockbench's DevTools console
 * (Help > Developer > Toggle DevTools, Console tab) and press Enter.
 *
 * It prints the state that decides whether the animation UI can work at all.
 * Copy the output back.
 */
(() => {
	const ID = 'firstperson_animation';
	const out = {};
	const safe = (label, fn) => { try { out[label] = fn(); } catch (e) { out[label] = 'ERROR: ' + e.message; } };

	safe('blockbench', () => Blockbench.version);
	safe('project open', () => !!Project);
	safe('Format.id', () => (typeof Format !== 'undefined' && Format) ? Format.id : '(none)');

	// The big one: after a plugin reload the old ModelFormat is deleted, but a
	// project opened before the reload still points at that dead object. Every
	// condition that compares against the live format then fails.
	safe('Format is the live registered one', () => {
		if (typeof Formats === 'undefined') return 'Formats global missing';
		const live = Formats[ID];
		if (!live) return 'format not registered';
		if (typeof Format === 'undefined' || !Format) return 'no active format';
		return Format === live ? 'YES' : 'NO  <-- stale format, reopen the project';
	});

	safe('format flags', () => {
		if (typeof Format === 'undefined' || !Format) return '(none)';
		return ['animation_mode', 'bone_rig', 'animation_files', 'display_mode', 'edit_mode', 'pose_mode']
			.map(k => k + '=' + Format[k]).join(' ');
	});

	safe('Mode', () => (typeof Mode !== 'undefined' && Mode.selected) ? Mode.selected.id : '(none)');
	safe('Animator.open', () => typeof Animator !== 'undefined' ? Animator.open : 'n/a');
	safe('Animation.all', () => (typeof Animation !== 'undefined' && Animation.all)
		? Animation.all.map(a => a.name + '(len=' + a.length + ', kf=' +
			Object.values(a.animators || {}).reduce((n, x) => n + ((x && x.keyframes) ? x.keyframes.length : 0), 0) + ')').join(', ') || '(none)'
		: 'n/a');
	safe('Animation.selected', () => (typeof Animation !== 'undefined' && Animation.selected) ? Animation.selected.name : '(none)');
	safe('Timeline.time', () => typeof Timeline !== 'undefined' ? Timeline.time : 'n/a');
	safe('Timeline.time is finite', () => typeof Timeline !== 'undefined' ? Number.isFinite(Timeline.time) : 'n/a');
	safe('Timeline.animators', () => (typeof Timeline !== 'undefined' && Timeline.animators) ? Timeline.animators.length : 'n/a');

	// has anything replaced setTime? (this plugin no longer does)
	safe('Timeline.setTime is native', () => {
		if (typeof Timeline === 'undefined' || !Timeline.setTime) return 'n/a';
		const src = Timeline.setTime.toString();
		return /originalSetTime|quantizeTime|fpa/.test(src) ? 'NO  <-- something is wrapping it' : 'yes';
	});

	safe('Group.all', () => typeof Group !== 'undefined' ? Group.all.length : 'n/a');
	safe('fpa_settings', () => Project ? JSON.stringify(Project.fpa_settings) : '(no project)');
	safe('plugin installed', () => {
		if (typeof Plugins === 'undefined') return 'Plugins global missing';
		const list = (Plugins.all || []).filter(p => p.id === ID);
		return list.length + ' instance(s), installed=' + list.map(p => p.installed + '/v' + p.version).join(',');
	});

	console.log('=== Firstperson Animation diagnostic ===');
	for (const k of Object.keys(out)) console.log(String(k).padEnd(32), out[k]);
	console.log('=== end ===');
	return out;
})();
