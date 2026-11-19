import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {RoomEnvironment} from 'three/addons/environments/RoomEnvironment.js';

import {buildRealisticBanana, type BananaRig} from './bananaBuilder';
import {clamp01, computeRipenessPalette} from './bananaMath';

type CameraPresetKey = 'overview' | 'closeup' | 'top';

interface CameraPreset {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const CAMERA_PRESETS: Record<CameraPresetKey, CameraPreset> = {
  overview: {
    position: new THREE.Vector3(0.28, 0.23, 0.50),
    target: new THREE.Vector3(0.0, 0.082, 0.0),
  },
  closeup: {
    position: new THREE.Vector3(0.14, 0.21, 0.27),
    target: new THREE.Vector3(-0.005, 0.135, 0.0),
  },
  top: {
    position: new THREE.Vector3(0.04, 0.44, 0.14),
    target: new THREE.Vector3(0.0, 0.115, 0.0),
  },
};

const PEEL_ANIM_DURATION_S = 2.8;

function getUrlParamFloat(name: string, fallback: number): number {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getUrlParamBool(name: string, fallback: boolean): boolean {
  const raw = new URLSearchParams(window.location.search).get(name);
  if (raw === null) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function detectSoftwareGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  } catch {
    return false;
  }
}

export class BananaStudioViewer {
  private readonly mountEl: HTMLElement;
  private readonly fallbackEl: HTMLElement | null;
  private readonly isSoftwareGl: boolean;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private envRenderTarget: THREE.WebGLRenderTarget | null = null;

  private bananaRig: BananaRig | null = null;
  private studioFloorGeo: THREE.BufferGeometry | null = null;
  private studioFloorMat: THREE.Material | null = null;
  private keyLight: THREE.DirectionalLight | null = null;

  private readonly initialRipeness = clamp01(getUrlParamFloat('ripeness', 0.55));
  private readonly initialPeel = clamp01(getUrlParamFloat('peel', 0.0));
  private readonly autoPeelOnStart = getUrlParamBool('autopeel', false);

  private targetRipeness = this.initialRipeness;
  private currentRipeness = this.initialRipeness;
  private targetPeel = this.initialPeel;
  private currentPeel = this.initialPeel;
  private lastSyncedPeelPct = Math.round(this.initialPeel * 100);

  private autoSpin = getUrlParamBool('spin', false);
  private pedestalVisible = true;
  private activePreset: CameraPresetKey = 'overview';

  private peelAnimActive = false;
  private peelAnimStartMs = 0;
  private peelAnimFrom = 0;
  private peelAnimTo = 1;
  private firstFrameRendered = false;

  private cameraTransitionActive = false;
  private readonly cameraGoalPos = new THREE.Vector3().copy(CAMERA_PRESETS.overview.position);
  private readonly cameraGoalTarget = new THREE.Vector3().copy(CAMERA_PRESETS.overview.target);

  // Render loop & pacing state (software-GL safe)
  private frameId = 0;
  private timerId = 0;
  private renderScheduled = false;
  private renderInFlight = false;
  private renderDirty = false;
  private lastFrameTimeMs = 0;
  private disposed = false;

  // DOM bindings
  private stageLabelEl!: HTMLElement;
  private ripenessSlider!: HTMLInputElement;
  private ripenessValueEl!: HTMLElement;
  private peelSlider!: HTMLInputElement;
  private peelValueEl!: HTMLElement;
  private peelAnimBtn!: HTMLButtonElement;
  private spinBtn!: HTMLButtonElement;
  private pedestalBtn!: HTMLButtonElement;
  private resetBtn!: HTMLButtonElement;
  private dockShellEl!: HTMLElement;
  private dockToggleBtn!: HTMLButtonElement;
  private presetButtons: HTMLButtonElement[] = [];

  private readonly onResizeBound = () => this.handleResize();
  private readonly onKeyDownBound = (event: KeyboardEvent) => this.handleKeyDown(event);
  private readonly onContextLostBound = (event: Event) => {
    event.preventDefault();
    this.cancelPendingFrames();
  };
  private readonly onContextRestoredBound = () => {
    this.requestRender();
  };

