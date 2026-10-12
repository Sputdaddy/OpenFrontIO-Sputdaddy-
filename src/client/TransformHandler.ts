import { Cell } from "@openfront/engine-api/game/GameTypes";
import { EventBus, GameEvent } from "@openfront/shared/EventBus";
import {
  CameraTiltEvent,
  CenterCameraEvent,
  DragEvent,
  ZOOM_DELTA_DIVISOR,
  ZoomEvent,
} from "./InputHandler";
import {
  type CameraTilt,
  cameraTilt,
  clampTilt,
  DEFAULT_TILT_DEGREES,
  drawnGroundY,
  maxRaise,
  seaLevelY,
  type SurfaceElevation,
  surfaceUnderGroundPoint,
} from "./render/three/Elevation";
import { UserSettings } from "./UserSettings";
import { GameView, PlayerView, UnitView } from "./view";

export class GoToPlayerEvent implements GameEvent {
  constructor(
    public player: PlayerView,
    public zoom?: number,
  ) {}
}

export class GoToPositionEvent implements GameEvent {
  constructor(
    public x: number,
    public y: number,
  ) {}
}

export class GoToUnitEvent implements GameEvent {
  constructor(public unit: UnitView) {}
}

export const GOTO_INTERVAL_MS = 16;
export const CAMERA_MAX_SPEED = 15;
export const CAMERA_SMOOTHING = 0.03;
// Wait this long after the camera stops tilting before saving the angle.
const SAVE_TILT_DELAY_MS = 500;

export class TransformHandler {
  public scale: number = 1.8;
  private _boundingRect: DOMRect;
  public offsetX: number = -350;
  public offsetY: number = -200;
  private lastGoToCallTime: number | null = null;

  private target: Cell | null;
  private targetScale: number | null = null;
  private intervalID: NodeJS.Timeout | null = null;
  private changed = false;
  // The 3D map's raised, tilted surface; null on the flat map.
  private elevation: SurfaceElevation | null = null;
  // The 3D camera's tilt away from straight down, in degrees.
  private tiltDegrees = 0;
  private saveTiltTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly userSettings = new UserSettings();

  constructor(
    private game: GameView,
    private eventBus: EventBus,
    private canvas: HTMLElement,
  ) {
    this._boundingRect = this.canvas.getBoundingClientRect();
    this.eventBus.on(ZoomEvent, (e) => this.onZoom(e));
    this.eventBus.on(DragEvent, (e) => this.onMove(e));
    this.eventBus.on(CameraTiltEvent, (e) => this.onTilt(e));
    this.eventBus.on(GoToPlayerEvent, (e) => this.onGoToPlayer(e));
    this.eventBus.on(GoToPositionEvent, (e) => this.onGoToPosition(e));
    this.eventBus.on(GoToUnitEvent, (e) => this.onGoToUnit(e));
    this.eventBus.on(CenterCameraEvent, () => this.centerCamera());
  }

  /**
   * Make screen↔tile conversions follow the 3D map's tilted camera, which
   * foreshortens the map down the screen and draws raised ground further up
   * it than sea level. The camera starts at the player's last tilt.
   */
  setElevation(elevation: SurfaceElevation | null): void {
    this.elevation = elevation;
    this.tiltDegrees = elevation
      ? clampTilt(this.userSettings.cameraTilt(DEFAULT_TILT_DEGREES))
      : 0;
    this.changed = true;
  }

  /** The 3D camera's tilt away from straight down, in degrees; 0 on the flat map. */
  tilt(): number {
    return this.tiltDegrees;
  }

  private onTilt(event: CameraTiltEvent) {
    if (this.elevation === null) return;
    const tilt = clampTilt(this.tiltDegrees + event.degrees);
    if (tilt === this.tiltDegrees) return;
    // Tilting turns the camera about the point in the middle of the view,
    // which TransformHandler's offsets already pin, so they stay as they are.
    this.tiltDegrees = tilt;
    this.changed = true;
    if (this.saveTiltTimer !== null) clearTimeout(this.saveTiltTimer);
    this.saveTiltTimer = setTimeout(() => {
      this.saveTiltTimer = null;
      this.userSettings.setCameraTilt(this.tiltDegrees);
    }, SAVE_TILT_DELAY_MS);
  }

  /** The tilted camera as it is now (only meaningful on the 3D map). */
  private viewTilt(): CameraTilt {
    const centerY =
      this.offsetY +
      this.game.height() / 2 +
      (this.boundingRect().height - this.game.height()) / (2 * this.scale);
    return cameraTilt(this.tiltDegrees, centerY);
  }

