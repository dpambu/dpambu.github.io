import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "./assets/models/memento-clock.glb";

const SOUND_ENABLED = true;
const SOUNDS = {
  crackOne: "./assets/sounds/crack-1.mp3",
  breakOne: "./assets/sounds/zerbruch-1.mp3",
  breakTwo: "./assets/sounds/2.Crack.mp3",
  breakThree: "./assets/sounds/reverse.mp3",
};
const BACKGROUND_SOUND_URL = "./assets/sounds/reverse.mp3";
const BACKGROUND_VOLUME = 1;
const BACKGROUND_GAIN = 2.4;
const SOUND_VOLUMES = {
  crackOne: 1,
  breakOne: 1.2,
  breakTwo: 2.52,
  breakThree: 2.8,
};
let soundsUnlocked = false;
let audioContext = null;
let backgroundAudio = null;
let backgroundSource = null;
let backgroundGain = null;

const canvas = document.querySelector("#scene");
const intro = document.querySelector("#intro");
const introText = document.querySelector("#introText");
const urlParams = new URLSearchParams(window.location.search);
const DEBUG_SKIP_INTRO = urlParams.has("skipIntro");
const DEBUG_AUTO_CYCLE = urlParams.has("autoCycle");

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x150b07, 0.155);

const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.16, 6.35);
const cameraHomePosition = camera.position.clone();
const cameraHomeRotation = camera.rotation.clone();

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.38;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const frameClock = new THREE.Clock();

const state = {
  ready: false,
  introDone: false,
  cycleRunning: false,
  stageAnimating: false,
  rebuilding: false,
  damageStage: 0,
  elapsed: 0,
  hoverClock: false,
  vortexSpin: 0,
  vortexYaw: 0,
  vortexLift: 0,
};

const parts = {
  allMeshes: [],
  cracks: [],
  glassNormal: [],
  caseNormal: [],
  glassShards: [],
  casePieces: [],
  looseParts: [],
  clickTargets: [],
  hourHand: null,
  minuteHand: null,
  secondHand: null,
  pendulum: null,
};

let clockRoot;
let gltfRoot;
let mysticGroup;
let handStart = {};
let pendulumStartZ = 0;
let damagePlans = {
  glass: [],
  case: [],
  loose: [],
};
let userRotation = {
  x: 0,
  y: 0,
};
let dragState = {
  active: false,
  moved: false,
  rotateClock: false,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
};
let shakeState = {
  elapsed: 0,
  duration: 0,
  intensity: 0,
  seed: 1,
};

const originalTransforms = new Map();
const activeTweens = [];
const damageProgress = {
  glass: 0,
  case: 0,
  loose: 0,
};

initLighting();
createAbandonedRoom();
loadClock().catch((error) => {
  console.error(error);
  document.querySelector("#loading").textContent = "could not load clock";
});
animate();

window.addEventListener("resize", onResize);
window.addEventListener("pointerdown", unlockSounds, { passive: true });
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("pointerleave", endDrag);
document.addEventListener("visibilitychange", onVisibilityChange);
prepareBackgroundSound();

function playSound(name, delay = 0) {
  if (!SOUND_ENABLED || !SOUNDS[name]) return;

  const start = () => {
    const volume = SOUND_VOLUMES[name] ?? 1;
    const copies = Math.max(1, Math.ceil(volume));
    for (let index = 0; index < copies; index += 1) {
      const player = new Audio(SOUNDS[name]);
      player.preload = "auto";
      player.volume = Math.min(volume / copies, 1);
      player.play().catch((error) => {
        console.warn(`Sound konnte nicht abgespielt werden: ${name}`, error);
      });
    }
  };

  if (delay > 0) {
    setTimeout(start, delay * 1000);
    return;
  }
  start();
}

function getAudioContext() {
  if (audioContext) return audioContext;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return null;
  try {
    audioContext = new AudioContextClass();
  } catch {
    audioContext = null;
  }
  return audioContext;
}

function prepareBackgroundSound() {
  if (!SOUND_ENABLED) return;

  backgroundAudio = new Audio(BACKGROUND_SOUND_URL);
  backgroundAudio.autoplay = true;
  backgroundAudio.loop = true;
  backgroundAudio.preload = "auto";
  backgroundAudio.volume = BACKGROUND_VOLUME;
  backgroundAudio.load();
  connectBackgroundSound();
  startBackgroundSound();
}

function startBackgroundSound() {
  if (!SOUND_ENABLED || !backgroundAudio) return;
  connectBackgroundSound();
  if (backgroundGain) backgroundGain.gain.value = BACKGROUND_GAIN;

  backgroundAudio.volume = BACKGROUND_VOLUME;
  if (!backgroundAudio.paused) return;
  backgroundAudio.play().catch(() => {});
}

function unlockSounds() {
  if (!SOUND_ENABLED) return;
  if (soundsUnlocked) {
    startBackgroundSound();
    return;
  }
  soundsUnlocked = true;

  const context = getAudioContext();
  context?.resume()
    .catch((error) => {
      console.warn("Sound konnte nicht vorbereitet werden", error);
    })
    .finally(() => startBackgroundSound());
  if (!context) startBackgroundSound();
}

