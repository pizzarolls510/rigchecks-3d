import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

const elements = {
  canvas: document.querySelector("#viewport"),
  stage: document.querySelector("#dropZone"),
  fileInput: document.querySelector("#fileInput"),
  modelLabel: document.querySelector("#modelLabel"),
  sourceLabel: document.querySelector("#sourceLabel"),
  clipSelect: document.querySelector("#clipSelect"),
  playButton: document.querySelector("#playButton"),
  previousFrame: document.querySelector("#previousFrame"),
  nextFrame: document.querySelector("#nextFrame"),
  timeline: document.querySelector("#timeline"),
  timecode: document.querySelector("#timecode"),
  speedRange: document.querySelector("#speedRange"),
  speedValue: document.querySelector("#speedValue"),
  loopToggle: document.querySelector("#loopToggle"),
  skeletonToggle: document.querySelector("#skeletonToggle"),
  gridToggle: document.querySelector("#gridToggle"),
  rotateToggle: document.querySelector("#rotateToggle"),
  rememberToggle: document.querySelector("#rememberToggle"),
  forgetButton: document.querySelector("#forgetButton"),
  fitButton: document.querySelector("#fitButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  screenshotButton: document.querySelector("#screenshotButton"),
  installButton: document.querySelector("#installButton"),
  dropPrompt: document.querySelector("#dropPrompt"),
  toast: document.querySelector("#toast"),
  trianglesStat: document.querySelector("#trianglesStat"),
  meshesStat: document.querySelector("#meshesStat"),
  bonesStat: document.querySelector("#bonesStat"),
  clipsStat: document.querySelector("#clipsStat"),
  sizeStat: document.querySelector("#sizeStat"),
  fpsStat: document.querySelector("#fpsStat")
};

const renderer = new THREE.WebGLRenderer({ canvas: elements.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.01, 1000);
camera.position.set(4.2, 2.8, 5.1);

const controls = new OrbitControls(camera, elements.canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.target.set(0, 1, 0);
controls.minDistance = 0.1;
controls.maxDistance = 500;

scene.add(new THREE.HemisphereLight(0xc6ecff, 0x17212a, 1.65));
const keyLight = new THREE.DirectionalLight(0xffffff, 3.1);
keyLight.position.set(4, 7, 5);
keyLight.castShadow = true;
scene.add(keyLight);
const rimLight = new THREE.DirectionalLight(0x2eafff, 2.2);
rimLight.position.set(-4, 3, -5);
scene.add(rimLight);

const grid = new THREE.GridHelper(20, 40, 0x2b85b5, 0x173044);
grid.material.opacity = 0.36;
grid.material.transparent = true;
scene.add(grid);

const floorGlow = new THREE.Mesh(
  new THREE.CircleGeometry(2.2, 64),
  new THREE.MeshBasicMaterial({ color: 0x0a5e86, transparent: true, opacity: 0.08, depthWrite: false })
);
floorGlow.rotation.x = -Math.PI / 2;
floorGlow.position.y = 0.002;
scene.add(floorGlow);

const state = {
  root: null,
  mixer: null,
  clips: [],
  action: null,
  clipIndex: 0,
  playing: true,
  duration: 0,
  bounds: new THREE.Box3(),
  sphere: new THREE.Sphere(),
  skeleton: null,
  fpsFrames: 0,
  fpsLast: performance.now(),
  fps: 0,
  deferredInstall: null,
  toastTimer: null,
  clock: new THREE.Clock()
};

function createDemo() {
  const root = new THREE.Group();
  root.name = "DemoRoot";
  const metal = new THREE.MeshStandardMaterial({ color: 0x394c5d, metalness: 0.62, roughness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x111a22, metalness: 0.7, roughness: 0.28 });
  const glow = new THREE.MeshStandardMaterial({ color: 0x36baff, emissive: 0x1276aa, emissiveIntensity: 2.1, metalness: 0.3, roughness: 0.25 });

  const pelvis = part("Pelvis", [0.62, 0.35, 0.34], metal, [0, 1.15, 0]);
  const torso = part("Torso", [0.82, 0.86, 0.42], metal, [0, 1.73, 0]);
  const chest = part("ChestLight", [0.34, 0.12, 0.44], glow, [0, 1.82, 0.22]);
  const head = part("Head", [0.46, 0.42, 0.44], dark, [0, 2.47, 0]);
  const visor = part("Visor", [0.36, 0.12, 0.08], glow, [0, 2.5, 0.25]);
  root.add(pelvis, torso, chest, head, visor);

  const leftArm = limb("LeftArm", [-0.58, 2.03, 0], metal, 0.72, 0.16);
  const rightArm = limb("RightArm", [0.58, 2.03, 0], metal, 0.72, 0.16);
  const leftLeg = limb("LeftLeg", [-0.24, 1.02, 0], dark, 0.92, 0.2);
  const rightLeg = limb("RightLeg", [0.24, 1.02, 0], dark, 0.92, 0.2);
  root.add(leftArm, rightArm, leftLeg, rightLeg);

  const baseRing = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.025, 8, 48), glow);
  baseRing.rotation.x = Math.PI / 2;
  baseRing.position.y = 0.035;
  root.add(baseRing);

  root.traverse((object) => {
    if (object.isMesh) {
      object.castShadow = true;
      object.receiveShadow = true;
    }
  });

  const idleTimes = [0, 0.75, 1.5];
  const idle = new THREE.AnimationClip("Idle Scan", 1.5, [
    new THREE.NumberKeyframeTrack("Torso.position[y]", idleTimes, [1.73, 1.77, 1.73]),
    new THREE.NumberKeyframeTrack("Head.rotation[y]", idleTimes, [-0.18, 0.18, -0.18]),
    new THREE.NumberKeyframeTrack("LeftArm.rotation[z]", idleTimes, [-0.08, -0.13, -0.08]),
    new THREE.NumberKeyframeTrack("RightArm.rotation[z]", idleTimes, [0.08, 0.13, 0.08])
  ]);

  const runTimes = [0, 0.25, 0.5, 0.75, 1];
  const run = new THREE.AnimationClip("Run Cycle", 1, [
    new THREE.NumberKeyframeTrack("LeftLeg.rotation[x]", runTimes, [-0.75, 0, 0.75, 0, -0.75]),
    new THREE.NumberKeyframeTrack("RightLeg.rotation[x]", runTimes, [0.75, 0, -0.75, 0, 0.75]),
    new THREE.NumberKeyframeTrack("LeftArm.rotation[x]", runTimes, [0.62, 0, -0.62, 0, 0.62]),
    new THREE.NumberKeyframeTrack("RightArm.rotation[x]", runTimes, [-0.62, 0, 0.62, 0, -0.62]),
    new THREE.NumberKeyframeTrack("Pelvis.position[y]", runTimes, [1.15, 1.22, 1.15, 1.22, 1.15])
  ]);

  setAsset(root, [idle, run], { name: "Motion rig", source: "BUILT-IN SAMPLE", size: "Sample" });
}

function part(name, scale, material, position) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...scale), material);
  mesh.name = name;
  mesh.position.set(...position);
  return mesh;
}

