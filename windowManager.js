import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {rectMatches, splitHorizontal} from './layout.js';

export function isEligible(window, workspace) {
    return window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.is_override_redirect() && !window.is_skip_taskbar() &&
        !window.get_transient_for() && !window.has_attached_dialogs() &&
        !window.is_fullscreen() && window.located_on_workspace(workspace) &&
        window.allows_move() && (window.allows_resize() ||
            window.get_maximized() === Meta.MaximizeFlags.BOTH);
}

// Keep Mutter operations separate from the panel, for later group management.
// `shell` is the GNOME Shell global object (injected for headless tests).
export class WindowManager {
    constructor(shell, onError, onDiagnostic) {
        this._shell = shell;
        this._onError = onError;
        this._onDiagnostic = onDiagnostic;
        this._lastDiagnostic = null;
        this._sources = new Set();
        this._destroyed = false;
        this._layoutChanges = new WeakMap();
        this._synchronousChanges = new Set();
        const resizeOps = new Set(Object.entries(Meta.GrabOp)
            .filter(([name]) => name.startsWith('RESIZING_') || name.startsWith('KEYBOARD_RESIZING_'))
            .map(([, value]) => value));
        this._grabSignal = shell.display.connect('grab-op-begin', (_display, window, op) => {
            if (resizeOps.has(op))
                this._layoutChanges.delete(window);
        });
        this.busy = false;
    }

    isLayoutChange(window) {
        const deadline = this._layoutChanges.get(window);
        return deadline !== undefined && GLib.get_monotonic_time() < deadline;
    }

    isSynchronousLayoutChange(window) {
        return this._synchronousChanges.has(window);
    }

    _withLayoutChange(window, callback) {
        this._synchronousChanges.add(window);
        try {
            callback();
        } finally {
            this._synchronousChanges.delete(window);
        }
    }

    list() {
        const workspace = this._shell.workspace_manager.get_active_workspace();
        return [...new Set(this._shell.get_window_actors()
            .map(actor => actor.meta_window)
            .filter(window => window && isEligible(window, workspace)))]
            .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    }

    _validate(left, right, workspace, monitor) {
        const windows = this.list();
        if (this._shell.workspace_manager.get_active_workspace() !== workspace ||
            !left || !right || left === right ||
            !windows.includes(left) || !windows.includes(right))
            throw new Error('選択した2つのウィンドウを現在のワークスペースで選び直してください．');
        if (monitor < 0 || monitor >= this._shell.display.get_n_monitors())
            throw new Error('配置先のモニターが見つかりません．選び直してください．');
    }

    _later(delay, callback) {
        const run = () => {
            this._sources.delete(id);
            if (!this._destroyed) {
                try {
                    callback();
                } catch (error) {
                    this.busy = false;
                    this._onError(error);
                }
            }
            return GLib.SOURCE_REMOVE;
        };
        const id = delay === 0
            ? GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, run)
            : GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, run);
        this._sources.add(id);
    }

    arrange(left, right, onPlaced = () => {}, monitor = left?.get_monitor() ?? -1) {
        if (this._destroyed || this.busy)
            return false;
        this.cancel();
        const workspace = this._shell.workspace_manager.get_active_workspace();
        this._validate(left, right, workspace, monitor);
        // Validate the work area before altering either window.
        splitHorizontal(workspace.get_work_area_for_monitor(monitor));
        this.busy = true;
        try {
            const deadline = GLib.get_monotonic_time() + 700_000;
            for (const window of [left, right])
                this._layoutChanges.set(window, deadline);
            for (const window of [left, right]) {
                this._withLayoutChange(window, () => {
                    window.unmaximize(Meta.MaximizeFlags.BOTH);
                    window.unminimize();
                    if (window.get_monitor() !== monitor)
                        window.move_to_monitor(monitor);
                });
            }
            // Let unmaximize/monitor changes settle before requesting geometry.
            // This is not an acknowledgement from a Wayland client.
            this._later(0, () => {
                this._validate(left, right, workspace, monitor);
                const rectangles = splitHorizontal(
                    workspace.get_work_area_for_monitor(monitor));
                [left, right].forEach((window, index) => {
                    // Extend only an uninterrupted request. A user's resize
                    // grab removes the exemption even while configure is pending.
                    if (this._layoutChanges.has(window))
                        this._layoutChanges.set(window, GLib.get_monotonic_time() + 700_000);
                    const {x, y, width, height} = rectangles[index];
                    this._withLayoutChange(window, () =>
                        window.move_resize_frame(true, x, y, width, height));
                });
                left.raise();
                right.activate(this._shell.get_current_time());
                this.busy = false;
                onPlaced();
                // One diagnostic check, no resize polling or enforcement loop.
                this._later(700, () => {
                    const live = this.list();
                    if (this._shell.workspace_manager.get_active_workspace() !== workspace ||
                        !live.includes(left) || !live.includes(right))
                        return;
                    const actual = [left, right].map(window => {
                        const {x, y, width, height} = window.get_frame_rect();
                        return {x, y, width, height};
                    });
                    if (actual.every((rect, index) => rectMatches(rect, rectangles[index]))) {
                        this._lastDiagnostic = null;
                        return;
                    }
                    // A geometry difference is not a failed operation: clients
                    // may constrain sizes, respond late, or be moved by users.
                    const diagnostic = {
                        windows: [left, right].map(window => window.get_stable_sequence()),
                        requested: rectangles, actual,
                    };
                    const signature = JSON.stringify(diagnostic);
                    if (signature !== this._lastDiagnostic) {
                        this._lastDiagnostic = signature;
                        this._onDiagnostic(diagnostic);
                    }
                });
            });
        } catch (error) {
            this.cancel();
            throw error;
        }
        return true;
    }

    movePair(windows, workspace, monitor) {
        if (this._destroyed || this.busy)
            throw new Error('配置処理中のためタブを移動できません．');
        if (!workspace || monitor < 0 || monitor >= this._shell.display.get_n_monitors())
            throw new Error('移動先のワークスペースまたはモニターが見つかりません．');
        const live = this._shell.get_window_actors().map(actor => actor.meta_window);
        if (windows.length !== 2 || windows[0] === windows[1] || windows.some(w => !live.includes(w)))
            throw new Error('移動する2つのウィンドウを確認できません．');
        const rectangles = splitHorizontal(workspace.get_work_area_for_monitor(monitor));
        for (const window of windows)
            this._layoutChanges.set(window, GLib.get_monotonic_time() + 700_000);
        windows.forEach((window, index) => this._withLayoutChange(window, () => {
            if (window.get_monitor() !== monitor)
                window.move_to_monitor(monitor);
            if (window.get_workspace() !== workspace)
                window.change_workspace(workspace);
            const {x, y, width, height} = rectangles[index];
            window.move_resize_frame(true, x, y, width, height);
        }));
    }

    cancel() {
        for (const id of this._sources)
            GLib.Source.remove(id);
        this._sources.clear();
        this.busy = false;
    }

    destroy() {
        this._destroyed = true;
        this.cancel();
        if (this._grabSignal)
            this._shell.display.disconnect(this._grabSignal);
        this._grabSignal = 0;
        this._layoutChanges = new WeakMap();
        this._synchronousChanges.clear();
        this._shell = null;
        this._onError = null;
        this._onDiagnostic = null;
    }
}
