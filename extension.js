import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {WindowManager} from './windowManager.js';
import {GroupStore} from './groups.js';
import {OverviewDrop} from './overviewDrop.js';
import {TabNameDialog} from './tabNameDialog.js';
import {OverviewGroups} from './overviewGroups.js';

export default class WindowGroupsExtension extends Extension {
    enable() {
        this._signals = [];
        this._selectionSignals = [];
        this._nameSignals = [];
        this._selected = [null, null];
        try {
            this._manager = new WindowManager(global,
                error => {
                    this._groups?.cancelSwitch();
                    this._report(error);
                },
                diagnostic => console.debug(
                    `[Window Groups] Geometry difference: ${JSON.stringify(diagnostic)}`));
            this._groups = new GroupStore(global, this._manager,
                () => this._syncTabs(), error => this._report(error));
            this._tabs = new PanelMenu.Button(0.0, 'Window Groups Tabs', true);
            this._tabMenus = [];
            this._tabMenuManager = new PopupMenu.PopupMenuManager(this._tabs);
            this._tabBox = new St.BoxLayout({style_class: 'window-groups-tabs'});
            this._tabs.add_child(this._tabBox);
            this._button = new PanelMenu.Button(0.5, 'Window Groups');
            this._button.add_child(new St.Icon({
                icon_name: 'view-dual-symbolic', style_class: 'system-status-icon',
            }));
            // PopupMenu.open() ignores empty menus before emitting its signal.
            // Seed one item so the first click reaches the rebuild callback.
            this._button.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                'ウィンドウ一覧を読み込み中…', {reactive: false}));
            this._connect(this._button.menu, 'open-state-changed', (_menu, open) => {
                if (open)
                    this._rebuild();
            });
            this._connect(global.workspace_manager, 'active-workspace-changed',
                () => this._contextChanged());
            this._connect(Main.layoutManager, 'monitors-changed',
                () => this._contextChanged());
            this._connect(Main.overview, 'showing', () => {
                this._closeTabMenus();
                this._tabs.container.hide();
                this._overviewGroups?.refresh();
            });
            this._connect(Main.overview, 'hidden', () => {
                this._overviewGroups?.restore();
                this._syncTabs();
            });
            this._connect(Main.overview, 'hiding', () => {
                this._drop?.cancel();
                this._closeNameDialog();
            });
            Main.panel.addToStatusArea(this.uuid, this._button);
            Main.panel.addToStatusArea(`${this.uuid}-tabs`, this._tabs, 1, 'left');
            const suspended = this._suspendedGroups;
            this._suspendedGroups = null;
            this._groups.restore(suspended,
                global.get_window_actors().map(actor => actor.meta_window));
            this._syncTabs();
            this._overviewGroups = new OverviewGroups(global, () => this._groups.groups,
                group => this._run(() => {
                    if (global.workspace_manager.get_active_workspace() !== group.workspace)
                        group.workspace.activate(global.get_current_time());
                    this._groups.show(group);
                    Main.overview.hide();
                }), error => this._report(error), () => Main.overview.visible,
                (group, nativeDrop) => this._groups.transfer(group, nativeDrop));
            this._drop = new OverviewDrop((left, right) => {
                try {
                    this._groups.validatePair(left, right);
                    return true;
                } catch (_) {
                    return false;
                }
            }, (left, right) => this._promptPair(left, right),
            error => this._report(error), () => Main.overview.visible && !this._nameDialog);
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    _connect(object, signal, callback) {
        this._signals.push([object, object.connect(signal, callback)]);
    }

    _disconnect(signals) {
        for (const [object, id] of signals)
            object.disconnect(id);
        signals.length = 0;
    }

    _contextChanged() {
        this._drop?.cancel();
        this._closeNameDialog();
        this._manager.cancel();
        this._groups.cancelSwitch();
        this._button.menu.close();
        this._selected = [null, null];
        this._watchSelection();
        this._syncTabs();
    }

    _closeNameDialog() {
        this._disconnect(this._nameSignals ?? []);
        this._nameDialog?.destroy();
        this._nameDialog = null;
    }

