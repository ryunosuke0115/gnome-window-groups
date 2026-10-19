import GLib from 'gi://GLib';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Workspace} from 'resource:///org/gnome/shell/ui/workspace.js';
import {WindowPreview} from 'resource:///org/gnome/shell/ui/windowPreview.js';
import {WorkspaceThumbnail, ThumbnailsBox} from 'resource:///org/gnome/shell/ui/workspaceThumbnail.js';

// Experimental GNOME 46 adapter. Keep both Meta.Windows and both original
// preview actors alive. Only the Overview layout slot and clone set change.
export class OverviewGroups {
    constructor(shell, getGroups, onActivate, onError, isVisible, onTransfer) {
        Object.assign(this, {_shell: shell, _getGroups: getGroups,
            _onActivate: onActivate, _onError: onError, _isVisible: isVisible, _onTransfer: onTransfer});
        this.enabled = true;
        this._workspaces = new Map();
        this._records = new Map();
        this._idle = 0;
        this._destroyed = false;
        this._injections = new InjectionManager();
        const owner = this;
        this._injections.overrideMethod(Workspace.prototype, '_addWindowClone', original =>
            function (...args) {
                const preview = original.apply(this, args);
                owner._track(this);
                owner.refresh();
                return preview;
            });
        this._injections.overrideMethod(WindowPreview.prototype, 'addDialog', original =>
            function (...args) {
                const result = original.apply(this, args);
                owner.refresh();
                return result;
            });
        for (const [prototype, method] of [
            [Workspace.prototype, 'acceptDrop'],
            [WorkspaceThumbnail.prototype, 'acceptDropInternal'],
            [ThumbnailsBox.prototype, 'acceptDrop'],
        ]) {
            this._injections.overrideMethod(prototype, method, original =>
                function (source, ...args) {
                    const group = source?._windowGroupsGroup;
                    if (!group || group.moving || !owner._getGroups().includes(group))
                        return original.call(this, source, ...args);
                    try {
                        return owner._onTransfer(group, () => original.call(this, source, ...args));
                    } catch (error) {
                        owner._onError(error);
                        // Do not let a parent drop target move only one member
                        // after a failed/partial group transfer.
                        return true;
                    }
                });
        }
    }

    _track(workspace) {
        if (this._workspaces.has(workspace))
            return;
        const id = workspace.connect('destroy', () => {
            for (const record of [...this._records.values()]) {
                if (record.workspace === workspace)
                    this._restore(record, true);
            }
            this._workspaces.delete(workspace);
        });
        this._workspaces.set(workspace, id);
    }

    _discover() {
        // Discover existing instances without assuming a particular monitor or
        // workspaces-display implementation (new instances are tracked above).
        const pending = [this._shell.stage];
        while (pending.length) {
            const actor = pending.pop();
            if (!actor)
                continue;
            if (actor instanceof WindowPreview && actor._workspace)
                this._track(actor._workspace);
            pending.push(...actor.get_children());
        }
    }

