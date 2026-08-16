# 担当別キャラクター制作参照

このディレクトリのPNGは、組み込みImageGenで作成した4方向×4コマの制作参照です。
ゲームが直接読む完成品は `assets/sprites/*-sheet.png` で、次のコマ順に統一しています。

- 行: 正面、左、右、背面
- 列: 直立、大股A、足をそろえる、大股B
- 背景: 生成時の市松模様を `tools/build_character_sheets.py` が外周から透過
- 完成品: 1コマ64×64、4列×4行、256×256

## 共通プロンプト

```text
Use case: stylized-concept
Asset type: production game character walk-cycle reference sheet
Input images: manager-walk-cycle-reference-v1.png is a strict style, scale,
pose-layout, pixel-density, and rendering-quality reference only; create a different person.
Style/medium: polished SNES / EarthBound-inspired pixel art matching the reference
in outline weight, proportions, shading density, and limited palette; crisp hard pixel edges.
Composition/framing: exactly 4 columns by 4 rows. Rows are front/down, facing left,
facing right, back/up. Columns are idle, stride A, passing pose, stride B.
Keep head and foot baselines identical; animate limbs only, never bob the whole body.
Scene/backdrop: transparent, no grid, labels, shadows, floor, text, or watermark.
Constraints: same character and outfit in all 16 cells; correct left/right views;
readable walking feet and opposite arm swing; unique silhouette.
```

## 担当別指定

| ファイル | デザイン指定 |
| --- | --- |
| `planner-walk-cycle-reference.png` | 横分けの栗色髪、琥珀色ネクタイ、企画カード |
| `researcher-walk-cycle-reference.png` | 青黒い髪、ティールの帽子、肩掛け鞄、シアンスキャナ |
| `coder-walk-cycle-reference.png` | 赤茶のスパイク髪、コーラルのフード、工具ベルト、コード端末 |
| `tester-walk-cycle-reference.png` | 深緑のボブ、角眼鏡、チェック徽章、テストメーター |
| `reviewer-walk-cycle-reference.png` | 銀紫の髪、細縁眼鏡、紫ベスト、赤ペン、チェック票 |
| `designer-walk-cycle-reference.png` | ローズのまとめ髪、ベレー帽、スカーフ、パレット、スタイラス |
| `accountant-walk-cycle-reference.png` | 黒い七三分け、丸眼鏡、紫ベスト、帳簿、金色計算機 |
| `communicator-walk-cycle-reference.png` | 海緑の髪、通信帽、アンテナ付きヘッドセット、受信端末 |
| `writer-walk-cycle-reference.png` | 茶色の結び髪、橙リボン、原稿帳、万年筆、書類鞄 |
| `general-walk-cycle-reference.png` | 灰色の短髪、ニット帽、作業エプロン、社員証、工具袋 |

同じ人物を作り直す場合は共通プロンプトと該当行の指定を併用し、統括責任者の参照画像を
スタイル参照として渡します。生成後は必ず一括変換と基準線検査を実行してください。
