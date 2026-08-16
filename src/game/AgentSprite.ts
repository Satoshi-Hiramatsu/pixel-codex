import Phaser from 'phaser';

import type { AgentDuty, AgentPresence, AgentState } from '../types';
import {
  animationKey,
  ATLAS_KEY,
  ensureCharacterSheet,
  frameName,
  type Facing,
} from './characterSheet';
import { RETRO_FONT, textResolutionFor } from './fonts';
import { center, doorTile, type Tile } from './officeLayout';

const statusColors: Record<AgentState['status'], number> = {
  idle: 0x94a0a0,
  planning: 0xf0bd55,
  researching: 0x65b7d8,
  coding: 0xe1775b,
  running: 0x78b56c,
  accounting: 0xb58bd4,
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

/** 玄関まで歩ききってから、姿が消えるまでの時間。 */
const LEAVE_FADE_DURATION = 460;

/** 1マス（40px）につき片足1回を踏み出す歩行速度。 */
const STEP_DURATION = 260;

/**
 * 64×64 のコマを、足元がタイルの中心（＝影の位置）に来るように置くための縦ずれ。
 * コマの中では足元が下端から 4px 上なので、スプライトの中心からは 28px 下になります。
 */
const CHARACTER_Y = 16 - 28;
/**
 * キャラが 32×40 から 64×64 になったぶん、頭の上に載っているもの
 * （名前・ステータス・吹き出し）をまとめて持ち上げる量。
 */
const HEAD_LIFT = 20;
const HIT_WIDTH = 48;
const HIT_HEIGHT = 90;

/** 当たり判定。頭のてっぺんから、足元より下の作業ラベルまでを含みます。 */
function hitArea(): Phaser.Geom.Rectangle {
  return new Phaser.Geom.Rectangle(-HIT_WIDTH / 2, -46, HIT_WIDTH, HIT_HEIGHT);
}

export class AgentSprite extends Phaser.GameObjects.Container {
  readonly agentId: string;
  private character: Phaser.GameObjects.Sprite;
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
  private currentColor: number;
  private currentDuty: AgentDuty;
  private currentPresence: AgentPresence;
  private speechTimer?: Phaser.Time.TimerEvent;
  private breakMessageIndex: number;
  private selected = false;
  /** 共有アトラスのどの枠（＝服の色）を使っているか。 */
  private slot: number;
  private facing: Facing = 'down';
  private walkTween?: Phaser.Tweens.TweenChain;
  /** 退勤中。玄関に着いたらフロアから姿を消します。 */
  private leaving = false;
  private fadeTween?: Phaser.Tweens.Tween;
  private leaveCheck?: Phaser.Time.TimerEvent;
  /** 補間を使わず、2px刻みで待機・作業姿勢を切り替えるタイマー。 */
  private motionTimer?: Phaser.Time.TimerEvent;
  private motionPhase = false;
  /** 現在地と目的地はタイル単位で持ち、経路探索と共有します。 */
  private tile: Tile;
  private destination: Tile;

  constructor(scene: Phaser.Scene, agent: AgentState, tile: Tile) {
    super(scene, center(tile.col), center(tile.row));
    this.agentId = agent.id;
    this.currentStatus = agent.status;
    this.currentName = agent.name;
    this.currentActivity = agent.activity;
    this.currentSpeech = agent.speech || agent.activity;
    this.currentSpeechKind = agent.speechKind;
    this.currentColor = agent.color;
    this.currentDuty = agent.duty;
    // 出社した状態から始めます。休憩中や退勤済みの人は、直後に呼ばれる
    // `updateAgent` が移動と退出をそのまま演じてくれます。
    this.currentPresence = 'working';
    this.tile = { ...tile };
    this.destination = { ...tile };
    this.breakMessageIndex = Phaser.Math.Between(0, breakTimeMessages.length - 1);

    const textResolution = textResolutionFor(scene);

    // 靴へ2px重なるハードエッジの接地影。大きな楕円影より浮いて見えません。
    const shadow = scene.add.graphics();
    shadow.fillStyle(0x101719, 0.3).fillRect(-12, 13, 24, 4);
    shadow.fillStyle(0x101719, 0.2).fillRect(-8, 17, 16, 2);
    this.slot = ensureCharacterSheet(scene, agent.color, agent.duty);
    this.character = scene.add
      .sprite(0, CHARACTER_Y, ATLAS_KEY, frameName(this.slot, 'down', 0))
      .setOrigin(0.5, 0.5);
    this.character.play(animationKey(this.slot, 'down', false));
    this.badge = scene.add.graphics();
    this.speechBubble = scene.add.graphics();
    this.nameBackground = scene.add.graphics();
    this.activityBackground = scene.add.graphics();
    this.speechLabel = scene.add
      .text(0, -72 - HEAD_LIFT, '', {
        fontFamily: RETRO_FONT,
        fontSize: '11px',
        color: '#263136',
        align: 'center',
        lineSpacing: 3,
        wordWrap: { width: 168, useAdvancedWrap: true },
        resolution: textResolution,
      })
      .setOrigin(0.5)
      .setMaxLines(3);
    this.speechLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    this.nameLabel = scene.add
      .text(0, -32 - HEAD_LIFT, agent.name, {
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
    this.drawBadge(agent.status);
    this.drawSpeech(agent);
    this.drawNameBackground();
    this.drawActivityBackground();
    this.configureSpeechCycle(agent.status, this.currentPresence);
    this.configureCharacterMotion();
    this.setSize(HIT_WIDTH, HIT_HEIGHT);
    this.setInteractive(hitArea(), Phaser.Geom.Rectangle.Contains);
    this.on('pointerover', () => this.setScale(1.06));
    this.on('pointerout', () => this.setScale(1));
    this.on('pointerdown', () => this.emit('agent-selected', this.agentId));
    // 家具は depth 2 に描いているので、社員は必ずその上を歩きます。
    this.setDepth(10);
    scene.add.existing(this);
  }

  /** 経路探索が「いま誰がどこにいるか」を知るために使います。 */
  get currentTile(): Tile {
    return this.tile;
  }

  get targetTile(): Tile {
    return this.destination;
  }

  get walking(): boolean {
    return Boolean(this.walkTween?.isPlaying());
  }

  /** 退勤済み。経路探索は、もうフロアにいない人を避ける必要がありません。 */
  get departed(): boolean {
    return this.leaving;
  }

  updateAgent(agent: AgentState): void {
    this.applyPresence(agent.presence ?? 'working');
    if (this.currentColor !== agent.color || this.currentDuty !== agent.duty) {
      this.currentColor = agent.color;
      this.currentDuty = agent.duty;
      this.slot = ensureCharacterSheet(this.scene, agent.color, agent.duty);
      this.character.setTexture(ATLAS_KEY, frameName(this.slot, this.facing, 0));
      this.character.play(animationKey(this.slot, this.facing, this.walking));
    }
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
      this.drawBadge(agent.status);
      this.drawSpeech(agent);
      this.configureSpeechCycle(agent.status, this.currentPresence);
      this.configureCharacterMotion();
      const scene = this.scene;
      if (!scene?.tweens || !this.active) return;
      scene.tweens.add({
        targets: this,
        scaleX: 1.12,
        scaleY: 1.12,
        duration: 120,
        yoyo: true,
      });
    } else if (speechChanged && this.currentPresence === 'lounge') {
      this.configureSpeechCycle(agent.status, this.currentPresence);
    }
  }

  /**
   * 出社・休憩・退勤の切り替え。退勤した人は玄関まで歩いてから姿を消し、
   * 呼び戻されたときは玄関から歩いて入り直します。
   */
  private applyPresence(presence: AgentPresence): void {
    if (presence === this.currentPresence) return;
    const previous = this.currentPresence;
    this.currentPresence = presence;

    if (presence === 'left') {
      this.leaving = true;
      this.clearSpeechTimer();
      this.clearCharacterMotion();
      this.disableInteractive();
      // 玄関にもう立っていて歩く必要がないときは、そのまま消えます。歩き出す
      // なら `walkPath` の完了時に消えるので、この確認は空振りになります。
      this.leaveCheck?.remove(false);
      this.leaveCheck = this.scene?.time.delayedCall(150, () => {
        this.leaveCheck = undefined;
        if (this.leaving && !this.walking) this.fadeOut();
      });
      return;
    }

    this.leaving = false;
    this.leaveCheck?.remove(false);
    this.leaveCheck = undefined;
    if (previous === 'left') this.returnToFloor();
    this.configureSpeechCycle(this.currentStatus, presence);
    if (!this.walking) this.configureCharacterMotion();
  }

  /** 退勤していた人が呼び戻されたとき。玄関の内側から歩き直します。 */
  private returnToFloor(): void {
    this.fadeTween?.remove();
    this.fadeTween = undefined;
    this.setAlpha(1);
    this.setVisible(true);
    this.setInteractive(hitArea(), Phaser.Geom.Rectangle.Contains);
    this.snapTo(doorTile);
  }

  private fadeOut(): void {
    const scene = this.scene;
    if (!scene?.tweens || !this.active) {
      this.setVisible(false);
      return;
    }
    this.fadeTween?.remove();
    this.fadeTween = scene.tweens.add({
      targets: this,
      alpha: 0,
      duration: LEAVE_FADE_DURATION,
      onComplete: () => {
        this.fadeTween = undefined;
        this.setVisible(false);
      },
    });
  }

  destroy(fromScene?: boolean): void {
    this.clearSpeechTimer();
    this.leaveCheck?.remove(false);
    this.leaveCheck = undefined;
    this.fadeTween?.remove();
    this.fadeTween = undefined;
    this.clearCharacterMotion();
    this.walkTween?.stop();
    this.walkTween = undefined;
    super.destroy(fromScene);
  }

  /**
   * タイルの列を 1マスずつ、上下左右だけで歩きます。斜め移動はしません。
   * 途中の家族や同僚は経路探索の段階で避けているので、ここでは素直に辿るだけです。
   */
  walkPath(path: Tile[], finalFacing?: Facing): void {
    const scene = this.scene;
    if (!scene?.tweens || !this.active) return;
    if (path.length === 0) return;
    this.destination = { ...path[path.length - 1] };
    this.walkTween?.stop();

    // 1タイルぶんずつの tween をつないで、角では必ず 90度で曲がるようにします。
    const timeline = path.map((step) => ({
      x: center(step.col),
      y: center(step.row),
      duration: STEP_DURATION,
      ease: 'Linear',
      onStart: () => {
        this.setFacing(this.facingTowards(step));
        this.playWalk(true);
      },
      onComplete: () => {
        this.tile = { ...step };
      },
    }));

    this.walkTween = scene.tweens.chain({
      targets: this,
      tweens: timeline,
      onComplete: () => {
        this.walkTween = undefined;
        if (finalFacing) this.facing = finalFacing;
        this.playWalk(false);
        // 玄関に着いた退勤者は、ここでフロアから姿を消します。
        if (this.leaving) this.fadeOut();
      },
    });
  }

  /** 移動せずに向きだけ変えたいとき（席に着いた直後など）に使います。 */
  setFacing(facing: Facing): void {
    if (this.facing === facing) return;
    this.facing = facing;
    this.playWalk(this.walking);
  }

  /** 経路が見つからなかった時などに、瞬間移動でタイルを合わせます。 */
  snapTo(tile: Tile, finalFacing?: Facing): void {
    this.walkTween?.stop();
    this.walkTween = undefined;
    this.tile = { ...tile };
    this.destination = { ...tile };
    if (finalFacing) this.facing = finalFacing;
    this.setPosition(center(tile.col), center(tile.row));
    this.playWalk(false);
    if (this.leaving) this.fadeOut();
  }

  setSelected(selected: boolean): void {
    if (this.selected === selected) return;
    this.selected = selected;
    this.drawNameBackground();
    this.setDepth(selected ? 20 : 10);
  }

  private facingTowards(next: Tile): Facing {
    if (next.col > this.tile.col) return 'right';
    if (next.col < this.tile.col) return 'left';
    if (next.row > this.tile.row) return 'down';
    if (next.row < this.tile.row) return 'up';
    return this.facing;
  }

  private playWalk(moving: boolean): void {
    const key = animationKey(this.slot, this.facing, moving);
    if (this.character.anims.currentAnim?.key !== key && this.scene?.anims.exists(key)) {
      this.character.play(key);
    }
    if (moving) this.clearCharacterMotion();
    else this.configureCharacterMotion();
  }

  private clearCharacterMotion(): void {
    this.motionTimer?.remove(false);
    this.motionTimer = undefined;
    this.motionPhase = false;
    this.character?.setPosition(0, CHARACTER_Y);
  }

  /**
   * 連続Tweenでは中間座標が半端になるため、タイマーで2pxずつ姿勢を切り替えます。
   * 待機はゆっくり上下、作業中は手元を動かしているように小さく左右へ揺れます。
   */
  private configureCharacterMotion(): void {
    this.clearCharacterMotion();
    if (this.walking || this.leaving || !this.scene?.time) return;
    const resting = this.currentStatus === 'idle' || this.currentStatus === 'done';
    const delay = this.currentStatus === 'error' ? 180 : resting ? 900 : 420;
    this.motionTimer = this.scene.time.addEvent({
      delay,
      loop: true,
      callback: () => {
        if (!this.active || this.walking || this.leaving) return;
        this.motionPhase = !this.motionPhase;
        if (resting || this.currentStatus === 'planning' || this.currentStatus === 'approval') {
          this.character.setPosition(0, CHARACTER_Y - (this.motionPhase ? 2 : 0));
          return;
        }
        if (this.currentStatus === 'error') {
          this.character.setPosition(this.motionPhase ? -2 : 2, CHARACTER_Y);
          return;
        }
        this.character.setPosition(this.motionPhase ? 2 : 0, CHARACTER_Y);
      },
    });
  }

  private drawBadge(status: AgentState['status']): void {
    this.badge.clear();
    // キャラが横に広がったぶん、頭の右わきに逃がしています。
    this.badge.fillStyle(0x1e282c, 1).fillRect(20, -26 - HEAD_LIFT, 14, 14);
    this.badge.fillStyle(statusColors[status], 1).fillRect(22, -24 - HEAD_LIFT, 10, 10);
    if (status === 'approval') {
      this.badge
        .fillStyle(0x1e282c, 1)
        .fillRect(26, -23 - HEAD_LIFT, 2, 5)
        .fillRect(26, -17 - HEAD_LIFT, 2, 2);
    }
  }

  private drawSpeech(agent: AgentState): void {
    const speech = (agent.speech || agent.activity).replace(/\s+/g, ' ').trim();
    this.drawSpeechText(speech, agent.speechKind);
  }

  private drawSpeechText(speech: string, speechKind?: AgentState['speechKind']): void {
    this.speechLabel.setText(speech);
    this.speechLabel.texture.setFilter(Phaser.Textures.FilterMode.LINEAR);
    const bubbleWidth = 186;
    const bubbleHeight = Math.max(34, Math.min(74, this.speechLabel.height + 14));
    const bubbleBottom = -45 - HEAD_LIFT;
    const bubbleTop = bubbleBottom - bubbleHeight;
    const borderColor = speechKind === 'question'
      ? 0xc78d2d
      : speechKind === 'message'
        ? 0x4c889e
        : 0x596a70;

    this.speechBubble.clear();
    // 角を丸めないことで、床と同じドット絵の見た目にそろえています。
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
      .fillRect(-Math.ceil(width / 2), -32 - HEAD_LIFT - Math.ceil(height / 2), width, height);
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

  private configureSpeechCycle(status: AgentState['status'], presence: AgentPresence): void {
    this.clearSpeechTimer();
    if (presence === 'left') return;
    this.speechBubble.setVisible(true);
    this.speechLabel.setVisible(true);
    // 休憩スペースに移った人だけが、ときどき雑談をこぼします。
    if (presence !== 'lounge' && status !== 'done') return;
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