    refresh() {
        if (this._destroyed || this._idle || !this.enabled || !this._isVisible())
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            if (!this._destroyed && this.enabled && this._isVisible()) {
                try {
                    this._sync();
                } catch (error) {
                    // An incompatible internal API should leave normal previews.
                    this.enabled = false;
                    this.restore();
                    this._onError(error);
                }
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _matches(record, group) {
        return group && group.windows[0] === record.primary.metaWindow &&
            group.windows[1] === record.secondary.metaWindow &&
            record.workspace._windows.includes(record.primary) &&
            record.workspace._windows.includes(record.secondary) &&
            group.windows.every(window => window.get_monitor() === record.workspace.monitorIndex &&
                window.get_workspace() === group.workspace && !window.has_attached_dialogs());
    }

    _sync() {
        this._discover();
        const groups = this._getGroups();
        for (const record of [...this._records.values()]) {
            if (record.group.moving)
                continue;
            const group = groups.find(value => value === record.group);
            if (!this._matches(record, group))
                this._restore(record);
            else
                record.primary._title.text = group.name;
        }
        for (const workspace of this._workspaces.keys()) {
            for (const group of groups) {
                if (workspace.metaWorkspace !== group.workspace)
                    continue;
                const primary = workspace._windows.find(p => p.metaWindow === group.windows[0]);
                const secondary = workspace._windows.find(p => p.metaWindow === group.windows[1]);
                if (!primary || !secondary || this._records.has(primary) ||
                    primary.inDrag || secondary.inDrag)
                    continue;
                const record = {workspace, group, primary, secondary,
                    visible: secondary.visible, closeVisible: primary._closeButton.visible,
                    methods: [], signals: [], dead: new Set()};
                if (this._matches(record, group))
                    this._merge(record);
            }
        }
    }

    _replace(record, object, key, value) {
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        record.methods.push({object, key, descriptor, value});
        object[key] = value;
    }

    _merge(record) {
        const {workspace, group, primary, secondary} = record;
        const layout = workspace._container.layout_manager;
        const cloneLayout = primary.window_container.layout_manager;
        if (typeof cloneLayout.remove_window !== 'function' ||
            typeof layout.removeWindow !== 'function' || typeof layout.addWindow !== 'function')
            throw new Error('Overview の内部 API が対応していません．試作表示を停止します．');
        this._records.set(primary, record);
        try {
            // Do not let the stock close button delete every cloned window.
            this._replace(record, primary, '_windowCanClose', () => false);
            this._replace(record, primary, '_deleteAll', () => {});
            this._replace(record, primary, '_getCaption', () => group.name);
            this._replace(record, primary, '_activate', () => this._onActivate(group));
            this._replace(record, primary, '_windowGroupsGroup', group);
            primary._closeButton.hide();
            primary._title.text = group.name;
            primary._addWindow(secondary.metaWindow);
            record.added = true;
            if (!cloneLayout.get_windows().includes(secondary.metaWindow))
                throw new Error('2つ目のウィンドウのプレビューを作成できませんでした．');
            // Preserve the peer actor as a hidden sibling so native stacking
            // references remain valid, but exclude it from layout slot counting.
            layout.removeWindow(secondary);
            record.removed = true;
            workspace._container.add_child(secondary);
            secondary.hide();
            for (const actor of [primary, secondary]) {
                record.signals.push([actor, actor.connect('destroy', () => {
                    record.dead.add(actor);
                    this._restore(record);
                    this.refresh();
                })]);
            }
            // Keep both live clones in the drag actor. The destination's native
            // acceptDrop is wrapped above to transfer the complete pair.
            record.signals.push([primary, primary.connect('drag-end', () => this.refresh())]);
            record.signals.push([primary, primary.connect('drag-cancelled', () => this.refresh())]);
            record.signals.push([primary, primary.connect('size-changed', () => {
                this._relayout(workspace);
            })]);
            this._relayout(workspace);
        } catch (error) {
            this._restore(record);
            throw error;
        }
    }

    _relayout(workspace) {
        const layout = workspace._container.layout_manager;
        layout._needsLayout = true;
        layout.layout_changed();
    }

    _restore(record, workspaceDestroyed = false) {
        if (!this._records.delete(record.primary))
            return;
        const {workspace, primary, secondary} = record;
        for (const [actor, id] of record.signals)
            actor.disconnect(id);
        if (record.added && !record.dead.has(primary))
            primary.window_container.layout_manager.remove_window(secondary.metaWindow);
        for (const {object, key, descriptor, value} of record.methods.reverse()) {
            if (!record.dead.has(object) && object[key] === value) {
                if (descriptor)
                    Object.defineProperty(object, key, descriptor);
                else
                    delete object[key];
            }
        }
        if (!workspaceDestroyed && record.removed && !record.dead.has(secondary) &&
            workspace._windows.includes(secondary)) {
            const parent = secondary.get_parent();
            parent?.remove_child(secondary);
            workspace._container.layout_manager.addWindow(secondary, secondary.metaWindow);
            secondary.visible = record.visible;
        }
        if (!record.dead.has(primary)) {
            primary._title.text = primary._getCaption();
            primary._closeButton.visible = record.closeVisible;
        }
        if (!workspaceDestroyed)
            this._relayout(workspace);
    }

    restore() {
        if (this._idle)
            GLib.Source.remove(this._idle);
        this._idle = 0;
        for (const record of [...this._records.values()])
            this._restore(record);
    }

    destroy() {
        this._destroyed = true;
        this._injections.clear();
        this.restore();
        for (const [workspace, id] of this._workspaces)
            workspace.disconnect(id);
        this._workspaces.clear();
    }
}
