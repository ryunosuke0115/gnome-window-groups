import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

export class TabNameDialog {
    constructor(labels, onCreate, onClosed) {
        this._dialog = new ModalDialog.ModalDialog({
            styleClass: 'window-groups-dialog', shouldFadeIn: false, shouldFadeOut: false,
        });
        this._dialog.contentLayout.add_child(new St.Label({
            text: '分割した2つのウィンドウをタブに登録', style_class: 'window-groups-dialog-title',
        }));
        this._swapped = false;
        const description = () => {
            const [left, right] = this._swapped ? [labels[1], labels[0]] : labels;
            return `左: ${left}\n右: ${right}`;
        };
        const details = new St.Label({text: description(), style_class: 'window-groups-dialog-details'});
        details.clutter_text.line_wrap = true;
        this._dialog.contentLayout.add_child(details);
        this._entry = new St.Entry({hint_text: 'タブ名', can_focus: true, x_expand: true});
        this._dialog.contentLayout.add_child(this._entry);
        this._error = new St.Label({text: '', style_class: 'window-groups-dialog-error'});
        this._error.clutter_text.line_wrap = true;
        this._dialog.contentLayout.add_child(this._error);
        const submit = () => {
            const name = this._entry.get_text().trim().slice(0, 24);
            if (!name) {
                this._error.text = 'タブ名を入力してください．';
                return;
            }
            try {
                onCreate(name, this._swapped);
                this.destroy();
            } catch (error) {
                this._error.text = error.message ?? String(error);
            }
        };
        this._dialog.setButtons([
            {label: 'キャンセル', key: Clutter.KEY_Escape, action: () => this.destroy()},
            {label: '左右を入れ替え', action: () => {
                this._swapped = !this._swapped;
                details.text = description();
                this._error.text = '';
            }},
            {label: '登録', default: true, action: submit},
        ]);
        this._entry.clutter_text.connect('activate', submit);
        this._dialog.setInitialKeyFocus(this._entry);
        this._dialog.connect('destroy', () => {
            this._dialog = null;
            onClosed();
        });
    }

    open() {
        if (!this._dialog.open()) {
            this.destroy();
            throw new Error('タブ名の入力画面を開けませんでした．もう一度試してください．');
        }
    }

    destroy() {
        this._dialog?.close();
        this._dialog?.destroy();
    }
}