  constructor(mountEl: HTMLElement, fallbackEl: HTMLElement | null) {
    this.mountEl = mountEl;
    this.fallbackEl = fallbackEl;
    this.isSoftwareGl = detectSoftwareGl();

    this.initThree();
    this.initControlsUi();

    if (this.autoPeelOnStart) {
      this.startPeelAnimation(this.initialPeel >= 0.5 ? 0 : 1);
    }

    this.syncBodyDataset();
    this.requestRender();
  }

  private initThree() {
    const width = Math.max(1, this.mountEl.clientWidth || window.innerWidth);
    const height = Math.max(1, this.mountEl.clientHeight || window.innerHeight);

    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: !this.isSoftwareGl,
        powerPreference: 'high-performance',
      });
    } catch {
      if (this.fallbackEl) {
        this.fallbackEl.hidden = false;
      }
      throw new Error('WebGL initialization failed');
    }

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.renderer.setSize(width, height);
    this.renderer.shadowMap.enabled = !this.isSoftwareGl;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.domElement.addEventListener('webglcontextlost', this.onContextLostBound);
    this.renderer.domElement.addEventListener('webglcontextrestored', this.onContextRestoredBound);
    this.mountEl.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x14171c);
    this.scene.fog = new THREE.FogExp2(0x14171c, 0.32);

    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.envRenderTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envRenderTarget.texture;
    this.scene.environmentIntensity = 0.78;
    pmremGenerator.dispose();

    this.camera = new THREE.PerspectiveCamera(36, width / height, 0.04, 20);
    this.camera.position.copy(CAMERA_PRESETS.overview.position);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = !this.isSoftwareGl;
    this.controls.dampingFactor = 0.06;
    this.controls.target.copy(CAMERA_PRESETS.overview.target);
    this.controls.minDistance = 0.22;
    this.controls.maxDistance = 1.65;
    this.controls.maxPolarAngle = Math.PI * 0.54;
    this.controls.update();

    this.controls.addEventListener('start', () => {
      // Cancel scripted camera presets immediately when the user interacts
      this.cameraTransitionActive = false;
    });
    this.controls.addEventListener('change', () => {
      this.requestRender();
    });

    this.setupLightingAndStage();
    this.setupBananaSpecimen();

    if (!this.isSoftwareGl) {
      this.renderer.compile(this.scene, this.camera);
    }

    window.addEventListener('resize', this.onResizeBound);
    window.addEventListener('keydown', this.onKeyDownBound);
  }

  private setupLightingAndStage() {
    // Cool sky / warm ground ambient bounce fill
    const hemi = new THREE.HemisphereLight(0xdcebff, 0x3b342b, 1.35);
    this.scene.add(hemi);

    // Warm studio key light casting tight soft shadow onto banana & pedestal
    const key = new THREE.DirectionalLight(0xfff4de, 2.3);
    key.position.set(0.75, 1.35, 0.85);
    key.castShadow = !this.isSoftwareGl;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.2;
    key.shadow.camera.far = 3.5;
    key.shadow.camera.left = -0.28;
    key.shadow.camera.right = 0.28;
    key.shadow.camera.top = 0.32;
    key.shadow.camera.bottom = -0.22;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.015;
    key.target.position.set(0, 0.1, 0);
    this.scene.add(key, key.target);
    this.keyLight = key;

    // Cool rim light separating the 5 peel ridges from dark slate studio backdrop
    const rim = new THREE.DirectionalLight(0xeef6ff, 1.15);
    rim.position.set(-0.9, 0.95, -0.95);
    rim.target.position.set(0, 0.12, 0);
    this.scene.add(rim, rim.target);

    // Subtle soft front-left fill so shadowed inner pith & creases retain rich detail
    const fill = new THREE.DirectionalLight(0xfff8ef, 0.48);
    fill.position.set(-0.6, 0.45, 0.75);
    this.scene.add(fill);

    // Grounded dark matte studio tabletop surface directly beneath pedestal (y = 0)
    const floorGeo = new THREE.CircleGeometry(3.5, 64);
    floorGeo.rotateX(-Math.PI / 2);
    const floorMat = new THREE.MeshStandardMaterial({
      color: 0x161a20,
      roughness: 0.92,
      metalness: 0.04,
    });
    const floorMesh = new THREE.Mesh(floorGeo, floorMat);
    floorMesh.name = 'StudioTabletop';
    floorMesh.receiveShadow = !this.isSoftwareGl;
    this.scene.add(floorMesh);
    this.studioFloorGeo = floorGeo;
    this.studioFloorMat = floorMat;
  }

  private setupBananaSpecimen() {
    const rig = buildRealisticBanana({
      renderer: this.renderer,
      initialRipeness: this.initialRipeness,
      initialPeel: this.initialPeel,
      castShadow: !this.isSoftwareGl,
    });
    rig.root.position.set(0, 0, 0);
    this.scene.add(rig.root);
    this.bananaRig = rig;
  }

  private initControlsUi() {
    this.stageLabelEl = document.getElementById('stage-label')!;
    this.ripenessSlider = document.getElementById('ripeness-slider') as HTMLInputElement;
    this.ripenessValueEl = document.getElementById('ripeness-value')!;
    this.peelSlider = document.getElementById('peel-slider') as HTMLInputElement;
    this.peelValueEl = document.getElementById('peel-value')!;
    this.peelAnimBtn = document.getElementById('peel-anim-btn') as HTMLButtonElement;
    this.spinBtn = document.getElementById('spin-btn') as HTMLButtonElement;
    this.pedestalBtn = document.getElementById('pedestal-btn') as HTMLButtonElement;
    this.resetBtn = document.getElementById('reset-btn') as HTMLButtonElement;
    this.dockShellEl = document.getElementById('dock-shell')!;
    this.dockToggleBtn = document.getElementById('dock-toggle-btn') as HTMLButtonElement;
    this.presetButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[data-camera-preset]')
    );

    const ripenessPct = Math.round(this.initialRipeness * 100);
    const peelPct = Math.round(this.initialPeel * 100);
    this.ripenessSlider.value = String(ripenessPct);
    this.ripenessValueEl.textContent = `${ripenessPct}%`;
    this.stageLabelEl.textContent = computeRipenessPalette(this.initialRipeness).stageLabelJa;

    this.peelSlider.value = String(peelPct);
    this.peelValueEl.textContent = `${peelPct}%`;
    this.updatePeelButtonUi();
    this.updateSpinButtonUi();
    this.updatePedestalButtonUi();

    this.ripenessSlider.addEventListener('input', () => {
      const value = Number.parseFloat(this.ripenessSlider.value) / 100;
      this.setRipeness(value, false);
    });

    this.peelSlider.addEventListener('input', () => {
      this.peelAnimActive = false;
      const value = Number.parseFloat(this.peelSlider.value) / 100;
      this.setPeel(value, false);
      this.updatePeelButtonUi();
    });

    this.peelAnimBtn.addEventListener('click', () => {
      const destination = this.targetPeel >= 0.5 ? 0 : 1;
      this.startPeelAnimation(destination);
    });

    for (const btn of this.presetButtons) {
      btn.addEventListener('click', () => {
        const key = btn.dataset.cameraPreset as CameraPresetKey | undefined;
        if (key && CAMERA_PRESETS[key]) {
          this.selectCameraPreset(key);
        }
      });
    }

    this.spinBtn.addEventListener('click', () => {
      this.autoSpin = !this.autoSpin;
      this.updateSpinButtonUi();
      this.syncBodyDataset();
      this.requestRender();
    });

    this.pedestalBtn.addEventListener('click', () => {
      this.pedestalVisible = !this.pedestalVisible;
      this.bananaRig?.setPedestalVisible(this.pedestalVisible);
      this.updatePedestalButtonUi();
      this.syncBodyDataset();
      this.requestRender();
    });

    this.resetBtn.addEventListener('click', () => this.resetAll());

    this.dockToggleBtn.addEventListener('click', () => this.toggleDock());
  }

  private setRipeness(value: number, syncSlider: boolean) {
    const clamped = clamp01(value);
    this.targetRipeness = clamped;
    const pct = Math.round(clamped * 100);
    this.ripenessValueEl.textContent = `${pct}%`;
    this.stageLabelEl.textContent = computeRipenessPalette(clamped).stageLabelJa;
    if (syncSlider) {
      this.ripenessSlider.value = String(pct);
    }
    this.syncBodyDataset();
    this.requestRender();
  }

  private setPeel(value: number, syncSlider: boolean) {
    const clamped = clamp01(value);
    this.targetPeel = clamped;
    const pct = Math.round(clamped * 100);
    this.peelValueEl.textContent = `${pct}%`;
    this.lastSyncedPeelPct = pct;
    if (syncSlider) {
      this.peelSlider.value = String(pct);
    }
    this.syncBodyDataset();
    this.requestRender();
  }

  private startPeelAnimation(toAmount: number) {
    this.peelAnimFrom = this.currentPeel;
    this.peelAnimTo = clamp01(toAmount);
    this.peelAnimStartMs = performance.now();
    this.peelAnimActive = Math.abs(this.peelAnimTo - this.peelAnimFrom) > 0.005;
    if (!this.peelAnimActive) {
      this.setPeel(this.peelAnimTo, true);
    }
    this.updatePeelButtonUi();
    this.syncBodyDataset();
    this.requestRender();
  }

  private selectCameraPreset(key: CameraPresetKey) {
    this.activePreset = key;
    const preset = CAMERA_PRESETS[key];
    this.cameraGoalPos.copy(preset.position);
    this.cameraGoalTarget.copy(preset.target);
    this.cameraTransitionActive = true;

    for (const btn of this.presetButtons) {
      const isMatch = btn.dataset.cameraPreset === key;
      btn.classList.toggle('is-active', isMatch);
      btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
    }
    this.syncBodyDataset();
    this.requestRender();
  }

  private resetAll() {
    this.peelAnimActive = false;
    this.setRipeness(this.initialRipeness, true);
    this.setPeel(this.initialPeel, true);
    this.updatePeelButtonUi();

    this.autoSpin = false;
    this.updateSpinButtonUi();

    this.pedestalVisible = true;
    this.bananaRig?.setPedestalVisible(true);
    this.updatePedestalButtonUi();

    if (this.bananaRig) {
      this.bananaRig.root.rotation.y = 0;
    }
    this.selectCameraPreset('overview');
  }

  private toggleDock() {
    const collapsed = this.dockShellEl.classList.toggle('is-collapsed');
    this.dockToggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    this.dockToggleBtn.textContent = collapsed
      ? 'コントロールを表示 (H)'
      : 'コントロールを隠す (H)';
  }

  private updatePeelButtonUi() {
    if (this.peelAnimActive) {
      this.peelAnimBtn.textContent = this.peelAnimTo >= 0.5 ? '剥き中...' : '閉じ中...';
      return;
    }
    this.peelAnimBtn.textContent = this.targetPeel >= 0.5 ? '皮を閉じる' : '皮を剥く';
  }

  private updateSpinButtonUi() {
    this.spinBtn.textContent = this.autoSpin ? '自動回転: ON' : '自動回転: OFF';
    this.spinBtn.classList.toggle('is-active', this.autoSpin);
    this.spinBtn.setAttribute('aria-pressed', this.autoSpin ? 'true' : 'false');
  }

  private updatePedestalButtonUi() {
    this.pedestalBtn.textContent = this.pedestalVisible ? '台座: ON' : '台座: OFF';
    this.pedestalBtn.classList.toggle('is-active', this.pedestalVisible);
    this.pedestalBtn.setAttribute('aria-pressed', this.pedestalVisible ? 'true' : 'false');
  }

  private syncBodyDataset() {
    document.body.dataset.state = this.firstFrameRendered ? 'ready' : 'initializing';
    document.body.dataset.ripeness = String(Math.round(this.targetRipeness * 100));
    document.body.dataset.peel = String(Math.round(this.targetPeel * 100));
    document.body.dataset.peelAnimating = this.peelAnimActive ? 'true' : 'false';
    document.body.dataset.spin = this.autoSpin ? 'on' : 'off';
    document.body.dataset.pedestal = this.pedestalVisible ? 'on' : 'off';
    document.body.dataset.cameraPreset = this.activePreset;
  }

  private handleKeyDown(event: KeyboardEvent) {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
      return;
    }
    if (event.key === 'h' || event.key === 'H') {
      this.toggleDock();
    } else if (event.key === ' ') {
      event.preventDefault();
      this.startPeelAnimation(this.targetPeel >= 0.5 ? 0 : 1);
    }
  }

  private handleResize() {
    if (this.disposed) return;
    const width = Math.max(1, this.mountEl.clientWidth || window.innerWidth);
    const height = Math.max(1, this.mountEl.clientHeight || window.innerHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(
      this.isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2)
    );
    this.requestRender();
  }

  private stepSimulation(dt: number): boolean {
    let needsMoreFrames = false;

    if (this.autoSpin && this.bananaRig) {
      this.bananaRig.root.rotation.y += 0.42 * dt;
      needsMoreFrames = true;
    }

    if (this.peelAnimActive && this.bananaRig) {
      const elapsedS = Math.max(0, (performance.now() - this.peelAnimStartMs) / 1000);
      const u = Math.min(1, elapsedS / PEEL_ANIM_DURATION_S);
      const eased = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const nextPeel = this.peelAnimFrom + (this.peelAnimTo - this.peelAnimFrom) * eased;

      this.targetPeel = nextPeel;
      this.currentPeel = nextPeel;
      this.bananaRig.setPeelAmount(nextPeel);

      const pct = Math.round(nextPeel * 100);
      if (pct !== this.lastSyncedPeelPct) {
        this.lastSyncedPeelPct = pct;
        this.peelValueEl.textContent = `${pct}%`;
        this.peelSlider.value = String(pct);
        document.body.dataset.peel = String(pct);
      }

      if (u >= 1) {
        this.peelAnimActive = false;
        this.targetPeel = this.peelAnimTo;
        this.currentPeel = this.peelAnimTo;
        this.bananaRig.setPeelAmount(this.currentPeel);
        this.setPeel(this.peelAnimTo, true);
        this.updatePeelButtonUi();
      } else {
        needsMoreFrames = true;
      }
    } else if (this.bananaRig) {
      const nextPeel = THREE.MathUtils.damp(this.currentPeel, this.targetPeel, 12, dt);
      if (Math.abs(nextPeel - this.currentPeel) > 0.0008) {
        this.currentPeel = nextPeel;
        this.bananaRig.setPeelAmount(this.currentPeel);
        needsMoreFrames = true;
      } else if (this.currentPeel !== this.targetPeel) {
        this.currentPeel = this.targetPeel;
        this.bananaRig.setPeelAmount(this.currentPeel);
      }
    }

    if (this.bananaRig) {
      const nextRipeness = THREE.MathUtils.damp(
        this.currentRipeness,
        this.targetRipeness,
        9,
        dt
      );
      if (Math.abs(nextRipeness - this.currentRipeness) > 0.005) {
        this.currentRipeness = nextRipeness;
        this.bananaRig.setRipeness(this.currentRipeness);
        needsMoreFrames = true;
      } else if (this.currentRipeness !== this.targetRipeness) {
        this.currentRipeness = this.targetRipeness;
        this.bananaRig.setRipeness(this.currentRipeness);
      }
    }

    if (this.cameraTransitionActive) {
      const lambda = this.isSoftwareGl ? 18 : 9;
      this.camera.position.x = THREE.MathUtils.damp(
        this.camera.position.x,
        this.cameraGoalPos.x,
        lambda,
        dt
      );
      this.camera.position.y = THREE.MathUtils.damp(
        this.camera.position.y,
        this.cameraGoalPos.y,
        lambda,
        dt
      );
      this.camera.position.z = THREE.MathUtils.damp(
        this.camera.position.z,
        this.cameraGoalPos.z,
        lambda,
        dt
      );
      this.controls.target.x = THREE.MathUtils.damp(
        this.controls.target.x,
        this.cameraGoalTarget.x,
        lambda,
        dt
      );
      this.controls.target.y = THREE.MathUtils.damp(
        this.controls.target.y,
        this.cameraGoalTarget.y,
        lambda,
        dt
      );
      this.controls.target.z = THREE.MathUtils.damp(
        this.controls.target.z,
        this.cameraGoalTarget.z,
        lambda,
        dt
      );

      const posDist = this.camera.position.distanceTo(this.cameraGoalPos);
      const tgtDist = this.controls.target.distanceTo(this.cameraGoalTarget);
      if (posDist < 0.0015 && tgtDist < 0.0015) {
        this.camera.position.copy(this.cameraGoalPos);
        this.controls.target.copy(this.cameraGoalTarget);
        this.cameraTransitionActive = false;
      } else {
        needsMoreFrames = true;
      }
    }

    const controlsMoving = this.controls.update();
    return needsMoreFrames || Boolean(controlsMoving);
  }

  private afterDraw(cb: () => void) {
    if (this.disposed) return;
    const gl = this.renderer.getContext() as WebGL2RenderingContext;
    if (typeof gl.fenceSync === 'function') {
      const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      gl.flush();
      const poll = () => {
        if (this.disposed) {
          if (sync) gl.deleteSync(sync);
          return;
        }
        const state = sync && gl.getSyncParameter(sync, gl.SYNC_STATUS);
        if (state === gl.UNSIGNALED) {
          this.timerId = window.setTimeout(poll, 5);
        } else {
          if (sync) gl.deleteSync(sync);
          this.timerId = window.setTimeout(cb, 80);
        }
      };
      this.timerId = window.setTimeout(poll, 5);
    } else {
      this.timerId = window.setTimeout(cb, 80);
    }
  }

  private requestRender() {
    if (this.disposed) return;
    if (this.renderInFlight) {
      this.renderDirty = true;
      return;
    }
    if (this.renderScheduled) return;
    this.renderScheduled = true;

    this.frameId = window.requestAnimationFrame((nowMs) => {
      this.renderScheduled = false;
      if (this.disposed) return;

      this.renderInFlight = true;
      this.renderDirty = false;

      const dt =
        this.lastFrameTimeMs > 0
          ? Math.min(0.1, Math.max(0.001, (nowMs - this.lastFrameTimeMs) / 1000))
          : 1 / 60;
      this.lastFrameTimeMs = nowMs;

      const keepAnimating = this.stepSimulation(dt);
      this.renderer.render(this.scene, this.camera);

      const finishFrame = () => {
        this.renderInFlight = false;
        if (this.disposed) return;
        if (!this.firstFrameRendered) {
          this.firstFrameRendered = true;
          this.syncBodyDataset();
        }
        if (keepAnimating || this.renderDirty) {
          this.requestRender();
        } else {
          this.lastFrameTimeMs = 0;
        }
      };

      if (this.isSoftwareGl) {
        this.afterDraw(finishFrame);
      } else {
        finishFrame();
      }
    });
  }

  private cancelPendingFrames() {
    if (this.frameId) {
      window.cancelAnimationFrame(this.frameId);
      this.frameId = 0;
    }
    if (this.timerId) {
      window.clearTimeout(this.timerId);
      this.timerId = 0;
    }
    this.renderScheduled = false;
    this.renderInFlight = false;
  }

  dispose() {
    this.disposed = true;
    this.cancelPendingFrames();
    window.removeEventListener('resize', this.onResizeBound);
    window.removeEventListener('keydown', this.onKeyDownBound);

    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLostBound);
    this.renderer.domElement.removeEventListener(
      'webglcontextrestored',
      this.onContextRestoredBound
    );

    this.controls.dispose();
    this.bananaRig?.dispose();
    this.studioFloorGeo?.dispose();
    this.studioFloorMat?.dispose();
    this.envRenderTarget?.dispose();
    if (this.keyLight) {
      this.keyLight.shadow.map?.dispose();
    }
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
