# 開発ガイド

## 構成

| ファイル | 役割 |
| --- | --- |
| `extension.js` | パネル，左右の選択，タブと右クリックメニュー，ライフサイクル管理 |
| `groups.js` | タブの登録・所有権・切り替え・左右交換・一括移動・解除 |
| `windowManager.js` | 対象ウィンドウの列挙，Mutter の位置・サイズ・モニター操作 |
| `layout.js` | 論理座標による分割矩形計算 |
| `overviewDrop.js` | Overview でのウィンドウ同士のドロップと終了処理 |
| `overviewGroups.js` | 2つのウィンドウの合成プレビューとグループ単位のドロップ |
| `tabNameDialog.js` | ドロップ後，登録確定前の名前入力と左右順の選択 |
| `stylesheet.css` | タブ，メニュー，ドロップ対象，ダイアログの表示 |
| `tests/` | GJS と模擬 Shell による自動テスト |

メニューのウィンドウ一覧は，メインメニューの `open-state-changed` で開いたことを検知して再構築する．表示中の一覧は継続更新せず，次に開いた時点の状態を反映する．

## 自動テスト

Ubuntu 24.04 の GJS，Meta-14 typelib，Node.js（20以降を想定），Python 3，Git を使用する．追加の npm パッケージは不要である．

```sh
sh scripts/check.sh
```

このスクリプトは ES module の構文，JSON，空白エラーを確認し，以下を実行する．

| テスト | 対象 |
| --- | --- |
| `tests/run.js` | 分割計算，対象ウィンドウ判定，Mutter API の存在，配置・一括移動，例外と取消 |
| `tests/groups.mjs` | 所有権，切り替え，最小化，解除，リサイズ判定，移動，左右交換 |
| `tests/menu.mjs` | 実際の拡張機能モジュールと模擬 UI を組み合わせたメニュー操作 |
| `tests/overview.mjs` | ドロップ，ハンドラー復元，名前入力，取消，後始末 |
| `tests/overview-groups.mjs` | 合成プレビュー，元の配置への復帰，クリック・ドラッグ，フック解除 |

Node.js の `vm` モジュールを使うテストには `--experimental-vm-modules` を指定している．表示される ExperimentalWarning はこの実行方法によるものである．

ウィンドウと UI は模擬オブジェクトである．テストの成功は実際の Wayland configure 応答，プレビューの描画，ポインターの解放，フォーカスやジェスチャーとの共存を保証しない．これらは[実機テスト手順](MANUAL_TESTS.md)で確認する．未実施の項目を確認済みとして扱わない．

## インストール用 ZIP

```sh
sh scripts/pack.sh
```

`dist/window-groups@local.dev.shell-extension.zip` を生成する．`metadata.json`，実行時の JavaScript，スタイル，README と docs を含める．テスト，開発用スクリプト，Git 情報やローカル設定は含めない．`dist/` は Git の追跡対象外である．

インストール済みコードとソースは別である．更新時は ZIP を再作成してインストールし，再ログインする．ES modules のキャッシュがあるため，無効化・有効化だけではソース更新を反映できない場合がある．

## GNOME Shell 内部 API

対応対象は GNOME Shell 46 である．次の依存箇所は GNOME 更新時に再確認が必要である．

| 領域 | 主な依存先 |
| --- | --- |
| パネル・メニュー | `Main.panel.addToStatusArea`，`Main.layoutManager`，`Main.uiGroup`，`PanelMenu`，`PopupMenu`，`PopupMenuManager` |
| ウィンドウ・入力 | Shell の `global`，`Shell.WindowTracker`，`Meta.Window`，`Meta.Display` の `grab-op-begin` |
| ドラッグ登録 | `DND.addDragMonitor/removeDragMonitor`，`WindowPreview.metaWindow`・`acceptDrop`・drag シグナル，actor の `_delegate` |
| ドロップ終了 | `WindowPreview._draggable._animateDragEnd` の1回限りの差し替え |
| 名前入力 | `ModalDialog.ModalDialog`，`Main.overview` の状態とシグナル |
| 合成プレビュー | `InjectionManager`，`Workspace._addWindowClone`，`WindowPreview.addDialog`，`window_container.layout_manager` |
| 合成表示の操作 | プレビューの `_activate`・`_getCaption`・`_windowCanClose`・`_deleteAll`・`_title`・`_closeButton`，Workspace の `_windows`・`_container`，レイアウトの `_needsLayout` |
| グループ移動 | `Workspace.acceptDrop`，`WorkspaceThumbnail.acceptDropInternal`，`ThumbnailsBox.acceptDrop` |

