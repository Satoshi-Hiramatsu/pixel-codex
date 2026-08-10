import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

/**
 * `./Foo` のような拡張子なしの読み込みを `./Foo.ts` へ解決します。
 *
 * アプリ本体はwebpackが束ねるので拡張子を書きません。一方、検証スクリプトは
 * Nodeが直接読み込むため、そのままでは相手が見つかりません。テスト用の依存を
 * 増やさずに橋渡しするための、この一枚だけの仕掛けです。
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    const relative = specifier.startsWith('./') || specifier.startsWith('../');
    if (relative && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) {
        return nextResolve(`${specifier}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});
