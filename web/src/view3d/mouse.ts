/**
 * One mouse convention for every 3D view in the app (founder 2026-10-16: "on
 * every 3d: left click -> move the object, right click : rotate").
 *
 *   left-drag            MOVE: pans the view (or moves the object, in a view
 *                        where objects may be moved and the press is on one)
 *   shift + left-drag    MOVE as well: the scene moves and the centre of
 *                        rotation moves with it (founder 2026-10-16: "when I
 *                        press shift left click move the object relative to the
 *                        center of rotation")
 *   right-drag           ROTATE (orbit) about the centre of rotation
 *   alt + left-drag      ROTATE too, for a trackpad with no right button
 *   wheel                zoom
 *
 * ⚠ The cnc chat view still moves no object (founder ruling, automatic
 * placement): there a left-drag only pans the view.
 */
import * as THREE from 'three';

export type DragMode = 'pan' | 'orbit';

export function dragMode(e: Pick<PointerEvent, 'button' | 'shiftKey' | 'altKey'>): DragMode {
  return e.button === 2 || (e.button === 0 && e.altKey) ? 'orbit' : 'pan';
}

/** Move `target` in the camera's screen plane by a pixel delta; distance-scaled. */
export function panTarget(camera: THREE.Camera, target: THREE.Vector3, dxPx: number, dyPx: number, radius: number, heightPx: number): void {
  const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
  const fov = (camera as THREE.PerspectiveCamera).fov ?? 40;
  const perPx = (2 * radius * Math.tan(((fov * Math.PI) / 180) / 2)) / Math.max(1, heightPx);
  target.addScaledVector(right, -dxPx * perPx).addScaledVector(up, dyPx * perPx);
}

/** The context menu would eat the right-drag; every view calls this on its canvas. */
export function noContextMenu(el: HTMLElement): () => void {
  const f = (e: Event) => e.preventDefault();
  el.addEventListener('contextmenu', f);
  return () => el.removeEventListener('contextmenu', f);
}
