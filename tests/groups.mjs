import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const module = new vm.SourceTextModule(
    await readFile(new URL('../groups.js', import.meta.url), 'utf8'));
await module.link(() => { throw new Error('GroupStore must not import Shell'); });
await module.evaluate();
const {GroupStore} = module.namespace;
let count = 0;
function test(name, run) {
    run();
    console.log(`ok ${++count} - ${name}`);
}
function fixture() {
    const ws = {};
    const otherWs = {};
    let current = ws;
    let changed = 0;
    const errors = [];
    const windows = Array.from({length: 6}, (_, index) => ({
        id: index, minimized: false, workspace: ws, closed: false, monitor: 0,
        modal: false, minimizable: true, sticky: false,
        rect: {x: 0, y: 0, width: 800, height: 600},
        get_frame_rect() { return this.rect; },
        signals: new Map(), nextId: 1,
        get_workspace() { return this.workspace; },
        get_monitor() { return this.monitor; },
        is_on_all_workspaces() { return this.sticky; },
        has_attached_dialogs() { return this.modal; },
        can_minimize() { return this.minimizable; },
        minimize() { this.minimized = true; },
        unminimize() { this.minimized = false; },
        connect(name, callback) {
            const id = this.nextId++;
            this.signals.set(id, {name, callback});
            return id;
        },
        disconnect(id) { this.signals.delete(id); },
        emit(name) {
            for (const handler of [...this.signals.values()]) {
                if (handler.name === name)
                    handler.callback();
            }
        },
    }));
    const shell = {workspace_manager: {get_active_workspace: () => current}};
    const manager = {
        busy: false, pending: null, failure: false, ownChanges: new Set(),
        isLayoutChange(window) { return this.ownChanges.has(window); },
        isSynchronousLayoutChange() { return false; },
        list: () => windows.filter(w => !w.closed && w.workspace === current),
        arrange(left, right, callback) {
            if (this.failure)
                throw new Error('test placement failure');
            if (this.busy)
                return false;
            this.busy = true;
            this.lastPair = [left, right];
            this.pending = () => {
                left.unminimize();
                right.unminimize();
                this.busy = false;
                callback();
            };
            return true;
        },
        finish() { const callback = this.pending; this.pending = null; callback?.(); },
        cancel() { this.pending = null; this.busy = false; },
        movePair(members, destination, monitor) {
            for (const window of members) {
                window.workspace = destination; window.monitor = monitor;
                window.emit('workspace-changed');
                window.rect.width += 1; window.emit('size-changed');
            }
        },
    };
    const store = new GroupStore(shell, manager, () => changed++, e => errors.push(e));
    function create(start) {
        const group = store.create(windows[start], windows[start + 1]);
        manager.finish();
        return group;
    }
    return {windows, ws, otherWs, manager, store, errors, create,
        setWorkspace: value => { current = value; }, getChanged: () => changed};
}
test('a split pair forms one tab; switching shows both and hides the old pair', () => {
    const f = fixture();
    const a = f.create(0);
    const b = f.create(2);
    assert.equal(f.store.groups.length, 2);
    assert.deepEqual(f.windows.slice(0, 4).map(w => w.minimized), [true, true, false, false]);
    assert.equal(f.store.active.get(f.ws), b);
    f.store.show(a);
    f.manager.finish();
    assert.deepEqual(f.windows.slice(0, 4).map(w => w.minimized), [false, false, true, true]);
    assert.equal(f.store.active.get(f.ws), a);
    assert.equal(f.windows[4].minimized, false, 'unregistered windows stay visible');
    f.store.destroy();
});
test('ownership rejects duplicate registration and repeated members', () => {
    const f = fixture();
    f.create(0);
    assert.throws(() => f.store.create(f.windows[0], f.windows[2]));
    assert.throws(() => f.store.create(f.windows[2], f.windows[2]));
    f.store.destroy();
});
test('sticky and nonminimizable windows are rejected', () => {
    const f = fixture();
    f.windows[0].sticky = true;
    assert.throws(() => f.create(0));
    f.windows[0].sticky = false;
    f.windows[0].minimizable = false;
    assert.throws(() => f.create(0));
    assert.equal(f.store.groups.length, 0);
    f.store.destroy();
});
test('failed placement leaves the old tab visible', () => {
    const f = fixture();
    const a = f.create(0);
    f.manager.failure = true;
    assert.throws(() => f.store.create(f.windows[2], f.windows[3]));
    assert.equal(f.windows[0].minimized, false);
    assert.equal(f.windows[1].minimized, false);
    assert.equal(f.store.active.get(f.ws), a);
    assert.equal(f.store.groups.length, 1);
    f.store.destroy();
});
test('pending placement cannot hide the old pair before completion', () => {
    const f = fixture();
    f.create(0);
    f.store.create(f.windows[2], f.windows[3]);
    assert.equal(f.windows[0].minimized, false);
    assert.throws(() => f.store.show(f.store.groups[0]));
    f.store.destroy();
    f.manager.finish();
    assert.equal(f.windows[0].minimized, false);
});
test('release restores only windows minimized by the extension', () => {
    const f = fixture();
    const a = f.create(0);
    f.windows[0].minimize(); // The user minimized this one first.
    f.create(2);
    f.store.release(a);
    assert.equal(f.windows[0].minimized, true);
    assert.equal(f.windows[1].minimized, false);
    assert.equal(f.windows[0].signals.size, 0);
    f.store.destroy();
});
test('closing one member releases the tab and restores the surviving hidden member', () => {
    const f = fixture();
    const a = f.create(0);
    f.create(2);
    f.windows[0].closed = true;
    f.windows[0].emit('unmanaged');
    assert.equal(f.store.groups.includes(a), false);
    assert.equal(f.windows[1].minimized, false);
    assert.equal(f.windows[0].signals.size, 0);
    assert.equal(f.windows[1].signals.size, 0);
    f.store.destroy();
});
test('workspace change of one member releases the pair', () => {
    const f = fixture();
    const a = f.create(0);
    f.create(2);
    f.windows[0].workspace = f.otherWs;
    f.windows[0].emit('workspace-changed');
    assert.equal(f.store.groups.includes(a), false);
    assert.equal(f.windows[1].minimized, false);
    f.store.destroy();
});
test('workspace tabs cannot hide windows in another workspace', () => {
    const f = fixture();
    const a = f.create(0);
    f.setWorkspace(f.otherWs);
    assert.equal(f.store.current().length, 0);
    assert.throws(() => f.store.show(a));
    f.windows[2].workspace = f.otherWs;
    f.windows[3].workspace = f.otherWs;
    f.create(2);
    assert.equal(f.windows[0].minimized, false);
    f.store.destroy();
});
test('modal outgoing windows prevent switching before changing visibility', () => {
    const f = fixture();
    f.create(0);
    f.windows[0].modal = true;
    assert.throws(() => f.create(2));
    assert.equal(f.windows[0].minimized, false);
    assert.equal(f.store.groups.length, 1);
    f.store.destroy();
});
test('disable restores hidden windows, cancels requests and disconnects every signal', () => {
    const f = fixture();
    f.create(0);
    f.create(2);
    f.store.destroy();
    f.store.destroy();
    assert.ok(f.windows.every(w => !w.minimized && w.signals.size === 0));
    assert.equal(f.store.groups.length, 0);
    assert.equal(f.manager.pending, null);
});
test('asynchronous placement failure can reset the switching guard', () => {
    const f = fixture();
    f.create(0);
    const b = f.store.create(f.windows[2], f.windows[3]);
    f.manager.cancel();
    f.store.cancelSwitch();
    f.store.show(b);
    f.manager.finish();
    assert.equal(f.store.active.get(f.ws), b);
    f.store.destroy();
});
test('resizing either member releases just that tab and restores hidden peer', () => {
    for (const index of [0, 1]) {
        const f = fixture(); const a = f.create(0); const b = f.create(2);
        f.windows[index].rect.width += 1;
        f.windows[index].emit('size-changed');
        assert.equal(f.store.groups.includes(a), false);
        assert.equal(f.store.groups.includes(b), true);
        assert.equal(f.windows[0].minimized || f.windows[1].minimized, false);
        assert.equal(f.windows[0].signals.size + f.windows[1].signals.size, 0);
        f.store.destroy();
    }
});
test('position changes or a size signal without dimension changes keep the tab', () => {
    const f = fixture(); const a = f.create(0);
    f.windows[0].rect.x += 10; f.windows[0].emit('size-changed');
    assert.equal(f.store.groups.includes(a), true); f.store.destroy();
});
test('own asynchronous layout changes keep the tab and update its size baseline', () => {
    const f = fixture(); const a = f.create(0);
    f.manager.ownChanges.add(f.windows[0]);
    f.windows[0].rect.width += 40; f.windows[0].emit('size-changed');
    f.manager.ownChanges.clear();
    f.windows[0].emit('size-changed');
    assert.equal(f.store.groups.includes(a), true);
    f.windows[0].rect.height += 1; f.windows[0].emit('size-changed');
    assert.equal(f.store.groups.includes(a), false); f.store.destroy();
});
test('external maximize and fullscreen changes release even during configure settling', () => {
    for (const property of ['maximized-horizontally', 'maximized-vertically', 'fullscreen']) {
        const f = fixture(); const a = f.create(0);
        f.manager.ownChanges.add(f.windows[0]);
        f.windows[0].emit(`notify::${property}`);
        assert.equal(f.store.groups.includes(a), false); f.store.destroy();
    }
});
test('own synchronous unmaximize notifications preserve the tab', () => {
    const f = fixture(); const a = f.create(0);
    f.manager.isSynchronousLayoutChange = () => true;
    f.windows[0].emit('notify::maximized-horizontally');
    f.windows[0].emit('notify::maximized-vertically');
    assert.equal(f.store.groups.includes(a), true); f.store.destroy();
});
test('overview drop transfers both windows and keeps tab identity through native notifications', () => {
    const f = fixture(); const a = f.create(0);
    const result = f.store.transfer(a, () => {
        f.windows[0].workspace = f.otherWs; f.windows[0].monitor = 1;
        f.windows[0].emit('workspace-changed');
        f.windows[0].rect.width += 5; f.windows[0].emit('size-changed');
        return true;
    });
    assert.equal(result, true); assert.equal(f.store.groups.includes(a), true);
    assert.ok(a.windows.every(w => w.workspace === f.otherWs && w.monitor === 1));
    assert.equal(a.workspace, f.otherWs); assert.equal(a.moving, false);
    assert.equal(f.store.active.has(f.ws), false);
    assert.equal(f.store.active.get(f.otherWs), a);
    f.windows[1].rect.width += 1; f.windows[1].emit('size-changed');
    assert.equal(f.store.groups.includes(a), false, 'Manual resize still releases after transfer');
    f.store.destroy();
});
test('rejected drops leave the pair and workspace unchanged', () => {
    const f = fixture(); const a = f.create(0);
    assert.equal(f.store.transfer(a, () => false), false);
    assert.equal(a.workspace, f.ws); assert.equal(a.moving, false);
    assert.equal(f.store.groups.includes(a), true); f.store.destroy();
});
test('partial transfer failure releases the group instead of retaining inconsistent ownership', () => {
    const f = fixture(); const a = f.create(0);
    f.manager.movePair = () => { throw new Error('transfer failure'); };
    assert.throws(() => f.store.transfer(a, () => true));
    assert.equal(f.store.groups.includes(a), false); assert.equal(a.moving, false);
    assert.ok(a.windows.every(w => w.signals.size === 0)); f.store.destroy();
});
test('moving into a workspace with another active tab preserves that tab', () => {
    const f = fixture(); const a = f.create(0);
    f.windows[2].workspace = f.otherWs; f.windows[3].workspace = f.otherWs;
    f.setWorkspace(f.otherWs); const b = f.create(2); f.setWorkspace(f.ws);
    f.store.transfer(a, () => { f.windows[0].workspace = f.otherWs; return true; });
    assert.equal(f.store.active.get(f.otherWs), b);
    assert.equal(f.store.groups.length, 2); f.store.destroy();
});
test('swap commits the reversed order, retains identity and persists on the next show', () => {
    const f = fixture(); const a = f.create(0); const id = a.id, name = a.name;
    f.store.swap(a);
    assert.equal(a.windows[0], f.windows[0], 'Order remains original until placement succeeds');
    assert.equal(f.manager.lastPair[0], f.windows[1]); f.manager.finish();
    assert.equal(a.windows[0], f.windows[1]); assert.equal(a.windows[1], f.windows[0]);
    assert.equal(a.id, id); assert.equal(a.name, name); assert.equal(f.store.groups.length, 1);
    f.store.show(a); assert.equal(f.manager.lastPair[0], f.windows[1]); f.manager.finish();
    f.store.swap(a); f.manager.finish(); assert.equal(a.windows[0], f.windows[0]);
    f.store.destroy();
});
test('swapping an inactive tab restores that pair and hides the previously active pair', () => {
    const f = fixture(); const a = f.create(0); f.create(2);
    f.store.swap(a); f.manager.finish();
    assert.deepEqual(f.windows.slice(0, 4).map(w => w.minimized), [false, false, true, true]);
    assert.equal(f.store.active.get(f.ws), a); f.store.destroy();
});
test('failed or cancelled swap leaves the registered order unchanged', () => {
    const f = fixture(); const a = f.create(0);
    f.manager.failure = true; assert.throws(() => f.store.swap(a));
    assert.equal(a.windows[0], f.windows[0]);
    f.manager.failure = false; f.store.swap(a); f.manager.cancel(); f.store.cancelSwitch();
    assert.equal(a.windows[0], f.windows[0]);
    f.store.destroy();
});
test('lock snapshot preserves pairs, names, order, active tab and hidden ownership', () => {
    const f = fixture();
    const first = f.create(0);
    first.name = '作業';
    f.store.swap(first); f.manager.finish();
    const second = f.create(2);
    const state = f.store.snapshot();
    f.store.destroy({restoreHidden: false});
    assert.ok(f.windows.every(w => w.signals.size === 0));
    assert.equal(f.windows[0].minimized, true, 'Lock must not reveal inactive tabs');
    f.windows[0].rect.width += 40;
    f.store.restore(state, f.windows);
    assert.equal(f.store.groups[0].name, '作業');
    assert.deepEqual(f.store.groups[0].windows, [f.windows[1], f.windows[0]]);
    assert.equal(f.store.active.get(f.ws).id, second.id);
    f.windows[0].emit('size-changed');
    assert.equal(f.store.groups.length, 2, 'Resume uses current geometry as baseline');
    f.windows[0].rect.width += 10; f.windows[0].emit('size-changed');
    assert.equal(f.store.groups.length, 1, 'Subsequent user resize still releases');
    assert.equal(f.windows[1].minimized, false, 'Hidden ownership survives resume');
    f.store.destroy();
    assert.ok(f.windows.every(w => w.signals.size === 0));
});
test('resume discards closed or moved pairs and reveals surviving hidden peers', () => {
    const f = fixture(); f.create(0); f.create(2); f.create(4);
    const state = f.store.snapshot();
    f.store.destroy({restoreHidden: false});
    f.windows[0].closed = true;
    f.windows[2].workspace = f.otherWs;
    f.store.restore(state, f.windows.filter(w => !w.closed));
    assert.equal(f.store.groups.length, 1);
    assert.equal(f.windows[1].minimized, false);
    assert.equal(f.windows[2].minimized, false);
    assert.equal(f.windows[3].minimized, false);
    assert.equal(f.windows[0].signals.size, 0);
    f.store.destroy();
});

console.log(`1..${count}`);
