import Phaser from 'phaser';
import React, { useEffect, useRef } from 'react';

import { waitForRetroFont } from './fonts';
import { OfficeScene } from './OfficeScene';

const OFFICE_WIDTH = 1000;
const OFFICE_HEIGHT = 600;
const RENDER_SCALE = 2;

export function PhaserCanvas(): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let game: Phaser.Game | undefined;
    let cancelled = false;

    // Phaser bakes text into textures on creation, so the retro font has to be
    // ready before the office is built or every label would fall back.
    void waitForRetroFont().then(() => {
      if (cancelled || !host.current) return;
      game = new Phaser.Game({
        type: Phaser.AUTO,
        parent: host.current,
        backgroundColor: '#1d2b33',
        pixelArt: true,
        antialias: false,
        scale: {
          mode: Phaser.Scale.FIT,
          autoCenter: Phaser.Scale.CENTER_BOTH,
          width: OFFICE_WIDTH * RENDER_SCALE,
          height: OFFICE_HEIGHT * RENDER_SCALE,
        },
        scene: [OfficeScene],
        render: { roundPixels: true },
      });
    });

    return () => {
      cancelled = true;
      game?.destroy(true);
    };
  }, []);

  return <div className="office-canvas" ref={host} aria-label="エージェントオフィス" />;
}
