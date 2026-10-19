import GLib from 'gi://GLib';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import {WindowPreview} from 'resource:///org/gnome/shell/ui/windowPreview.js';

// GNOME 46 internal API adapter. Only hovered preview instances are wrapped;
// the normal DND acceptDrop path performs drag cleanup and pointer ungrabbing.
export class OverviewDrop {
    constructor(canPair, onPair, onError, isEnabled) {
        this._canPair = canPair;
        this._onPair = onPair;
        this._onError = onError;
        this._isEnabled = isEnabled;
        this._signals = [];
        this._target = null;
        this._source = null;
        this._pair = null;
        this._idle = 0;
        this._monitor = {dragMotion: event => this._motion(event)};
        DND.addDragMonitor(this._monitor);
    }

    _preview(actor) {
        for (let current = actor; current; current = current.get_parent()) {
            if (current._delegate instanceof WindowPreview)
                return current._delegate;
        }
        return null;
    }

    _valid(source, target) {
        return this._isEnabled() && source instanceof WindowPreview &&
            target instanceof WindowPreview && source !== target &&
            this._canPair(target.metaWindow, source.metaWindow);
    }

    _motion(event) {
        try {
            const source = event.source;
            const target = this._preview(event.targetActor);
            if (!this._valid(source, target)) {
                this._clearTarget();
                return DND.DragMotionResult.CONTINUE;
            }
            if (this._source !== source) {
                this.cancel();
                this._source = source;
                this._signals.push([source, source.connect('drag-end', () => this._ended())]);
                this._signals.push([source, source.connect('drag-cancelled', () => this.cancel())]);
                this._signals.push([source, source.connect('destroy', () => this.cancel())]);
            }
            if (this._target !== target) {
                this._clearTarget();
                this._target = target;
                this._original = Object.getOwnPropertyDescriptor(target, 'acceptDrop');
                const fallback = target.acceptDrop;
                this._accept = (dragSource, ...args) => {
                    if (!this._valid(dragSource, target))
                        return fallback.call(target, dragSource, ...args);
                    this._pair = [target.metaWindow, dragSource.metaWindow];
                    this._skipRestoreAnimation(dragSource);
                    this._clearTarget();
                    return true;
                };
                target.acceptDrop = this._accept;
                target.add_style_class_name('window-groups-drop-target');
                this._targetDestroy = target.connect('destroy', () => this._clearTarget());
            }
            return DND.DragMotionResult.COPY_DROP;
        } catch (error) {
            this.cancel();
            this._onError(error);
            return DND.DragMotionResult.CONTINUE;
        }
    }

    _clearTarget() {
        if (!this._target)
            return;
        const target = this._target;
        target.disconnect(this._targetDestroy);
        target.remove_style_class_name('window-groups-drop-target');
        if (target.acceptDrop === this._accept) {
            if (this._original)
                Object.defineProperty(target, 'acceptDrop', this._original);
            else
                delete target.acceptDrop;
        }
        this._target = null;
        this._original = null;
        this._accept = null;
    }

    _skipRestoreAnimation(source) {
        // GNOME 46 restores successful window drags with a 750ms fade while
        // keeping the drag actor reparented to uiGroup. Skip only that one
        // animation; retain its normal completion, reparenting and grab cleanup.
        const draggable = source._draggable;
        if (typeof draggable?._animateDragEnd !== 'function')
            return;
        const descriptor = Object.getOwnPropertyDescriptor(draggable, '_animateDragEnd');
        const original = draggable._animateDragEnd;
        const restore = () => {
            if (draggable._animateDragEnd === animate) {
                if (descriptor)
                    Object.defineProperty(draggable, '_animateDragEnd', descriptor);
                else
                    delete draggable._animateDragEnd;
            }
            this._restoreAnimation = null;
        };
        const animate = (time, params) => {
            restore();
            return original.call(draggable, time, {...params, duration: 0});
        };
        this._restoreAnimation = restore;
        draggable._animateDragEnd = animate;
    }

    _ended() {
        const pair = this._pair;
        this.cancel();
        if (!pair)
            return;
        // drag-end is emitted just before DND releases its grab. Wait until
        // that call stack completes before opening a system-modal dialog.
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idle = 0;
            try {
                if (this._isEnabled() && this._canPair(...pair))
                    this._onPair(...pair);
            } catch (error) {
                this._onError(error);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        this._clearTarget();
        this._restoreAnimation?.();
        for (const [object, id] of this._signals)
            object.disconnect(id);
        this._signals = [];
        this._source = null;
        this._pair = null;
        if (this._idle)
            GLib.Source.remove(this._idle);
        this._idle = 0;
    }

    destroy() {
        this.cancel();
        DND.removeDragMonitor(this._monitor);
    }
}
