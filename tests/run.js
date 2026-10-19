import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import {splitHorizontal, rectMatches} from '../layout.js';
import {WindowManager, isEligible} from '../windowManager.js';

let count = 0;
function assert(condition, message = 'Assertion failed') {
    if (!condition)
        throw new Error(message);
}
function equal(actual, expected) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function throws(callback) {
    let caught = false;
    try {
        callback();
    } catch (_) {
        caught = true;
    }
    assert(caught, 'Expected an error');
}
function test(name, callback) {
    callback();
    print(`ok ${++count} - ${name}`);
}
function flushIdle() {
    const context = GLib.MainContext.default();
    for (let i = 0; context.pending() && i < 100; i++)
        context.iteration(false);
}
function wait(ms) {
    const loop = new GLib.MainLoop(null, false);
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
    loop.run();
}

function fixture() {
    const workspace = {get_work_area_for_monitor: () =>
        ({x: -1920, y: 32, width: 1919, height: 1048})};
    const calls = [];
    function window(id, monitor = 0) {
        return {
            id, monitor, rect: {}, workspace,
            get_window_type: () => Meta.WindowType.NORMAL,
            is_override_redirect: () => false,
            is_skip_taskbar: () => false,
            get_transient_for: () => null,
            has_attached_dialogs: () => false,
            is_fullscreen: () => false,
            located_on_workspace: ws => ws === workspace,
            allows_move: () => true,
            maximized: 0,
            get_maximized() { return this.maximized; },
            allows_resize() { return this.maximized !== Meta.MaximizeFlags.BOTH; },
            get_stable_sequence: () => id,
            get_monitor() { return this.monitor; },
            get_workspace() { return this.workspace; },
            change_workspace(target) { this.workspace = target; calls.push([id, 'workspace']); },
            unmaximize(flags) {
                this.maximized &= ~flags;
                calls.push([id, 'unmaximize', flags]);
            },
            unminimize: () => calls.push([id, 'unminimize']),
            move_to_monitor(target) {
                this.monitor = target;
                calls.push([id, 'monitor', target]);
            },
            move_resize_frame(user, x, y, width, height) {
                this.rect = {x, y, width, height};
                calls.push([id, 'resize', user, this.rect]);
            },
            raise: () => calls.push([id, 'raise']),
            activate: time => calls.push([id, 'activate', time]),
            get_frame_rect() { return this.rect; },
        };
    }
    const left = window(1);
    const right = window(2, 1);
    const shell = {
        workspace_manager: {get_active_workspace: () => workspace},
        display: {
            get_n_monitors: () => 2,
            handlers: new Map(),
            connect(name, callback) { this.handlers.set(1, {name, callback}); return 1; },
            disconnect(id) { this.handlers.delete(id); },
            grab(window, op) { this.handlers.get(1)?.callback(this, window, op); },
        },
        get_window_actors: () => [left, right].map(w => ({meta_window: w})),
        get_current_time: () => 12345,
    };
    const errors = [];
    const warnings = [];
    const manager = new WindowManager(shell, e => errors.push(e), m => warnings.push(m));
    return {workspace, shell, left, right, calls, errors, warnings, manager};
}

