# KOROGI-Lab Ver.0.1

KOROGI-Labは、虫音・環境音の音響モデルを設計して検証するWeb Audio研究用アプリです。8つの独立したTimbreを、共通のNear／Far空間処理へ送って重ねられます。

公開候補バージョンは **0.1.0** です。GitHub Pages公開後のURLは `https://akiramaetomo.github.io/KOROGI-Lab/` を予定しています。

## 特徴
- 秋の虫の鳴き声に寄せた目的指向のシンセサイザ
- 作者の鳴き声研究の結果を踏まえて、以下の機能を実装している
  - 音量エンベロープ(AEnv)へのバーストトリガ機能
  - 音量エンベロープ(AEnv)カーブはリニアと対数を用意。
  - 1音色の最終段にエフェクト（ディストーションを意図）
  - FM変調機能は、キリギリス系を再現するために効果的
  - AM変調機能のDCオフセットが可変できる
  - 鍵盤・ノート単位の音程入力は未実装（今後実装）

## クイックスタート
- 画面右上ボタン `Trigger` でsin波が鳴ることを確認してください。または `Audio ready · Tap` の操作でオーディオエンジンが開始します。
- Demoメニューから `Akino-mushi`、`Filter-Acid1`、`Filter-Acid2` を読み込めます。Demoは `Play All` ボタンで再生できます。
- Timbre は１音色の単位です。Session はプロジェクト全体の単位です。それぞれ、ファイルの保存・読込が可能です。

## 主な機能

- 8 Timbres、各2 OSC、PEnv、MOD、2 Filter、AEnv、BURST、FX1
- TimbreごとのL/R Pan、Level、Mute、Near／Far送信
- 共通Near／Farバス、各FX2／FX3、Bus Gain、Output Balance、Master、Limiter
- Manual／Auto／User 1／User 2のGate再生と、最大5分のUser Gate記録
- Timbre保存 `timbre-v7`、Session保存 `session-v8`。対応する旧形式は読込時に正規化
- PC、タブレット、スマートフォン向けの固定viewportと領域別スクロール

## ローカル実行

Windowsでは `.node-version` のNode 22.15.0と `lab.ps1` を使用します。

```powershell
.\lab.ps1 install
.\lab.ps1 dev
```

同じLAN内の端末から確認する場合は `.\lab.ps1 dev:lan` を使います。自動検証は次のコマンドです。

```powershell
.\lab.ps1 check
.\lab.ps1 build:pages
.\lab.ps1 test:pages
```

通常の`build`はルート`/`、`build:pages`はGitHub Pages用の`/KOROGI-Lab/`をbaseとして生成します。`test:pages`は生成HTMLとhashed assetを検査し、Pages相当のサブパスをローカルChromeで起動します。生成物`dist/`はGit管理しません。

## 文書

- [現在状態と検証範囲](docs/プロジェクト状態.md)
- [仕様](docs/仕様.md)
- [設計](docs/設計.md)
- [開発計画](docs/開発計画.md)
- [変更履歴](CHANGELOG.md)

## リポジトリ方針

このリポジトリはKOROGI-Labだけを公開するための同期先です。開発正本から、Lab本体、試験、現行Demoを明示的なallowlistで同期します。公開README、CHANGELOG、公開向け文書、Pages workflowは公開側で管理します。

## このアプリの目的と発展性
元々、このアプリの上位レイヤーアプリの企画として、美しいグラフィックと気持ちいい操作感で虫の音を奏でたい、というのが一番最初の方針で、今も変わっていません。その開発の初期段階として、まずはこの鳴き声研究アプリがちょっとした形になり、案外リアルな虫サウンドが出せるようになったことから、予定はしておりませんでしたが、公開するに至りました。というのも、これはこれで発展性があるのではないか、とも思い始めまして。  

遡ると、作者の長年の音研究の一つのテーマ「気持ちいい音とは何か」を研究するための一つの試みでもあります。気持ちいい音を再現するために、ボトムアップ的にシンセサイザを構築しています。  
世の中にある音楽系シンセをお勉強のために作ってみた、ではありません。「音楽シンセ」ではありませんが「音を楽しむ」シンセではあり、根底は同じ方向性を目指しています。  
このアプリの機能を練り込んでいくうちに、独自性を持った音楽シンセに近づくかもしれません。それは今後の楽しみとしておきます。  

## License

現時点ではLICENSEを設定していません。ソースを閲覧できることは、複製・改変・再配布・商用利用などの許諾を意味しません。
