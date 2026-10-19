// Run the real extension lifecycle with a minimal Shell UI model. In GNOME 46,
// PopupMenu.open() returns before emitting open-state-changed if it is empty.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

class Signals {
    handlers = new Map();
    nextId = 1;
    connect(name, callback) {
        const id = this.nextId++;
        this.handlers.set(id, {name, callback});
        return id;
    }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.name === name)
                handler.callback(this, ...args);
        }
    }
}
class Menu extends Signals {
    actor = {hide() {}, add_style_class_name() {}};
    items = [];
    isOpen = false;
    addMenuItem(item) {
        this.items.push(item);
        item.menu.parent = this;
        item.connect('activate', () => {
            let root = this;
            while (root.parent)
                root = root.parent;
            root.close();
        });
    }
    addAction(label, callback) {
        const item = new Item(label);
        item.connect('activate', callback);
        this.addMenuItem(item);
    }
    removeAll() { this.items = []; }
    open() {
        if (this.isOpen || this.items.length === 0)
            return;
        this.isOpen = true;
        this.emit('open-state-changed', true);
    }
    close() {
        if (!this.isOpen)
            return;
        this.isOpen = false;
        this.emit('open-state-changed', false);
    }
    destroy() { this.close(); uiActors.delete(this.actor); this.handlers.clear(); this.items = []; }
}
class MenuManager {
    menus = new Set();
    addMenu(menu) { this.menus.add(menu); }
    removeMenu(menu) { this.menus.delete(menu); }
}
class Item extends Signals {
    children = [];
    constructor(text) {
        super();
        this.label = {text, add_style_class_name() {}};
        this.menu = new Menu();
    }
    setSensitive(value) { this.sensitive = value; }
    setOrnament(value) { this.ornament = value; }
    activate(event) { this.emit('activate', event); }
    add_child(child) { this.children.push(child); }
}
class Button {
    menu = new Menu();
    container = {visible: true, hide() { this.visible = false; }};
    add_child() {}
    destroy() { this.menu.handlers.clear(); }
}
class Box {
    children = [];
    add_child(child) { this.children.push(child); }
    destroy_all_children() { this.children = []; }
}
class Tab extends Signals {
    constructor(props) { super(); Object.assign(this, props); }
    add_style_pseudo_class() {}
}
class Entry {
    text = '';
    get_text() { return this.text; }
}
const workspace = new Signals();
workspace.get_active_workspace = () => workspace;
const layoutManager = new Signals();
const overview = new Signals();
overview.hide = () => { overview.visible = false; overview.emit('hiding'); overview.emit('hidden'); };
const sessionMode = {isLocked: false};
const notices = [];
const uiActors = new Set();
let availableWindows = [];
const context = vm.createContext({console, global: {workspace_manager: workspace,
    get_window_actors: () => availableWindows.map(meta_window => ({meta_window}))}});