    _promptPair(left, right) {
        this._groups.validatePair(left, right);
        this._closeNameDialog();
        this._nameDialog = new TabNameDialog(
            [this._label(left), this._label(right)],
            (name, swapped) => {
                const group = swapped
                    ? this._groups.create(right, left)
                    : this._groups.create(left, right);
                group.name = name;
                this._selected = [null, null];
                this._watchSelection();
                this._syncTabs();
                Main.overview.hide();
            }, () => {
                this._disconnect(this._nameSignals);
                this._nameDialog = null;
            });
        for (const window of [left, right]) {
            for (const signal of ['unmanaged', 'workspace-changed'])
                this._nameSignals.push([window,
                    window.connect(signal, () => this._closeNameDialog())]);
        }
        this._nameDialog.open();
    }

    _run(callback) {
        this._button.menu.close();
        this._closeTabMenus();
        try {
            callback();
        } catch (error) {
            this._report(error);
        }
    }

    _syncTabs() {
        if (!this._tabBox)
            return;
        this._destroyTabMenus();
        this._tabBox.destroy_all_children();
        const groups = this._groups.current();
        for (const group of groups.slice(0, 5)) {
            const tab = new St.Button({
                label: group.name, can_focus: true,
                accessible_name: `${group.name}: 分割した2つのウィンドウを表示`,
                style_class: 'window-groups-tab',
                button_mask: St.ButtonMask.ONE | St.ButtonMask.THREE,
            });
            if (this._groups.active.get(group.workspace) === group)
                tab.add_style_pseudo_class('active');
            const contextMenu = new PopupMenu.PopupMenu(tab, 0.5, St.Side.TOP);
            contextMenu.actor.add_style_class_name('panel-menu');
            Main.uiGroup.add_child(contextMenu.actor);
            contextMenu.actor.hide();
            this._tabMenuManager.addMenu(contextMenu);
            this._tabMenus.push(contextMenu);
            contextMenu.addAction('左右を入れ替え', () => this._run(() => this._groups.swap(group)));
            contextMenu.addAction('タブを解除', () => this._run(() => this._groups.release(group)));
            tab.connect('clicked', (_tab, button) => {
                if (button === 3) {
                    this._button.menu.close();
                    this._closeTabMenus();
                    contextMenu.open();
                } else {
                    this._run(() => this._groups.show(group));
                }
            });
            tab.connect('key-press-event', (_tab, event) => {
                if (event.get_key_symbol() === Clutter.KEY_Menu ||
                    (event.get_key_symbol() === Clutter.KEY_F10 &&
                     (event.get_state() & Clutter.ModifierType.SHIFT_MASK))) {
                    this._button.menu.close();
                    this._closeTabMenus();
                    contextMenu.open();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._tabBox.add_child(tab);
        }
        if (groups.length > 5)
            this._tabBox.add_child(new St.Label({text: `+${groups.length - 5}`}));
        this._tabs.container.visible = groups.length > 0 && !Main.overview.visible;
        this._overviewGroups?.refresh();
    }

    _closeTabMenus() {
        for (const menu of this._tabMenus ?? [])
            menu.close();
    }

    _destroyTabMenus() {
        for (const menu of this._tabMenus ?? []) {
            menu.close();
            this._tabMenuManager.removeMenu(menu);
            menu.destroy();
        }
        this._tabMenus = [];
    }

    _watchSelection() {
        this._disconnect(this._selectionSignals);
        for (const window of new Set(this._selected.filter(Boolean))) {
            const id = window.connect('unmanaged', () => {
                // Do not rebuild/destroy menu actors during window destruction.
                this._manager.cancel();
                this._selected = this._selected.map(value => value === window ? null : value);
                this._button.menu.close();
                // Disconnect this and any other selection handlers now.
                this._watchSelection();
            });
            this._selectionSignals.push([window, id]);
        }
    }

    _label(window) {
        if (!window)
            return '未選択';
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const clean = text => String(text).replace(/[\r\n\t]/g, ' ').slice(0, 70);
        return `${clean(app?.get_name() ?? window.get_wm_class() ?? 'アプリ')} — ` +
            `${clean(window.get_title() || '無題')} [#${window.get_stable_sequence()}]`;
    }

    _rebuild() {
        try {
            const windows = this._manager.list();
            this._selected = this._selected.map(window => windows.includes(window) ? window : null);
            this._watchSelection();
            const menu = this._button.menu;
            menu.removeAll();
            const selectors = [];
            const choices = [];
            let create;
            const syncSelection = () => {
                for (const [side, name] of ['左', '右'].entries())
                    selectors[side].label.text = `${name}: ${this._label(this._selected[side])}`;
                for (const {item, window, side} of choices) {
                    item.setOrnament(this._selected[side] === window
                        ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
                    item.setSensitive(this._selected[1 - side] !== window &&
                        !this._groups.owner(window));
                }
                create?.setSensitive(this._selected.every(w => w && !this._groups.owner(w)) &&
                    !this._manager.busy);
            };
            for (const [side, name] of ['左', '右'].entries()) {
                const submenu = new PopupMenu.PopupSubMenuMenuItem(
                    `${name}: ${this._label(this._selected[side])}`);
                submenu.label.add_style_class_name('window-groups-window-label');
                selectors.push(submenu);
                menu.addMenuItem(submenu);
                if (windows.length === 0)
                    submenu.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                        '対象の通常ウィンドウがありません', {reactive: false}));
                for (const window of windows) {
                    const item = new PopupMenu.PopupMenuItem(this._label(window));
                    item.label.add_style_class_name('window-groups-window-label');
                    choices.push({item, window, side});
                    // Override only this item's activation: emitting the usual
                    // activate signal makes PopupMenu close the entire menu.
                    // Both pointer and keyboard activation call this method.
                    item.activate = () => {
                        try {
                            const live = this._manager.list();
                            this._selected = this._selected.map(w => live.includes(w) ? w : null);
                            if (live.includes(window) && this._selected[1 - side] !== window &&
                                !this._groups.owner(window))
                                this._selected[side] = window;
                            this._watchSelection();
                            syncSelection();
                            submenu.menu.close();
                        } catch (error) {
                            this._report(error);
                        }
                    };
                    submenu.menu.addMenuItem(item);
                }
            }
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const nameRow = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
            const nameEntry = new St.Entry({
                hint_text: 'タブ名（空欄なら自動）', can_focus: true,
                style_class: 'window-groups-name', x_expand: true,
            });
            nameRow.add_child(nameEntry);
            menu.addMenuItem(nameRow);
            create = new PopupMenu.PopupMenuItem('選んだ2つのウィンドウを1つのタブに登録');
            create.connect('activate', () => this._run(() => {
                const group = this._groups.create(...this._selected);
                group.name = nameEntry.get_text().trim().slice(0, 24) || group.name;
                this._selected = [null, null];
                this._watchSelection();
                this._syncTabs();
            }));
            menu.addMenuItem(create);
            for (const group of this._groups.current()) {
                const submenu = new PopupMenu.PopupSubMenuMenuItem(group.name);
                submenu.menu.addAction('このタブを表示（分割した2つのウィンドウ）',
                    () => this._run(() => this._groups.show(group)));
                submenu.menu.addAction('入力したタブ名に変更', () => this._run(() => {
                    const name = nameEntry.get_text().trim().slice(0, 24);
                    if (!name)
                        throw new Error('先にメニューのタブ名欄に名前を入力してください．');
                    group.name = name;
                    this._syncTabs();
                }));
                submenu.menu.addAction('タブを解除（ウィンドウは閉じない）',
                    () => this._run(() => this._groups.release(group)));
                menu.addMenuItem(submenu);
            }
            menu.addAction('選択をクリア', () => {
                this._selected = [null, null];
                this._watchSelection();
            });
            syncSelection();
        } catch (error) {
            this._button.menu.close();
            this._report(error);
        }
    }

    _report(error) {
        console.error(`[Window Groups] ${error.stack ?? error}`);
        Main.notify('Window Groups', `${error.message ?? error} 一部だけ配置が変わった場合は手動で戻してください．`);
    }

    disable() {
        const locked = Main.sessionMode.isLocked;
        if (this._groups)
            this._suspendedGroups = locked ? this._groups.snapshot() : null;
        else if (!locked)
            this._suspendedGroups = null;
        this._destroyTabMenus();
        this._tabMenuManager = null;
        this._overviewGroups?.destroy();
        this._overviewGroups = null;
        this._drop?.destroy();
        this._drop = null;
        this._closeNameDialog();
        this._groups?.destroy({restoreHidden: !locked});
        this._manager?.destroy();
        this._disconnect(this._selectionSignals ?? []);
        this._disconnect(this._signals ?? []);
        this._button?.destroy();
        this._tabs?.destroy();
        this._tabs = null;
        this._tabBox = null;
        this._groups = null;
        this._button = null;
        this._manager = null;
        this._selected = null;
    }
}