function connectBackgroundSound() {
  if (!backgroundAudio || backgroundGain) return;
  const context = getAudioContext();
  if (!context) return;

  try {
    backgroundSource = context.createMediaElementSource(backgroundAudio);
    backgroundGain = context.createGain();
    backgroundGain.gain.value = BACKGROUND_GAIN;
    backgroundSource.connect(backgroundGain).connect(context.destination);
  } catch (error) {
    backgroundSource = null;
    backgroundGain = null;
    console.warn("Hintergrundsound konnte nicht verstaerkt werden", error);
  }
}

function onVisibilityChange() {
  if (!document.hidden && soundsUnlocked) {
    startBackgroundSound();
  }
}

function initLighting() {
  scene.add(new THREE.HemisphereLight(0xa8784b, 0x1b0d07, 1.9));

  const key = new THREE.SpotLight(0xffd29a, 26, 12, 0.58, 0.72, 1.08);
  key.position.set(-2.8, 3.2, 3.8);
  scene.add(key);

  const rim = new THREE.DirectionalLight(0xb98557, 2.35);
  rim.position.set(3.5, 1.8, -3);
  scene.add(rim);

  const frontFill = new THREE.PointLight(0xbf7d45, 3.7, 7.5, 1.4);
  frontFill.position.set(1.8, 0.9, 3.2);
  scene.add(frontFill);
}

function createAbandonedRoom() {
  const texture = makeGrimyTexture(768, 768);
  texture.colorSpace = THREE.SRGBColorSpace;

  const wallMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    color: 0x6f432b,
    roughness: 0.95,
    metalness: 0,
    side: THREE.BackSide,
  });

  const room = new THREE.Mesh(new THREE.BoxGeometry(12, 7, 8), wallMaterial);
  room.position.set(0, 0.15, -0.75);
  scene.add(room);
}

function makeGrimyTexture(width, height) {
  const canvasTexture = document.createElement("canvas");
  canvasTexture.width = width;
  canvasTexture.height = height;
  const ctx = canvasTexture.getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#2b160d");
  gradient.addColorStop(0.48, "#5a311d");
  gradient.addColorStop(1, "#1a0d08");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < 9000; i += 1) {
    const alpha = Math.random() * 0.05;
    const shade = Math.random() > 0.5 ? "255, 213, 153" : "0, 0, 0";
    ctx.fillStyle = `rgba(${shade}, ${alpha})`;
    ctx.fillRect(Math.random() * width, Math.random() * height, 1 + Math.random() * 2, 1 + Math.random() * 2);
  }

  for (let i = 0; i < 36; i += 1) {
    ctx.strokeStyle = `rgba(20, 9, 4, ${0.08 + Math.random() * 0.12})`;
    ctx.lineWidth = 1 + Math.random() * 3;
    ctx.beginPath();
    const x = Math.random() * width;
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + 30, height * 0.3, x - 40, height * 0.65, x + 20, height);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvasTexture);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 1);
  return texture;
}

async function loadClock() {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(MODEL_URL);

  clockRoot = new THREE.Group();
  clockRoot.name = "Floating_Memento_Mori_Clock";
  gltfRoot = gltf.scene;

  centerAndScaleModel(gltfRoot, clockRoot);
  scene.add(clockRoot);

  collectParts();
  configureInitialVisibility();
  captureOriginalTransforms();
  prepareDamagePlans();
  createMysticRebuildEffect();

  state.ready = true;
  document.body.classList.add("is-ready");
  await runIntro();
}

function centerAndScaleModel(model, root) {
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);

  model.position.sub(center);
  root.add(model);
  root.scale.setScalar(2.95 / maxDimension);
  root.position.set(0, -0.05, 0);
}

function collectParts() {
  parts.allMeshes.length = 0;
  gltfRoot.traverse((object) => {
    if (!object.isMesh) return;

    object.castShadow = false;
    object.receiveShadow = true;
    parts.allMeshes.push(object);
    parts.clickTargets.push(object);

    const name = object.name;
    if (name.startsWith("Glass_Cracked_") || name === "Clock_Case_Cracked") parts.cracks.push(object);
    if (name.startsWith("Glass_Shard_")) parts.glassShards.push(object);
    if (name.startsWith("Clock_Case_Piece_")) parts.casePieces.push(object);
    if (name.startsWith("Glass_Normal_")) parts.glassNormal.push(object);
    if (name === "Clock_Case_Normal" || name === "Clock_Frame_Normal") parts.caseNormal.push(object);
    if (["Clock_Dial_Normal", "Clock_Dial_Inner_Ring", "Clock_Hand_Hub", "Clock_Dial_Decor_Left", "Clock_Dial_Decor_Right"].includes(name)) {
      parts.looseParts.push(object);
    }

    if (name === "Hour_Hand") parts.hourHand = object;
    if (name === "Minute_Hand") parts.minuteHand = object;
    if (name === "Second_Hand") parts.secondHand = object;
    if (name === "Pendulum") parts.pendulum = object;
  });

  [parts.hourHand, parts.minuteHand, parts.secondHand, parts.pendulum]
    .filter(Boolean)
    .forEach((object) => parts.looseParts.push(object));

  handStart = {
    hour: parts.hourHand?.rotation.z ?? 0,
    minute: parts.minuteHand?.rotation.z ?? 0,
    second: parts.secondHand?.rotation.z ?? 0,
  };
  pendulumStartZ = parts.pendulum?.rotation.z ?? 0;
}