const imports = {
    'gi://Clutter': {default: {ActorAlign: {CENTER: 0}, KEY_Menu: 1, KEY_F10: 2,
        ModifierType: {SHIFT_MASK: 1}, EVENT_STOP: true, EVENT_PROPAGATE: false}},
    'gi://Shell': {default: {WindowTracker: {get_default: () => ({
        get_window_app: () => ({get_name: () => 'Test app'}),
    })}}},
    'gi://St': {default: {Label: class {}, Icon: class {}, BoxLayout: Box, Button: Tab, Entry,
        ButtonMask: {ONE: 1, THREE: 4}, Side: {TOP: 0}}},
    'resource:///org/gnome/shell/extensions/extension.js': {Extension: class {}},
    'resource:///org/gnome/shell/ui/main.js': {
        layoutManager, overview, sessionMode, panel: {addToStatusArea() {}},
        uiGroup: {add_child(actor) { uiActors.add(actor); }},
        notify: (...args) => notices.push(args),
    },
    'resource:///org/gnome/shell/ui/panelMenu.js': {Button},
    'resource:///org/gnome/shell/ui/popupMenu.js': {
        PopupMenuItem: Item, PopupSubMenuMenuItem: Item, PopupSeparatorMenuItem: Item,
        PopupBaseMenuItem: Item,
        PopupMenu: Menu, PopupMenuManager: MenuManager,
        Ornament: {DOT: 1, NONE: 0},
    },
    './windowManager.js': {WindowManager: class {
        constructor(_shell, _onError, onDiagnostic) {
            this.onDiagnostic = onDiagnostic;
        }
        busy = false;
        isLayoutChange() { return false; }
        isSynchronousLayoutChange() { return false; }
        list() { return availableWindows; }
        arrange(left, right, onPlaced) {
            left.unminimize();
            right.unminimize();
            onPlaced?.();
            return true;
        }
        cancel() {}
        destroy() {}
    }},
    './overviewDrop.js': {OverviewDrop: class {
        constructor(canPair, onPair) { this.canPair = canPair; this.onPair = onPair; }
        cancel() {}
        destroy() {}
    }},
    './tabNameDialog.js': {TabNameDialog: class {
        constructor(description, onCreate, onClosed) {
            Object.assign(this, {description, onCreate, onClosed});
        }
        open() {}
        destroy() { this.onClosed(); }
    }},
    './overviewGroups.js': {OverviewGroups: class {
        constructor(_shell, _getGroups, onActivate) { this.onActivate = onActivate; }
        enabled = true;
        refresh() {}
        restore() {}
        destroy() {}
    }},
};
const groupSource = await readFile(new URL('../groups.js', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(
    await readFile(new URL('../extension.js', import.meta.url), 'utf8'), {context});
await module.link(specifier => {
    if (specifier === './groups.js')
        return new vm.SourceTextModule(groupSource, {context});
    const exports = imports[specifier];
    assert.ok(exports, `Unexpected import ${specifier}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [name, value] of Object.entries(exports))
            this.setExport(name, value);
    }, {context});
});
await module.evaluate();
const extension = new module.namespace.default();
for (let i = 0; i < 2; i++) {
    extension.enable();
    const menu = extension._button.menu;
    menu.open();
    assert.equal(menu.isOpen, true, 'First click must open the menu, even with no windows');
    assert.equal(menu.items[0].label.text, '左: 未選択');
    assert.equal(menu.items[1].label.text, '右: 未選択');
    assert.equal(menu.items.find(item => item.label.text === '選んだ2つのウィンドウを1つのタブに登録').sensitive, false);
    assert.ok(!menu.items.some(item => item.label.text === '左右50:50に配置'));
    menu.close();
    menu.open();
    assert.equal(menu.items.length, 6, 'Reopening must not duplicate entries');
    extension.disable();
    assert.equal(workspace.handlers.size, 0);
    assert.equal(layoutManager.handlers.size, 0);
    assert.equal(overview.handlers.size, 0);
}
availableWindows = Array.from({length: 4}, (_, index) => Object.assign(new Signals(), {
    minimized: false,
    get_stable_sequence: () => index + 1,
    get_title: () => `Window ${index + 1}`,
    get_frame_rect: () => ({x: 0, y: 0, width: 800, height: 600}),
    get_workspace: () => workspace,
    get_monitor: () => 0,
    is_on_all_workspaces: () => false,
    has_attached_dialogs: () => false,
    can_minimize: () => true,
    minimize() { this.minimized = true; },
    unminimize() { this.minimized = false; },
}));
extension.enable();
const originalDebug = console.debug;
const diagnostics = [];
console.debug = message => diagnostics.push(message);
extension._manager.onDiagnostic({requested: [], actual: []});
console.debug = originalDebug;
assert.equal(diagnostics.length, 1);
assert.equal(notices.length, 0, 'Geometry diagnostics must not display desktop notifications');
const menu = extension._button.menu;
function registerPair(left, right, name) {
    menu.open();
    const entry = menu.items.find(item => item.children.length).children[0];
    entry.text = name;
    menu.items[0].menu.open();
    menu.items[0].menu.items[left].activate();
    assert.equal(menu.isOpen, true, 'Selecting left must keep the top menu open');
    assert.equal(menu.items[0].menu.isOpen, false, 'Only the left submenu collapses');
    assert.ok(menu.items[0].label.text.includes(`Window ${left + 1}`));
    assert.equal(menu.items[1].menu.items[left].sensitive, false, 'Cannot select left again on right');
    menu.items[1].menu.open();
    menu.items[1].menu.items[right].activate({keyboard: true});
    assert.equal(menu.isOpen, true, 'Selecting right must keep the top menu open');
    assert.ok(menu.items[1].label.text.includes(`Window ${right + 1}`));
    const create = menu.items.find(item => item.label.text === '選んだ2つのウィンドウを1つのタブに登録');
    assert.equal(create.sensitive, true);
    assert.equal(entry.text, name, 'Tab name survives both selections');
    create.activate();
    assert.equal(menu.isOpen, false, 'Creating a tab still closes the menu');
}
registerPair(0, 1, '開発');
registerPair(2, 3, '調査');
assert.equal(extension._tabBox.children.length, 2);
assert.equal(extension._tabBox.children[0].label, '開発');
assert.deepEqual(availableWindows.map(w => w.minimized), [true, true, false, false]);
extension._tabBox.children[0].emit('clicked');
assert.deepEqual(availableWindows.map(w => w.minimized), [false, false, true, true]);
overview.visible = true;
extension._overviewGroups.onActivate(extension._groups.groups[1]);
assert.equal(overview.visible, false, 'Clicking a combined preview exits overview');
assert.deepEqual(availableWindows.map(w => w.minimized), [true, true, false, false]);
menu.open();
menu.items.find(item => item.label.text === '調査').menu.items[2].emit('activate');
assert.equal(extension._tabBox.children.length, 1);
assert.equal(availableWindows[2].minimized, false);
extension._drop.onPair(availableWindows[2], availableWindows[3]);
assert.ok(extension._nameDialog, 'Drop opens a name prompt');
assert.equal(extension._groups.groups.length, 1, 'Drop does not register before confirmation');
extension._nameDialog.destroy();
assert.equal(extension._groups.groups.length, 1, 'Cancel does not register');
extension._drop.onPair(availableWindows[2], availableWindows[3]);
extension._nameDialog.onCreate('ドロップ登録', true);
assert.equal(extension._groups.groups.length, 2);
assert.equal(extension._groups.groups[1].name, 'ドロップ登録');
assert.equal(extension._groups.groups[1].windows[0], availableWindows[3]);
assert.equal(extension._groups.groups[1].windows[1], availableWindows[2]);
assert.equal(extension._nameDialog, null);
const group = extension._groups.groups[0];
const originalLeft = group.windows[0], originalRight = group.windows[1];
const beforeVisibility = availableWindows.map(w => w.minimized);
extension._tabBox.children[0].emit('clicked', 3);
assert.equal(extension._tabMenus[0].isOpen, true);
assert.deepEqual(availableWindows.map(w => w.minimized), beforeVisibility,
    'Right click must not activate the tab');
assert.equal(extension._tabMenus[0].items[0].label.text, '左右を入れ替え');
assert.equal(extension._tabMenus[0].items[1].label.text, 'タブを解除');
extension._tabMenus[0].items[0].activate();
assert.equal(group.windows[0], originalRight);
assert.equal(group.windows[1], originalLeft);
assert.equal(extension._groups.groups.includes(group), true);
extension._tabBox.children[0].emit('key-press-event', {get_key_symbol: () => 1});
assert.equal(extension._tabMenus[0].isOpen, true, 'Keyboard menu key opens tab context menu');
extension._tabMenus[0].items[1].activate();
assert.equal(extension._groups.groups.includes(group), false);
assert.equal(extension._tabBox.children.length, 1);
assert.equal(uiActors.size, 1, 'Old context menus must be destroyed on tab refresh');
const savedName = extension._groups.groups[0].name;
sessionMode.isLocked = true;
extension.disable();
assert.equal(uiActors.size, 0, 'Lock removes context menus');
assert.ok(availableWindows.every(w => w.handlers.size === 0), 'Lock disconnects window signals');
sessionMode.isLocked = false;
extension.enable();
assert.equal(extension._groups.groups.length, 1, 'Unlock restores group');
assert.equal(extension._groups.groups[0].name, savedName, 'Unlock preserves tab name');
extension.disable();
extension.enable();
assert.equal(extension._groups.groups.length, 0, 'Manual disable clears groups');
extension.disable();
assert.equal(uiActors.size, 0, 'Disable removes every context menu actor');
assert.ok(availableWindows.every(w => !w.minimized && w.handlers.size === 0));
assert.equal(notices.length, 0);
console.log('PASS: menu lifecycle, register two split tabs, click to switch, release and disable');
