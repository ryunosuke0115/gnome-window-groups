import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

class Signals {
    signals = new Map();
    next = 1;
    connect(name, callback) { const id = this.next++; this.signals.set(id, {name, callback}); return id; }
    disconnect(id) { this.signals.delete(id); }
    emit(name) {
        for (const handler of [...this.signals.values()]) {
            if (handler.name === name)
                handler.callback();
        }
    }
}
class Preview extends Signals {
    constructor(id) {
        super(); this.metaWindow = {id}; this._delegate = this;
        this.animations = [];
        this._draggable = Object.create({
            _animateDragEnd: (time, params) => this.animations.push({time, params}),
        });
    }
    get_parent() { return null; }
    add_style_class_name() { this.highlighted = true; }
    remove_style_class_name() { this.highlighted = false; }
    acceptDrop() { return 'native-drop'; }
}
const queued = new Map();
let nextSource = 1;
const GLib = {
    PRIORITY_DEFAULT_IDLE: 0, SOURCE_REMOVE: false,
    idle_add(_priority, callback) { const id = nextSource++; queued.set(id, callback); return id; },
    Source: {remove(id) { queued.delete(id); }},
};
function flush() { for (const [id, run] of [...queued]) { queued.delete(id); run(); } }
const monitors = new Set();
const DND = {
    DragMotionResult: {CONTINUE: 3, COPY_DROP: 1},
    addDragMonitor: monitor => monitors.add(monitor),
    removeDragMonitor: monitor => monitors.delete(monitor),
};
const context = vm.createContext({console});
async function load(file, imports) {
    const module = new vm.SourceTextModule(await readFile(new URL(file, import.meta.url), 'utf8'), {context});
    await module.link(name => {
        const values = imports[name];
        assert.ok(values, `Unexpected import ${name}`);
        return new vm.SyntheticModule(Object.keys(values), function () {
            for (const [key, value] of Object.entries(values))
                this.setExport(key, value);
        }, {context});
    });
    await module.evaluate();
    return module.namespace;
}
const {OverviewDrop} = await load('../overviewDrop.js', {
    'gi://GLib': {default: GLib},
    'resource:///org/gnome/shell/ui/dnd.js': DND,
    'resource:///org/gnome/shell/ui/windowPreview.js': {WindowPreview: Preview},
});
let count = 0;
function test(name, run) { run(); console.log(`ok ${++count} - ${name}`); }
function fixture() {
    let valid = true;
    let enabled = true;
    const pairs = [], errors = [];
    const drop = new OverviewDrop(() => valid, (...pair) => pairs.push(pair), e => errors.push(e), () => enabled);
    const source = new Preview(1), target = new Preview(2);
    const event = {source, targetActor: {get_parent: () => target}};
    return {drop, source, target, event, pairs, errors,
        invalidate: () => { valid = false; }, hide: () => { enabled = false; }};
}
test('hover highlights a window and native acceptDrop handles successful drag cleanup', () => {
    const f = fixture();
    assert.equal(f.drop._monitor.dragMotion(f.event), DND.DragMotionResult.COPY_DROP);
    assert.equal(f.target.highlighted, true);
    assert.equal(f.target.acceptDrop(f.source), true);
    f.source._draggable._animateDragEnd(42, {duration: 750, opacity: 255});
    assert.equal(f.source.animations[0].params.duration, 0);
    assert.equal(f.source.animations[0].params.opacity, 255);
    assert.equal(Object.hasOwn(f.source._draggable, '_animateDragEnd'), false);
    assert.equal(f.pairs.length, 0, 'No dialog while the DND grab is active');
    assert.equal(f.target.acceptDrop(), 'native-drop', 'Original method is restored');
    f.source.emit('drag-end');
    assert.equal(f.pairs.length, 0, 'Wait for native DND call stack to finish');
    flush();
    assert.equal(f.pairs[0][0], f.target.metaWindow);
    assert.equal(f.pairs[0][1], f.source.metaWindow);
    assert.equal(f.source.signals.size, 0);
    f.drop.destroy();
});
test('animation override is single use and does not affect later native drags', () => {
    const f = fixture(); f.drop._monitor.dragMotion(f.event);
    f.target.acceptDrop(f.source);
    f.source._draggable._animateDragEnd(1, {duration: 750});
    f.source._draggable._animateDragEnd(2, {duration: 750});
    assert.equal(f.source.animations[0].params.duration, 0);
    assert.equal(f.source.animations[1].params.duration, 750);
    f.drop.destroy();
});
test('cancel or disable restores an unconsumed animation override', () => {
    const f = fixture(); f.drop._monitor.dragMotion(f.event);
    f.target.acceptDrop(f.source);
    assert.equal(Object.hasOwn(f.source._draggable, '_animateDragEnd'), true);
    f.drop.destroy();
    assert.equal(Object.hasOwn(f.source._draggable, '_animateDragEnd'), false);
    f.source._draggable._animateDragEnd(1, {duration: 750});
    assert.equal(f.source.animations[0].params.duration, 750);
});
test('moving off a window restores its original behavior', () => {
    const f = fixture();
    f.drop._monitor.dragMotion(f.event);
    f.drop._monitor.dragMotion({source: f.source, targetActor: null});
    assert.equal(f.target.highlighted, false);
    assert.equal(f.target.acceptDrop(), 'native-drop');
    f.source.emit('drag-end'); flush();
    assert.equal(f.pairs.length, 0);
    f.drop.destroy();
});
test('same-window and nonwindow drags remain native', () => {
    const f = fixture();
    for (const event of [{source: f.target, targetActor: f.target}, {source: {}, targetActor: f.target}])
        assert.equal(f.drop._monitor.dragMotion(event), DND.DragMotionResult.CONTINUE);
    assert.equal(Object.hasOwn(f.target, 'acceptDrop'), false);
    f.drop.destroy();
});
test('invalid or registered pairs do not change drop behavior', () => {
    const f = fixture(); f.invalidate();
    assert.equal(f.drop._monitor.dragMotion(f.event), DND.DragMotionResult.CONTINUE);
    assert.equal(f.target.acceptDrop(), 'native-drop');
    f.drop.destroy();
});
test('eligibility is rechecked at drop and before opening a dialog', () => {
    const f = fixture();
    f.drop._monitor.dragMotion(f.event); f.invalidate();
    assert.equal(f.target.acceptDrop(f.source), 'native-drop');
    f.source.emit('drag-end'); flush(); assert.equal(f.pairs.length, 0);
    f.drop.destroy();
    const g = fixture(); g.drop._monitor.dragMotion(g.event);
    g.target.acceptDrop(g.source); g.source.emit('drag-end'); g.invalidate(); flush();
    assert.equal(g.pairs.length, 0); g.drop.destroy();
});
test('cancel, source destroy and target destroy restore handlers and highlighting', () => {
    for (const signal of ['drag-cancelled', 'destroy']) {
        const f = fixture(); f.drop._monitor.dragMotion(f.event); f.source.emit(signal);
        assert.equal(f.target.highlighted, false);
        assert.equal(f.source.signals.size, 0); f.drop.destroy();
    }
    const f = fixture(); f.drop._monitor.dragMotion(f.event); f.target.emit('destroy');
    assert.equal(f.target.acceptDrop(), 'native-drop'); f.drop.destroy();
});
test('disable removes monitor, temporary methods, handlers and queued prompts', () => {
    const f = fixture(); f.drop._monitor.dragMotion(f.event);
    f.drop.destroy();
    assert.equal(f.target.acceptDrop(), 'native-drop');
    assert.equal(f.source.signals.size, 0);
    const g = fixture(); g.drop._monitor.dragMotion(g.event);
    g.target.acceptDrop(g.source); g.source.emit('drag-end'); g.drop.destroy(); flush();
    assert.equal(g.pairs.length, 0); assert.equal(monitors.size, 0);
});
test('hiding overview prevents a queued prompt', () => {
    const f = fixture(); f.drop._monitor.dragMotion(f.event);
    f.target.acceptDrop(f.source); f.source.emit('drag-end'); f.hide(); flush();
    assert.equal(f.pairs.length, 0); f.drop.destroy();
});

