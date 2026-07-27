import Phaser from 'phaser';

import type { AgentState } from '../types';
import { RETRO_FONT } from './fonts';

const statusColors: Record<AgentState['status'], number> = {
  idle: 0x94a0a0,
  planning: 0xf0bd55,
  researching: 0x65b7d8,
  coding: 0xe1775b,
  running: 0x78b56c,
  approval: 0xffcc4d,
  done: 0x68c48b,
  error: 0xe65d68,
};

const breakTimeMessages = [
  '暇だな～',
  'コーヒータイム♪',
  'ちょっと休憩中～',
  '次の仕事は何かな？',
  'ひと息ついてるよ',
];

export class AgentSprite extends Phaser.GameObjects.Container {
  readonly agentId: string;
  private character: Phaser.GameObjects.Graphics;
  private badge: Phaser.GameObjects.Graphics;
  private speechBubble: Phaser.GameObjects.Graphics;
  private speechLabel: Phaser.GameObjects.Text;
  private nameBackground: Phaser.GameObjects.Graphics;
  private nameLabel: Phaser.GameObjects.Text;
  private activityBackground: Phaser.GameObjects.Graphics;
  private activityLabel: Phaser.GameObjects.Text;
  private currentStatus: AgentState['status'];
  private currentName: string;
  private currentActivity: string;
  private currentSpeech: string;
  private currentSpeechKind?: AgentState['speechKind'];
  private speechTimer?: Phaser.Time.TimerEvent;
  private breakMessageIndex: number;
  private selected = false;

  constructor(scene: Phaser.Scene, agent: AgentState, x: number, y: number) {
    super(scene, x, y);
    this.agentId = agent.id;
    this.currentStatus = agent.status;
    this.currentName = agent.name;
    this.currentActivity = agent.activity;
    this.currentSpeech = agent.speech || agent.activity;
    this.currentSpeechKind = agent.speechKind;
    this.breakMessageIndex = Phaser.Math.Between(0, breakTimeMessages.length - 1);

    const textResolution = Math.max(2, Math.ceil(window.devicePixelRatio || 1));

    // Seen from straight above, the "shadow" is just a soft pool under the body.
    const shadow = scene.add.ellipse(1, 3, 34, 32, 0x101719, 0.22);
    this.character = scene.add.graphics();
    this.badge = scene.add.graphics();
    this.speechBubble = scene.add.graphics();
    this.nameBackground = scene.add.graphics();
    this.activityBackground = scene.add.graphics();
    this.speechLabel = scene.add
      .text(0, -72, '', {
        fontFamily: RETRO_FONT,
        fontSize: '11px',
        color: '#263136',
        align: 'center',
        lineSpacing: 3,
        wordWrap: { width: 142, useAdvancedWrap: true },
        resolution: textResolution,
      })
      .setOrigin(0.5)
      .setMaxLines(3);
    this.speechLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.nameLabel = scene.add
      .text(0, -32, agent.name, {
        fontFamily: RETRO_FONT,
        fontSize: '11px',
        color: '#f4f0dc',
        resolution: textResolution,
      })
      .setOrigin(0.5);
    this.nameLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.activityLabel = scene.add
      .text(0, 30, agent.activity, {
        fontFamily: RETRO_FONT,
        fontSize: '9px',
        color: '#fff7d8',
        align: 'center',
        lineSpacing: 1,
        wordWrap: { width: 116, useAdvancedWrap: true },
        resolution: textResolution,
      })
      .setOrigin(0.5)
      .setMaxLines(2);
    this.activityLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);