function configureInitialVisibility() {
  parts.cracks.forEach((object) => {
    object.visible = false;
    cloneMaterials(object);
    setMeshOpacity(object, 0);
  });
  parts.glassShards.forEach((object) => (object.visible = false));
  parts.casePieces.forEach((object) => (object.visible = false));
  [...parts.glassNormal, ...parts.caseNormal, ...parts.looseParts].forEach((object) => (object.visible = true));
}

function cloneMaterials(object) {
  if (Array.isArray(object.material)) {
    object.material = object.material.map((material) => material.clone());
  } else if (object.material) {
    object.material = object.material.clone();
  }
}

function setMeshOpacity(object, opacity) {
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  materials.filter(Boolean).forEach((material) => {
    material.transparent = true;
    material.opacity = opacity;
    material.depthWrite = opacity > 0.9;
    material.needsUpdate = true;
  });
}

function captureOriginalTransforms() {
  [...parts.allMeshes, clockRoot].forEach((object) => {
    originalTransforms.set(object.uuid, {
      position: object.position.clone(),
      rotation: object.rotation.clone(),
      scale: object.scale.clone(),
    });
  });
}

function prepareDamagePlans() {
  damagePlans = {
    glass: createExplosionPlans(parts.glassShards, {
      baseDistance: 3.45,
      distanceJitter: 2.45,
      sideBlast: 3.2,
      verticalBlast: 2.7,
      cameraBlast: 2.95,
      curveStrength: 1.55,
      spinStrength: 7.4,
      seed: 11,
    }),
    case: createExplosionPlans(parts.casePieces, {
      baseDistance: 2.75,
      distanceJitter: 1.9,
      sideBlast: 2.35,
      verticalBlast: 2.05,
      cameraBlast: 1.9,
      curveStrength: 1.05,
      spinStrength: 4.35,
      seed: 37,
    }),
    loose: createExplosionPlans(parts.looseParts, {
      baseDistance: 2.2,
      distanceJitter: 1.35,
      sideBlast: 1.8,
      verticalBlast: 1.45,
      cameraBlast: 1.35,
      curveStrength: 0.75,
      spinStrength: 2.65,
      seed: 71,
    }),
  };
}