  /**
   * Screen pixels per tile down the screen, relative to across it: below 1
   * when the 3D camera is tilted, since it sees the map at a slant.
   */
  private foreshortening(): number {
    return this.elevation ? this.viewTilt().cos : 1;
  }

  public updateCanvasBoundingRect() {
    this._boundingRect = this.canvas.getBoundingClientRect();
  }

  boundingRect(): DOMRect {
    return this._boundingRect;
  }

  width(): number {
    return this.boundingRect().width;
  }
  hasChanged(): boolean {
    return this.changed;
  }
  resetChanged() {
    this.changed = false;
  }

  handleTransform(context: CanvasRenderingContext2D) {
    // Disable image smoothing for pixelated effect
    context.imageSmoothingEnabled = false;

    // Apply zoom and pan
    context.setTransform(
      this.scale,
      0,
      0,
      this.scale,
      this.game.width() / 2 - this.offsetX * this.scale,
      this.game.height() / 2 - this.offsetY * this.scale,
    );
  }

  worldToCanvasCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1: Convert from Cell coordinates to game coordinates
    // (reverse of Math.floor operation - we'll use the exact values)
    const gameX = cell.x;
    const gameY = this.elevation
      ? drawnGroundY(this.elevation, this.viewTilt(), cell.x, cell.y)
      : cell.y;

    // Step 2: Reverse the game center offset calculation
    // Original: gameX = centerX + this.game.width() / 2
    // Therefore: centerX = gameX - this.game.width() / 2
    const centerX = gameX - this.game.width() / 2;
    const centerY = gameY - this.game.height() / 2;

    // Step 3: Reverse the world point calculation
    // Original: centerX = (canvasX - this.game.width() / 2) / this.scale + this.offsetX
    // Therefore: canvasX = (centerX - this.offsetX) * this.scale + this.game.width() / 2
    const canvasX =
      (centerX - this.offsetX) * this.scale + this.game.width() / 2;
    const canvasY =
      (centerY - this.offsetY) * this.scale + this.game.height() / 2;

