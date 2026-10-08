import { createEffect, createSignal, onCleanup, Show } from 'solid-js';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { parsePts } from '../lib/pts';

interface Props {
  modelUrl: string | null;
  ptsUrl?: string | null;
  label: string;
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error('load');
  return r.arrayBuffer();
}

/** 3D view of an STL model with its PTS trim line on top. Open trim lines are drawn red. */
export function StlViewer(props: Props) {
  let host!: HTMLDivElement;
  const [msg, setMsg] = createSignal<string | null>(null);
  const [trim, setTrim] = createSignal<{ closed: boolean; count: number } | null>(null);

  // Runs again when the model or the trim line changes: it reads the two urls here and nowhere else, so the scene is built once per pair.
  createEffect(() => {
    const modelUrl = props.modelUrl;
    const ptsUrl = props.ptsUrl;
    const el = host;
    setTrim(null);
    if (!el || !modelUrl) { setMsg(modelUrl ? null : 'Choose a model to see it here.'); return; }
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setMsg('Your browser cannot show 3D models. Download the file to view it.');
      return;
    }
    setMsg('Loading the model');
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    // Three lights that move with the camera but come from different sides, so surfaces facing the viewer are not all equally bright.
    // A single light on the camera ("headlight") makes a model look flat.
    scene.add(new THREE.HemisphereLight(0xffffff, 0x7f8c97, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(-1.2, 1.6, 1.4);
    const fill = new THREE.DirectionalLight(0xdfe9f5, 0.7);
    fill.position.set(1.6, 0.2, 0.8);
    const rim = new THREE.DirectionalLight(0xffffff, 0.9);
    rim.position.set(0.2, 0.8, -1.6);
    for (const l of [key, fill, rim]) camera.add(l);
    scene.add(camera);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    let raf = 0;
    let dead = false;
    const disposables: { dispose: () => void }[] = [];

    function resize() {
      const w = el!.clientWidth || 300;
      const h = el!.clientHeight || 300;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const loop = () => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    (async () => {
      try {
        const buf = await fetchBuffer(modelUrl);
        if (dead) return;
        let geo = new STLLoader().parse(buf);
        // An STL gives every triangle its own corners, so normals come out per face and the surface looks faceted and flat.
        // Joining the shared corners gives smooth shading. Very large models keep per face normals to stay fast.
        if (geo.attributes.position.count / 3 <= 700_000) {
          geo.deleteAttribute('normal');
          const smooth = mergeVertices(geo, 1e-3);
          geo.dispose();
          geo = smooth;
        }
        geo.computeVertexNormals();
        geo.computeBoundingBox();
        const box = geo.boundingBox!;
        const centre = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const mat = new THREE.MeshStandardMaterial({ color: 0xc4ccd2, roughness: 0.42, metalness: 0.0, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        const group = new THREE.Group();
        group.add(mesh);
        disposables.push(geo, mat);

        if (ptsUrl) {
          try {
            const text = new TextDecoder().decode(await fetchBuffer(ptsUrl));
            if (dead) return;
            const t = parsePts(text);
            if (t.count >= 2) {
              const lg = new THREE.BufferGeometry();
              lg.setAttribute('position', new THREE.BufferAttribute(t.points, 3));
              const lm = new THREE.LineBasicMaterial({ color: t.closed ? 0x0f8a5f : 0xe11d2e, depthTest: false });
              const line = t.closed ? new THREE.LineLoop(lg, lm) : new THREE.Line(lg, lm);
              line.renderOrder = 10;
              group.add(line);
              disposables.push(lg, lm);
              if (!t.closed) {
                const dot = new THREE.SphereGeometry(Math.max(size.x, size.y, size.z) * 0.008, 12, 12);
                const dm = new THREE.MeshBasicMaterial({ color: 0xe11d2e, depthTest: false });
                for (const i of [0, t.count - 1]) {
                  const s = new THREE.Mesh(dot, dm);
                  s.position.set(t.points[i * 3]!, t.points[i * 3 + 1]!, t.points[i * 3 + 2]!);
                  s.renderOrder = 11;
                  group.add(s);
                }
                disposables.push(dot, dm);
              }
              setTrim({ closed: t.closed, count: t.count });
            }
          } catch { /* the model still shows without its trim line */ }
        }
        group.position.sub(centre);
        scene.add(group);
        const radius = Math.max(size.x, size.y, size.z) || 50;
        camera.position.set(radius * 0.4, -radius * 1.6, radius * 1.1);
        camera.up.set(0, 0, 1);
        controls.target.set(0, 0, 0);
        controls.update();
        camera.near = radius / 100;
        camera.far = radius * 20;
        camera.updateProjectionMatrix();
        setMsg(null);
      } catch {
        if (!dead) setMsg('The model could not be loaded. You can still download it.');
      }
    })();

    onCleanup(() => {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    });
  });

  return (
    <div class="viewer" ref={host} role="img" aria-label={props.label}>
      <Show when={msg()}><div class="viewer-msg" role="status">{msg()}</div></Show>
      <Show when={trim()}>
        {(t) => (
          <div class="viewer-legend">
            <span><span class="swatch" style={{ background: t().closed ? '#0f8a5f' : '#e11d2e' }} />{t().closed ? 'Trim line is closed' : 'Trim line is open'}</span>
          </div>
        )}
      </Show>
    </div>
  );
}