function limb(name, position, material, length, width) {
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.set(...position);
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(width, length, 5, 10), material);
  mesh.position.y = -length * 0.46;
  pivot.add(mesh);
  return pivot;
}

function setAsset(root, clips, metadata) {
  disposeCurrentAsset();
  state.root = root;
  state.clips = clips || [];
  scene.add(root);
  state.mixer = state.clips.length ? new THREE.AnimationMixer(root) : null;
  state.skeleton = new THREE.SkeletonHelper(root);
  state.skeleton.visible = elements.skeletonToggle.checked;
  state.skeleton.material.linewidth = 2;
  scene.add(state.skeleton);

  elements.modelLabel.textContent = metadata.name;
  elements.sourceLabel.textContent = metadata.source;
  populateClips();
  updateStats(root, state.clips, metadata.size);
  fitModel();
  if (state.clips.length) selectClip(0);
  else updateTimeDisplay(0, 0);
}

function disposeCurrentAsset() {
  if (state.action) state.action.stop();
  if (state.mixer && state.root) state.mixer.uncacheRoot(state.root);
  if (state.skeleton) {
    scene.remove(state.skeleton);
    state.skeleton.dispose?.();
  }
  if (state.root) {
    scene.remove(state.root);
    state.root.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry?.dispose?.();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        if (!material) continue;
        for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
        material.dispose?.();
      }
    });
  }
  state.root = null;
  state.mixer = null;
  state.action = null;
  state.clips = [];
}