class Label { constructor(props) { Object.assign(this, props); this.clutter_text = new Signals(); } }
class Entry extends Label { get_text() { return this.text ?? ''; } }
let lastModal;
class Modal extends Signals {
    constructor() { super(); lastModal = this; this.contentLayout = {children: [], add_child(c) { this.children.push(c); }}; }
    setButtons(buttons) { this.buttons = buttons; }
    setInitialKeyFocus(actor) { this.focus = actor; }
    open() { this.opened = true; return true; }
    close() { this.destroy(); }
    destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('destroy'); } }
}
const {TabNameDialog} = await load('../tabNameDialog.js', {
    'gi://Clutter': {default: {KEY_Escape: 27}},
    'gi://St': {default: {Label, Entry}},
    'resource:///org/gnome/shell/ui/modalDialog.js': {ModalDialog: Modal},
});
test('name prompt requires a name; cancel makes no registration', () => {
    const created = []; let closed = 0;
    const dialog = new TabNameDialog(['App A', 'App B'], name => created.push(name), () => closed++);
    dialog.open(); lastModal.buttons[2].action();
    assert.equal(created.length, 0); assert.ok(dialog._error.text);
    lastModal.buttons[0].action();
    assert.equal(closed, 1); assert.equal(created.length, 0);
});
test('name prompt registers on confirmation and supports Enter', () => {
    const names = [];
    const dialog = new TabNameDialog(['App A', 'App B'], name => names.push(name), () => {});
    dialog.open(); dialog._entry.text = '  開発  ';
    dialog._entry.clutter_text.emit('activate');
    assert.deepEqual(names, ['開発']); assert.equal(dialog._dialog, null);
});
test('registration failure stays in the dialog and can be cancelled', () => {
    const dialog = new TabNameDialog(['App A', 'App B'], () => { throw new Error('window closed'); }, () => {});
    dialog.open(); dialog._entry.text = 'Tab'; lastModal.buttons[2].action();
    assert.equal(dialog._error.text, 'window closed'); assert.ok(dialog._dialog);
    dialog.destroy(); assert.equal(dialog._dialog, null);
});
test('swapping in the name prompt changes preview and submitted order without losing the name', () => {
    const created = [];
    const dialog = new TabNameDialog(['App A', 'App B'],
        (name, swapped) => created.push({name, swapped}), () => {});
    dialog.open(); dialog._entry.text = '開発';
    const details = lastModal.contentLayout.children[1];
    assert.equal(details.text, '左: App A\n右: App B');
    lastModal.buttons[1].action();
    assert.equal(details.text, '左: App B\n右: App A');
    assert.equal(dialog._entry.text, '開発');
    assert.equal(created.length, 0, 'Swap must not register or place windows');
    dialog._entry.clutter_text.emit('activate');
    assert.deepEqual(created, [{name: '開発', swapped: true}]);
});
test('two swaps restore the original order and cancel still makes no registration', () => {
    const created = [];
    const dialog = new TabNameDialog(['App A', 'App B'],
        (name, swapped) => created.push({name, swapped}), () => {});
    dialog.open();
    lastModal.buttons[1].action(); lastModal.buttons[1].action();
    assert.equal(lastModal.contentLayout.children[1].text, '左: App A\n右: App B');
    assert.equal(dialog._swapped, false);
    lastModal.buttons[0].action();
    assert.deepEqual(created, []);
});

console.log(`1..${count}`);
