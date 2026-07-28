import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { WebpackPlugin } from '@electron-forge/plugin-webpack';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

import { mainConfig } from './webpack.main.config';
import { rendererConfig } from './webpack.renderer.config';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'PixelCodex',
    win32metadata: {
      CompanyName: 'Pixel Codex',
      FileDescription: 'Pixel Codex agent office',
      ProductName: 'Pixel Codex',
      InternalName: 'PixelCodex',
      OriginalFilename: 'PixelCodex.exe',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: 'pixel_codex',
      setupExe: 'PixelCodexSetup.exe',
    }),
    new MakerZIP({}, ['win32']),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      // The dev server sends a strict CSP by default; DotGothic16 is served by
      // Google Fonts, so the stylesheet and font hosts have to be allowed.
      devContentSecurityPolicy:
        "default-src 'self' 'unsafe-inline' data:; " +
        "script-src 'self' 'unsafe-eval' 'unsafe-inline' data:; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' data: https://fonts.gstatic.com; " +
        "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
      devServer: {
        client: {
          overlay: {
            errors: true,
            warnings: true,
            // Chromium reports failed cross-origin resources without a source,
            // line, or underlying exception as this opaque message. Showing it
            // as an app crash is misleading; real runtime errors still surface.
            runtimeErrors: (error: Error) => error.message !== 'Script error.',
          },
        },
      },
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