function populateClips() {
  elements.clipSelect.replaceChildren();
  if (!state.clips.length) {
    const option = new Option("No animation clips", "");
    elements.clipSelect.add(option);
    elements.clipSelect.disabled = true;
    elements.playButton.disabled = true;
    elements.timeline.disabled = true;
    return;
  }
  state.clips.forEach((clip, index) => elements.clipSelect.add(new Option(clip.name || `Clip ${index + 1}`, String(index))));
  elements.clipSelect.disabled = false;
  elements.playButton.disabled = false;
  elements.timeline.disabled = false;
}

function selectClip(index) {
  if (!state.mixer || !state.clips[index]) return;
  state.action?.stop();
  state.clipIndex = index;
  const clip = state.clips[index];
  state.duration = Math.max(clip.duration, 0.001);
  state.action = state.mixer.clipAction(clip);
  applyLoopSetting();
  state.action.reset().play();
  state.action.paused = !state.playing;
  elements.clipSelect.value = String(index);
  elements.timeline.value = "0";
  updateTimeDisplay(0, state.duration);
  syncPlayButton();
}

function applyLoopSetting() {
  if (!state.action) return;
  if (elements.loopToggle.checked) {
    state.action.setLoop(THREE.LoopRepeat, Infinity);
    state.action.clampWhenFinished = false;
  } else {
    state.action.setLoop(THREE.LoopOnce, 1);
    state.action.clampWhenFinished = true;
  }
}

function togglePlayback(force) {
  if (!state.action) return;
  state.playing = typeof force === "boolean" ? force : !state.playing;
  state.action.paused = !state.playing;
  syncPlayButton();
}

function syncPlayButton() {
  elements.playButton.textContent = state.playing ? "Pause" : "Play";
  elements.playButton.setAttribute("aria-label", state.playing ? "Pause animation" : "Play animation");
}

function seekTo(seconds) {
  if (!state.action) return;
  const end = state.duration;
  const next = elements.loopToggle.checked ? ((seconds % end) + end) % end : THREE.MathUtils.clamp(seconds, 0, end);
  state.action.time = next;
  state.mixer.update(0);
  elements.timeline.value = String(Math.round((next / end) * 1000));
  updateTimeDisplay(next, end);
}