合成表示では代表プレビューにもう1つのウィンドウの clone を追加し，相手プレビューをレイアウトの配置枠から除外する．スタッキング参照を維持するため，非表示側の actor と native のウィンドウ情報は残す．実際のウィンドウの `skip-taskbar` などの属性は変更しない．合成プレビューの閉じる操作は，複数アプリを誤って終了しないよう抑止している．

グループ移動は標準 DND が決めた代表ウィンドウの移動先へ相手のウィンドウを追従させる．入れ子の drop 処理で二重移動を防ぐ．登録用ドロップも標準の acceptDrop 経路を通し，ポインター解放後に idle で名前入力を開く．登録に成功したドロップだけ，復帰アニメーションの時間を0にして待ち時間を省く．

無効化時には，シグナル，idle / timeout，メニュー，合成 clone，配置枠，変更したメソッド，プロトタイプのフックを復元・解除する．

画面ロックによる `disable()` は `Main.sessionMode.isLocked` で区別し，グループ名・左右順・所属ワークスペース・選択タブ・最小化の所有権を拡張機能インスタンス上に一時保持する．ロック中の UI・シグナル・フックは通常どおり破棄し，ウィンドウの復元は行わない．再有効化時は生存ウィンドウと所属を確認し，再配置せず登録を復元する．閉じたウィンドウや所属が変わったペアは破棄し，拡張機能が隠した相手を復元する．復帰後のサイズを基準に，通常のリサイズ検出を再開する．

## 配置と状態管理

- 座標は外枠を含む論理座標である．倍率を手動で掛けず，モニター別の作業領域で分割する．奇数幅では右側を1論理ピクセル広くする．
- 最大化解除の後に idle を挟んでサイズを要求する．呼び出しは Wayland クライアントの応答完了を意味しない．
- 登録ウィンドウのサイズ・最大化・全画面・所属ワークスペースの変更でタブを解除する．位置だけの移動では解除しない．
- 内部配置の同期呼び出し中と，サイズ要求後700msの応答待ちを保護する．利用者のリサイズ開始は待機中でも優先する．アプリ起因の変更と遅延 configure は完全には識別できない．
- 配置後700msに一度だけ実測値を比較し，2論理ピクセル超の差は `Geometry difference` としてデバッグログへ記録する．同じ内容の連続記録や自動リサイズの再試行は行わない．
- 一括移動中は変更通知でタブを解除しないよう保護する．部分失敗時には不整合な登録を残さず解除する．2つのウィンドウへの操作は原子的ではない．
- 左右の登録順は配置要求の成功後に更新する．失敗・取消時には元の順序を維持する．
- 拡張機能が最小化したウィンドウだけを追跡し，解除・無効化で復元する．ログアウトをまたぐ保存は行わない．

## 参照資料

- [GNOME 拡張機能ガイド](https://gjs.guide/extensions/)
- [GNOME Shell 46 移行ガイド](https://gjs.guide/extensions/upgrading/gnome-shell-46.html)
- [Mutter の Window API](https://github.com/GNOME/mutter/blob/46.0/src/meta/window.h)
- [GNOME Shell の Workspace](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/workspace.js)
- [WindowPreview](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/windowPreview.js)
- [ドラッグ＆ドロップ](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/dnd.js)
- [ModalDialog](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/modalDialog.js)
- [PopupMenu](https://github.com/GNOME/gnome-shell/blob/46.0/js/ui/popupMenu.js)