test('50:50 preserves negative coordinates, panel offset and odd width', () => {
    equal(splitHorizontal({x: -1001, y: 32, width: 1001, height: 700}), [
        {x: -1001, y: 32, width: 500, height: 700},
        {x: -501, y: 32, width: 501, height: 700},
    ]);
    equal(splitHorizontal({x: 0, y: -800, width: 2, height: 1})[1],
        {x: 1, y: -800, width: 1, height: 1});
});
test('invalid work areas are rejected before Mutter operations', () => {
    for (const width of [0, 1, -2, 12.5, NaN, Infinity])
        throws(() => splitHorizontal({x: 0, y: 0, width, height: 100}));
});
test('diagnostics distinguish constrained geometry', () => {
    const rect = {x: 0, y: 32, width: 800, height: 900};
    assert(rectMatches({...rect, width: 802}, rect));
    assert(!rectMatches({...rect, width: 900}, rect));
});
test('API names used by the manager exist in installed Meta-14', () => {
    for (const name of ['allows_move', 'allows_resize', 'is_skip_taskbar',
        'get_window_type', 'is_override_redirect', 'get_transient_for',
        'has_attached_dialogs', 'is_fullscreen', 'located_on_workspace',
        'get_stable_sequence', 'get_monitor', 'get_maximized', 'unmaximize', 'unminimize',
        'move_to_monitor', 'move_resize_frame', 'raise', 'activate', 'get_frame_rect',
        'can_minimize', 'minimize', 'is_on_all_workspaces', 'get_workspace'])
        assert(typeof Meta.Window.prototype[name] === 'function', name);
    assert(typeof Meta.Display.prototype.get_n_monitors === 'function');
    assert(typeof Meta.Workspace.prototype.get_work_area_for_monitor === 'function');
});
test('dialogs, fullscreen, fixed windows and other workspaces are excluded', () => {
    const f = fixture();
    assert(isEligible(f.left, f.workspace));
    for (const [key, value] of [
        ['get_window_type', Meta.WindowType.DIALOG],
        ['is_override_redirect', true], ['is_skip_taskbar', true],
        ['get_transient_for', {}], ['has_attached_dialogs', true],
        ['is_fullscreen', true], ['located_on_workspace', false],
        ['allows_move', false], ['allows_resize', false],
    ])
        assert(!isEligible({...f.left, [key]: () => value}, f.workspace), key);
    f.manager.destroy();
});
test('window identity retains separate same-app windows and deduplicates actors', () => {
    const f = fixture();
    f.shell.get_window_actors = () => [f.right, f.left, f.left, null]
        .map(w => ({meta_window: w}));
    equal(f.manager.list().map(w => w.id), [1, 2]);
    f.manager.destroy();
});
test('maximized normal windows remain selectable when allows_resize is false', () => {
    const f = fixture();
    f.left.maximized = Meta.MaximizeFlags.BOTH;
    f.right.maximized = Meta.MaximizeFlags.BOTH;
    assert(!f.left.allows_resize());
    equal(f.manager.list().map(w => w.id), [1, 2]);
    f.manager.arrange(f.left, f.right);
    flushIdle();
    assert(f.calls.filter(c => c[1] === 'resize').length === 2);
    equal(f.errors, []);
    f.manager.destroy();
});
test('a window that still cannot resize after unmaximize is not resized', () => {
    const f = fixture();
    f.left.maximized = Meta.MaximizeFlags.BOTH;
    f.left.allows_resize = () => false;
    f.manager.arrange(f.left, f.right);
    flushIdle();
    equal(f.errors.length, 1);
    assert(!f.calls.some(c => c[1] === 'resize'));
    f.manager.destroy();
});
test('missing or duplicate selections cannot change window state', () => {
    const f = fixture();
    throws(() => f.manager.arrange(f.left, f.left));
    throws(() => f.manager.arrange(f.left, null));
    equal(f.calls, []);
    f.manager.destroy();
});
test('invalid monitor or work area causes no partial mutation', () => {
    const f = fixture();
    f.left.monitor = 2;
    throws(() => f.manager.arrange(f.left, f.right));
    f.left.monitor = 0;
    f.workspace.get_work_area_for_monitor = () => ({x: 0, y: 0, width: 1, height: 1});
    throws(() => f.manager.arrange(f.left, f.right));
    equal(f.calls, []);
    f.manager.destroy();
});
test('arrange restores, relocates and requests geometry then activates right', () => {
    const f = fixture();
    f.manager.arrange(f.left, f.right);
    assert(f.manager.busy);
    assert(!f.calls.some(c => c[1] === 'resize'));
    f.manager.arrange(f.left, f.right); // busy invocation is ignored
    flushIdle();
    equal(f.left.rect, {x: -1920, y: 32, width: 959, height: 1048});
    equal(f.right.rect, {x: -961, y: 32, width: 960, height: 1048});
    assert(f.calls.some(c => c[0] === 2 && c[1] === 'monitor' && c[2] === 0));
    equal(f.calls.at(-1), [2, 'activate', 12345]);
    equal(f.errors, []);
    assert(!f.manager.busy);
    f.manager.destroy();
});
test('window closed before idle placement cancels geometry requests', () => {
    const f = fixture();
    f.manager.arrange(f.left, f.right);
    f.shell.get_window_actors = () => [{meta_window: f.left}];
    flushIdle();
    assert(!f.calls.some(c => c[1] === 'resize'));
    equal(f.errors.length, 1);
    assert(!f.manager.busy);
    f.manager.destroy();
});
test('workspace changes before idle cannot resize the old workspace', () => {
    const f = fixture();
    f.manager.arrange(f.left, f.right);
    f.shell.workspace_manager.get_active_workspace = () => ({});
    flushIdle();
    assert(!f.calls.some(c => c[1] === 'resize'));
    equal(f.errors.length, 1);
    f.manager.destroy();
});
test('monitor removal before idle cannot issue geometry requests', () => {
    const f = fixture();
    f.manager.arrange(f.left, f.right);
    f.shell.display.get_n_monitors = () => 0;
    flushIdle();
    assert(!f.calls.some(c => c[1] === 'resize'));
    equal(f.errors.length, 1);
    f.manager.destroy();
});
test('disable removes idle source and is safe when repeated', () => {
    const f = fixture();
    f.manager.arrange(f.left, f.right);
    const before = f.calls.length;
    f.manager.destroy();
    f.manager.destroy();
    flushIdle();
    equal(f.calls.length, before);
    equal(f.manager._sources.size, 0);
});
test('preparation failure is surfaced and cancels pending state', () => {
    const f = fixture();
    f.right.unminimize = () => { throw new Error('test failure'); };
    throws(() => f.manager.arrange(f.left, f.right));
    assert(!f.manager.busy);
    equal(f.manager._sources.size, 0);
    f.manager.destroy();
});
test('geometry failure is reported without leaving the manager busy', () => {
    const f = fixture();
    f.right.move_resize_frame = () => { throw new Error('test failure'); };
    f.manager.arrange(f.left, f.right);
    flushIdle();
    equal(f.errors.length, 1);
    assert(!f.manager.busy);
    equal(f.manager._sources.size, 0);
    f.manager.destroy();
});
test('constrained geometry records actual and requested sizes without a retry loop', () => {
    const f = fixture();
    f.right.rect = {x: -961, y: 32, width: 1100, height: 1048};
    f.right.move_resize_frame = () => {};
    f.manager.arrange(f.left, f.right);
    flushIdle();
    wait(800);
    equal(f.warnings.length, 1);
    equal(f.warnings[0].windows, [1, 2]);
    equal(f.warnings[0].requested[1], {x: -961, y: 32, width: 960, height: 1048});
    equal(f.warnings[0].actual[1], {x: -961, y: 32, width: 1100, height: 1048});
    equal(f.manager._sources.size, 0);
    f.manager.destroy();
});
test('repeated identical geometry differences do not repeat diagnostic logs', () => {
    const f = fixture();
    f.right.move_resize_frame = () => {
        f.right.rect = {x: -961, y: 32, width: 965, height: 1048};
    };
    for (let i = 0; i < 2; i++) {
        f.manager.arrange(f.left, f.right);
        flushIdle();
        wait(800);
    }
    equal(f.warnings.length, 1);
    equal(f.errors, []);
    f.manager.destroy();
});
test('disable cancels delayed geometry diagnostics', () => {
    const f = fixture();
    f.right.move_resize_frame = () => {};
    f.manager.arrange(f.left, f.right);
    flushIdle();
    f.manager.destroy();
    wait(800);
    equal(f.warnings, []);
    equal(f.manager._sources.size, 0);
});
test('own geometry requests stay marked until their Wayland settling interval ends', () => {
    const f = fixture();
    f.left.unmaximize = () => assert(f.manager.isSynchronousLayoutChange(f.left));
    const resize = f.left.move_resize_frame.bind(f.left);
    f.left.move_resize_frame = (...args) => {
        assert(f.manager.isSynchronousLayoutChange(f.left));
        resize(...args);
    };
    f.manager.arrange(f.left, f.right); flushIdle();
    assert(f.manager.isLayoutChange(f.left));
    assert(!f.manager.isSynchronousLayoutChange(f.left));
    wait(800);
    assert(!f.manager.isLayoutChange(f.left)); f.manager.destroy();
});
test('pointer and keyboard resize grabs override own configure exemptions', () => {
    for (const op of [Meta.GrabOp.RESIZING_E, Meta.GrabOp.KEYBOARD_RESIZING_UNKNOWN]) {
        const f = fixture(); f.manager.arrange(f.left, f.right); flushIdle();
        assert(f.manager.isLayoutChange(f.left));
        f.shell.display.grab(f.left, op);
        assert(!f.manager.isLayoutChange(f.left));
        assert(f.manager.isLayoutChange(f.right));
        f.manager.destroy(); equal(f.shell.display.handlers.size, 0);
    }
});
test('native move grabs do not invalidate resize exemptions', () => {
    const f = fixture(); f.manager.arrange(f.left, f.right); flushIdle();
    f.shell.display.grab(f.left, Meta.GrabOp.MOVING);
    assert(f.manager.isLayoutChange(f.left)); f.manager.destroy();
});
test('pair transfer moves both windows to a nonactive workspace without focusing or unminimizing', () => {
    const f = fixture(); const target = {get_work_area_for_monitor: () =>
        ({x: 1920, y: 32, width: 1600, height: 900})};
    f.manager.movePair([f.left, f.right], target, 1);
    assert(f.left.workspace === target && f.right.workspace === target);
    equal(f.left.monitor, 1); equal(f.right.monitor, 1);
    equal(f.left.rect, {x: 1920, y: 32, width: 800, height: 900});
    equal(f.right.rect, {x: 2720, y: 32, width: 800, height: 900});
    assert(f.manager.isLayoutChange(f.left));
    assert(!f.calls.some(c => ['activate', 'unminimize'].includes(c[1])));
    f.manager.destroy();
});
test('invalid pair transfer destinations are rejected before changing either window', () => {
    const f = fixture();
    throws(() => f.manager.movePair([f.left, f.right], f.workspace, 9));
    throws(() => f.manager.movePair([f.left, f.left], f.workspace, 0));
    equal(f.calls, []); f.manager.destroy();
});
print(`1..${count}`);