    return { x: canvasX, y: canvasY };
  }

  worldToScreenCoordinates(cell: Cell): { x: number; y: number } {
    // Step 1-3: Convert world coordinates to canvas coordinates in worldToCanvasCoordinates
    // Step 4 only where needed: Convert canvas coordinates back to screen coordinates
    const canvasCoords = this.worldToCanvasCoordinates(cell);
    return this.canvasToScreenCoordinates(canvasCoords.x, canvasCoords.y);
  }

  screenToWorldCoordinates(screenX: number, screenY: number): Cell {
    const f = this.screenToWorldCoordinatesFloat(screenX, screenY);
    return new Cell(Math.floor(f.x), Math.floor(f.y));
  }

  /** Like screenToWorldCoordinates but returns sub-tile precision. */
  screenToWorldCoordinatesFloat(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasCoords = this.screenToCanvasCoordinates(screenX, screenY);
    const gameX =
      (canvasCoords.x - this.game.width() / 2) / this.scale +
      this.offsetX +
      this.game.width() / 2;
    const gameY =
      (canvasCoords.y - this.game.height() / 2) / this.scale +
      this.offsetY +
      this.game.height() / 2;
    if (this.elevation) {
      return surfaceUnderGroundPoint(
        this.elevation,
        this.viewTilt(),
        gameX,
        gameY,
      );
    }
    return { x: gameX, y: gameY };
  }

  canvasToScreenCoordinates(
    canvasX: number,
    canvasY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return {
      x: canvasX + canvasRect.left,
      y: canvasY + canvasRect.top,
    };
  }

  screenToCanvasCoordinates(
    screenX: number,
    screenY: number,
  ): { x: number; y: number } {
    const canvasRect = this.boundingRect();
    return { x: screenX - canvasRect.left, y: screenY - canvasRect.top };
  }

  screenBoundingRect(): [Cell, Cell] {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;

    const LeftX = -this.game.width() / 2 / this.scale + this.offsetX;
    const TopY = -this.game.height() / 2 / this.scale + this.offsetY;

    const gameLeftX = LeftX + this.game.width() / 2;
    let gameTopY = TopY + this.game.height() / 2;

    const rightX =
      (canvasWidth - this.game.width() / 2) / this.scale + this.offsetX;
    const bottomY =
      (canvasHeight - this.game.height() / 2) / this.scale + this.offsetY;

    const gameRightX = rightX + this.game.width() / 2;
    let gameBottomY = bottomY + this.game.height() / 2;
    if (this.elevation) {
      // The tilted 3D camera sees more of the map down the screen, and
      // draws raised ground south of the bottom edge up into view.
      const t = this.viewTilt();
      gameTopY = seaLevelY(t, gameTopY);
      gameBottomY = seaLevelY(t, gameBottomY) + maxRaise(this.elevation, t);
    }

    return [
      new Cell(Math.floor(gameLeftX), Math.floor(gameTopY)),
      new Cell(Math.floor(gameRightX), Math.floor(gameBottomY)),
    ];
  }

  isOnScreen(cell: Cell): boolean {
    const [topLeft, bottomRight] = this.screenBoundingRect();
    return (
      cell.x > topLeft.x &&
      cell.x < bottomRight.x &&
      cell.y > topLeft.y &&
      cell.y < bottomRight.y
    );
  }

  screenCenter(): { screenX: number; screenY: number } {
    if (this.elevation) {
      // The point the 3D camera looks at; the bounding rect reaches further
      // south than north of it.
      const { width } = this.boundingRect();
      return {
        screenX: Math.floor(
          this.offsetX +
            this.game.width() / 2 +
            (width - this.game.width()) / (2 * this.scale),
        ),
        screenY: Math.floor(this.viewTilt().centerY),
      };
    }
    const [upperLeft, bottomRight] = this.screenBoundingRect();
    return {
      screenX: upperLeft.x + Math.floor((bottomRight.x - upperLeft.x) / 2),
      screenY: upperLeft.y + Math.floor((bottomRight.y - upperLeft.y) / 2),
    };
  }

  onGoToPlayer(event: GoToPlayerEvent) {
    this.clearTarget();
    const nameLocation = event.player.nameLocation();
    if (!nameLocation) {
      return;
    }
    this.target = new Cell(nameLocation.x, nameLocation.y);
    this.targetScale = event.zoom ?? null;
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToPosition(event: GoToPositionEvent) {
    this.clearTarget();
    this.target = new Cell(event.x, event.y);
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  onGoToUnit(event: GoToUnitEvent) {
    this.clearTarget();
    this.target = new Cell(
      this.game.x(event.unit.lastTile()),
      this.game.y(event.unit.lastTile()),
    );
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  centerCamera() {
    this.clearTarget();
    const player = this.game.myPlayer();
    const nameLocation = player?.nameLocation();
    if (!nameLocation) return;
    this.target = new Cell(nameLocation.x, nameLocation.y);
    this.intervalID = setInterval(() => this.goTo(), GOTO_INTERVAL_MS);
  }

  private goTo() {
    const { screenX, screenY } = this.screenCenter();

    if (this.target === null) {
      throw new Error("null target");
    }
    const positionClose =
      Math.abs(this.target.x - screenX) + Math.abs(this.target.y - screenY) < 2;
    const scaleClose =
      this.targetScale === null ||
      Math.abs(this.scale - this.targetScale) < 0.01;
    if (positionClose && scaleClose) {
      this.clearTarget();
      return;
    }

    let dt: number;
    const now = window.performance.now();
    if (this.lastGoToCallTime === null) {
      dt = GOTO_INTERVAL_MS;
    } else {
      dt = now - this.lastGoToCallTime;
    }
    this.lastGoToCallTime = now;

    const r = 1 - Math.pow(CAMERA_SMOOTHING, dt / 1000);

    this.offsetX += Math.max(
      Math.min((this.target.x - screenX) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );
    this.offsetY += Math.max(
      Math.min((this.target.y - screenY) * r, CAMERA_MAX_SPEED),
      -CAMERA_MAX_SPEED,
    );

    if (this.targetScale !== null) {
      const oldScale = this.scale;
      const zoomSmoothing = 0.7;
      const zoomR = 1 - Math.pow(zoomSmoothing, dt / 1000);
      const diff = this.targetScale - this.scale;
      const smoothStep = diff * zoomR;
      const minStep =
        Math.sign(diff) * Math.min(Math.abs(diff), (6.0 * dt) / 1000);
      this.scale +=
        Math.abs(smoothStep) >= Math.abs(minStep) ? smoothStep : minStep;
      // Keep screen center pinned as scale changes: (canvasSize - mapSize) / (2 * scale)
      // shifts the apparent center when canvas != map dimensions (always on mobile).
      const { width: canvasWidth, height: canvasHeight } = this.boundingRect();
      this.offsetX +=
        (canvasWidth - this.game.width()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
      this.offsetY +=
        (canvasHeight - this.game.height()) *
        (1 / (2 * oldScale) - 1 / (2 * this.scale));
    }

    this.changed = true;
  }

  onZoom(event: ZoomEvent) {
    this.clearTarget();
    const oldScale = this.scale;
    const zoomFactor = 1 + event.delta / ZOOM_DELTA_DIVISOR;
    this.scale /= zoomFactor;

    // Clamp the scale to prevent extreme zooming
    this.scale = Math.max(0.2, Math.min(20, this.scale));

    const canvasCoords = this.screenToCanvasCoordinates(event.x, event.y);

    // Calculate the world point we want to zoom towards
    const zoomPointX =
      (canvasCoords.x - this.game.width() / 2) / oldScale + this.offsetX;
    const zoomPointY =
      (canvasCoords.y - this.game.height() / 2) / oldScale + this.offsetY;

    // Adjust the offset
    this.offsetX =
      zoomPointX - (canvasCoords.x - this.game.width() / 2) / this.scale;
    this.offsetY =
      zoomPointY - (canvasCoords.y - this.game.height() / 2) / this.scale;
    if (this.elevation) {
      // Down the screen the tilted 3D camera's pixels cover more ground, so
      // the point under the cursor is further from the middle of the view.
      const fromCenter = canvasCoords.y - this.boundingRect().height / 2;
      this.offsetY +=
        fromCenter *
        (1 / oldScale - 1 / this.scale) *
        (1 / this.foreshortening() - 1);
    }
    this.clampOffsets();
    this.changed = true;
  }

  private clampOffsets() {
    const canvasRect = this.boundingRect();
    const canvasWidth = canvasRect.width;
    const canvasHeight = canvasRect.height;
    const gameWidth = this.game.width();
    const gameH = this.game.height();
    const scale = this.scale;

    // Allow panning so that up to half of the viewport can be outside the map on each side.
    // This lets a map corner be placed at the screen center, but no further.
    // Derivation (X axis):
    //   gameLeftX = -gameWidth/(2*scale) + offsetX + gameWidth/2 >= -vw/2
    //   gameRightX = (canvasWidth - gameWidth/2)/scale + offsetX + gameWidth/2 <= gameWidth + vw/2
    // Solving gives:
    //   minOffsetX = -gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
    //   maxOffsetX =  gameWidth/2 + (gameWidth - canvasWidth) / (2*scale)
    const minOffsetX = -gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);
    const maxOffsetX = gameWidth / 2 + (gameWidth - canvasWidth) / (2 * scale);

    const minOffsetY = -gameH / 2 + (gameH - canvasHeight) / (2 * scale);
    const maxOffsetY = gameH / 2 + (gameH - canvasHeight) / (2 * scale);

    // Clamp offsets within computed bounds on each axis
    if (this.offsetX < minOffsetX) {
      this.offsetX = minOffsetX;
    } else if (this.offsetX > maxOffsetX) {
      this.offsetX = maxOffsetX;
    }

    if (this.offsetY < minOffsetY) {
      this.offsetY = minOffsetY;
    } else if (this.offsetY > maxOffsetY) {
      this.offsetY = maxOffsetY;
    }
  }

  onMove(event: DragEvent) {
    this.clearTarget();
    this.offsetX -= event.deltaX / this.scale;
    this.offsetY -= event.deltaY / this.scale / this.foreshortening();
    this.clampOffsets();
    this.changed = true;
  }

  private clearTarget() {
    if (this.intervalID !== null) {
      clearInterval(this.intervalID);
      this.intervalID = null;
    }
    this.target = null;
    this.targetScale = null;
  }

  override(x: number = 0, y: number = 0, s: number = 1) {
    //hardset view position
    this.clearTarget();
    this.offsetX = x;
    this.offsetY = y;
    this.scale = s;
    this.changed = true;
  }

  centerAll(fit: number = 1) {
    //position entire map centered on the screen

    const vpWidth = this.boundingRect().width;
    const vpHeight = this.boundingRect().height;
    const mapWidth = this.game.width();
    const mapHeight = this.game.height();

    const scHor = (vpWidth / mapWidth) * fit;
    const scVer = (vpHeight / mapHeight) * fit;
    const tScale = Math.min(scHor, scVer);

    const oHor = (mapWidth - vpWidth) / 2 / tScale;
    const oVer = (mapHeight - vpHeight) / 2 / tScale;

    this.override(oHor, oVer, tScale);
  }
}
