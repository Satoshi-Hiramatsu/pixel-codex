import type { PixelCodexApi } from './types';

declare global {
  interface Window {
    pixelCodex: PixelCodexApi;
  }
}

export {};
