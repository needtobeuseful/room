// Картинки для карточек магазина: каждая модель один раз рисуется
// отдельным маленьким рендерером под тем же углом, что и комната.

import * as THREE from 'three';
import { VIEW_DIRECTION } from './room.js';

export function makeThumbnails(types, buildModel, size = 160) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff1dc, 0x39405a, 1.8));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(6, 10, 4);
  scene.add(sun);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  const urls = {};
  for (const type of types) {
    const model = buildModel(type);
    // Настенное повёрнуто к камере вполоборота - так его лучше видно
    if (type.surface === 'wall') model.rotation.y = Math.PI / 4;
    scene.add(model);

    const box = new THREE.Box3().setFromObject(model);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    camera.position.copy(sphere.center).addScaledVector(VIEW_DIRECTION, 20);
    camera.lookAt(sphere.center);
    const r = sphere.radius * 1.02;
    camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
    camera.updateProjectionMatrix();

    renderer.render(scene, camera);
    urls[type.id] = renderer.domElement.toDataURL('image/png');
    scene.remove(model);
  }
  renderer.dispose();
  renderer.forceContextLoss();
  return urls;
}