function createMysticRebuildEffect() {
  mysticGroup = new THREE.Group();
  mysticGroup.name = "Mystic_Rebuild_Effect";
  mysticGroup.visible = false;

  const ringMaterial = new THREE.MeshBasicMaterial({
    color: 0xc99a5a,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(1.22, 0.014, 14, 128), ringMaterial);
  mysticGroup.add(ring);

  const tiltedRing = new THREE.Mesh(new THREE.TorusGeometry(1.42, 0.008, 12, 128), ringMaterial.clone());
  tiltedRing.rotation.x = Math.PI / 2.8;
  tiltedRing.rotation.y = Math.PI / 7;
  mysticGroup.add(tiltedRing);

  const particleGeometry = new THREE.BufferGeometry();
  const positions = [];
  for (let i = 0; i < 260; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 0.5 + Math.random() * 1.45;
    positions.push(Math.cos(angle) * radius, (Math.random() - 0.5) * 2.65, Math.sin(angle) * radius * 0.28);
  }
  particleGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

  const particleMaterial = new THREE.PointsMaterial({
    color: 0xd9b06e,
    size: 0.038,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  mysticGroup.add(new THREE.Points(particleGeometry, particleMaterial));
  clockRoot.add(mysticGroup);
}

async function runIntro() {
  if (DEBUG_SKIP_INTRO) {
    intro.classList.add("is-hidden");
    document.body.classList.add("is-revealed");
    state.introDone = true;
    setTimeout(() => intro.remove(), 400);
    if (DEBUG_AUTO_CYCLE) setTimeout(() => startDecayCycle(), 900);
    return;
  }

  await showIntroReminder();
  await showIntroLine("Memento Mori", "introTitle");

  intro.classList.add("is-hidden");
  document.body.classList.add("is-revealed");
  state.introDone = true;
  setTimeout(() => intro.remove(), 1400);
}

function showIntroLine(text, soundName) {
  playSound(soundName);
  introText.textContent = text;
  introText.classList.remove("is-active", "is-stacked");
  void introText.offsetWidth;
  introText.classList.add("is-active");
  return new Promise((resolve) => setTimeout(resolve, 3900));
}

function showIntroReminder() {
  playSound("introLine");
  introText.innerHTML = `
    <span class="intro__line intro__line--primary">Remember one day you'll die.</span>
    <span class="intro__line intro__line--secondary">Be. Here Now.</span>
  `;
  introText.classList.remove("is-active", "is-stacked");
  void introText.offsetWidth;
  introText.classList.add("is-active", "is-stacked");
  return new Promise((resolve) => setTimeout(resolve, 5000));
}

function onPointerMove(event) {
  if (!state.ready || !state.introDone) {
    canvas.style.cursor = "default";
    return;
  }

  if (dragState.active) {
    const dx = event.clientX - dragState.lastX;
    const dy = event.clientY - dragState.lastY;
    const totalMove = Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY);

    if (totalMove > 4) dragState.moved = true;
    if (dragState.rotateClock && dragState.moved) {
      userRotation.y += dx * 0.008;
      userRotation.x = THREE.MathUtils.clamp(userRotation.x + dy * 0.006, -0.8, 0.8);
    }

    dragState.lastX = event.clientX;
    dragState.lastY = event.clientY;
    canvas.style.cursor = dragState.rotateClock ? "grabbing" : "pointer";
    return;
  }

  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(parts.clickTargets, true).some((entry) => entry.object.visible);
  state.hoverClock = hit;
  canvas.style.cursor = hit ? "grab" : state.damageStage > 0 ? "pointer" : "default";
}

function onPointerDown(event) {
  unlockSounds();
  if (!state.ready || !state.introDone || state.stageAnimating) return;

  updatePointer(event);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(parts.clickTargets, true).some((entry) => entry.object.visible);
  if (!hit && state.damageStage === 0) return;

  dragState = {
    active: true,
    moved: false,
    rotateClock: hit,
    startX: event.clientX,
    startY: event.clientY,
    lastX: event.clientX,
    lastY: event.clientY,
  };
  canvas.setPointerCapture(event.pointerId);
  canvas.style.cursor = hit ? "grabbing" : "pointer";
}

function onPointerUp(event) {
  if (!dragState.active) return;

  const wasClick = !dragState.moved && Math.hypot(event.clientX - dragState.startX, event.clientY - dragState.startY) < 5;
  endDrag(event);
  if (wasClick && state.ready && state.introDone && !state.stageAnimating) advanceDamageStage();
}

function endDrag(event) {
  if (!dragState.active) return;
  dragState.active = false;
  if (event?.pointerId !== undefined && canvas.hasPointerCapture(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }
  canvas.style.cursor = state.hoverClock ? "grab" : state.damageStage > 0 ? "pointer" : "default";
}

function updatePointer(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
}

async function advanceDamageStage() {
  if (state.stageAnimating || state.damageStage >= 5) return;

  state.stageAnimating = true;
  state.damageStage += 1;
  state.cycleRunning = state.damageStage > 0;
  document.body.classList.add("is-cycle-running");
  canvas.style.cursor = "default";

  if (state.damageStage === 1) {
    await revealCracks();
  } else if (state.damageStage === 2) {
    await breakGlassStage();
  } else if (state.damageStage === 3) {
    await breakCaseStage();
  } else if (state.damageStage === 4) {
    await detachClockPartsStage();
  } else if (state.damageStage === 5) {
    await finalCollapseAndRebuild();
  }

  state.stageAnimating = false;
  if (state.damageStage === 0) state.cycleRunning = false;
  document.body.classList.remove("is-cycle-running");
}

async function startDecayCycle() {
  for (let stage = state.damageStage; stage < 5; stage += 1) {
    await advanceDamageStage();
    await wait(0.28);
  }
}

window.mementoMoriClock = {
  advanceDamageStage,
  startDecayCycle,
};

async function revealCracks() {
  playSound("crackOne");
  triggerExistentialShake(0.36, 0.42);
  showCracks();
  await tween(0.42, (progress) => {
    const opacity = easeOutCubic(progress) * 0.82;
    parts.cracks.forEach((object) => setMeshOpacity(object, opacity));
  });
}

async function breakGlassStage() {
  playSound("crackOne");
  triggerExistentialShake(0.9, 0.58);
  parts.glassNormal.forEach((object) => (object.visible = false));
  parts.glassShards.forEach((object) => (object.visible = true));
  await tweenPlanProgress("glass", 0.32, 0.74, easeOutQuart);
}

async function breakCaseStage() {
  playSound("breakOne");
  triggerExistentialShake(1.05, 0.68);
  parts.caseNormal.forEach((object) => (object.visible = false));
  parts.casePieces.forEach((object) => (object.visible = true));
  await Promise.all([
    tweenPlanProgress("glass", 0.58, 0.76, easeOutQuart),
    tweenPlanProgress("case", 0.38, 0.84, easeOutQuart),
  ]);
}

async function detachClockPartsStage() {
  playSound("breakTwo");
  triggerExistentialShake(0.78, 0.56);
  await Promise.all([
    tweenPlanProgress("glass", 0.82, 0.82, easeOutQuart),
    tweenPlanProgress("case", 0.66, 0.92, easeOutQuart),
    tweenPlanProgress("loose", 0.45, 0.88, easeOutQuart),
  ]);
}

async function finalCollapseAndRebuild() {
  playSound("breakThree");
  triggerExistentialShake(1.18, 0.82);
  const allPlans = [...damagePlans.glass, ...damagePlans.case, ...damagePlans.loose];
  await Promise.all([
    tweenPlanProgress("glass", 1, 1.05, easeOutQuart),
    tweenPlanProgress("case", 1, 1.12, easeOutQuart),
    tweenPlanProgress("loose", 1, 1.02, easeOutQuart),
  ]);

  await wait(0.32);
  await vortexBeforeRebuild(allPlans);
  await rebuildClock(allPlans);
  state.damageStage = 0;
  damageProgress.glass = 0;
  damageProgress.case = 0;
  damageProgress.loose = 0;
}

function showCracks() {
  parts.cracks.forEach((object) => {
    object.visible = true;
    setMeshOpacity(object, 0);
  });
}

function tweenPlanProgress(groupName, targetProgress, duration, easing) {
  const plans = damagePlans[groupName];
  const fromProgress = damageProgress[groupName];
  const tweenStarts = plans.map((plan) => {
    resetAirMotionRecord(plan);
    return {
      plan,
      position: plan.object.position.clone(),
      rotation: plan.object.rotation.clone(),
    };
  });

  return tween(duration, (progress) => {
    const eased = easing(progress);
    const nextProgress = THREE.MathUtils.lerp(fromProgress, targetProgress, eased);
    damageProgress[groupName] = nextProgress;
    tweenStarts.forEach((start) => {
      const motion = getPlanMotionAtProgress(start.plan, nextProgress);
      start.plan.object.position.lerpVectors(start.position, motion.position, eased);
      applyTweenedRotation(start.plan, start.rotation, motion.rotation, eased);
      resetAirMotionRecord(start.plan);
    });
  });
}

function getPlanMotionAtProgress(plan, progress) {
  const arcProgress = THREE.MathUtils.clamp(progress, 0, 1);
  const flightArc = Math.sin(arcProgress * Math.PI);
  const wobble = Math.sin(arcProgress * Math.PI * 4.2 + plan.spinPhase) * plan.spinWobble * flightArc;
  const position = new THREE.Vector3().lerpVectors(plan.originalPosition, plan.toPosition, progress);
  position.addScaledVector(plan.curveOffset, flightArc);

  const rotation = new THREE.Euler();
  if (isClockHand(plan.object)) {
    rotation.x = THREE.MathUtils.lerp(plan.originalRotation.x, plan.toRotation.x, progress * 0.45) + wobble * 0.18;
    rotation.y = THREE.MathUtils.lerp(plan.originalRotation.y, plan.toRotation.y, progress * 0.45) - wobble * 0.18;
    rotation.z = plan.object.rotation.z;
    return { position, rotation };
  }

  if (plan.object === parts.pendulum) {
    rotation.x = THREE.MathUtils.lerp(plan.originalRotation.x, plan.toRotation.x, progress * 0.35) + wobble * 0.15;
    rotation.y = THREE.MathUtils.lerp(plan.originalRotation.y, plan.toRotation.y, progress * 0.35) - wobble * 0.15;
    rotation.z = plan.object.rotation.z;
    return { position, rotation };
  }

  rotation.x = THREE.MathUtils.lerp(plan.originalRotation.x, plan.toRotation.x, progress) + wobble * 0.42;
  rotation.y = THREE.MathUtils.lerp(plan.originalRotation.y, plan.toRotation.y, progress) - wobble * 0.35;
  rotation.z = THREE.MathUtils.lerp(plan.originalRotation.z, plan.toRotation.z, progress) + wobble * 0.28;
  return { position, rotation };
}

function applyTweenedRotation(plan, startRotation, targetRotation, progress) {
  if (isClockHand(plan.object) || plan.object === parts.pendulum) {
    plan.object.rotation.x = THREE.MathUtils.lerp(startRotation.x, targetRotation.x, progress);
    plan.object.rotation.y = THREE.MathUtils.lerp(startRotation.y, targetRotation.y, progress);
    return;
  }

  plan.object.rotation.x = THREE.MathUtils.lerp(startRotation.x, targetRotation.x, progress);
  plan.object.rotation.y = THREE.MathUtils.lerp(startRotation.y, targetRotation.y, progress);
  plan.object.rotation.z = THREE.MathUtils.lerp(startRotation.z, targetRotation.z, progress);
}

function createExplosionPlans(objects, options = {}) {
  const {
    baseDistance = 2,
    distanceJitter = 1,
    sideBlast = 1,
    verticalBlast = 1,
    cameraBlast = 1,
    curveStrength = 0.5,
    spinStrength = 3,
    seed = 1,
  } = options;

  const modelCenter = new THREE.Box3().setFromObject(clockRoot).getCenter(new THREE.Vector3());
  const cameraDirection = camera.position.clone().sub(modelCenter).normalize();

  return objects.map((object, index) => {
    const original = originalTransforms.get(object.uuid);
    const worldPosition = object.getWorldPosition(new THREE.Vector3());
    const direction = worldPosition.clone().sub(modelCenter);
    if (direction.length() < 0.001) {
      direction.set(Math.cos(index * 2.17), Math.sin(index * 1.31) * 0.4, Math.sin(index * 2.17));
    }
    direction.normalize();

    const chaoticDirection = direction.clone().add(
      new THREE.Vector3(
        (pseudoNoise(index + 5, seed) - 0.5) * 1.15,
        (pseudoNoise(index + 9, seed) - 0.5) * 0.95,
        (pseudoNoise(index + 14, seed) - 0.5) * 1.05,
      ),
    ).normalize();

    const sideSign = pseudoNoise(index + 21, seed) > 0.5 ? 1 : -1;
    const verticalSign = pseudoNoise(index + 25, seed) > 0.42 ? 1 : -1;
    const cameraSign = pseudoNoise(index + 33, seed) > 0.24 ? 1 : -0.55;
    const blastDistance = baseDistance + pseudoNoise(index + 39, seed) * distanceJitter;
    const screenKick = new THREE.Vector3(
      sideSign * sideBlast * (0.45 + pseudoNoise(index + 47, seed) * 0.95),
      verticalSign * verticalBlast * (0.35 + pseudoNoise(index + 53, seed) * 1.1),
      0,
    );
    const cameraKick = cameraDirection.clone().multiplyScalar(
      cameraSign * cameraBlast * (0.35 + pseudoNoise(index + 61, seed) * 0.9),
    );

    const targetWorld = worldPosition.clone()
      .add(chaoticDirection.multiplyScalar(blastDistance))
      .add(screenKick)
      .add(cameraKick);
    const targetLocal = object.parent.worldToLocal(targetWorld.clone());
    const curveWorld = new THREE.Vector3(
      (pseudoNoise(index + 73, seed) - 0.5) * curveStrength * 2.2,
      (pseudoNoise(index + 79, seed) - 0.5) * curveStrength * 1.7,
      (pseudoNoise(index + 83, seed) - 0.5) * curveStrength * 1.35,
    );
    const curveOffset = worldVectorToParentLocal(object, worldPosition, curveWorld);
    const spin = new THREE.Euler(
      original.rotation.x + (pseudoNoise(index + 7, seed) - 0.5) * spinStrength,
      original.rotation.y + (pseudoNoise(index + 13, seed) - 0.5) * spinStrength * 1.2,
      original.rotation.z + (pseudoNoise(index + 29, seed) - 0.5) * spinStrength,
    );
    const floatVector = worldVectorToParentLocal(
      object,
      worldPosition,
      new THREE.Vector3(
        (pseudoNoise(index + 103, seed) - 0.5) * 0.22,
        (pseudoNoise(index + 109, seed) - 0.5) * 0.18,
        (pseudoNoise(index + 113, seed) - 0.5) * 0.2,
      ),
    );
    const floatCross = worldVectorToParentLocal(
      object,
      worldPosition,
      new THREE.Vector3(
        (pseudoNoise(index + 127, seed) - 0.5) * 0.14,
        (pseudoNoise(index + 131, seed) - 0.5) * 0.22,
        (pseudoNoise(index + 137, seed) - 0.5) * 0.12,
      ),
    );

    return {
      object,
      toPosition: targetLocal,
      toRotation: spin,
      originalPosition: original.position.clone(),
      originalRotation: original.rotation.clone(),
      curveOffset,
      spinPhase: pseudoNoise(index + 91, seed) * Math.PI * 2,
      spinWobble: 0.18 + pseudoNoise(index + 97, seed) * 0.32,
      floatVector,
      floatCross,
      floatPhase: pseudoNoise(index + 139, seed) * Math.PI * 2,
      floatSpeed: 0.65 + pseudoNoise(index + 149, seed) * 1.25,
      airSpin: new THREE.Vector3(
        (pseudoNoise(index + 151, seed) - 0.5) * 0.42,
        (pseudoNoise(index + 157, seed) - 0.5) * 0.5,
        (pseudoNoise(index + 163, seed) - 0.5) * 0.46,
      ),
      airSpinSpeed: 0.34 + pseudoNoise(index + 167, seed) * 0.78,
      lastFloatOffset: new THREE.Vector3(),
      lastFloatRotation: new THREE.Vector3(),
    };
  });
}

function worldVectorToParentLocal(object, worldOrigin, worldVector) {
  const localOrigin = object.parent.worldToLocal(worldOrigin.clone());
  const localTarget = object.parent.worldToLocal(worldOrigin.clone().add(worldVector));
  return localTarget.sub(localOrigin);
}

async function vortexBeforeRebuild(plans) {
  state.rebuilding = true;
  mysticGroup.visible = true;
  plans.forEach(resetAirMotionRecord);

  const vortexCenterWorld = clockRoot.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.1, 0));
  const starts = plans.map((plan, index) => {
    const worldPosition = plan.object.parent.localToWorld(plan.object.position.clone());
    const offset = worldPosition.clone().sub(vortexCenterWorld);
    const radius = Math.max(Math.hypot(offset.x, offset.y), 0.22);
    return {
      plan,
      rotation: plan.object.rotation.clone(),
      offset,
      radius,
      angle: Math.atan2(offset.y, offset.x),
      phase: pseudoNoise(index + 211, 17) * Math.PI * 2,
      direction: pseudoNoise(index + 223, 17) > 0.5 ? 1 : -1,
      inwardPull: 0.16 + pseudoNoise(index + 229, 17) * 0.2,
      spinTurns: Math.PI * (3.4 + pseudoNoise(index + 239, 17) * 2.4),
    };
  });

  await tween(1.85, (progress) => {
    const eased = easeInOutCubic(progress);
    const glow = Math.sin(progress * Math.PI);
    setMysticOpacity(0.16 + glow * 0.92);

    state.vortexSpin = Math.sin(progress * Math.PI) * 0.2;
    state.vortexYaw = Math.sin(progress * Math.PI * 2) * 0.12;
    state.vortexLift = Math.sin(progress * Math.PI) * 0.09;

    starts.forEach((start) => {
      const spin = start.spinTurns * eased * start.direction;
      const radiusPulse = 1 + glow * 0.2 - eased * start.inwardPull;
      const angle = start.angle + spin;
      const targetWorld = new THREE.Vector3(
        vortexCenterWorld.x + Math.cos(angle) * start.radius * radiusPulse,
        vortexCenterWorld.y + Math.sin(angle) * start.radius * radiusPulse + glow * 0.24,
        vortexCenterWorld.z + start.offset.z * (1 - eased * 0.1) + Math.sin(angle * 1.4 + start.phase) * glow * 0.42,
      );

      start.plan.object.position.copy(start.plan.object.parent.worldToLocal(targetWorld));
      start.plan.object.rotation.x = start.rotation.x + spin * 0.18 + Math.sin(start.phase + progress * Math.PI * 4) * glow * 0.22;
      start.plan.object.rotation.y = start.rotation.y - spin * 0.12 + Math.cos(start.phase + progress * Math.PI * 3) * glow * 0.2;
      if (!isClockHand(start.plan.object) && start.plan.object !== parts.pendulum) {
        start.plan.object.rotation.z = start.rotation.z + spin * 0.24;
      }
    });
  });

  state.vortexSpin = 0;
  state.vortexYaw = 0;
  state.vortexLift = 0;
  plans.forEach(resetAirMotionRecord);
}

async function rebuildClock(plans) {
  state.rebuilding = true;
  mysticGroup.visible = true;
  const rebuildStarts = plans.map((plan) => {
    resetAirMotionRecord(plan);
    return {
      plan,
      position: plan.object.position.clone(),
      rotation: plan.object.rotation.clone(),
    };
  });

  await tween(2.45, (progress) => {
    const eased = easeInOutCubic(progress);
    const glow = Math.sin(progress * Math.PI);
    setMysticOpacity(glow * 0.78);

    rebuildStarts.forEach((start) => {
      start.plan.object.position.lerpVectors(start.position, start.plan.originalPosition, eased);
      start.plan.object.rotation.x = THREE.MathUtils.lerp(start.rotation.x, start.plan.originalRotation.x, eased);
      start.plan.object.rotation.y = THREE.MathUtils.lerp(start.rotation.y, start.plan.originalRotation.y, eased);
      if (!isClockHand(start.plan.object) && start.plan.object !== parts.pendulum) {
        start.plan.object.rotation.z = THREE.MathUtils.lerp(start.rotation.z, start.plan.originalRotation.z, eased);
      }
    });

    parts.cracks.forEach((object) => setMeshOpacity(object, (1 - eased) * 0.82));
  });

  resetSceneToWholeClock();
  await tween(0.55, (progress) => setMysticOpacity((1 - progress) * 0.45));
  mysticGroup.visible = false;
  state.rebuilding = false;
}

function resetSceneToWholeClock() {
  state.vortexSpin = 0;
  state.vortexYaw = 0;
  state.vortexLift = 0;
  parts.cracks.forEach((object) => {
    object.visible = false;
    setMeshOpacity(object, 0);
  });
  parts.glassShards.forEach((object) => (object.visible = false));
  parts.casePieces.forEach((object) => (object.visible = false));
  parts.glassNormal.forEach((object) => (object.visible = true));
  parts.caseNormal.forEach((object) => (object.visible = true));
  parts.looseParts.forEach((object) => {
    const original = originalTransforms.get(object.uuid);
    object.visible = true;
    object.position.copy(original.position);
    object.rotation.x = original.rotation.x;
    object.rotation.y = original.rotation.y;
    if (!isClockHand(object) && object !== parts.pendulum) {
      object.rotation.z = original.rotation.z;
    }
  });
  [...damagePlans.glass, ...damagePlans.case, ...damagePlans.loose].forEach(resetAirMotionRecord);
}

function setMysticOpacity(opacity) {
  mysticGroup.children.forEach((child) => {
    child.material.opacity = THREE.MathUtils.clamp(opacity, 0, 1);
    child.material.needsUpdate = true;
  });
}

function triggerExistentialShake(intensity, duration) {
  shakeState.elapsed = 0;
  shakeState.duration = Math.max(duration, shakeState.duration * 0.35);
  shakeState.intensity = Math.max(intensity, shakeState.intensity * 0.55);
  shakeState.seed = pseudoNoise(Math.round(state.elapsed * 1000), 911) * 100;
}

function updateCameraShake(delta) {
  camera.position.copy(cameraHomePosition);
  camera.rotation.copy(cameraHomeRotation);

  if (shakeState.intensity <= 0.001 || shakeState.duration <= 0) return;

  shakeState.elapsed += delta;
  const progress = THREE.MathUtils.clamp(shakeState.elapsed / shakeState.duration, 0, 1);
  const heartbeat = Math.sin(progress * Math.PI * 2.4);
  const envelope = Math.pow(1 - progress, 2.15) * (0.72 + Math.abs(heartbeat) * 0.28);
  const amp = shakeState.intensity * envelope;
  const time = state.elapsed * 46 + shakeState.seed;

  camera.position.x += Math.sin(time * 1.9) * 0.045 * amp;
  camera.position.y += Math.sin(time * 2.5 + 1.1) * 0.034 * amp;
  camera.position.z += Math.sin(time * 1.3 + 0.8) * 0.035 * amp;
  camera.rotation.x += Math.sin(time * 2.2 + 0.3) * 0.012 * amp;
  camera.rotation.y += Math.sin(time * 1.7 + 1.8) * 0.01 * amp;
  camera.rotation.z += Math.sin(time * 2.8 + 2.4) * 0.02 * amp;

  if (progress >= 1) {
    shakeState.elapsed = 0;
    shakeState.duration = 0;
    shakeState.intensity = 0;
  }
}

function updateAirborneFragments() {
  if (state.rebuilding) return;

  [
    [damagePlans.glass, damageProgress.glass],
    [damagePlans.case, damageProgress.case],
    [damagePlans.loose, damageProgress.loose],
  ].forEach(([plans, progress]) => {
    const strength = easeOutCubic(THREE.MathUtils.clamp(progress, 0, 1));
    plans.forEach((plan) => updateAirMotion(plan, strength));
  });
}

function updateAirMotion(plan, strength) {
  if (strength <= 0.001 || !plan.object.visible) {
    resetAirMotionRecord(plan);
    return;
  }

  const time = state.elapsed * plan.floatSpeed + plan.floatPhase;
  const desiredOffset = plan.floatVector.clone()
    .multiplyScalar(Math.sin(time) * strength)
    .addScaledVector(plan.floatCross, Math.sin(time * 0.63 + 1.7) * strength);

  plan.object.position.sub(plan.lastFloatOffset).add(desiredOffset);
  plan.lastFloatOffset.copy(desiredOffset);

  const spinTime = state.elapsed * plan.airSpinSpeed + plan.floatPhase;
  const spinPulse = 0.62 + Math.sin(spinTime * 0.74) * 0.38;
  const desiredRotation = plan.airSpin.clone().multiplyScalar(strength * spinPulse);
  const rotationDelta = desiredRotation.clone().sub(plan.lastFloatRotation);
  plan.object.rotation.x += rotationDelta.x;
  plan.object.rotation.y += rotationDelta.y;
  if (!isClockHand(plan.object) && plan.object !== parts.pendulum) {
    plan.object.rotation.z += rotationDelta.z;
  }
  plan.lastFloatRotation.copy(desiredRotation);
}

function resetAirMotionRecord(plan) {
  plan.lastFloatOffset?.set(0, 0, 0);
  plan.lastFloatRotation?.set(0, 0, 0);
}

function isClockHand(object) {
  return object === parts.hourHand || object === parts.minuteHand || object === parts.secondHand;
}

function pseudoNoise(index, seed) {
  const value = Math.sin(index * 12.9898 + seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function tween(duration, update, easing = linear) {
  return new Promise((resolve) => {
    activeTweens.push({
      elapsed: 0,
      duration,
      update,
      easing,
      resolve,
    });
  });
}

function wait(duration) {
  return tween(duration, () => {});
}

function updateTweens(delta) {
  for (let index = activeTweens.length - 1; index >= 0; index -= 1) {
    const tweenItem = activeTweens[index];
    tweenItem.elapsed += delta;
    const raw = Math.min(tweenItem.elapsed / tweenItem.duration, 1);
    tweenItem.update(tweenItem.easing(raw), raw);
    if (raw >= 1) {
      activeTweens.splice(index, 1);
      tweenItem.resolve();
    }
  }
}

function animate() {
  requestAnimationFrame(animate);

  const delta = Math.min(frameClock.getDelta(), 0.04);
  state.elapsed += delta;
  updateTweens(delta);
  updateClockLife(delta);
  updateCameraShake(delta);

  renderer.render(scene, camera);
}

function updateClockLife(delta) {
  if (!clockRoot) return;

  const bounce = Math.sin(state.elapsed * 1.25) * 0.055;
  const drift = Math.sin(state.elapsed * 0.62) * 0.018;
  clockRoot.position.y = -0.05 + bounce + state.vortexLift;
  clockRoot.rotation.x = userRotation.x + Math.sin(state.elapsed * 0.48) * 0.012;
  clockRoot.rotation.y = userRotation.y + state.vortexYaw;
  clockRoot.rotation.z = drift + state.vortexSpin;

  if (parts.hourHand) parts.hourHand.rotation.z = handStart.hour - state.elapsed * 0.045;
  if (parts.minuteHand) parts.minuteHand.rotation.z = handStart.minute - state.elapsed * 0.26;
  if (parts.secondHand) parts.secondHand.rotation.z = handStart.second - state.elapsed * 2.25;
  if (parts.pendulum) parts.pendulum.rotation.z = pendulumStartZ + Math.sin(state.elapsed * 1.55) * 0.22;

  updateAirborneFragments();

  if (mysticGroup?.visible) {
    mysticGroup.rotation.y += 0.22 * delta;
    mysticGroup.rotation.z -= 0.13 * delta;
  }
}

function onResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

function linear(value) {
  return value;
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function easeOutQuart(value) {
  return 1 - Math.pow(1 - value, 4);
}

function easeInOutCubic(value) {
  return value < 0.5 ? 4 * value * value * value : 1 - Math.pow(-2 * value + 2, 3) / 2;
}
