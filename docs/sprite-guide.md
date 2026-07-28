# キャラクタースプライトの作り方（4方向 + 歩行アニメ）

「キャラに正面・背面・左・右を表示させたい」への回答と、そのまま使える雛形の説明です。

---

## 1. どの方法を選ぶべきか

| 方法 | 内容 | 向いている場面 | 手間 |
| --- | --- | --- | --- |
| **A. コードで図形を描く**（改修前のやり方） | `Phaser.GameObjects.Graphics` で毎回四角を描く | 1方向だけの静止画 | 小 |
| **B. 実行時にスプライトシートを生成**（← いま採用） | Canvas に 4方向×3コマを描いて `textures.addCanvas` で登録 | 画像素材が無い／社員ごとに服の色を変えたい | 中 |
| **C. PNG スプライトシート** | 1枚の PNG を格子状に切って使う | 本格的なドット絵を入れる時の**最終形** | 中 |
| **D. テクスチャアトラス（PNG + JSON）** | TexturePacker や Aseprite の書き出しを使う | コマ数が増えて格子に収まらなくなった時 | 大 |

**おすすめの進め方は B → C です。**
いまは B（`src/game/characterSheet.ts`）が動いているので絵が無くても 4方向が出ます。
絵ができたら C に差し替えるだけで、アニメ名もコードもほぼそのまま使えます。

---

## 2. 採用しているフレーム規格

`src/game/characterSheet.ts` の定数がそのまま規格です。

- **1コマ**: 幅 `32px` × 高さ `40px`
- **並び**: 横 3列（コマ）× 縦 4行（向き）＝ 1枚 `96px × 160px`

```
        コマ0(直立)  コマ1(右足前)  コマ2(左足前)
行0 down  [  正面  ] [   正面   ] [   正面   ]
行1 left  [   左   ] [    左    ] [    左    ]
行2 right [   右   ] [    右    ] [    右    ]
行3 up    [  背面  ] [   背面   ] [   背面   ]
```

これは「ぴぽや」形式や LPC（Liberated Pixel Cup）の並びとほぼ同じなので、
配布素材を持ってきても行の入れ替えだけで合わせられます。

歩行アニメは `[1, 0, 2, 0]` の順に 7fps で再生します。
2コマしか描かなくても、あいだに直立コマが入ることで自然に歩いて見えます。

---

## 3. PNG に差し替える手順（B → C）

1. 上の規格どおりに `96 × 160` の PNG を用意し、`src/assets/agent.png` に置く。
   - Aseprite なら「32×40 のセル、3列4行」でグリッドを作るのが楽です。
   - 背景は必ず透過（アルファ）にしてください。
2. Webpack で画像を読めるようにする（`webpack.rules.ts` に `asset/resource` を追加）。
3. シーンの `preload()` で読み込む。

```ts
import { registerLoadedSheetAnimations } from './characterSheet';
import agentSheetUrl from '../assets/agent.png';

preload(): void {
  this.load.spritesheet('agent-art', agentSheetUrl, {
    frameWidth: 32,
    frameHeight: 40,
  });
}

create(): void {
  registerLoadedSheetAnimations(this, 'agent-art');
}
```

4. `AgentSprite` の `ensureCharacterSheet(scene, color)` を `'agent-art'` に置き換え、
   アニメ名を `agent-art-walk-down` のように使う。
   （`registerLoadedSheetAnimations` が同じ命名でアニメを作ります）

### 社員ごとに服の色を変えたい場合

PNG は 1枚だけ用意して、服の部分を**白（`#ffffff`）**で描いておき、
スプライト側で `sprite.setTint(agent.color)` を掛けるのが一番簡単です。
肌や髪まで色が変わってしまうのが困る場合は、

- 服だけの PNG と 体だけの PNG を重ねる（`Container` に 2枚入れる）
- もしくは色ちがいを人数分だけ書き出す

のどちらかになります。いまの生成版は前者と同じ考え方で、
服の色だけをコードから差し込んでいます。

---

## 4. 向きの決め方（実装済み）

歩く方向から自動で決めています。`AgentSprite.walkPath()` が
1マス進むごとに次のマスとの差分を見て、

```ts
if (次のマス.col > いまのマス.col) facing = 'right';
else if (次のマス.col < いまのマス.col) facing = 'left';
else if (次のマス.row > いまのマス.row) facing = 'down';
else facing = 'up';
```

としています。移動が終わったら `idle` アニメ（コマ0）に戻り、
**最後に向いていた方向のまま立ち止まります**。

席に着いたときだけ特定の向きにしたい場合は、
`officeLayout.ts` の椅子データに `facing` があるので、
到着後にそれを使って `setFacing()` を呼べば「机に向かって座る」表現になります。

---

## 5. さらに凝りたくなったら

- **待機モーション**: `idle` を 2コマにして 1.5fps くらいで再生すると、呼吸しているように見えます。
- **作業モーション**: `type`（キーボードを打つ）、`read`（本を読む）などの行を増やし、
  `AgentStatus` に応じて再生アニメを切り替える。行を足すだけで規格は壊れません。
- **影**: いまはスプライトとは別に楕円を描いています。PNG に影を焼き込まないでください
  （重なった時に不自然になります）。
- **ドット絵の等倍表示**: Phaser 側で `pixelArt: true` と `roundPixels: true` を設定済みなので、
  拡大してもぼやけません。`FRAME_WIDTH` を変えるときは `AgentSprite` の当たり判定も合わせて調整してください。
