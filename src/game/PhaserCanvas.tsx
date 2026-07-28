import Phaser from 'phaser';
import React, { useEffect, useRef, useState } from 'react';

import { waitForRetroFont } from './fonts';
import { OfficeScene } from './OfficeScene';

const OFFICE_WIDTH = 1000;
const OFFICE_HEIGHT = 600;

/**
 * How many device pixels one world unit gets.
 *
 * The office is a fixed 1000x600 world, but the panel it lives in is whatever
 * size the window happens to be. Rendering into a fixed oversized framebuffer
 * and letting CSS shrink it means every pixel — including the text textures —
 * is resampled on the way to the screen, which smears a dot-matrix font.
 * Sizing the framebuffer to the panel's real device pixels instead keeps the
 * whole office at 1:1, so nothing is resampled at all.
 */
function computeRenderScale(host: HTMLElement): number {
  const rect = host.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return 1;
  const ratio = window.devicePixelRatio || 1;
  const fit = Math.min(rect.width / OFFICE_WIDTH, rect.height / OFFICE_HEIGHT);
  // Clamped so a tiny window still renders legibly and a huge one stays cheap.
  return Math.max(0.6, Math.min(3, fit * ratio));
}

export function PhaserCanvas(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let game: Phaser.Game | undefined;
    let observer: ResizeObserver | undefined;
    let cancelled = false;

    // Phaser bakes text into textures on creation, so the retro font has to be
    // ready before the office is built or every label would fall back. The wait
    // is deliberately short — a slow font host must not hold up the whole app.
    void waitForRetroFont().then(() => {
      if (cancelled || !host.current) return;
      const element = host.current;
      const renderScale = computeRenderScale(element);
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: element,
        backgroundColor: '#1d2b33',
        pixelArt: true,
        antialias: false,
        scale: {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.CENTER_BOTH,
          width: Math.round(OFFICE_WIDTH * renderScale),
          height: Math.round(OFFICE_HEIGHT * renderScale),
        },
        scene: [OfficeScene],
        render: { roundPixels: true },
        callbacks: {
          postBoot: () => {
            if (!cancelled) setReady(true);
          },
        },
      });

      // Keep the framebuffer matched to the panel as the window is resized, so
      // the office never drifts back into being up- or down-sampled.
      let lastScale = renderScale;
      observer = new ResizeObserver(() => {
        if (cancelled || !game) return;
        const next = computeRenderScale(element);
        if (Math.abs(next - lastScale) < 0.02) return;
        lastScale = next;
        game.scale.resize(
          Math.round(OFFICE_WIDTH * next),
          Math.round(OFFICE_HEIGHT * next),
        );
      });
      observer.observe(element);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      game?.destroy(true);
    };
  }, []);

  return (
    <div className="office-canvas" ref={host} aria-label="エージェントオフィス">
      {!ready && (
        <div className="office-loading" role="status">
          <span className="office-loading-spinner" aria-hidden="true"><i /><i /><i /><i /></span>
          <strong>オフィスを準備中…</strong>
          <small>フロアの家具と社員を配置しています</small>
        </div>
      )}
    </div>
  );
}