function stepFrame(direction) {
  if (!state.action) return;
  togglePlayback(false);
  seekTo(state.action.time + direction / 30);
}

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${mins}:${secs}`;
}

function updateTimeDisplay(current, duration) {
  elements.timecode.textContent = `${formatTime(current)} / ${formatTime(duration)}`;
}

async function handleFiles(fileList, restored = false) {
  const files = [...fileList];
  const primary = files.find((file) => /\.(glb|gltf)$/i.test(file.name));
  if (!primary) {
    showToast("Choose a GLB or glTF file.", true);
    return;
  }

  elements.sourceLabel.textContent = restored ? "RESTORING MODEL" : "LOADING MODEL";
  elements.modelLabel.textContent = primary.name;

  const objectUrls = new Map();
  for (const file of files) {
    objectUrls.set(file.name, URL.createObjectURL(file));
    if (file.webkitRelativePath) objectUrls.set(file.webkitRelativePath, objectUrls.get(file.name));
  }

  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    const clean = decodeURIComponent(url).split(/[?#]/)[0];
    const base = clean.split("/").pop();
    return objectUrls.get(clean) || objectUrls.get(base) || url;
  });

  const loader = new GLTFLoader(manager);
  const dracoLoader = new DRACOLoader(manager);
  dracoLoader.setDecoderPath(new URL("./vendor/three/addons/libs/draco/gltf/", window.location.href).href);
  loader.setDRACOLoader(dracoLoader);
  loader.setMeshoptDecoder(MeshoptDecoder);
  const primaryUrl = objectUrls.get(primary.name);
  try {
    const gltf = await loader.loadAsync(primaryUrl);
    setAsset(gltf.scene, gltf.animations, {
      name: primary.name,
      source: restored ? "SAVED ON THIS DEVICE" : "LOCAL FILE",
      size: formatBytes(primary.size)
    });
    showToast(`${gltf.animations.length} animation clip${gltf.animations.length === 1 ? "" : "s"} loaded.`);
    if (!restored && elements.rememberToggle.checked && /\.glb$/i.test(primary.name)) await saveLatestModel(primary);
    else if (!restored && elements.rememberToggle.checked && !/\.glb$/i.test(primary.name)) showToast("Use GLB if you want this device to remember the model.");
  } catch (error) {
    console.error(error);
    showToast("That model could not be opened. Try exporting one self-contained GLB.", true);
    elements.sourceLabel.textContent = "LOAD FAILED";
  } finally {
    dracoLoader.dispose();
    for (const url of new Set(objectUrls.values())) URL.revokeObjectURL(url);
    elements.fileInput.value = "";
  }
}

function updateStats(root, clips, size) {
  let triangles = 0;
  let meshes = 0;
  const bones = new Set();
  root.traverse((object) => {
    if (object.isMesh) {
      meshes += 1;
      const geometry = object.geometry;
      if (geometry?.index) triangles += geometry.index.count / 3;
      else if (geometry?.attributes?.position) triangles += geometry.attributes.position.count / 3;
    }
    if (object.isBone) bones.add(object.uuid);
  });
  elements.trianglesStat.textContent = Math.round(triangles).toLocaleString();
  elements.meshesStat.textContent = meshes.toLocaleString();
  elements.bonesStat.textContent = bones.size.toLocaleString();
  elements.clipsStat.textContent = clips.length.toLocaleString();
  elements.sizeStat.textContent = size;
}

function fitModel(view = "iso") {
  if (!state.root) return;
  state.bounds.setFromObject(state.root);
  if (state.bounds.isEmpty()) return;
  state.bounds.getBoundingSphere(state.sphere);
  const center = state.sphere.center;
  const radius = Math.max(state.sphere.radius, 0.25);
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.76;
  const vectors = {
    front: new THREE.Vector3(0, 0.12, 1),
    side: new THREE.Vector3(1, 0.12, 0),
    top: new THREE.Vector3(0.01, 1, 0.01),
    iso: new THREE.Vector3(0.72, 0.58, 0.82)
  };
  const direction = (vectors[view] || vectors.iso).normalize();
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = Math.max(distance * 50, 100);
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
  grid.position.y = state.bounds.min.y;
  floorGlow.position.y = state.bounds.min.y + 0.002;
  floorGlow.scale.setScalar(radius / 1.2);
}

function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", error);
  elements.toast.classList.add("visible");
  state.toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

async function captureFrame() {
  renderer.render(scene, camera);
  const blob = await new Promise((resolve) => elements.canvas.toBlob(resolve, "image/png"));
  if (!blob) return showToast("Could not capture this frame.", true);
  const file = new File([blob], `rigcheck-${Date.now()}.png`, { type: "image/png" });
  try {
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: "RigCheck frame" });
      return;
    }
  } catch (error) {
    if (error?.name === "AbortError") return;
  }
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("Frame saved.");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("rigcheck-local", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("models");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveLatestModel(file) {
  if (file.size > 75 * 1024 * 1024) {
    showToast("Model loaded, but it is too large to remember safely.");
    return;
  }
  try {
    const db = await openDatabase();
    const tx = db.transaction("models", "readwrite");
    tx.objectStore("models").put({ blob: file, name: file.name, modified: file.lastModified }, "latest");
    await transactionDone(tx);
    db.close();
  } catch (error) {
    console.warn(error);
    showToast("Model loaded, but this browser could not remember it.");
  }
}

async function restoreLatestModel() {
  try {
    const db = await openDatabase();
    const tx = db.transaction("models", "readonly");
    const saved = await requestDone(tx.objectStore("models").get("latest"));
    db.close();
    if (saved?.blob) {
      const file = new File([saved.blob], saved.name, { type: saved.blob.type || "model/gltf-binary", lastModified: saved.modified });
      await handleFiles([file], true);
    }
  } catch (error) {
    console.warn(error);
  }
}

async function forgetLatestModel() {
  try {
    const db = await openDatabase();
    const tx = db.transaction("models", "readwrite");
    tx.objectStore("models").delete("latest");
    await transactionDone(tx);
    db.close();
    showToast("Saved model removed from this device.");
  } catch {
    showToast("There was no saved model to remove.");
  }
}

function requestDone(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function resize() {
  const width = elements.stage.clientWidth;
  const height = elements.stage.clientHeight;
  if (!width || !height) return;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(state.clock.getDelta(), 0.1);
  if (state.mixer && state.playing) state.mixer.update(delta * Number(elements.speedRange.value));
  if (state.action) {
    elements.timeline.value = String(Math.round((state.action.time / state.duration) * 1000));
    updateTimeDisplay(state.action.time, state.duration);
  }
  controls.autoRotate = elements.rotateToggle.checked;
  controls.autoRotateSpeed = 1.4;
  controls.update();
  renderer.render(scene, camera);

  state.fpsFrames += 1;
  const now = performance.now();
  if (now - state.fpsLast >= 700) {
    state.fps = Math.round((state.fpsFrames * 1000) / (now - state.fpsLast));
    elements.fpsStat.textContent = String(state.fps);
    state.fpsFrames = 0;
    state.fpsLast = now;
  }
}

elements.fileInput.addEventListener("change", () => handleFiles(elements.fileInput.files));
elements.clipSelect.addEventListener("change", () => selectClip(Number(elements.clipSelect.value)));
elements.playButton.addEventListener("click", () => togglePlayback());
elements.previousFrame.addEventListener("click", () => stepFrame(-1));
elements.nextFrame.addEventListener("click", () => stepFrame(1));
elements.timeline.addEventListener("input", () => {
  togglePlayback(false);
  seekTo((Number(elements.timeline.value) / 1000) * state.duration);
});
elements.speedRange.addEventListener("input", () => { elements.speedValue.value = `${Number(elements.speedRange.value).toFixed(1)}×`; });
elements.loopToggle.addEventListener("change", applyLoopSetting);
elements.skeletonToggle.addEventListener("change", () => { if (state.skeleton) state.skeleton.visible = elements.skeletonToggle.checked; });
elements.gridToggle.addEventListener("change", () => { grid.visible = elements.gridToggle.checked; floorGlow.visible = elements.gridToggle.checked; });
elements.fitButton.addEventListener("click", () => fitModel());
elements.screenshotButton.addEventListener("click", captureFrame);
elements.forgetButton.addEventListener("click", forgetLatestModel);
elements.fullscreenButton.addEventListener("click", async () => {
  if (!document.fullscreenElement) await elements.stage.requestFullscreen?.();
  else await document.exitFullscreen?.();
});
document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => fitModel(button.dataset.view)));

for (const eventName of ["dragenter", "dragover"]) {
  elements.stage.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropPrompt.hidden = false;
  });
}
for (const eventName of ["dragleave", "drop"]) {
  elements.stage.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropPrompt.hidden = true;
  });
}
elements.stage.addEventListener("drop", (event) => handleFiles(event.dataTransfer.files));

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  state.deferredInstall = event;
  elements.installButton.hidden = false;
});
elements.installButton.addEventListener("click", async () => {
  if (!state.deferredInstall) return;
  state.deferredInstall.prompt();
  await state.deferredInstall.userChoice;
  state.deferredInstall = null;
  elements.installButton.hidden = true;
});

new ResizeObserver(resize).observe(elements.stage);
window.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !/INPUT|SELECT|BUTTON/.test(document.activeElement?.tagName)) {
    event.preventDefault();
    togglePlayback();
  }
  if (event.code === "ArrowLeft") stepFrame(-1);
  if (event.code === "ArrowRight") stepFrame(1);
});

if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));

createDemo();
resize();
animate();
restoreLatestModel();
