// A tab contains an independent pair of windows and its owning workspace.
// Only windows minimized by us are restored when a tab is released/disabled.
export class GroupStore {
    constructor(shell, manager, onChanged, onError) {
        this._shell = shell;
        this._manager = manager;
        this._onChanged = onChanged;
        this._onError = onError;
        this.groups = [];
        this.active = new Map();
        this._hidden = new Set();
        this._nextId = 1;
        this._pending = null;
    }

    owner(window) {
        return this.groups.find(group => group.windows.includes(window));
    }

    current() {
        const workspace = this._shell.workspace_manager.get_active_workspace();
        return this.groups.filter(group => group.workspace === workspace);
    }

    validatePair(left, right) {
        const windows = [left, right];
        const live = this._manager.list();
        if (!left || !right || left === right || windows.some(w => !live.includes(w)))
            throw new Error('異なる通常ウィンドウを左右に選択してください．');
        if (windows.some(w => this.owner(w)))
            throw new Error('そのウィンドウは別のタブに登録済みです．先にタブを解除してください．');
        if (windows.some(w => w.is_on_all_workspaces() || !w.can_minimize()))
            throw new Error('タブには最小化できる，単一ワークスペースのウィンドウを選んでください．');
        if (this._manager.busy || this._pending)
            throw new Error('切り替え中です．少し待ってから操作してください．');
    }

    create(left, right) {
        this.validatePair(left, right);
        const windows = [left, right];
        const id = this._nextId++;
        const group = {
            id, name: `タブ ${id}`, windows,
            workspace: this._shell.workspace_manager.get_active_workspace(),
            signals: [],
            sizes: new Map(windows.map(window => {
                const {width, height} = window.get_frame_rect();
                return [window, {width, height}];
            })),
        };
        this.groups.push(group);
        this._watch(group);
        try {
            this.show(group);
        } catch (error) {
            this.release(group);
            throw error;
        }
        this._onChanged();
        return group;
    }

    _watch(group) {
        for (const window of group.windows) {
            group.signals.push([window, window.connect('unmanaged', () => {
                this.release(group, window);
            })]);
            group.signals.push([window, window.connect('workspace-changed', () => {
                if (!group.moving && window.get_workspace() !== group.workspace)
                    this.release(group);
            })]);
            group.signals.push([window, window.connect('size-changed', () => {
                const {width, height} = window.get_frame_rect();
                const previous = group.sizes.get(window);
                group.sizes.set(window, {width, height});
                if (previous.width === width && previous.height === height)
                    return;
                if (!group.moving && !this._manager.isLayoutChange(window))
                    this.release(group);
            })]);
            for (const property of ['maximized-horizontally', 'maximized-vertically', 'fullscreen']) {
                group.signals.push([window, window.connect(`notify::${property}`, () => {
                    if (!group.moving && !this._manager.isSynchronousLayoutChange(window))
                        this.release(group);
                })]);
            }
        }
    }

    // Keep only inert references while Shell disables us for the lock screen.
    snapshot() {
        return {
            groups: this.groups.map(({id, name, windows, workspace}) =>
                ({id, name, windows: [...windows], workspace})),
            active: new Map([...this.active].map(([workspace, group]) => [workspace, group.id])),
            hidden: new Set(this._hidden),
            nextId: this._nextId,
        };
    }

    restore(snapshot, liveWindows) {
        if (!snapshot)
            return;
        const live = new Set(liveWindows);
        this._nextId = snapshot.nextId;
        this._hidden = new Set([...snapshot.hidden].filter(w => live.has(w)));
        for (const saved of snapshot.groups) {
            if (saved.windows.some(w => !live.has(w) ||
                w.get_workspace() !== saved.workspace || w.is_on_all_workspaces()))
                continue;
            const group = {...saved, signals: [], sizes: new Map(saved.windows.map(w => {
                const {width, height} = w.get_frame_rect();
                return [w, {width, height}];
            }))};
            this.groups.push(group);
            this._watch(group);
            if (snapshot.active.get(saved.workspace) === saved.id)
                this.active.set(saved.workspace, group);
        }
        // A peer may have closed or moved while disabled. Restore survivors
        // hidden by a discarded group, without touching valid inactive tabs.
        for (const window of [...this._hidden]) {
            if (!this.owner(window)) {
                this._hidden.delete(window);
                this._restore(window);
            }
        }
        this._onChanged();
    }