    this.add([
      shadow,
      this.character,
      this.badge,
      this.nameBackground,
      this.nameLabel,
      this.activityBackground,
      this.activityLabel,
      this.speechBubble,
      this.speechLabel,
    ]);
    this.draw(agent);
    this.drawSpeech(agent);
    this.drawNameBackground();
    this.drawActivityBackground();
    this.configureSpeechCycle(agent.status);
    // The body fills exactly one 40px grid tile; the hit area also covers the
    // name plate above and the activity plate below.
    this.setSize(40, 78);
    this.setInteractive(
      new Phaser.Geom.Rectangle(-20, -40, 40, 78),
      Phaser.Geom.Rectangle.Contains,
    );
    this.on('pointerover', () => this.setScale(1.06));
    this.on('pointerout', () => this.setScale(1));
    this.on('pointerdown', () => this.emit('agent-selected', this.agentId));
    // Furniture is drawn at depth 2, so staff always walk on top of it.
    this.setDepth(10);
    scene.add.existing(this);
  }

  updateAgent(agent: AgentState): void {
    if (this.currentName !== agent.name) {
      this.currentName = agent.name;
      this.nameLabel.setText(agent.name);
      this.nameLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
      this.drawNameBackground();
    }
    if (this.currentActivity !== agent.activity) {
      this.currentActivity = agent.activity;
      this.activityLabel.setText(agent.activity);
      this.activityLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
      this.drawActivityBackground();
    }
    const speech = agent.speech || agent.activity;
    const speechChanged = this.currentSpeech !== speech || this.currentSpeechKind !== agent.speechKind;
    if (speechChanged) {
      this.currentSpeech = speech;
      this.currentSpeechKind = agent.speechKind;
      this.drawSpeech(agent);
    }
    if (this.currentStatus !== agent.status) {
      this.currentStatus = agent.status;
      this.draw(agent);
      this.drawSpeech(agent);
      this.configureSpeechCycle(agent.status);
      const scene = this.scene;
      if (!scene?.tweens || !this.active) return;
      scene.tweens.add({
        targets: this,
        scaleX: 1.12,
        scaleY: 1.12,
        duration: 120,
        yoyo: true,
      });
    } else if (speechChanged && agent.status === 'done') {
      this.configureSpeechCycle(agent.status);
    }
  }

  destroy(fromScene?: boolean): void {
    this.clearSpeechTimer();
    super.destroy(fromScene);
  }

  walkTo(x: number, y: number): void {
    const scene = this.scene;
    if (!scene?.tweens || !this.active) return;
    if (Math.abs(this.x - x) < 2 && Math.abs(this.y - y) < 2) return;
    scene.tweens.killTweensOf(this);
    scene.tweens.add({
      targets: this,
      x,
      y,
      duration: 650 + Phaser.Math.Between(0, 250),
      ease: 'Sine.easeInOut',
    });
  }

  setSelected(selected: boolean): void {
    if (this.selected === selected) return;
    this.selected = selected;
    this.drawNameBackground();
    this.setDepth(selected ? 20 : 10);
  }

  /**
   * A bird's-eye character: shoulders fill the tile, the head sits on top of
   * them, and the hair covers everything except the face turned down-screen.
   */
  private draw(agent: AgentState): void {
    this.character.clear();
    this.badge.clear();
    const skin = 0xe6b88c;
    const hair = 0x3a2b24;
    const outline = 0x1e282c;
    const shirt = agent.color;

    // Shoulders / torso, squared off to sit inside one grid tile.
    this.character.fillStyle(outline, 1).fillRect(-17, -14, 34, 30);
    this.character.fillStyle(shirt, 1).fillRect(-15, -12, 30, 26);
    this.character.fillStyle(0x000000, 0.16).fillRect(-15, 8, 30, 6);
    // Arms peeking out at each side.
    this.character.fillStyle(skin, 1).fillRect(-19, 2, 5, 9).fillRect(14, 2, 5, 9);

    // Head from above: hair cap with the face visible at the lower edge.
    this.character.fillStyle(outline, 1).fillCircle(0, -4, 13);
    this.character.fillStyle(hair, 1).fillCircle(0, -4, 11);
    this.character.fillStyle(skin, 1).fillRect(-8, 1, 16, 7);
    this.character.fillStyle(hair, 1).fillRect(-11, 1, 3, 7).fillRect(8, 1, 3, 7);
    this.character.fillStyle(outline, 1).fillRect(-5, 4, 2, 2).fillRect(3, 4, 2, 2);
    this.character.fillStyle(0xffffff, 0.22).fillRect(-7, -11, 9, 3);

    this.badge.fillStyle(outline, 1).fillRect(11, -22, 14, 14);
    this.badge.fillStyle(statusColors[agent.status], 1).fillRect(13, -20, 10, 10);
    if (agent.status === 'approval') {
      this.badge.fillStyle(0x1e282c, 1).fillRect(17, -19, 2, 5).fillRect(17, -13, 2, 2);
    }
  }

  private drawSpeech(agent: AgentState): void {
    const speech = (agent.speech || agent.activity).replace(/\s+/g, ' ').trim();
    this.drawSpeechText(speech, agent.speechKind);
  }

  private drawSpeechText(speech: string, speechKind?: AgentState['speechKind']): void {
    this.speechLabel.setText(speech);
    this.speechLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    const bubbleWidth = 160;
    const bubbleHeight = Math.max(34, Math.min(66, this.speechLabel.height + 14));
    const bubbleBottom = -45;
    const bubbleTop = bubbleBottom - bubbleHeight;
    const borderColor = speechKind === 'question'
      ? 0xc78d2d
      : speechKind === 'message'
        ? 0x4c889e
        : 0x596a70;

    this.speechBubble.clear();
    // Square corners keep the bubble in the same pixel-art language as the floor.
    this.speechBubble
      .fillStyle(0xfff8e8, 0.97)
      .fillRect(-bubbleWidth / 2, bubbleTop, bubbleWidth, bubbleHeight);
    this.speechBubble
      .lineStyle(2, borderColor, 1)
      .strokeRect(-bubbleWidth / 2, bubbleTop, bubbleWidth, bubbleHeight);
    this.speechBubble
      .fillStyle(0xfff8e8, 1)
      .fillTriangle(-7, bubbleBottom - 1, 7, bubbleBottom - 1, 0, bubbleBottom + 9);
    this.speechBubble
      .lineStyle(2, borderColor, 1)
      .lineBetween(-7, bubbleBottom, 0, bubbleBottom + 9)
      .lineBetween(0, bubbleBottom + 9, 7, bubbleBottom);
    this.speechLabel.setY(bubbleTop + bubbleHeight / 2);
    this.speechBubble.setVisible(true);
    this.speechLabel.setVisible(true);
  }

  private drawNameBackground(): void {
    const width = Math.ceil(this.nameLabel.width) + 10;
    const height = Math.ceil(this.nameLabel.height) + 6;
    this.nameBackground.clear();
    this.nameBackground
      .fillStyle(this.selected ? 0xb7793d : 0x263136, 1)
      .fillRect(-Math.ceil(width / 2), -32 - Math.ceil(height / 2), width, height);
  }

  private drawActivityBackground(): void {
    const width = Math.min(126, Math.max(54, Math.ceil(this.activityLabel.width) + 12));
    const height = Math.max(18, Math.ceil(this.activityLabel.height) + 6);
    const top = 30 - Math.ceil(height / 2);
    this.activityBackground.clear();
    this.activityBackground
      .fillStyle(0x17272c, 0.94)
      .fillRect(-Math.ceil(width / 2), top, width, height);
    this.activityBackground
      .lineStyle(1, 0xe9cf83, 0.9)
      .strokeRect(-Math.ceil(width / 2), top, width, height);
  }

  private configureSpeechCycle(status: AgentState['status']): void {
    this.clearSpeechTimer();
    this.speechBubble.setVisible(true);
    this.speechLabel.setVisible(true);
    if (status !== 'done') return;
    this.speechTimer = this.scene.time.delayedCall(5000, () => {
      this.hideSpeech();
      this.scheduleBreakMessage(Phaser.Math.Between(2200, 3800));
    });
  }

  private scheduleBreakMessage(delay: number): void {
    this.clearSpeechTimer();
    this.speechTimer = this.scene.time.delayedCall(delay, () => {
      const message = breakTimeMessages[this.breakMessageIndex % breakTimeMessages.length];
      this.breakMessageIndex += 1;
      this.drawSpeechText(message, 'activity');
      this.speechTimer = this.scene.time.delayedCall(4000, () => {
        this.hideSpeech();
        this.scheduleBreakMessage(Phaser.Math.Between(3500, 6500));
      });
    });
  }

  private hideSpeech(): void {
    this.speechBubble.setVisible(false);
    this.speechLabel.setVisible(false);
  }

  private clearSpeechTimer(): void {
    this.speechTimer?.remove(false);
    this.speechTimer = undefined;
  }
}
