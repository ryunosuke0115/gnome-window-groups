import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) { const id = this.nextId++; this.handlers.set(id, {name, callback}); return id; }
    disconnect(id) { this.handlers.delete(id); }
    emit(name) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.name === name)
                handler.callback();
        }
    }
}
class Actor extends Signals {
    children = [];
    parent = null;
    visible = true;
    get_children() { return this.children; }
    get_parent() { return this.parent; }
    add_child(child) {
        assert.equal(child.parent, null, 'Cannot parent an already parented actor');
        this.children.push(child); child.parent = this;
    }
    remove_child(child) { this.children = this.children.filter(a => a !== child); child.parent = null; }
    hide() { this.visible = false; }
}
class Preview extends Actor {
    constructor(window, workspace) {
        super();
        this.metaWindow = window; this._workspace = workspace; this.inDrag = false;
        const members = new Set([window]);
        this.window_container = {layout_manager: {
            get_windows: () => [...members],
            remove_window: win => members.delete(win),
            add_window: win => members.add(win),
        }};
        this._title = {text: window.title};
        this._closeButton = new Actor();
        this.originalActivations = 0; this.deleted = 0;
    }
    _addWindow(win) { this.window_container.layout_manager.add_window(win); }
    _getCaption() { return this.metaWindow.title; }
    _windowCanClose() { return true; }
    _deleteAll() { this.deleted++; }
    _activate() { this.originalActivations++; }
    addDialog() {}
}
class Workspace extends Actor {
    constructor(metaWorkspace) {
        super(); this.metaWorkspace = metaWorkspace; this.monitorIndex = 0;
        this._windows = []; this._container = new Actor(); this.add_child(this._container);
        const slots = new Map();
        this.slots = slots;
        this._container.layout_manager = {
            addWindow: (preview, win) => {
                slots.set(preview, win); this._container.add_child(preview);
            },
            removeWindow: preview => {
                if (!slots.delete(preview)) return;
                if (preview.parent === this._container) this._container.remove_child(preview);
            },
            layout_changed() {},
        };
    }
    _addWindowClone(win) {
        const preview = new Preview(win, this); this._windows.push(preview);
        this._container.layout_manager.addWindow(preview, win); return preview;
    }
    acceptDrop(source) {
        if (!this.destination)
            return false;
        source.metaWindow.workspace = this.destination;
        return true;
    }
}
class WorkspaceThumbnail {
    acceptDropInternal(source) { source.metaWindow.workspace = this.destination; return true; }
}
class ThumbnailsBox {
    acceptDrop(source) {
        if (this.thumbnail)
            return this.thumbnail.acceptDropInternal(source);
        source.metaWindow.workspace = this.newWorkspace;
        return true;
    }
}
class InjectionManager {
    methods = [];
    overrideMethod(prototype, key, factory) {
        const original = prototype[key]; this.methods.push([prototype, key, original]);
        prototype[key] = factory(original);
    }
    clear() { for (const [prototype, key, method] of this.methods.reverse()) prototype[key] = method; this.methods = []; }
}
const queued = new Map(); let sourceId = 1;
const GLib = {
    PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
    idle_add(_priority, callback) { const id = sourceId++; queued.set(id, callback); return id; },
    Source: {remove: id => queued.delete(id)},
};
function flush() { for (const [id, callback] of [...queued]) { queued.delete(id); callback(); } }
const imports = {
    'gi://GLib': {default: GLib},
    'resource:///org/gnome/shell/extensions/extension.js': {InjectionManager},
    'resource:///org/gnome/shell/ui/workspace.js': {Workspace},
    'resource:///org/gnome/shell/ui/windowPreview.js': {WindowPreview: Preview},
    'resource:///org/gnome/shell/ui/workspaceThumbnail.js': {WorkspaceThumbnail, ThumbnailsBox},
};
const context = vm.createContext({console});
const module = new vm.SourceTextModule(await readFile(new URL('../overviewGroups.js', import.meta.url), 'utf8'), {context});
await module.link(name => {
    const values = imports[name]; assert.ok(values, name);
    return new vm.SyntheticModule(Object.keys(values), function () {
        for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, {context});
});
await module.evaluate();
const {OverviewGroups} = module.namespace;
const originalAdd = Workspace.prototype._addWindowClone;
const originalDialog = Preview.prototype.addDialog;
function fixture(before = true) {
    const metaWorkspace = {}, stage = new Actor();
    const ws = new Workspace(metaWorkspace); stage.add_child(ws);
    const windows = Array.from({length: 4}, (_, id) => ({
        id, title: `Window ${id}`, monitor: 0, modal: false,
        get_monitor() { return this.monitor; },
        get_workspace: () => metaWorkspace,
        has_attached_dialogs() { return this.modal; },
    }));
    const previews = [];
    if (before) windows.forEach(win => previews.push(ws._addWindowClone(win)));
    const group = {name: '開発', workspace: metaWorkspace, windows: windows.slice(0, 2)};
    let groups = [group], visible = true;
    const selected = [], errors = [], transfers = [];
    const combined = new OverviewGroups({stage}, () => groups,
        item => selected.push(item), error => errors.push(error), () => visible,
        (item, nativeDrop) => {
            transfers.push(item); item.moving = true;
            try { return nativeDrop(); } finally { item.moving = false; }
        });
    if (!before) windows.forEach(win => previews.push(ws._addWindowClone(win)));
    return {ws, windows, previews, group, combined, selected, errors, transfers,
        removeGroup: () => { groups = []; }, hide: () => { visible = false; }};
}
let count = 0;
function test(name, run) { run(); console.log(`ok ${++count} - ${name}`); }
test('two grouped windows occupy one native layout slot with two live clones', () => {
    const f = fixture(); f.combined.refresh(); flush();
    assert.equal(f.ws.slots.size, 3);
    assert.equal(f.previews[0].window_container.layout_manager.get_windows().length, 2);
    assert.equal(f.previews[1].visible, false);
    assert.equal(f.previews[1].parent, f.ws._container, 'Hidden peer remains valid for stacking');
    assert.equal(f.ws._windows.length, 4, 'Keep original native bookkeeping');
    assert.equal(f.errors.length, 0); f.combined.destroy();
});
test('group preview click activates the pair and close cannot delete both apps', () => {
    const f = fixture(); f.combined.refresh(); flush();
    const preview = f.previews[0];
    preview._activate(); assert.equal(f.selected[0], f.group);
    assert.equal(preview._title.text, '開発');
    assert.equal(preview._windowCanClose(), false);
    preview._deleteAll(); assert.equal(preview.deleted, 0);
    f.previews[2]._activate(); assert.equal(f.previews[2].originalActivations, 1);
    f.combined.destroy();
});
test('restoring the overview restores original slots, clones and activation methods', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.combined.restore();
    assert.equal(f.ws.slots.size, 4); assert.equal(f.previews[1].visible, true);
    assert.equal(f.previews[0].window_container.layout_manager.get_windows().length, 1);
    assert.equal(f.previews[0]._title.text, 'Window 0');
    f.previews[0]._activate(); assert.equal(f.previews[0].originalActivations, 1);
    f.combined.refresh(); flush(); assert.equal(f.ws.slots.size, 3);
    f.combined.destroy();
});
test('renaming and releasing a group update its representation', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.group.name = '調査'; f.combined.refresh(); flush();
    assert.equal(f.previews[0]._title.text, '調査');
    f.removeGroup(); f.combined.refresh(); flush();
    assert.equal(f.ws.slots.size, 4); f.combined.destroy();
});
test('new workspace previews created after enable are discovered by injection', () => {
    const f = fixture(false); flush(); assert.equal(f.ws.slots.size, 3);
    f.combined.destroy();
});
test('different monitors and modal dialogs fall back to individual previews', () => {
    const f = fixture(); f.windows[1].monitor = 1; f.combined.refresh(); flush();
    assert.equal(f.ws.slots.size, 4);
    f.windows[1].monitor = 0; f.combined.refresh(); flush(); assert.equal(f.ws.slots.size, 3);
    f.windows[1].modal = true; f.previews[1].addDialog({}); flush();
    assert.equal(f.ws.slots.size, 4); f.combined.destroy();
});
test('group dragging keeps two live clones in one preview', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.previews[0].inDrag = true; f.previews[0].emit('drag-begin');
    assert.equal(f.ws.slots.size, 3);
    assert.equal(f.previews[0].window_container.layout_manager.get_windows().length, 2);
    assert.equal(f.previews[0]._windowGroupsGroup, f.group);
    f.combined.refresh(); flush();
    assert.equal(f.ws.slots.size, 3); f.combined.destroy();
});
test('native workspace drops are coordinated as a group transfer', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.ws.destination = {};
    assert.equal(f.ws.acceptDrop(f.previews[0]), true);
    assert.equal(f.transfers.length, 1);
    assert.equal(f.windows[0].workspace, f.ws.destination);
    f.combined.destroy();
});
test('thumbnail nesting transfers only once and new-workspace drops are covered', () => {
    const f = fixture(); f.combined.refresh(); flush();
    const box = new ThumbnailsBox(), thumb = new WorkspaceThumbnail();
    thumb.destination = {}; box.thumbnail = thumb;
    assert.equal(box.acceptDrop(f.previews[0]), true);
    assert.equal(f.transfers.length, 1);
    delete box.thumbnail; box.newWorkspace = {};
    assert.equal(box.acceptDrop(f.previews[0]), true);
    assert.equal(f.transfers.length, 2);
    assert.equal(f.windows[0].workspace, box.newWorkspace);
    f.combined.destroy();
});
test('ungrouped native drops bypass group transfer logic', () => {
    const f = fixture(); f.combined.refresh(); flush(); f.ws.destination = {};
    assert.equal(f.ws.acceptDrop(f.previews[2]), true);
    assert.equal(f.transfers.length, 0); f.combined.destroy();
});
test('closing a member restores its surviving peer without recreating the dead actor', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.ws._windows = f.ws._windows.filter(p => p !== f.previews[0]);
    f.previews[0].emit('destroy'); flush();
    assert.equal(f.ws.slots.has(f.previews[1]), true);
    assert.equal(f.previews[1].visible, true); f.combined.destroy();
});
test('closing the hidden secondary removes its extra clone and restores primary methods', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.ws._windows = f.ws._windows.filter(p => p !== f.previews[1]);
    f.previews[1].emit('destroy'); flush();
    assert.equal(f.previews[0].window_container.layout_manager.get_windows().length, 1);
    assert.equal(Object.hasOwn(f.previews[0], '_activate'), false); f.combined.destroy();
});
test('partial merge errors restore the normal overview and disable the experiment', () => {
    const f = fixture();
    f.previews[0]._addWindow = () => { throw new Error('simulated native failure'); };
    f.combined.refresh(); flush();
    assert.equal(f.errors.length, 1); assert.equal(f.combined.enabled, false);
    assert.equal(f.ws.slots.size, 4);
    assert.equal(Object.hasOwn(f.previews[0], '_activate'), false); f.combined.destroy();
});
test('hidden overview and disable restore all records, sources and prototype hooks', () => {
    const f = fixture(); f.combined.refresh(); flush();
    f.hide(); f.combined.restore(); assert.equal(f.ws.slots.size, 4);
    f.combined.destroy(); f.combined.destroy();
    assert.equal(f.ws.handlers.size, 0); assert.equal(queued.size, 0);
    assert.equal(Workspace.prototype._addWindowClone, originalAdd);
    assert.equal(Preview.prototype.addDialog, originalDialog);
    assert.ok(f.previews.every(p => p.handlers.size === 0));
});
console.log(`1..${count}`);