    show(group) {
        return this._show(group, group.windows);
    }

    swap(group) {
        if (!this.groups.includes(group))
            throw new Error('入れ替えるタブが見つかりません．');
        return this._show(group, [group.windows[1], group.windows[0]]);
    }

    _show(group, windows) {
        if (!this.groups.includes(group) || !this.current().includes(group))
            throw new Error('このタブのワークスペースへ切り替えてください．');
        if (this._pending || this._manager.busy)
            throw new Error('切り替え中です．少し待ってから操作してください．');
        // Validate every outgoing pair before changing the incoming pair.
        const others = this.current().filter(value => value !== group);
        if (others.some(value => value.windows.some(w =>
            !w.can_minimize() || w.has_attached_dialogs())))
            throw new Error('別タブのダイアログを閉じてから切り替えてください．');
        this._pending = group;
        try {
            const accepted = this._manager.arrange(...windows, () => {
                if (this._pending !== group || !this.groups.includes(group))
                    return;
                // Commit the new order only after placement requests succeed.
                group.windows = windows;
                // Hide other tabs only once incoming geometry has been requested.
                // Mutter requests remain asynchronous; this is not a client ACK.
                try {
                    for (const other of others) {
                        for (const window of other.windows) {
                            if (!window.minimized) {
                                this._hidden.add(window);
                                window.minimize();
                            }
                        }
                    }
                    group.windows.forEach(w => this._hidden.delete(w));
                    this.active.set(group.workspace, group);
                } catch (error) {
                    this._restoreHidden();
                    this._onError(error);
                } finally {
                    this._pending = null;
                    this._onChanged();
                }
            }, group.windows[0].get_monitor());
            if (!accepted)
                this._pending = null;
        } catch (error) {
            this._pending = null;
            throw error;
        }
    }

    cancelSwitch() {
        this._pending = null;
    }

    transfer(group, nativeDrop) {
        if (!this.groups.includes(group))
            throw new Error('移動するタブが見つかりません．');
        if (this._pending || this._manager.busy)
            throw new Error('切り替え中です．少し待ってから移動してください．');
        if (group.windows.some(window => window.has_attached_dialogs()))
            throw new Error('タブのダイアログを閉じてから移動してください．');
        const origin = group.workspace;
        const wasActive = this.active.get(origin) === group;
        group.moving = true;
        try {
            // Native DND chooses the destination, including newly inserted
            // dynamic workspaces. Its first-member notifications are guarded.
            const accepted = nativeDrop();
            if (!accepted || !this.groups.includes(group))
                return accepted;
            const leader = group.windows[0];
            const destination = leader.get_workspace();
            const monitor = leader.get_monitor();
            this._manager.movePair(group.windows, destination, monitor);
            group.workspace = destination;
            for (const window of group.windows) {
                const {width, height} = window.get_frame_rect();
                group.sizes.set(window, {width, height});
            }
            if (wasActive && destination !== origin) {
                this.active.delete(origin);
                if (!this.active.has(destination))
                    this.active.set(destination, group);
            }
            return true;
        } catch (error) {
            this.release(group);
            throw error;
        } finally {
            group.moving = false;
            this._onChanged();
        }
    }

    release(group, closed = null) {
        if (!this.groups.includes(group))
            return;
        this._manager.cancel();
        this._pending = null;
        for (const [window, id] of group.signals)
            window.disconnect(id);
        this.groups = this.groups.filter(value => value !== group);
        if (this.active.get(group.workspace) === group)
            this.active.delete(group.workspace);
        for (const window of group.windows) {
            if (this._hidden.delete(window) && window !== closed)
                this._restore(window);
        }
        this._onChanged();
    }

    _restore(window) {
        try {
            window.unminimize();
        } catch (error) {
            this._onError(error);
        }
    }

    _restoreHidden() {
        for (const window of this._hidden)
            this._restore(window);
        this._hidden.clear();
    }

    destroy({restoreHidden = true} = {}) {
        this._manager.cancel();
        this._pending = null;
        for (const group of this.groups) {
            for (const [window, id] of group.signals)
                window.disconnect(id);
        }
        if (restoreHidden)
            this._restoreHidden();
        else
            this._hidden.clear();
        this.groups = [];
        this.active.clear();
    }
}
